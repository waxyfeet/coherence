/**
 * OWNER: export builder (tracker/HTTP-client territory).
 * Figma REST import: list the top-level frames of a file and render selected frames to PNG.
 * API: GET https://api.figma.com/v1/files/:key?depth=2 (pages → top-level frames), GET /v1/images/:key?ids=..&format=png&scale=2
 * (returns short-lived S3 URLs to download). Auth header: `X-Figma-Token: <token>`.
 * Accepts URLs like https://www.figma.com/design/<key>/<name>?node-id=1-2 and /file/<key>/... (also a bare key).
 *
 * Quota: files, nodes and images are all Figma "Tier 1" endpoints, and View/Collab seats get only a handful of
 * those calls per month. So thumbnails are rendered for the first MAX_THUMBNAILS frames only, and the frame
 * names and thumbnail URLs of a listing are kept for a while: listing again does not re-render thumbnails, and
 * importing frames from that listing does not fetch their names again.
 */
import { createHash } from "node:crypto";
import { figmaImageUrl } from "../security/outboundPolicy";
import type {
  FigmaFrame,
  FigmaFramesResponse,
  TestConnectionResponse,
} from "@shared/api";
import {
  BadRequestError,
  CancelledError,
  IntegrationError,
  errorMessage,
} from "../errors";
import {
  figmaErrorMessage,
  requestBuffer,
  requestJson,
  type ServiceInfo,
} from "../export/http";
import type { UploadedImage } from "../storage/projectStore";

export const FIGMA_API = "https://api.figma.com";

const FIGMA_SERVICE: ServiceInfo = {
  label: "Figma",
  extractMessage: figmaErrorMessage,
  authHint:
    "Check the Figma personal access token in Settings (it needs read access to file content).",
  rateLimitHint: (headers) =>
    headers.get("x-figma-rate-limit-type")?.toLowerCase() === "low"
      ? "This token belongs to a View or Collab seat, which Figma allows only a small number of file and image calls per month (listing frames and importing each use some). A Dev or Full seat has a much higher limit."
      : undefined,
};

/** Node types that make sensible screens; SECTIONs are opened up to their frames. */
const SCREEN_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET"]);
const BATCH = 50;
const MAX_IMPORT = 50;
/** One /v1/images call's worth; frames after these are listed without a preview. */
const MAX_THUMBNAILS = 50;
/** Figma image URLs stay valid far longer than this. */
const CACHE_TTL_MS = 30 * 60_000;
const CACHE_MAX_FILES = 20;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** Rendering big frames takes Figma a while — allow more than the default 30 s. */
const RENDER_TIMEOUT_MS = 90_000;
const PATH_KINDS = new Set(["file", "design", "proto", "board"]);

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  absoluteBoundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  absoluteRenderBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
}

interface FigmaFile {
  name?: string;
  document?: FigmaNode;
}

interface FigmaNodes {
  nodes?: Record<string, { document?: FigmaNode } | null>;
}

interface FigmaImages {
  err?: string | null;
  images?: Record<string, string | null>;
}

/** @throws BadRequestError for unrecognised URLs. */
export function parseFigmaFileKey(fileUrl: string): string {
  const input = (fileUrl ?? "").trim();
  if (!input)
    throw new BadRequestError(
      "Paste a Figma file link, e.g. https://www.figma.com/design/AbC123xyz/My-app.",
    );
  if (/^[A-Za-z0-9]{10,128}$/.test(input)) return input;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new BadRequestError(
      "This is not a Figma link. Copy the link from Figma's Share dialog or the browser address bar.",
    );
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) =>
      /token|api.?key|secret|password|authorization|credential|signature/i.test(
        key,
      ),
    )
  ) {
    throw new BadRequestError(
      "Figma links cannot include credentials or fragments. Enter the access token in the protected Figma token field.",
    );
  }
  if (!/(^|\.)figma\.com$/i.test(url.hostname)) {
    throw new BadRequestError(
      "This is not a Figma address — the link should start with https://www.figma.com/.",
    );
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const kindIndex = parts.findIndex((p) => PATH_KINDS.has(p.toLowerCase()));
  const key = kindIndex >= 0 ? parts[kindIndex + 1] : undefined;
  if (!key || !/^[A-Za-z0-9]+$/.test(key)) {
    throw new BadRequestError(
      "That Figma link does not point to a file. Open the design file in Figma and copy its link (…/design/<key>/…).",
    );
  }
  // Branch links: /design/<mainKey>/branch/<branchKey>/<name> — the branch is its own file for the API.
  if (
    parts[kindIndex + 2]?.toLowerCase() === "branch" &&
    /^[A-Za-z0-9]+$/.test(parts[kindIndex + 3] ?? "")
  ) {
    return parts[kindIndex + 3];
  }
  return key;
}

function requireToken(token: string): string {
  const t = (token ?? "").trim();
  if (!t)
    throw new BadRequestError(
      "Add a Figma personal access token in Settings before importing from Figma.",
    );
  return t;
}

function headers(token: string): Record<string, string> {
  return { "X-Figma-Token": token };
}

function size(node: FigmaNode): { width: number; height: number } {
  const box = node.absoluteBoundingBox ?? node.absoluteRenderBounds;
  return {
    width: Math.round(box?.width ?? 0),
    height: Math.round(box?.height ?? 0),
  };
}

function chunk<T>(items: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Run tasks with a small concurrency limit, keeping result order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

type Slot = { frame: FigmaFrame } | { sectionId: string; page: string };

interface FileCache {
  at: number;
  names: Map<string, string>;
  /** Frame id → thumbnail URL (null: Figma could not render it). */
  thumbs: Map<string, string | null>;
}

/** Per token + file key (the token only as a hash). */
const fileCache = new Map<string, FileCache>();

function cachedFile(
  token: string,
  key: string,
  create: boolean,
): FileCache | undefined {
  const now = Date.now();
  for (const [id, entry] of fileCache)
    if (now - entry.at > CACHE_TTL_MS) fileCache.delete(id);
  const id = `${createHash("sha256").update(token).digest("hex").slice(0, 16)}:${key}`;
  let entry = fileCache.get(id);
  if (!entry && create) {
    if (fileCache.size >= CACHE_MAX_FILES)
      fileCache.delete(fileCache.keys().next().value as string);
    entry = { at: now, names: new Map(), thumbs: new Map() };
    fileCache.set(id, entry);
  }
  return entry;
}

/** Tests only. */
export function clearFigmaCache(): void {
  fileCache.clear();
}

/** Top-level FRAME / COMPONENT / SECTION children of every page, with thumbnails (scale 0.25) for the first MAX_THUMBNAILS. */
export async function listFigmaFrames(
  token: string,
  fileUrl: string,
): Promise<FigmaFramesResponse> {
  const key = parseFigmaFileKey(fileUrl);
  const t = requireToken(token);
  const { data: file } = await requestJson<FigmaFile>(
    FIGMA_SERVICE,
    `${FIGMA_API}/v1/files/${encodeURIComponent(key)}?depth=2`,
    { headers: headers(t) },
  );

  // Slots keep document order while sections are expanded into their frames.
  let slots: Slot[] = [];
  for (const page of file?.document?.children ?? []) {
    if (page.type !== "CANVAS") continue;
    for (const child of page.children ?? [])
      slots.push(...toSlots(child, page.name));
  }

  for (
    let round = 0;
    round < 3 && slots.some((s) => "sectionId" in s);
    round++
  ) {
    const sectionIds = slots
      .filter((s): s is { sectionId: string; page: string } => "sectionId" in s)
      .map((s) => s.sectionId);
    const children = new Map<string, FigmaNode[]>();
    for (const ids of chunk(sectionIds, BATCH)) {
      const { data } = await requestJson<FigmaNodes>(
        FIGMA_SERVICE,
        `${FIGMA_API}/v1/files/${encodeURIComponent(key)}/nodes?ids=${encodeURIComponent(ids.join(","))}&depth=1`,
        { headers: headers(t) },
      );
      for (const id of ids)
        children.set(id, data?.nodes?.[id]?.document?.children ?? []);
    }
    slots = slots.flatMap((s) =>
      "sectionId" in s
        ? (children.get(s.sectionId) ?? []).flatMap((c) => toSlots(c, s.page))
        : [s],
    );
  }

  const frames = slots
    .filter((s): s is { frame: FigmaFrame } => "frame" in s)
    .map((s) => s.frame);
  const cache = cachedFile(t, key, true)!;
  for (const f of frames) cache.names.set(f.id, f.name);
  const render = frames
    .slice(0, MAX_THUMBNAILS)
    .map((f) => f.id)
    .filter((id) => !cache.thumbs.has(id));
  if (render.length) {
    try {
      const thumbs = await renderImages(t, key, render, 0.25, 30_000);
      for (const id of render) cache.thumbs.set(id, thumbs[id] ?? null);
    } catch {
      // Thumbnails are a nicety; the BA can still pick frames by name.
    }
  }
  for (const f of frames) {
    const url = cache.thumbs.get(f.id);
    if (url) {
      try {
        figmaImageUrl(url);
        f.thumbnailUrl = `/api/figma/thumbnail/${encodeURIComponent(key)}/${encodeURIComponent(f.id)}`;
      } catch {
        /* Unsupported thumbnail destinations are never sent to the browser. */
      }
    }
  }
  return { fileKey: key, fileName: file?.name ?? key, frames };
}

/** Only already-listed thumbnails for the current token can be downloaded; callers cannot supply a URL. */
export async function figmaThumbnail(
  token: string,
  fileKey: string,
  nodeId: string,
): Promise<Buffer> {
  const url = cachedFile(token, fileKey, false)?.thumbs.get(nodeId);
  if (!url)
    throw new BadRequestError(
      "This Figma thumbnail expired. Reload the frame list.",
    );
  const { data } = await requestBuffer(FIGMA_SERVICE, url, {
    destination: "figma-image",
    headers: { Accept: "image/png" },
    maxBytes: MAX_IMAGE_BYTES,
  });
  if (data.length < 8 || data.readUInt32BE(0) !== 0x89504e47)
    throw new IntegrationError("Figma did not return a PNG thumbnail.");
  return data;
}

function toSlots(node: FigmaNode, page: string): Slot[] {
  if (node.visible === false) return [];
  if (SCREEN_TYPES.has(node.type))
    return [{ frame: { id: node.id, name: node.name, page, ...size(node) } }];
  // Sections always sit at the edge of a depth-limited response, so their frames are fetched separately.
  if (node.type === "SECTION") return [{ sectionId: node.id, page }];
  return [];
}

/** GET /v1/images in batches of 50; returns node id → URL (null when Figma could not render it). */
async function renderImages(
  token: string,
  key: string,
  ids: string[],
  scale: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  const batches = chunk(ids, BATCH);
  await mapLimit(batches, 3, async (batch) => {
    const { data } = await requestJson<FigmaImages>(
      FIGMA_SERVICE,
      `${FIGMA_API}/v1/images/${encodeURIComponent(key)}?ids=${encodeURIComponent(batch.join(","))}&format=png&scale=${scale}`,
      { headers: headers(token), timeoutMs, signal },
    );
    if (data?.err)
      throw new IntegrationError(
        "Figma could not render the frames. Response details were withheld; check the frame selection and Figma access.",
      );
    for (const id of batch) out[id] = data?.images?.[id] ?? null;
  });
  return out;
}

/** Frame name → safe file name (no path separators / reserved characters), without extension. */
export function sanitiseFileName(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, 100)
    .trim();
  if (!cleaned) return "Figma frame";
  // Windows reserves these device names.
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned)
    ? `${cleaned} frame`
    : cleaned;
}

/** Renders frames to PNG and downloads them; originalName = "<frame name>.png". */
export async function exportFigmaFrames(
  token: string,
  fileUrl: string,
  frameIds: string[],
  scale: 1 | 2,
  options: { signal?: AbortSignal; onDownloaded?: (name: string) => void } = {},
): Promise<UploadedImage[]> {
  const { signal } = options;
  if (signal?.aborted) throw new CancelledError();
  const key = parseFigmaFileKey(fileUrl);
  const t = requireToken(token);
  const ids = [
    ...new Set((frameIds ?? []).map((id) => id.trim()).filter(Boolean)),
  ];
  if (!ids.length)
    throw new BadRequestError("Select at least one Figma frame to import.");
  if (ids.length > MAX_IMPORT)
    throw new BadRequestError(
      `Select at most ${MAX_IMPORT} frames per import (you selected ${ids.length}).`,
    );
  const renderScale = scale === 1 ? 1 : 2;

  // Names for the screens (and for readable errors): from the frame list the BA picked from, else from Figma.
  const names = new Map<string, string>();
  const listed = cachedFile(t, key, false);
  for (const id of ids) {
    const name = listed?.names.get(id);
    if (name !== undefined) names.set(id, name);
  }
  const unnamed = ids.filter((id) => !names.has(id));
  if (unnamed.length) {
    const { data } = await requestJson<FigmaNodes>(
      FIGMA_SERVICE,
      `${FIGMA_API}/v1/files/${encodeURIComponent(key)}/nodes?ids=${encodeURIComponent(unnamed.join(","))}&depth=1`,
      { headers: headers(t), signal },
    );
    for (const id of unnamed) {
      const node = data?.nodes?.[id]?.document;
      if (!node)
        throw new BadRequestError(
          `Frame ${id} no longer exists in this Figma file — reload the frame list and try again.`,
        );
      names.set(id, node.name);
    }
  }

  const urls = await renderImages(
    t,
    key,
    ids,
    renderScale,
    RENDER_TIMEOUT_MS,
    signal,
  );
  for (const id of ids) {
    if (!urls[id]) {
      throw new IntegrationError(
        `Figma could not render the frame "${names.get(id)}" — it may have been deleted, or be empty, hidden or fully transparent.`,
      );
    }
  }

  const used = new Map<string, number>();
  const fileNames = ids.map((id) => {
    const base = sanitiseFileName(names.get(id) ?? id);
    const n = (used.get(base.toLowerCase()) ?? 0) + 1;
    used.set(base.toLowerCase(), n);
    return `${n > 1 ? `${base} (${n})` : base}.png`;
  });

  let totalBytes = 0;
  return mapLimit(
    ids.map((id, i) => ({ id, fileName: fileNames[i] })),
    4,
    async ({ id, fileName }) => {
      if (signal?.aborted) throw new CancelledError();
      // Rendered images live on Figma's CDN behind a signed URL — no token header there.
      const { data: buffer } = await requestBuffer(
        FIGMA_SERVICE,
        urls[id] as string,
        {
          timeoutMs: RENDER_TIMEOUT_MS,
          headers: { Accept: "image/png" },
          signal,
          maxBytes: MAX_IMAGE_BYTES,
          destination: "figma-image",
        },
      );
      const name = names.get(id) ?? id;
      if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
        throw new IntegrationError(
          `Figma returned something other than a PNG for the frame "${name}".`,
        );
      }
      if (buffer.length > MAX_IMAGE_BYTES) {
        throw new BadRequestError(
          `The frame "${name}" is too large at ${renderScale}x (${Math.round(buffer.length / 1024 / 1024)} MB). Import it at 1x or split it in Figma.`,
        );
      }
      totalBytes += buffer.length;
      if (totalBytes > 100 * 1024 * 1024)
        throw new BadRequestError(
          "Figma import exceeds the 100 MB total limit. Import fewer frames or choose 1× scale.",
        );
      if (signal?.aborted) throw new CancelledError();
      options.onDownloaded?.(fileName);
      return { originalName: fileName, mimeType: "image/png", buffer };
    },
  );
}

/** GET /v1/me. Never throws. */
export async function testFigmaToken(
  token: string,
): Promise<TestConnectionResponse> {
  const started = Date.now();
  try {
    const t = requireToken(token);
    const { data } = await requestJson<{ handle?: string; email?: string }>(
      FIGMA_SERVICE,
      `${FIGMA_API}/v1/me`,
      { headers: headers(t) },
    );
    return {
      ok: true,
      latencyMs: Date.now() - started,
      message: `Connected to Figma as ${data?.handle ?? "the token owner"}.`,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: errorMessage(err),
    };
  }
}
