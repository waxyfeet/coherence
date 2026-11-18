/** Bounded catalogue GETs only. Inference adapters, model assignments and project files are untouched. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProviderConnection, LLMConnection } from "@shared/types";
import type { ListModelsResponse } from "@shared/api";
import type {
  CatalogueModel,
  ModelCatalogue,
  CatalogueFailure,
} from "@shared/modelCatalogue";
import { validModelId } from "@shared/modelSelection";
import { PROVIDER_PRESETS } from "@shared/providers";
import { config } from "../config";
import { assertV2Path } from "../storage/boundary";
import { writeJsonAtomic, PRIVATE_FILE_MODE } from "../storage/fsUtils";
import {
  providerEndpoint,
  providerFetch,
  validateProviderEndpoint,
} from "../security/endpointPolicy";
import { redactDiagnostic } from "../security/diagnostics";
import { BadRequestError } from "../errors";
import { ProviderError } from "./errors";
import { RequestGuard, resolveApiKey } from "./providers/common";

export const CATALOGUE_MAX_MODELS = 2000,
  CATALOGUE_MAX_PAGES = 20;
const cacheFile = () =>
  assertV2Path(path.join(config.dataDir, "model-catalogues.json"));
let writes: Promise<unknown> = Promise.resolve(),
  ticket = 0;
const latest = new Map<string, number>();
export const CATALOGUE_RUNTIME_TTL_MS = 24 * 60 * 60 * 1000;
const smallestCapacity = (...values: unknown[]) => {
  const valid = values.filter(
    (v): v is number =>
      typeof v === "number" &&
      Number.isSafeInteger(v) &&
      v > 0 &&
      v <= 1_000_000_000,
  );
  return valid.length ? Math.min(...valid) : undefined;
};
/** Legacy adapter entry point shares the same bounded reader; errors never masquerade as live lists. */
/**
 * A recognised service's documented key check (owner test note 3): a GET that runs no model. Undefined when the
 * answer says neither yes nor no, or the service could not be reached.
 */
export async function checkServiceKey(
  c: ProviderConnection,
  path: string,
): Promise<"accepted" | "refused" | undefined> {
  try {
    const request = providerFetch({ ...c, model: "key-check" }, c.apiKey);
    const res = await request(providerEndpoint(c).replace(/\/+$/, "") + path, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel();
    return res.ok
      ? "accepted"
      : res.status === 401 || res.status === 403
        ? "refused"
        : undefined;
  } catch {
    return undefined;
  }
}

export async function listCatalogueModels(connection: LLMConnection) {
  const result = await discoverCatalogue({
    ...connection,
    modelIds: [],
    presetId: (connection as ProviderConnection).presetId,
  });
  if (result.error)
    throw new ProviderError(result.error, {
      failure:
        result.errorCode === "auth"
          ? "auth"
          : result.errorCode === "timeout"
            ? "timeout"
            : "other",
    });
  return result.models.map((m) => ({
    id: m.id,
    label: m.label,
    vision: m.reported?.vision,
  }));
}
class CatalogueError extends Error {
  constructor(
    readonly kind: CatalogueFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
const cleanText = (v: unknown, max = 160) =>
  typeof v === "string" &&
  v.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(v) &&
  redactDiagnostic(v) === v
    ? v
    : undefined;
export function cleanCatalogueModel(
  value: unknown,
): CatalogueModel | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as CatalogueModel;
  if (!validModelId(v.id) || !cleanText(v.id, 300)) return;
  const r = v.reported;
  const reported =
    r && typeof r === "object"
      ? {
          ...(typeof r.vision === "boolean" ? { vision: r.vision } : {}),
          ...(typeof r.loaded === "boolean" ? { loaded: r.loaded } : {}),
          ...(r.reasoning && typeof r.reasoning === "object"
            ? {
                reasoning: {
                  ...(typeof r.reasoning.mandatory === "boolean"
                    ? { mandatory: r.reasoning.mandatory }
                    : {}),
                  ...(Array.isArray(r.reasoning.supportedEfforts)
                    ? {
                        supportedEfforts: [
                          ...new Set(
                            r.reasoning.supportedEfforts.filter((e) =>
                              [
                                "low",
                                "minimal",
                                "medium",
                                "high",
                                "xhigh",
                                "max",
                                "none",
                              ].includes(e),
                            ),
                          ),
                        ].slice(0, 7),
                      }
                    : {}),
                },
              }
            : {}),
          ...(Number.isSafeInteger(r.inputTokenLimit) &&
          r.inputTokenLimit! > 0 &&
          r.inputTokenLimit! <= 1_000_000_000
            ? { inputTokenLimit: r.inputTokenLimit }
            : {}),
          ...(Array.isArray(r.supportedParameters)
            ? {
                supportedParameters: [
                  ...new Set(
                    r.supportedParameters.filter((p) =>
                      [
                        "reasoning",
                        "reasoning_effort",
                        "response_format",
                        "structured_outputs",
                      ].includes(p),
                    ),
                  ),
                ].slice(0, 4),
              }
            : {}),
          ...(Number.isSafeInteger(r.outputTokenLimit) &&
          r.outputTokenLimit! > 0 &&
          r.outputTokenLimit! <= 1_000_000_000
            ? { outputTokenLimit: r.outputTokenLimit }
            : {}),
          ...(Number.isSafeInteger(r.contextWindow) &&
          r.contextWindow! > 0 &&
          r.contextWindow! <= 1_000_000_000
            ? { contextWindow: r.contextWindow }
            : {}),
        }
      : undefined;
  return {
    id: v.id,
    ...(cleanText(v.label) ? { label: v.label } : {}),
    ...(reported && Object.keys(reported).length ? { reported } : {}),
  };
}
function cleanSnapshot(value: unknown): ModelCatalogue | undefined {
  const v = value as ModelCatalogue | undefined;
  if (
    !v ||
    !Array.isArray(v.models) ||
    v.models.length > CATALOGUE_MAX_MODELS ||
    ![
      "openai",
      "anthropic",
      "gemini",
      "ollama",
      "lm-studio-v1",
      "lm-studio-v0",
      "compatible",
    ].includes(v.source) ||
    typeof v.complete !== "boolean" ||
    typeof v.refreshedAt !== "string" ||
    !Number.isFinite(Date.parse(v.refreshedAt))
  )
    return;
  const models = [
    ...new Map(
      v.models
        .map(cleanCatalogueModel)
        .filter((m): m is CatalogueModel => !!m)
        .map((m) => [m.id, m]),
    ).values(),
  ];
  return {
    models,
    refreshedAt: new Date(v.refreshedAt).toISOString(),
    source: v.source,
    complete: v.complete,
  };
}
function identity(c: ProviderConnection) {
  const key = resolveApiKey(c);
  return {
    key,
    hash: createHash("sha256")
      .update(
        JSON.stringify([
          c.provider,
          "capacity-metadata-v2",
          providerEndpoint(c).replace(/\/+$/, ""),
          c.presetId ?? "",
          c.azureApiVersion ?? "",
          key ?? "",
        ]),
      )
      .digest("hex"),
  };
}
async function readCache(): Promise<Record<string, ModelCatalogue>> {
  try {
    const file = cacheFile();
    if (
      (await fs.lstat(file)).isSymbolicLink() ||
      (await fs.stat(file)).size > 8_000_000
    )
      return {};
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    return Object.fromEntries(
      Object.entries(raw)
        .filter(([k]) => /^[a-f0-9]{64}$/.test(k))
        .slice(-10)
        .map(([k, v]) => [k, cleanSnapshot(v)])
        .filter(([, v]) => !!v),
    );
  } catch {
    return {};
  } // Optional cache damage cannot block projects or manual setup.
}
export async function cachedCatalogue(
  c: ProviderConnection,
): Promise<ModelCatalogue | undefined> {
  try {
    const { hash } = identity(c);
    return (await readCache())[hash];
  } catch {
    return undefined;
  }
}

/** Read-only metadata refresh at an explicit generation action. No inference, new destinations or model selection. */
export async function executionCatalogue(
  c: ProviderConnection,
  signal?: AbortSignal,
): Promise<ModelCatalogue | undefined> {
  const cached = await cachedCatalogue(c);
  const age = cached ? Date.now() - Date.parse(cached.refreshedAt) : Infinity;
  if (cached && age >= -60_000 && age <= CATALOGUE_RUNTIME_TTL_MS)
    return cached;
  // A failed/unsupported catalogue leaves capacity unknown; it must never block manual endpoints.
  try {
    const result = await discoverCatalogue(c, { signal, timeoutMs: 3000 });
    if (!result.error) return result.catalogue;
  } catch {
    /* Existing guarded transport enforces the same approved destination. */
  }
  return undefined;
}
async function cacheSnapshot(
  hash: string,
  snapshot: ModelCatalogue,
  version: number,
) {
  const run = writes.then(async () => {
    if (latest.get(hash) !== version) return false;
    const records = await readCache();
    delete records[hash];
    records[hash] = snapshot;
    const keys = Object.keys(records);
    while (
      keys.length > 10 ||
      Object.values(records).reduce((n, c) => n + c.models.length, 0) > 8000 ||
      Buffer.byteLength(JSON.stringify(records, null, 2), "utf8") > 7_900_000
    )
      delete records[keys.shift()!];
    if (latest.get(hash) !== version) return false;
    await writeJsonAtomic(cacheFile(), records, PRIVATE_FILE_MODE);
    return true;
  });
  writes = run.catch(() => {});
  return run;
}
function statusError(status: number): CatalogueError {
  const kind: CatalogueFailure =
    status === 401 || status === 403
      ? "auth"
      : status === 404 || status === 405 || status === 501
        ? "unsupported"
        : status === 429
          ? "rate-limit"
          : "unreachable";
  const message =
    kind === "auth"
      ? "The endpoint rejected authentication. Check the API key or access permissions; manual model setup remains available."
      : kind === "unsupported"
        ? "This endpoint does not provide a supported model catalogue. Enter exact model IDs manually."
        : kind === "rate-limit"
          ? "The provider limited catalogue requests. Retry later; saved models are unchanged."
          : "The catalogue request failed. Check the endpoint and retry; saved models are unchanged.";
  return new CatalogueError(kind, message, status);
}
async function boundedJson(res: Response): Promise<Record<string, any>> {
  if (!res.ok) {
    await res.body?.cancel();
    throw statusError(res.status);
  }
  const reader = res.body?.getReader();
  if (!reader)
    throw new CatalogueError(
      "malformed",
      "The endpoint returned no catalogue document. Manual model entry remains available.",
    );
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) {
        await reader.cancel();
        throw new CatalogueError(
          "malformed",
          "The catalogue response exceeded the safe size limit. Use manual model entry or a narrower endpoint.",
        );
      }
      chunks.push(value);
    }
    const obj = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw Error();
    return obj;
  } catch (e) {
    if (e instanceof CatalogueError) throw e;
    throw new CatalogueError(
      "malformed",
      "The endpoint returned an unreadable model catalogue. Enter model IDs manually or retry later.",
    );
  } finally {
    reader.releaseLock();
  }
}
/** Every URL is constructed from the approved endpoint; provider-supplied URLs are never followed. */
export async function discoverCatalogue(
  c: ProviderConnection,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ListModelsResponse> {
  let hash: string | undefined, version: number | undefined;
  let cached: ModelCatalogue | undefined,
    source: ModelCatalogue["source"] = "compatible";
  const models = new Map<string, CatalogueModel>();
  const guard = new RequestGuard(options.signal, options.timeoutMs ?? 30_000);
  try {
    validateProviderEndpoint(c);
    if (c.presetId && c.provider !== "openai-compatible")
      throw new BadRequestError(
        "LM Studio requires its compatible provider preset.",
      );
    if (c.provider === "mock" || c.provider === "azure-openai")
      return {
        models: [],
        unsupported: true,
        errorCode: "unsupported",
        error:
          c.provider === "mock"
            ? "Offline demo is built in and has no provider catalogue."
            : "Azure catalogue base models do not identify your deployments. Add exact deployment names from your Azure resource manually.",
      };
    const auth = identity(c);
    hash = auth.hash;
    version = ++ticket;
    // Registration and atomic cache publication share a queue: a newer claim cannot
    // interleave between an older writer's ownership check and its rename.
    const register = writes.then(() => {
      latest.set(hash!, version!);
    });
    writes = register.catch(() => {});
    await register;
    cached = (await readCache())[hash];
    if (PROVIDER_PRESETS[c.provider].apiKeyRequired && !auth.key)
      throw new CatalogueError(
        "auth",
        "Enter an API key before finding models. You can still save the account and enter model IDs manually.",
      );
    const runtime: LLMConnection = { ...c, model: "catalogue-only" };
    const request = providerFetch(runtime, auth.key);
    const base = providerEndpoint(c).replace(/\/+$/, "");
    const get = (url: string) =>
      request(url, {
        method: "GET",
        signal: guard.signal,
        headers:
          c.provider === "anthropic"
            ? { "anthropic-version": "2023-06-01" }
            : {},
      }).then(boundedJson);
    const add = (raw: unknown) => {
      const m = cleanCatalogueModel(raw);
      if (!m)
        throw new CatalogueError(
          "malformed",
          "The catalogue contains an invalid or unsafe model record. Existing saved models are unchanged.",
        );
      if (!models.has(m.id) && models.size >= CATALOGUE_MAX_MODELS)
        throw new CatalogueError(
          "partial",
          "The catalogue reached its safe model limit. Showing a partial result or the last saved catalogue.",
        );
      const prior = models.get(m.id);
      models.set(m.id, {
        ...prior,
        ...m,
        ...(prior?.reported || m.reported
          ? { reported: { ...prior?.reported, ...m.reported } }
          : {}),
      });
    };
    const rows = (obj: Record<string, any>, key: string): any[] => {
      if (!Array.isArray(obj[key]))
        throw new CatalogueError(
          "malformed",
          "The endpoint did not return the expected model list. Use manual model entry or check the endpoint.",
        );
      return obj[key];
    };
    if (c.provider === "ollama") {
      source = "ollama";
      for (const m of rows(
        await get(base.replace(/\/(api|v1)$/i, "") + "/api/tags"),
        "models",
      ))
        add({ id: m?.name ?? m?.model });
    } else if (c.presetId === "lm-studio") {
      const root = base.replace(/\/v1$/i, "");
      let body: Record<string, any> | undefined;
      for (const [url, kind] of [
        [root + "/api/v1/models", "lm-studio-v1"],
        [root + "/api/v0/models", "lm-studio-v0"],
        [base + "/models", "compatible"],
      ] as const) {
        try {
          body = await get(url);
          source = kind;
          break;
        } catch (e) {
          if (
            !(e instanceof CatalogueError) ||
            e.kind !== "unsupported" ||
            kind === "compatible"
          )
            throw e;
        }
      }
      for (const m of rows(
        body!,
        source === "lm-studio-v1" ? "models" : "data",
      )) {
        if (["embedding", "embeddings", "decision"].includes(m?.type)) continue;
        if (source === "lm-studio-v1")
          add({
            id: m?.key,
            label: m?.display_name,
            reported: {
              vision: m?.capabilities?.vision,
              contextWindow: m?.max_context_length,
              loaded: Array.isArray(m?.loaded_instances)
                ? m.loaded_instances.length > 0
                : undefined,
            },
          });
        else if (source === "lm-studio-v0")
          add({
            id: m?.id,
            reported: {
              vision: m?.type === "vlm" ? true : undefined,
              contextWindow: m?.max_context_length,
              loaded:
                typeof m?.state === "string" ? m.state === "loaded" : undefined,
            },
          });
        else add({ id: m?.id });
      }
    } else {
      source = c.provider === "openai-compatible" ? "compatible" : c.provider;
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < CATALOGUE_MAX_PAGES; page++) {
        const url = new URL(
          c.provider === "gemini"
            ? base + "/v1beta/models"
            : c.provider === "anthropic"
              ? base.replace(/\/v1$/, "") + "/v1/models"
              : base + "/models",
        );
        if (c.provider === "gemini") {
          url.searchParams.set("pageSize", "100");
          if (cursor) url.searchParams.set("pageToken", cursor);
        } else if (c.provider === "anthropic") {
          url.searchParams.set("limit", "100");
          if (cursor) url.searchParams.set("after_id", cursor);
        } else if (cursor) url.searchParams.set("after", cursor);
        const body = await get(url.href);
        if (
          (body.has_more !== undefined && typeof body.has_more !== "boolean") ||
          (body.nextPageToken !== undefined &&
            body.nextPageToken !== null &&
            typeof body.nextPageToken !== "string")
        )
          throw new CatalogueError(
            "malformed",
            "The catalogue pagination metadata is invalid. Use manual model entry or retry later.",
          );
        // Protobuf JSON may omit an empty repeated field on a valid Gemini page.
        const list =
          c.provider === "gemini" &&
          body.models === undefined &&
          Object.keys(body).every((k) => k === "nextPageToken")
            ? []
            : rows(body, c.provider === "gemini" ? "models" : "data");
        for (const m of list) {
          if (c.provider === "gemini") {
            if (!Array.isArray(m?.supportedGenerationMethods))
              throw new CatalogueError(
                "malformed",
                "Generation support is missing from the Gemini catalogue. Manual model entry remains available.",
              );
            if (!m.supportedGenerationMethods.includes("generateContent"))
              continue;
            add({
              id:
                typeof m.name === "string"
                  ? m.name.replace(/^models\//, "")
                  : undefined,
              label: m.displayName,
              reported: {
                inputTokenLimit: m.inputTokenLimit,
                outputTokenLimit: m.outputTokenLimit,
              },
            });
          } else if (c.provider === "anthropic")
            add({
              id: m?.id,
              label: m?.display_name,
              reported: {
                vision: m?.capabilities?.image_input?.supported,
                inputTokenLimit: m?.max_input_tokens,
              },
            });
          else
            add({
              id: m?.id,
              reported:
                c.provider === "openai-compatible"
                  ? {
                      // OpenRouter's documented allow-listed fields; URLs/routing/pricing are never imported.
                      contextWindow: smallestCapacity(
                        m?.top_provider?.context_length,
                        m?.context_length,
                      ),
                      outputTokenLimit: m?.top_provider?.max_completion_tokens,
                      vision: Array.isArray(m?.architecture?.input_modalities)
                        ? m.architecture.input_modalities.includes("image")
                        : undefined,
                      supportedParameters: m?.supported_parameters,
                      reasoning:
                        m?.reasoning && typeof m.reasoning === "object"
                          ? {
                              mandatory: m.reasoning.mandatory,
                              supportedEfforts: m.reasoning.supported_efforts,
                            }
                          : undefined,
                    }
                  : undefined,
            });
        }
        const next =
          c.provider === "gemini"
            ? body.nextPageToken
            : body.has_more === true
              ? (body.last_id ?? list.at(-1)?.id)
              : undefined;
        if (!next) {
          if (body.has_more === true)
            throw new CatalogueError(
              "partial",
              "The provider reported more models without a continuation cursor. Showing a partial result or the last saved catalogue.",
            );
          break;
        }
        if (typeof next !== "string" || next.length > 2000 || seen.has(next))
          throw new CatalogueError(
            "partial",
            "Catalogue pagination could not complete safely. Showing a partial result or the last saved catalogue.",
          );
        if (
          page === CATALOGUE_MAX_PAGES - 1 ||
          models.size >= CATALOGUE_MAX_MODELS
        )
          throw new CatalogueError(
            "partial",
            "The catalogue reached its safe page/model limit. Refine the endpoint or enter additional IDs manually.",
          );
        seen.add(next);
        cursor = next;
      }
    }
    const snapshot: ModelCatalogue = {
      models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)),
      refreshedAt: new Date().toISOString(),
      source,
      complete: true,
    };
    if (latest.get(hash) !== version)
      throw new CatalogueError(
        "superseded",
        "A newer catalogue request replaced this result. Refresh again if needed.",
      );
    const saved = await cacheSnapshot(hash, snapshot, version);
    if (!saved)
      throw new CatalogueError(
        "superseded",
        "A newer catalogue request replaced this result. Refresh again if needed.",
      );
    return { models: snapshot.models, catalogue: snapshot, cached: false };
  } catch (e) {
    const failure = guard.timedOut
      ? new CatalogueError(
          "timeout",
          "The catalogue request timed out. Check that the server is running, or enter model IDs manually.",
        )
      : e instanceof CatalogueError
        ? e
        : e instanceof BadRequestError
          ? new CatalogueError("policy", e.message)
          : new CatalogueError(
              "unreachable",
              "The model catalogue could not be reached. Check the server address and retry; manual model entry remains available.",
            );
    const partial: ModelCatalogue | undefined = models.size
      ? {
          models: [...models.values()],
          source,
          refreshedAt: new Date().toISOString(),
          complete: false,
        }
      : undefined;
    return {
      models: cached?.models ?? partial?.models ?? [],
      catalogue: cached ?? partial,
      cached: !!cached,
      partial: !!partial,
      unsupported: failure.kind === "unsupported",
      errorCode: failure.kind,
      error: failure.message,
    };
  } finally {
    guard.dispose();
    if (hash && latest.get(hash) === version) latest.delete(hash);
  }
}
