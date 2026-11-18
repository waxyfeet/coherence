import type {
  Job,
  JobFailure,
  JobFailureAction,
  JobFailureKind,
  JobKind,
} from "@shared/types";
import { safeDiagnosticValue } from "./diagnostics";

// Version 1 preserved export results wholesale, including historical service failure prose.
export const JOB_DIAGNOSTICS_VERSION = 2;
const HISTORICAL_EXPORT_ERROR =
  "Earlier export failure details were removed for privacy. Reconcile the recorded outcome before retrying.";
const EXPORT_ERROR =
  "Export failed. Review the connection settings and recorded outcome before retrying.";
const EXPORT_CATEGORIES = [
  "Export authorization failed. Check the tracker credentials and permissions.",
  "Export rate limited. Wait before retrying and reconcile the recorded outcome.",
  "Export outcome is uncertain. Reconcile the recorded operation before retrying.",
  "Export secure connection failed. Check the endpoint and certificate configuration.",
  "Export dependency or project item is unavailable. Review the selected items.",
];

/** Return only fixed categories, never an excerpt from a tracker/gateway response. */
function exportError(value: unknown, historical: boolean): string {
  if (historical || value === HISTORICAL_EXPORT_ERROR)
    return HISTORICAL_EXPORT_ERROR;
  if (typeof value !== "string") return EXPORT_ERROR;
  if (EXPORT_CATEGORIES.includes(value)) return value;
  if (
    /HTTP (?:401|403)\b|rejected the credentials|permission denied/i.test(value)
  )
    return EXPORT_CATEGORIES[0];
  if (/HTTP 429\b|rate limit/i.test(value)) return EXPORT_CATEGORIES[1];
  if (/uncertain|reconcile/i.test(value)) return EXPORT_CATEGORIES[2];
  if (/TLS|certificate/i.test(value)) return EXPORT_CATEGORIES[3];
  if (/not exported|no longer exists|not in the model/i.test(value))
    return EXPORT_CATEGORIES[4];
  return EXPORT_ERROR;
}

function exportEntries(value: unknown, historical: boolean): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || !("error" in entry))
      return entry;
    const { error, ...domain } = entry;
    return {
      ...domain,
      ...(error === undefined ? {} : { error: exportError(error, historical) }),
    };
  });
}

/** Export results mix domain records with diagnostics; revision Markdown is never processed here. */
export function safeJobResult(
  kind: JobKind,
  result: unknown,
  historical = false,
): unknown {
  const copy = structuredClone(result);
  if (kind !== "export" || !copy || typeof copy !== "object") return copy;
  const exported = copy as Record<string, unknown>;
  for (const field of ["items", "parents", "links"])
    if (field in exported)
      exported[field] = exportEntries(exported[field], historical);
  return exported;
}

// Records keep only the categories this build knows; a failure from elsewhere is dropped, not guessed at.
const FAILURE_KINDS: Record<JobFailureKind, true> = {
  "no-key": true,
  "key-refused": true,
  "access-refused": true,
  "model-not-found": true,
  "rate-limited": true,
  quota: true,
  "cannot-read-images": true,
  "too-large": true,
  declined: true,
  timeout: true,
  unreachable: true,
  "service-error": true,
  "request-rejected": true,
  other: true,
};
const FAILURE_ACTIONS: Record<JobFailureAction, true> = {
  "try-again": true,
  "change-model": true,
  "fix-connection": true,
  wait: true,
};

function safeFailure(value: unknown): JobFailure | undefined {
  if (!value || typeof value !== "object") return undefined;
  const f = value as Record<string, unknown>;
  const text = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() ? v.slice(0, max) : undefined;
  const message = text(f.message, 600);
  if (
    typeof f.kind !== "string" ||
    !Object.hasOwn(FAILURE_KINDS, f.kind) ||
    typeof f.action !== "string" ||
    !Object.hasOwn(FAILURE_ACTIONS, f.action) ||
    !message
  )
    return undefined;
  const connectionId = text(f.connectionId, 200);
  const connectionName = text(f.connectionName, 200);
  const model = text(f.model, 300);
  const resetAt =
    typeof f.resetAt === "string" && Number.isFinite(Date.parse(f.resetAt))
      ? new Date(f.resetAt).toISOString()
      : undefined;
  return {
    kind: f.kind as JobFailureKind,
    action: f.action as JobFailureAction,
    message,
    ...(connectionId ? { connectionId } : {}),
    ...(connectionName ? { connectionName } : {}),
    ...(model ? { model } : {}),
    ...(resetAt ? { resetAt } : {}),
  };
}

/** Old diagnostic prose can echo arbitrary project text/retired keys: no regex can certify it safe. */
export function safeJobDiagnostics(job: Job): Job {
  const { result, ...metadata } = structuredClone(job);
  const allowed = new Set([
    "diagnosticsVersion",
    "eventSequence",
    "id",
    "kind",
    "projectId",
    "status",
    "progress",
    "logs",
    "usage",
    "error",
    "failure",
    "createdAt",
    "startedAt",
    "finishedAt",
  ]);
  for (const key of Object.keys(metadata))
    if (!allowed.has(key))
      delete (metadata as unknown as Record<string, unknown>)[key];
  const { stage, stageIndex, stageCount, current, total, label } =
    metadata.progress;
  metadata.progress = { stage, stageIndex, stageCount, current, total, label };
  const {
    calls,
    inputTokens,
    outputTokens,
    costUsd,
    estimateSource,
    pricingAsOf,
  } = metadata.usage;
  metadata.usage = {
    calls,
    inputTokens,
    outputTokens,
    costUsd,
    estimateSource,
    pricingAsOf,
  };
  // Version 1 already removed old top-level prose. Retain its useful sanitized diagnostics.
  if (
    metadata.diagnosticsVersion !== 1 &&
    metadata.diagnosticsVersion !== JOB_DIAGNOSTICS_VERSION
  ) {
    metadata.logs = [];
    metadata.progress = {
      ...metadata.progress,
      stage: "Earlier operation",
      label: undefined,
    };
    if (metadata.error)
      metadata.error =
        "Earlier failure details were removed for privacy. Review the saved outputs before retrying.";
  }
  const failure =
    metadata.diagnosticsVersion === JOB_DIAGNOSTICS_VERSION
      ? safeFailure(metadata.failure)
      : undefined;
  if (failure) metadata.failure = failure;
  else delete metadata.failure;
  metadata.diagnosticsVersion = JOB_DIAGNOSTICS_VERSION;
  return {
    ...(safeDiagnosticValue(metadata) as Job),
    // R1: a domain artifact must remain complete and identical to the canonical reviewed proposal.
    ...(result === undefined
      ? {}
      : {
          result: safeJobResult(
            job.kind,
            result,
            job.diagnosticsVersion !== JOB_DIAGNOSTICS_VERSION,
          ),
        }),
  };
}

export function safeJournalDiagnostics<
  T extends { diagnosticsVersion?: number; operations: { error?: string }[] },
>(journal: T): T {
  const copy = structuredClone(journal);
  const allowed = new Set([
    "diagnosticsVersion",
    "id",
    "projectId",
    "jobId",
    "target",
    "targetFingerprint",
    "createdAt",
    "operations",
  ]);
  for (const key of Object.keys(copy))
    if (!allowed.has(key)) delete (copy as Record<string, unknown>)[key];
  for (const operation of copy.operations) {
    for (const key of Object.keys(operation))
      if (
        ![
          "key",
          "kind",
          "state",
          "startedAt",
          "finishedAt",
          "result",
          "error",
          "resolution",
        ].includes(key)
      )
        delete (operation as Record<string, unknown>)[key];
    // Link outcomes are also saved in the durable journal, independently of the job result.
    const typed = operation as typeof operation & {
      kind?: string;
      result?: unknown;
    };
    if (typed.kind === "links" && typed.result !== undefined)
      typed.result = exportEntries(
        typed.result,
        copy.diagnosticsVersion !== JOB_DIAGNOSTICS_VERSION,
      );
    if (operation.error !== undefined)
      operation.error = exportError(
        operation.error,
        copy.diagnosticsVersion !== JOB_DIAGNOSTICS_VERSION,
      );
  }
  copy.diagnosticsVersion = JOB_DIAGNOSTICS_VERSION;
  return copy;
}
