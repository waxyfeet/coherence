/** Explicit, bounded synthetic probes. No project content or provider response bodies are retained. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ProviderConnection } from "@shared/types";
import type {
  Capability,
  CapabilityRecord,
  CapabilityInventory,
  CapabilityTestResponse,
  StructuredTestMode,
} from "@shared/modelCapabilities";
import {
  CAPABILITY_TEST_VERSION,
  capabilityRecordSchema as recordSchema,
} from "@shared/modelCapabilities";
import { validModelId } from "@shared/modelSelection";
import { config } from "../config";
import { assertV2Path } from "../storage/boundary";
import { PRIVATE_FILE_MODE, writeJsonAtomic } from "../storage/fsUtils";
import {
  providerEndpoint,
  providerFetch,
  validateProviderEndpoint,
} from "../security/endpointPolicy";
import { redactDiagnostic } from "../security/diagnostics";
import { BadRequestError } from "../errors";
import { ProviderError } from "./errors";
import { resolveApiKey, RequestGuard } from "./providers/common";
import { ollamaBaseUrl } from "./providers/ollama";
import { loadSharp } from "./sharpLoader";
import type { LLMRequest } from "./types";

const file = () =>
  assertV2Path(path.join(config.dataDir, "model-capability-tests.json"));
type Cache = Record<string, CapabilityRecord[]>;
let queue: Promise<unknown> = Promise.resolve(),
  sequence = 0,
  active = 0;
const latest = new Map<string, number>();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}
function identity(c: ProviderConnection, modelId: string) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        CAPABILITY_TEST_VERSION,
        c.id,
        c.provider,
        providerEndpoint(c).replace(/\/+$/, ""),
        c.presetId ?? "",
        resolveApiKey(c) ?? "",
        c.azureApiVersion ?? "",
        modelId,
        c.vision,
        c.structuredOutput,
        c.effort ?? "",
        c.temperature ?? null,
        c.maxOutputTokens ?? null,
        c.requestTimeoutSec,
      ]),
    )
    .digest("hex");
}
async function read(): Promise<Cache> {
  try {
    if (
      (await fs.lstat(file())).isSymbolicLink() ||
      (await fs.stat(file())).size > 2_000_000
    )
      return {};
    const value = JSON.parse(await fs.readFile(file(), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => /^[a-f0-9]{64}$/.test(k))
        .slice(-1000)
        .map(([k, v]) => [
          k,
          Array.isArray(v)
            ? v.slice(0, 5).flatMap((row) => {
                const p = recordSchema.safeParse(row);
                return p.success ? [p.data] : [];
              })
            : [],
        ]),
    );
  } catch {
    return {};
  }
}
/** Optional evidence never prevents opening projects; no network requests. */
export async function cachedCapabilities(
  c: ProviderConnection,
): Promise<CapabilityInventory> {
  if (c.provider === "mock") return {};
  try {
    const cache = await read();
    return Object.fromEntries(
      c.modelIds.map((id) => [id, cache[identity(c, id)] ?? []]),
    );
  } catch {
    return {};
  }
}
const fixedMessage: Record<CapabilityRecord["reason"], string> = {
  passed:
    "The selected model passed this small test. This does not certify arbitrary screenshots or requirements quality.",
  answer:
    "The answer did not match the synthetic test. Capability remains unknown; check the model and try again.",
  auth: "The API key or model access was rejected. Check the key and permissions, then try again.",
  unreachable:
    "The provider could not be reached. Check the address and that your local model server is running.",
  timeout:
    "The test timed out. Check the server and try again; this does not mean the capability is unsupported.",
  "rate-limit":
    "The request was rate-limited or the account has no available quota. Check usage and try later.",
  missing:
    "The model or Azure deployment was not found. Check the exact name and resource address.",
  unsupported:
    "This capability was explicitly reported as unsupported. Choose another model or test mode.",
  cancelled:
    "Test cancelled. No successful verification was recorded for this attempt.",
  unavailable:
    "Verification is unavailable here. Discovery and manual model entry remain available.",
  failed:
    "The test could not be completed. Check the connection and selected model, then try again. Capability remains unknown.",
};
function failure(
  err: unknown,
  capability: Capability,
  mode?: StructuredTestMode,
): CapabilityRecord["reason"] {
  if (!(err instanceof ProviderError)) return "failed";
  return (
    (
      {
        auth: "auth",
        forbidden: "auth",
        not_found: "missing",
        rate_limit: "rate-limit",
        quota: "rate-limit",
        timeout: "timeout",
        network: "unreachable",
        unreachable: "unreachable",
        image_unsupported: capability === "image" ? "unsupported" : "failed",
        format_unsupported:
          capability === "structured" &&
          mode === "native" &&
          err.definitiveCapability === "structured"
            ? "unsupported"
            : "failed",
      } as Record<string, CapabilityRecord["reason"]>
    )[err.failure] ?? "failed"
  );
}
/** Three broad colour panels; the text prompt contains no answer and arbitrary prose cannot pass. */
async function image() {
  const sharp = await loadSharp();
  const width = 192,
    height = 64,
    raw = Buffer.alloc(width * height * 3);
  const colors = [
    [245, 215, 20],
    [20, 60, 220],
    [20, 175, 50],
  ];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      raw.set(colors[Math.floor(x / 64)], offset);
    }
  return (
    await sharp(raw, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer()
  ).toString("base64");
}
async function ollamaMetadata(
  c: ProviderConnection,
  model: string,
  signal: AbortSignal,
) {
  const key = resolveApiKey(c);
  const response = await providerFetch({ ...c, model }, key)(
    ollamaBaseUrl(c.baseUrl) + "/api/show",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ model, verbose: false }),
      signal,
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderError("Model metadata unavailable", {
      failure:
        response.status === 401 || response.status === 403
          ? "auth"
          : response.status === 404
            ? "not_found"
            : "other",
    });
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error("No metadata");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const row = await reader.read();
      if (row.done) break;
      bytes += row.value.length;
      if (bytes > 1_000_000) throw Error("Metadata too large");
      chunks.push(row.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    !Array.isArray(payload.capabilities) ||
    !payload.capabilities.every((v: unknown) => typeof v === "string")
  )
    return undefined;
  const context = Object.entries(payload.model_info ?? {}).find(
    ([k, v]) =>
      k.endsWith(".context_length") &&
      typeof v === "number" &&
      Number.isSafeInteger(v) &&
      v > 0 &&
      v <= 1_000_000_000,
  )?.[1] as number | undefined;
  return {
    image: payload.capabilities.includes("vision"),
    text: payload.capabilities.includes("completion"),
    ...(payload.capabilities.includes("thinking") ? { reasoning: true } : {}),
    ...(context ? { contextWindow: context } : {}),
  };
}

export async function testModelCapability(
  c: ProviderConnection,
  modelId: string,
  capability: Capability,
  mode?: StructuredTestMode,
  signal?: AbortSignal,
): Promise<CapabilityTestResponse> {
  if (!validModelId(modelId) || redactDiagnostic(modelId) !== modelId)
    throw new BadRequestError(
      "Enter a safe exact model ID or deployment name.",
    );
  if (capability === "structured" && !mode)
    throw new BadRequestError("Choose native or prompt-and-validate testing.");
  if (capability !== "structured" && mode)
    throw new BadRequestError(
      "This test does not accept a structured-output mode.",
    );
  validateProviderEndpoint(c);
  const hash = identity(c, modelId),
    slot = hash + ":" + capability + ":" + (mode ?? "");
  const ticket = await serial(async () => {
    const n = ++sequence;
    latest.set(slot, n);
    return n;
  });
  const guard = new RequestGuard(
    signal,
    Math.min(c.requestTimeoutSec * 1000, 90_000),
  );
  // Hard deadline as well as adapter inactivity deadlines, including providers that keep streaming.
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(),
    Math.min(c.requestTimeoutSec * 1000, 90_000),
  );
  const combined = AbortSignal.any([guard.signal, deadline.signal]);
  let record: CapabilityRecord = {
    capability,
    mode,
    at: new Date().toISOString(),
    outcome: "failed",
    state: "unknown",
    reason: "failed",
  };
  let storageIssue = false,
    superseded = false;
  let persisted = false,
    entered = false;
  try {
    if (signal?.aborted) throw Error("Cancelled");
    if (
      c.provider === "mock" ||
      (capability === "metadata" && c.provider !== "ollama") ||
      active >= 4
    ) {
      record = { ...record, outcome: "unavailable", reason: "unavailable" };
    } else {
      active++;
      entered = true;
      if (capability === "metadata") {
        const reported = await ollamaMetadata(c, modelId, combined);
        record = reported
          ? {
              ...record,
              state: "provider-reported",
              outcome: "passed",
              reason: "passed",
              reported,
            }
          : { ...record, outcome: "unavailable", reason: "unavailable" };
      } else {
        const { instantiateProvider } = await import("./registry");
        const { cachedCatalogue } = await import("./catalogue");
        const facts = (await cachedCatalogue(c))?.models.find(
          (m) => m.id === modelId,
        )?.reported;
        const provider = instantiateProvider({
          ...c,
          model: modelId,
          modelReasoning: facts?.reasoning
            ? { ...facts.reasoning, automaticExtraction: false }
            : undefined,
          vision: capability === "image" ? "yes" : "no",
          refusalFallback: false,
          requestTimeoutSec: Math.min(c.requestTimeoutSec, 90),
          structuredOutput: mode === "native" ? "native" : c.structuredOutput,
        });
        const schema = {
          type: "object",
          properties: {
            status: { type: "string", enum: ["ready"] },
            count: { type: "integer", enum: [3] },
          },
          required: ["status", "count"],
          additionalProperties: false,
        };
        const request: LLMRequest = {
          system:
            "Follow the small synthetic test instruction exactly. Do not add explanations.",
          messages: [
            {
              role: "user",
              content: [
                ...(capability === "image"
                  ? [
                      {
                        type: "image" as const,
                        image: {
                          mimeType: "image/png" as const,
                          base64: await image(),
                        },
                      },
                    ]
                  : []),
                {
                  type: "text",
                  text:
                    capability === "image"
                      ? "Name the three broad colour panels from left to right. Reply with exactly three English colour words separated by spaces, nothing else."
                      : capability === "structured"
                        ? 'Return only the JSON object with status equal to "ready" and count equal to 3. No extra fields.'
                        : "Reply with exactly the word OK, nothing else.",
                },
              ],
            },
          ],
          maxOutputTokens: Math.min(c.maxOutputTokens ?? 1024, 4096),
          signal: combined,
          purpose: `capability-test:${capability}:${mode ?? "single"}`,
          ...(capability === "structured" && mode === "native"
            ? { jsonSchema: { name: "screenscribe_capability", schema } }
            : {}),
        };
        const response = await provider.complete(request);
        let matches = false;
        if (response.stopReason === "end") {
          if (capability === "text")
            matches = /^OK[.!]?$/i.test(response.text.trim());
          else if (capability === "image")
            matches =
              response.text.trim().toLowerCase() === "yellow blue green";
          else {
            try {
              matches = z
                .object({ status: z.literal("ready"), count: z.literal(3) })
                .strict()
                .safeParse(JSON.parse(response.text)).success;
            } catch {
              /* Invalid JSON is not evidence. */
            }
          }
        }
        record = {
          ...record,
          state: matches ? "tested" : "unknown",
          outcome: matches ? "passed" : "failed",
          reason: matches ? "passed" : "answer",
          ...(matches && response.acceptedControls?.length
            ? { controls: response.acceptedControls }
            : {}),
        };
      }
    }
  } catch (err) {
    const reason = signal?.aborted
      ? "cancelled"
      : guard.timedOut || deadline.signal.aborted
        ? "timeout"
        : failure(err, capability, mode);
    record = {
      ...record,
      reason,
      outcome: reason === "cancelled" ? "cancelled" : "failed",
      state: reason === "unsupported" ? "unsupported" : "unknown",
    };
  } finally {
    clearTimeout(timer);
    guard.dispose();
    if (entered) active--;
  }
  let records = [record];
  try {
    await serial(async () => {
      if (latest.get(slot) !== ticket) {
        superseded = true;
        return;
      }
      if (signal?.aborted)
        record = {
          ...record,
          outcome: "cancelled",
          state: "unknown",
          reason: "cancelled",
          controls: undefined,
          reported: undefined,
        };
      const { getConnection } = await import("../storage/settingsStore");
      const stored = await getConnection(c.id).catch(() => undefined);
      if (
        !stored ||
        !stored.modelIds.includes(modelId) ||
        identity(stored, modelId) !== hash
      ) {
        records = [record];
        return;
      }
      const cache = await read();
      records = [
        record,
        ...(cache[hash] ?? []).filter(
          (r) => r.capability !== capability || r.mode !== mode,
        ),
      ].slice(0, 5);
      delete cache[hash];
      cache[hash] = records;
      const entries = Object.entries(cache).slice(-1000);
      while (
        Buffer.byteLength(JSON.stringify(Object.fromEntries(entries)), "utf8") >
          1_800_000 &&
        entries.length > 1
      )
        entries.shift();
      await writeJsonAtomic(
        file(),
        Object.fromEntries(entries),
        PRIVATE_FILE_MODE,
      );
      persisted = true;
    });
  } catch {
    storageIssue = true;
    /* Evidence persistence is optional; never expose filesystem/provider details. */
  } finally {
    if (latest.get(slot) === ticket) latest.delete(slot);
  }
  if (superseded)
    records = [
      (record = {
        ...record,
        state: "unknown",
        outcome: "unavailable",
        reason: "unavailable",
      }),
    ];
  return {
    ok: record.outcome === "passed",
    provider: c.provider,
    connectionId: c.id,
    modelId,
    record,
    records,
    persisted,
    message:
      (capability === "metadata" && record.outcome === "passed"
        ? "Provider-reported model information retrieved. No inference was performed; this is not a successful model test."
        : capability === "structured" && record.outcome === "passed"
          ? mode === "native"
            ? "The native schema request was accepted and its small JSON response validated. This is a sample compatibility check, not comprehensive schema certification."
            : "The prompt-and-validate sample passed. Native schema support was not tested by this action."
          : fixedMessage[record.reason]) +
      (storageIssue
        ? " Verification could not be retained locally. Check local folder access before relying on saved evidence."
        : record.outcome === "passed" && !persisted
          ? " Save this exact account/model and test again to retain verification after closing Settings."
          : ""),
  };
}
