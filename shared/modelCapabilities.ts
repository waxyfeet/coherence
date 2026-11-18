import { z } from "zod";
import type { CatalogueModel } from "./modelCatalogue";
import { effectiveModelFacts } from "./modelFacts";

export type Capability = "text" | "image" | "structured" | "metadata";
export type EvidenceState =
  "unknown" | "provider-reported" | "tested" | "unsupported";
export type StructuredTestMode = "native" | "prompt";
export const CAPABILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Version 1 could attach an image/schema rejection to an unrelated capability.
// Those summaries cannot distinguish the original cause; require explicit retesting.
export const CAPABILITY_TEST_VERSION = 2;
export interface CapabilityRecord {
  capability: Capability;
  mode?: StructuredTestMode;
  at: string;
  outcome: "passed" | "failed" | "cancelled" | "unavailable";
  state: EvidenceState;
  reason:
    | "passed"
    | "answer"
    | "auth"
    | "unreachable"
    | "timeout"
    | "rate-limit"
    | "missing"
    | "unsupported"
    | "cancelled"
    | "unavailable"
    | "failed";
  controls?: ("temperature" | "reasoning-effort")[];
  reported?: {
    image?: boolean;
    text?: boolean;
    reasoning?: boolean;
    contextWindow?: number;
  };
}
export type CapabilityInventory = Record<string, CapabilityRecord[]>;
/** The same allow-list guards persisted summaries and presentation inputs. */
export const capabilityRecordSchema = z
  .object({
    capability: z.enum(["text", "image", "structured", "metadata"]),
    mode: z.enum(["native", "prompt"]).optional(),
    at: z.iso.datetime(),
    outcome: z.enum(["passed", "failed", "cancelled", "unavailable"]),
    state: z.enum(["unknown", "provider-reported", "tested", "unsupported"]),
    reason: z.enum([
      "passed",
      "answer",
      "auth",
      "unreachable",
      "timeout",
      "rate-limit",
      "missing",
      "unsupported",
      "cancelled",
      "unavailable",
      "failed",
    ]),
    controls: z
      .array(z.enum(["temperature", "reasoning-effort"]))
      .max(2)
      .optional(),
    reported: z
      .object({
        image: z.boolean().optional(),
        text: z.boolean().optional(),
        reasoning: z.boolean().optional(),
        contextWindow: z
          .number()
          .int()
          .positive()
          .max(1_000_000_000)
          .optional(),
      })
      .optional(),
  })
  .refine(
    (r) =>
      (r.capability === "structured") === !!r.mode &&
      (r.state !== "tested" ||
        (r.outcome === "passed" && r.capability !== "metadata")) &&
      (r.state !== "provider-reported" ||
        (r.outcome === "passed" &&
          r.capability === "metadata" &&
          !!r.reported)) &&
      (r.state !== "unsupported" || r.outcome === "failed"),
  );
const recordsSchema = z.array(capabilityRecordSchema).max(5);
function validatedRecords(value: unknown): CapabilityRecord[] {
  const parsed = recordsSchema.safeParse(value);
  // A malformed newest result must not resurrect an older successful test.
  return parsed.success ? parsed.data : [];
}
/** Exact IDs are data, including constructor/__proto__; never read the prototype. */
export function capabilityRecords(
  inventory: unknown,
  modelId: string,
): CapabilityRecord[] {
  if (
    !inventory ||
    typeof inventory !== "object" ||
    !Object.hasOwn(inventory, modelId)
  )
    return [];
  return validatedRecords((inventory as Record<string, unknown>)[modelId]);
}
export interface Evidence {
  state: EvidenceState;
  at?: string;
  stale?: boolean;
  outcome?: CapabilityRecord["outcome"];
}
export function currentEvidence(value?: unknown, now = Date.now()): Evidence {
  const parsed = capabilityRecordSchema.safeParse(value);
  if (!parsed.success) return { state: "unknown" };
  const record = parsed.data;
  const age = now - Date.parse(record.at);
  const stale =
    !Number.isFinite(age) || age < -60_000 || age > CAPABILITY_TTL_MS;
  return {
    state: stale ? "unknown" : record.state,
    at: record.at,
    stale,
    outcome: record.outcome,
  };
}
/** Inputs are already bound to the effective configuration by the server. Names never imply support. */
export function modelEvidence(value?: unknown, catalogue?: CatalogueModel) {
  const records = validatedRecords(value);
  const latest = (capability: Capability, mode?: StructuredTestMode) =>
    records.find((r) => r.capability === capability && r.mode === mode);
  const metadata = latest("metadata");
  const freshMetadata =
    currentEvidence(metadata).state === "provider-reported"
      ? metadata?.reported
      : undefined;
  const reported = (value?: boolean): Evidence => ({
    state:
      value === undefined
        ? "unknown"
        : value
          ? "provider-reported"
          : "unsupported",
  });
  const dimension = (capability: Capability, fallback: Evidence): Evidence => {
    const r = latest(capability);
    const e = currentEvidence(r);
    // A failed test invalidates older success; ordinary failures do not prove unsupported.
    return r ? e : fallback;
  };
  const text = dimension("text", reported(freshMetadata?.text));
  let image = dimension(
    "image",
    reported(freshMetadata?.image ?? catalogue?.reported?.vision),
  );
  // An explicit negative catalogue remains reliable even after an ambiguous inference failure.
  if (
    image.state === "unknown" &&
    (freshMetadata?.image ?? catalogue?.reported?.vision) === false
  )
    image = { ...image, state: "unsupported" };
  const controls = records
    .filter(
      (r) => r.outcome === "passed" && currentEvidence(r).state === "tested",
    )
    .flatMap((r) => r.controls ?? []);
  return {
    text,
    image,
    nativeStructured: currentEvidence(latest("structured", "native")),
    promptStructured: currentEvidence(latest("structured", "prompt")),
    reasoning: controls.includes("reasoning-effort")
      ? { state: "tested" as const }
      : reported(freshMetadata?.reasoning),
    sampling: {
      state: controls.includes("temperature")
        ? ("tested" as const)
        : ("unknown" as const),
    },
    contextWindow:
      freshMetadata?.contextWindow ?? catalogue?.reported?.contextWindow,
  };
}
export const evidenceLabel = (e: Evidence) =>
  e.stale
    ? "Unknown · previous test expired"
    : {
        unknown: "Unknown",
        "provider-reported": "Provider-reported",
        tested: "Tested",
        unsupported: "Unsupported",
      }[e.state];

/** The same exact account/model facts drive setup, preflight and inference. No requests. */
export function modelEvidenceForConnection(
  account:
    | {
        provider: string;
        endpoint?: string;
        baseUrl?: string;
        capabilities?: unknown;
        catalogue?: { models: CatalogueModel[] };
      }
    | undefined,
  modelId: string,
) {
  return modelEvidence(
    capabilityRecords(account?.capabilities, modelId),
    account
      ? effectiveModelFacts(
          account,
          modelId,
          account.catalogue?.models.find((m) => m.id === modelId),
        )
      : undefined,
  );
}
export interface CapabilityTestRequest {
  connectionId?: string;
  connection?: import("./api").ConnectionInput;
  modelId: string;
  capability: Capability;
  mode?: StructuredTestMode;
}
export interface CapabilityTestResponse {
  ok: boolean;
  provider: import("./types").ProviderKind;
  connectionId: string;
  modelId: string;
  record: CapabilityRecord;
  message: string;
  records?: CapabilityRecord[];
  persisted: boolean;
}
