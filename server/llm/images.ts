import { readOwnedFile } from "../storage/fsUtils";
/**
 * OWNER: llm builder.
 * Prepares screen images for vision models using sharp:
 *  - normal screens: downscale so the long edge ≤ 1568 px (keeps detail, avoids provider-side resizing);
 *  - tall/long screens (height > 1.8 × width, e.g. full-page captures): split into overlapping vertical
 *    tiles (≈10% overlap) each ≤ 1568 px tall at ≤ 1568 px wide, max `maxTiles` (default 6), labelled
 *    "<name> — part i of n (top→bottom)"; very wide screens are tiled horizontally the same way;
 *  - converts GIF/WebP to PNG for maximum provider compatibility; JPEG stays JPEG.
 * Results are cached in memory by (path, mtime, options).
 *
 * Tile labels also state which percentage range of the full image the tile covers (and `region` carries
 * the exact numbers) so the Screen Analyst can report element bounds relative to the FULL screen.
 */
import fs from "node:fs/promises";
import type { Sharp } from "sharp";
import { BadRequestError, NotFoundError } from "../errors";
import { loadSharp } from "./sharpLoader";
import type { LLMImage, LLMImageMime, LLMImageRegion } from "./types";

export interface PrepareImageOptions {
  /** Used in tile labels. */
  name: string;
  maxTiles?: number;
  /** Long-edge cap in px (default 1568). */
  maxEdge?: number;
}

export const DEFAULT_MAX_EDGE = 1568;
export const DEFAULT_MAX_TILES = 6;
export const THUMBNAIL_EDGE = 768;
/** Aspect ratio beyond which a screen is tiled instead of shrunk into illegibility. */
export const TILE_RATIO = 1.8;
const OVERLAP = 0.1;
/** Providers cap images at ~5 MB (Anthropic: 5 MB of base64) — stay safely below. */
const MAX_BASE64_CHARS = Math.floor(5 * 1024 * 1024 * 0.95);
/** Full-page captures can be enormous; this is generous but stops decompression bombs. */
const MAX_INPUT_PIXELS = 400_000_000;

/* ------------------------------------------------------------------ */
/* Tile planning (pure — unit tested)                                  */
/* ------------------------------------------------------------------ */

export interface TilePlan {
  /** Crop in source pixels (after EXIF orientation). */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Output size in pixels. */
  outWidth: number;
  outHeight: number;
  index: number;
  count: number;
  axis: "none" | "vertical" | "horizontal";
}

function spread(count: number, total: number, size: number): number[] {
  if (count <= 1) return [0];
  return Array.from({ length: count }, (_, i) =>
    Math.round((i * (total - size)) / (count - 1)),
  );
}

/**
 * Decide how to cut a `width × height` image: one downscaled image, or n overlapping tiles along the
 * long axis, each fitting in maxEdge × maxEdge. With too many tiles the whole image is scaled down
 * further so that exactly `maxTiles` tiles cover it.
 */
export function planTiles(
  width: number,
  height: number,
  maxEdge = DEFAULT_MAX_EDGE,
  maxTiles = DEFAULT_MAX_TILES,
): TilePlan[] {
  const tall = height > TILE_RATIO * width;
  const wide = width > TILE_RATIO * height;
  const single = (scale: number): TilePlan[] => [
    {
      left: 0,
      top: 0,
      width,
      height,
      outWidth: Math.max(1, Math.round(width * scale)),
      outHeight: Math.max(1, Math.round(height * scale)),
      index: 1,
      count: 1,
      axis: "none",
    },
  ];
  if (!tall && !wide)
    return single(Math.min(1, maxEdge / Math.max(width, height)));

  // Along = the long axis we cut; across = the axis that must fit within maxEdge.
  const along = tall ? height : width;
  const across = tall ? width : height;
  let scale = Math.min(1, maxEdge / across);
  if (along * scale <= maxEdge) return single(scale);

  const overlap = OVERLAP * maxEdge;
  let count = Math.ceil((along * scale - overlap) / (maxEdge - overlap));
  const tiles = Math.max(1, Math.floor(maxTiles));
  if (count > tiles) {
    count = tiles;
    scale = (maxEdge * ((1 - OVERLAP) * tiles + OVERLAP)) / along;
  }
  if (count <= 1) return single(Math.min(scale, maxEdge / along));

  const tileAlong = Math.min(along, Math.round(maxEdge / scale));
  const starts = spread(count, along, tileAlong);
  const outAcross = Math.max(1, Math.round(across * scale));
  const outAlong = Math.max(1, Math.round(tileAlong * scale));
  return starts.map((start, i) =>
    tall
      ? {
          left: 0,
          top: start,
          width,
          height: tileAlong,
          outWidth: outAcross,
          outHeight: outAlong,
          index: i + 1,
          count,
          axis: "vertical" as const,
        }
      : {
          left: start,
          top: 0,
          width: tileAlong,
          height,
          outWidth: outAlong,
          outHeight: outAcross,
          index: i + 1,
          count,
          axis: "horizontal" as const,
        },
  );
}

function pct(value: number): number {
  return Math.round(value * 1000) / 10;
}

export function tileRegion(
  plan: TilePlan,
  width: number,
  height: number,
): LLMImageRegion {
  return {
    index: plan.index,
    count: plan.count,
    leftPct: pct(plan.left / width),
    topPct: pct(plan.top / height),
    rightPct: pct((plan.left + plan.width) / width),
    bottomPct: pct((plan.top + plan.height) / height),
  };
}

/** "Orders — part 2 of 3, top→bottom (covers 30%–68% of the screen height)". */
export function tileLabel(
  name: string,
  plan: TilePlan,
  region: LLMImageRegion,
): string {
  if (plan.axis === "none") return name;
  if (plan.axis === "vertical") {
    return `${name} — part ${plan.index} of ${plan.count}, top→bottom (covers ${Math.round(region.topPct)}%–${Math.round(region.bottomPct)}% of the screen height)`;
  }
  return `${name} — part ${plan.index} of ${plan.count}, left→right (covers ${Math.round(region.leftPct)}%–${Math.round(region.rightPct)}% of the screen width)`;
}

/* ------------------------------------------------------------------ */
/* Encoding                                                            */
/* ------------------------------------------------------------------ */

interface SourceImage {
  buffer: Buffer;
  width: number;
  height: number;
  /** JPEG sources stay JPEG; everything else becomes PNG. */
  jpeg: boolean;
}

/** Original image stays untouched. A small overlap provides context at adaptive task seams. */
export async function prepareRegionForLLM(
  filePath: string,
  name: string,
  core: { x: number; y: number; width: number; height: number },
): Promise<LLMImage> {
  const source = await loadSource(filePath, name);
  const left = Math.max(0, Math.floor(((core.x - 2) * source.width) / 100));
  const top = Math.max(0, Math.floor(((core.y - 2) * source.height) / 100));
  const right = Math.min(
    source.width,
    Math.ceil(((core.x + core.width + 2) * source.width) / 100),
  );
  const bottom = Math.min(
    source.height,
    Math.ceil(((core.y + core.height + 2) * source.height) / 100),
  );
  const scale = Math.min(
    1,
    DEFAULT_MAX_EDGE / Math.max(right - left, bottom - top),
  );
  const plan: TilePlan = {
    left,
    top,
    width: right - left,
    height: bottom - top,
    outWidth: Math.max(1, Math.round((right - left) * scale)),
    outHeight: Math.max(1, Math.round((bottom - top) * scale)),
    index: 1,
    count: 1,
    axis: "none",
  };
  return {
    ...(await encode(source, plan)),
    label: name + " — automatically sized section",
    region: {
      index: 1,
      count: 1,
      leftPct: (left / source.width) * 100,
      topPct: (top / source.height) * 100,
      rightPct: (right / source.width) * 100,
      bottomPct: (bottom / source.height) * 100,
    },
  };
}

async function open(buffer: Buffer): Promise<Sharp> {
  const sharp = await loadSharp();
  return sharp(buffer, {
    autoOrient: true,
    animated: false,
    failOn: "error",
    limitInputPixels: MAX_INPUT_PIXELS,
  });
}

async function loadSource(
  filePath: string,
  name: string,
): Promise<SourceImage> {
  let buffer: Buffer;
  try {
    buffer = await readOwnedFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NotFoundError(
        `The image for screen "${name}" is missing on disk (${filePath}). Re-upload the screen.`,
      );
    }
    throw err;
  }
  // Outside the try: an unavailable image library is not a damaged screen.
  const image = await open(buffer);
  try {
    const meta = await image.metadata();
    const width = meta.autoOrient?.width ?? meta.width;
    const height = meta.autoOrient?.height ?? meta.height;
    if (!width || !height) throw new Error("no image dimensions");
    return { buffer, width, height, jpeg: meta.format === "jpeg" };
  } catch (err) {
    throw new BadRequestError(
      `Screen "${name}" could not be read as an image (${err instanceof Error ? err.message : String(err)}). Replace it with a PNG or JPEG.`,
    );
  }
}

async function encode(
  source: SourceImage,
  plan: TilePlan,
): Promise<{ mimeType: LLMImageMime; base64: string }> {
  let outWidth = plan.outWidth;
  let outHeight = plan.outHeight;
  let jpeg = source.jpeg;
  for (let round = 0; round < 4; round += 1) {
    let pipeline = await open(source.buffer);
    if (
      plan.axis !== "none" ||
      plan.width !== source.width ||
      plan.height !== source.height
    ) {
      pipeline = pipeline.extract({
        left: plan.left,
        top: plan.top,
        width: plan.width,
        height: plan.height,
      });
    }
    if (outWidth !== plan.width || outHeight !== plan.height) {
      pipeline = pipeline.resize({
        width: outWidth,
        height: outHeight,
        fit: "fill",
        kernel: "lanczos3",
      });
    }
    const data = jpeg
      ? await pipeline
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: 90 })
          .toBuffer()
      : await pipeline.png({ compressionLevel: 6 }).toBuffer();
    const base64 = data.toString("base64");
    if (base64.length <= MAX_BASE64_CHARS)
      return { mimeType: jpeg ? "image/jpeg" : "image/png", base64 };
    // Too big for providers: photo-heavy PNGs compress far better as JPEG; after that, shrink.
    if (!jpeg) {
      jpeg = true;
    } else {
      outWidth = Math.max(1, Math.round(outWidth * 0.8));
      outHeight = Math.max(1, Math.round(outHeight * 0.8));
    }
  }
  throw new BadRequestError(
    "A screen image is too large to send to the AI model even after compression.",
  );
}

async function buildImages(
  filePath: string,
  opts: Required<PrepareImageOptions>,
): Promise<LLMImage[]> {
  const source = await loadSource(filePath, opts.name);
  const plans = planTiles(
    source.width,
    source.height,
    opts.maxEdge,
    opts.maxTiles,
  );
  return Promise.all(
    plans.map(async (plan) => {
      const { mimeType, base64 } = await encode(source, plan);
      const region = tileRegion(plan, source.width, source.height);
      return {
        mimeType,
        base64,
        label: tileLabel(opts.name, plan, region),
        region,
      };
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

/** Encoded screens are big; keep the cache bounded by total base64 size (LRU). */
const CACHE_BUDGET_CHARS = 200 * 1024 * 1024;

interface CacheEntry {
  promise: Promise<LLMImage[]>;
  size: number;
}

const cache = new Map<string, CacheEntry>();
let cachedChars = 0;

function evict(): void {
  for (const [key, entry] of cache) {
    if (cachedChars <= CACHE_BUDGET_CHARS) break;
    cache.delete(key);
    cachedChars -= entry.size;
  }
}

async function cached(
  key: string,
  build: () => Promise<LLMImage[]>,
): Promise<LLMImage[]> {
  const hit = cache.get(key);
  if (hit) {
    // Re-insert to mark as most recently used.
    cache.delete(key);
    cache.set(key, hit);
    return hit.promise;
  }
  const entry: CacheEntry = { promise: build(), size: 0 };
  cache.set(key, entry);
  try {
    const images = await entry.promise;
    if (cache.get(key) === entry) {
      entry.size = images.reduce((sum, img) => sum + img.base64.length, 0);
      cachedChars += entry.size;
      evict();
    }
    return images;
  } catch (err) {
    if (cache.get(key) === entry) cache.delete(key);
    throw err;
  }
}

async function cacheKey(
  filePath: string,
  parts: (string | number)[],
): Promise<string> {
  let stamp = "missing";
  try {
    const stat = await fs.stat(filePath);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // loadSource reports the missing file with a readable message.
  }
  return [filePath, stamp, ...parts].join("|");
}

/** Drop all cached images (tests; also useful after bulk image replacement). */
export function clearImageCache(): void {
  cache.clear();
  cachedChars = 0;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function prepareImageForLLM(
  filePath: string,
  opts: PrepareImageOptions,
): Promise<LLMImage[]> {
  const options: Required<PrepareImageOptions> = {
    name: opts.name,
    maxTiles: Math.max(1, Math.floor(opts.maxTiles ?? DEFAULT_MAX_TILES)),
    maxEdge: Math.max(64, Math.floor(opts.maxEdge ?? DEFAULT_MAX_EDGE)),
  };
  const key = await cacheKey(filePath, [
    "full",
    options.name,
    options.maxTiles,
    options.maxEdge,
  ]);
  return cached(key, () => buildImages(filePath, options));
}

/** Single small thumbnail (long edge ≤ 768 px) — for prompts that only need context, not detail. */
export async function thumbnailForLLM(
  filePath: string,
  name: string,
): Promise<LLMImage> {
  const key = await cacheKey(filePath, ["thumb", name]);
  const [image] = await cached(key, async () => {
    const source = await loadSource(filePath, name);
    const scale = Math.min(
      1,
      THUMBNAIL_EDGE / Math.max(source.width, source.height),
    );
    const plan: TilePlan = {
      left: 0,
      top: 0,
      width: source.width,
      height: source.height,
      outWidth: Math.max(1, Math.round(source.width * scale)),
      outHeight: Math.max(1, Math.round(source.height * scale)),
      index: 1,
      count: 1,
      axis: "none",
    };
    const { mimeType, base64 } = await encode(source, plan);
    return [
      {
        mimeType,
        base64,
        label: name,
        region: tileRegion(plan, source.width, source.height),
      },
    ];
  });
  return image;
}
