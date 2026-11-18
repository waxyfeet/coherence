/**
 * Destination discovery entry point: run the read-only adapter for the configured tracker, fingerprint the
 * structure and cache it in the global profile (AppData), keyed by a secret-free destination identity.
 * The cache is refreshable on demand; a damaged cache file is ignored and rediscovered, never trusted.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { DestinationIdentity, DestinationSchema } from "@shared/delivery";
import type {
  AzdoSettings,
  ExternalSystem,
  GitHubSettings,
  JiraSettings,
} from "@shared/types";
import { BadRequestError } from "../../errors";
import { config } from "../../config";
import { readJsonIfExists, writeJsonAtomic } from "../../storage/fsUtils";
import { discoverAzdo } from "./azdo";
import { discoverGitHub } from "./github";
import { discoverJira } from "./jira";
import type { DiscoveryDraft } from "./types";

export type TrackerSettings = JiraSettings | AzdoSettings | GitHubSettings;

/** Stable JSON: object keys sorted, so the same structure always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as object)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Structure only: help text, labels, milestones, paths and timestamps do not invalidate approved mappings. */
export function schemaFingerprint(draft: DiscoveryDraft): string {
  const byId = <T extends { id: string }>(list: T[]) =>
    [...list].sort((a, b) => a.id.localeCompare(b.id));
  return sha256(
    canonical({
      identity: draft.identity,
      textFormat: draft.textFormat,
      itemTypes: byId(draft.itemTypes).map((t) => ({
        id: t.id,
        level: t.level,
        disabled: !!t.disabled,
        fields: t.fields
          ? byId(t.fields).map((f) => ({
              id: f.id,
              kind: f.kind,
              role: f.role,
              required: f.required,
              hasDefault: f.hasDefault,
              readOnly: f.readOnly,
              allowedValues: f.allowedValues
                ? [...f.allowedValues].sort()
                : null,
              maxLength: f.maxLength ?? null,
            }))
          : null,
      })),
      linkTypes: byId(draft.linkTypes).map((l) => ({ id: l.id, kind: l.kind })),
      hierarchy: [...draft.hierarchy]
        .map((h) => `${h.parentTypeId}>${h.childTypeId}:${h.via}`)
        .sort(),
    }),
  ).slice(0, 32);
}

/** Secret-free key for caches and profiles. */
export function destinationKey(identity: DestinationIdentity): string {
  return sha256(
    canonical({
      system: identity.system,
      base: identity.base.toLowerCase(),
      container: identity.container.toLowerCase(),
      variant: identity.variant ?? "",
    }),
  ).slice(0, 24);
}

export function sameDestination(
  a: DestinationIdentity,
  b: DestinationIdentity,
): boolean {
  return destinationKey(a) === destinationKey(b);
}

export function finishSchema(
  draft: DiscoveryDraft,
  discoveredAt = new Date().toISOString(),
): DestinationSchema {
  return {
    schemaVersion: 1,
    ...draft,
    fingerprint: schemaFingerprint(draft),
    discoveredAt,
  };
}

const fieldSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.string(),
  role: z.string(),
  required: z.boolean(),
  hasDefault: z.boolean(),
  readOnly: z.boolean(),
  custom: z.boolean(),
  allowedValues: z.array(z.string()).optional(),
  allowedValuesTruncated: z.boolean().optional(),
  maxLength: z.number().optional(),
  help: z.string().optional(),
  sourceType: z.string().optional(),
});
const cachedSchema = z.object({
  schemaVersion: z.literal(1),
  identity: z.object({
    system: z.enum(["jira", "azdo", "github"]),
    base: z.string(),
    container: z.string(),
    variant: z.string().optional(),
  }),
  fingerprint: z.string(),
  discoveredAt: z.string(),
  textFormat: z.enum(["html", "adf", "jira-wiki", "markdown"]),
  itemTypes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      level: z.string(),
      isDefault: z.boolean().optional(),
      disabled: z.boolean().optional(),
      fields: z.array(fieldSchema).optional(),
    }),
  ),
  linkTypes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      direction: z.string().optional(),
    }),
  ),
  hierarchy: z.array(
    z.object({
      parentTypeId: z.string(),
      childTypeId: z.string(),
      via: z.string(),
    }),
  ),
  areas: z.array(z.string()).optional(),
  iterations: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  milestones: z.array(z.string()).optional(),
  capabilities: z.array(
    z.object({ id: z.string(), state: z.string(), note: z.string() }),
  ),
  gaps: z.array(z.string()),
  requestCount: z.number(),
});

function cacheFile(identity: DestinationIdentity): string {
  return path.join(
    config.dataDir,
    "delivery",
    "destinations",
    `${destinationKey(identity)}.json`,
  );
}

/** A cached snapshot whose content still matches its own fingerprint, or undefined. */
export async function readCachedSchema(
  identity: DestinationIdentity,
): Promise<DestinationSchema | undefined> {
  try {
    const raw = await readJsonIfExists<unknown>(cacheFile(identity));
    const parsed = cachedSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const schema = parsed.data as unknown as DestinationSchema;
    if (!sameDestination(schema.identity, identity)) return undefined;
    if (schemaFingerprint(schema) !== schema.fingerprint) return undefined;
    return schema;
  } catch {
    return undefined;
  }
}

export async function writeCachedSchema(schema: DestinationSchema) {
  await writeJsonAtomic(cacheFile(schema.identity), schema);
}

/** Identity of the configured destination, computed without contacting it. */
export function configuredIdentity(
  system: ExternalSystem,
  settings: TrackerSettings,
): DestinationIdentity {
  switch (system) {
    case "azdo": {
      const s = settings as AzdoSettings;
      return {
        system,
        base: azdoBase(s),
        container: s.project.trim().toLowerCase(),
      };
    }
    case "jira": {
      const s = settings as JiraSettings;
      return {
        system,
        base: hostPath(s.baseUrl),
        container: s.projectKey.trim().toLowerCase(),
        variant: s.deployment === "server" ? "server" : "cloud",
      };
    }
    case "github": {
      const s = settings as GitHubSettings;
      const api = (s.apiBaseUrl?.trim() || "https://api.github.com").replace(
        /\/+$/,
        "",
      );
      const enterprise = !/^https:\/\/api\.github\.com$/i.test(api);
      return {
        system,
        base: githubWebHost(api),
        container: `${s.owner.trim()}/${s.repo.trim()}`.toLowerCase(),
        variant: enterprise ? "enterprise" : "github.com",
      };
    }
    default:
      throw new BadRequestError(`Unknown destination "${String(system)}".`);
  }
}

function hostPath(raw: string): string {
  try {
    const url = new URL(raw.trim());
    return `${url.host}${url.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

function azdoBase(s: AzdoSettings): string {
  const value = hostPath(s.orgUrl);
  const legacy =
    /^([^/.:]+)\.visualstudio\.com(?:\/defaultcollection(?=\/|$))?(.*)$/.exec(
      value,
    );
  return legacy ? `dev.azure.com/${legacy[1]}${legacy[2]}` : value;
}

function githubWebHost(api: string): string {
  const value = hostPath(api);
  return /\/api\/v3$/.test(value)
    ? value.replace(/\/api\/v3$/, "")
    : value.replace(/^api\./, "");
}

export interface DiscoveryResult {
  schema: DestinationSchema;
  fromCache: boolean;
}

/**
 * Cached snapshot unless `refresh`; otherwise a fresh read-only discovery that replaces the cache. `keepCache`
 * reads without replacing it (publishing compares a fresh read with the plan and must not overwrite a good snapshot
 * with a partial one).
 */
export async function discoverDestination(
  system: ExternalSystem,
  settings: TrackerSettings,
  opts: { refresh?: boolean; signal?: AbortSignal; keepCache?: boolean } = {},
): Promise<DiscoveryResult> {
  const identity = configuredIdentity(system, settings);
  if (!opts.refresh) {
    const cached = await readCachedSchema(identity);
    if (cached) return { schema: cached, fromCache: true };
  }
  const draft =
    system === "azdo"
      ? await discoverAzdo(settings as AzdoSettings, opts.signal)
      : system === "jira"
        ? await discoverJira(settings as JiraSettings, opts.signal)
        : await discoverGitHub(settings as GitHubSettings, opts.signal);
  // The adapter's identity comes from the same settings; keep the configured one as the cache key.
  const schema = finishSchema({ ...draft, identity });
  if (!opts.keepCache) await writeCachedSchema(schema);
  return { schema, fromCache: false };
}
