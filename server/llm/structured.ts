/**
 * OWNER: llm builder.
 * The single entry point agents use to call an LLM. Handles: per-connection concurrency limiting,
 * zod → JSON Schema conversion (sanitised per provider), native schema mode vs prompt-and-validate,
 * JSON extraction from messy output, zod validation with a repair round-trip (max 2), retry with
 * exponential backoff + jitter for retryable errors (max 4 attempts, honours Retry-After),
 * max_tokens truncation handling, refusals, cancellation and usage accounting.
 * For provider 'mock' it returns opts.mock() (validated against the schema) without any network call.
 */
import type { z } from "zod";
import { documentedModelFacts } from "@shared/modelFacts";
import { estimateCostUsd } from "@shared/pricing";
import type { LLMConnection, LogLevel } from "@shared/types";
import { CancelledError, LLMError, errorMessage } from "../errors";
import { ModelDeclinedError, ProviderError, throwIfAborted } from "./errors";
import { extractJson } from "./json";
import { limiterFor } from "./limiter";
import { withOrigin } from "./origin";
import { beforeCall, noteRateLimit, rateLimitExhausted } from "./rateLimit";
import {
  connectionLabel,
  createProvider,
  providerFingerprint,
} from "./registry";
import { sleep, withRetry, type RetryPolicy } from "./retry";
import {
  dialectFor,
  safeSchemaName,
  schemaFor,
  type JsonSchema,
} from "./schema";
import {
  type BudgetReservation,
  CapacityError,
  fitRequest,
  RequestBudget,
} from "./capacity";
import type {
  LLMContentPart,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LiveCalls,
} from "./types";

export interface UsageReport {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  visibleOutputTokens?: number;
  /** From shared/pricing.ts estimateCostUsd; undefined when the model price is unknown. */
  costUsd?: number;
}

export interface CallOptionsBase {
  connection: LLMConnection;
  resources?: RequestBudget;
  system: string;
  /** The user turn: text and images. */
  content: LLMContentPart[];
  /** Short tag for logs, e.g. "screen-analysis:Login". */
  purpose: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  onUsage?: (usage: UsageReport) => void;
  log?: (level: LogLevel, message: string) => void;
  /** Live progress of each request (the activity panel). */
  live?: LiveCalls;
}

export interface StructuredCallOptions<T> extends CallOptionsBase {
  schema: z.ZodType<T>;
  /** [a-zA-Z0-9_-]+ */
  schemaName: string;
  /** Deterministic output for the offline 'mock' provider. Must satisfy `schema`. */
  mock: () => T;
}

/* ------------------------------------------------------------------ */
/* Runtime knobs                                                       */
/* ------------------------------------------------------------------ */

export interface LLMRuntimeConfig extends RetryPolicy {
  /** Validation repair turns per call. */
  maxRepairs: number;
  /** Ceiling for the doubled max_tokens after a truncated answer. */
  maxOutputTokensCap: number;
  /** Artificial latency per offline-demo call so progress is visible in the UI (0 under tests). */
  mockDelayMs: number;
}

function defaultMockDelay(): number {
  const fromEnv = Number(process.env.SCREENSCRIBE_V2_MOCK_DELAY_MS);
  if (
    Number.isFinite(fromEnv) &&
    process.env.SCREENSCRIBE_V2_MOCK_DELAY_MS !== undefined
  )
    return Math.max(0, fromEnv);
  return process.env.VITEST || process.env.NODE_ENV === "test" ? 0 : 250;
}

const runtime: LLMRuntimeConfig = {
  attempts: 4,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 120_000,
  maxRepairs: 2,
  maxOutputTokensCap: 64_000,
  mockDelayMs: defaultMockDelay(),
};

/** Adjust retry/backoff/mock timing (tests use tiny delays). Returns the previous values. */
export function configureLLMRuntime(
  patch: Partial<LLMRuntimeConfig>,
): LLMRuntimeConfig {
  const previous = { ...runtime };
  Object.assign(runtime, patch);
  return previous;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** A bounded starting allowance when capacity is unknown; never a claim about a model maximum. */
export function defaultMaxOutputTokens(connection: LLMConnection): number {
  if (connection.provider === "mock") return 0;
  const facts = documentedModelFacts(connection, connection.model);
  const known = connection.modelOutputTokenLimit ?? facts?.outputTokenLimit;
  return known && known > 0 ? Math.min(known, 32768) : 8192;
}

/** Model limits, deliberate account cap and application recovery guard remain separate. */
export function tokenBudget(
  connection: LLMConnection,
  requested?: number,
): { initial: number; ceiling: number } {
  const valid = (n?: number) => Number.isSafeInteger(n) && n! > 0;
  const configured = valid(connection.maxOutputTokens)
    ? connection.maxOutputTokens
    : undefined;
  const wanted = valid(requested)
    ? requested!
    : (configured ?? defaultMaxOutputTokens(connection));
  const facts = documentedModelFacts(connection, connection.model);
  const limits = [
    connection.modelOutputTokenLimit,
    facts?.outputTokenLimit,
  ].filter((n): n is number => valid(n));
  const modelLimit = limits.length ? Math.min(...limits) : Infinity;
  const ceiling = Math.min(
    configured ??
      (Number.isFinite(modelLimit) ? modelLimit : runtime.maxOutputTokensCap),
    modelLimit,
  );
  return { initial: Math.min(wanted, ceiling), ceiling };
}

/** Estimated USD for one response. Anthropic prompt-cache reads/writes are billed at 0.1× / 1.25×. */
export function usageReportFor(
  connection: LLMConnection,
  response: Pick<LLMResponse, "model" | "usage">,
): UsageReport {
  const { inputTokens, outputTokens } = response.usage;
  const cacheRead = response.usage.cacheReadInputTokens ?? 0;
  const cacheWrite = response.usage.cacheWriteInputTokens ?? 0;
  const billedInput =
    connection.provider === "anthropic"
      ? Math.max(0, inputTokens - cacheRead - cacheWrite) +
        cacheWrite * 1.25 +
        cacheRead * 0.1
      : inputTokens;
  const cost =
    estimateCostUsd(
      connection.provider,
      response.model || connection.model,
      billedInput,
      outputTokens,
      connection.baseUrl,
    ) ??
    (response.model && response.model !== connection.model
      ? estimateCostUsd(
          connection.provider,
          connection.model,
          billedInput,
          outputTokens,
          connection.baseUrl,
        )
      : undefined);
  return {
    inputTokens,
    outputTokens,
    costUsd: cost,
    ...(response.usage.reasoningTokens !== undefined
      ? { reasoningTokens: response.usage.reasoningTokens }
      : {}),
    ...(response.usage.visibleOutputTokens !== undefined
      ? { visibleOutputTokens: response.usage.visibleOutputTokens }
      : {}),
  };
}

/**
 * The budget reservations of one logical request. Each physical attempt (retries included) replaces them; only the
 * attempt that answered is settled with its usage, so failed attempts keep their full reservation.
 */
class AttemptReservations {
  private current: BudgetReservation[] = [];
  begin(...reservations: (BudgetReservation | undefined)[]): void {
    this.current = reservations.filter(
      (r): r is BudgetReservation => r !== undefined,
    );
  }
  settle(usage: { inputTokens: number; outputTokens: number }): void {
    for (const r of this.current) r.settle(usage);
    this.current = [];
  }
}

function emit(opts: CallOptionsBase, level: LogLevel, message: string): void {
  try {
    opts.log?.(level, message);
  } catch {
    // A failing logger must never break an LLM call.
  }
}

function reportUsage(opts: CallOptionsBase, usage: UsageReport): void {
  try {
    opts.onUsage?.(usage);
  } catch {
    // Same as above: accounting problems must not fail the call.
  }
}

/** Remove images when the connection cannot read them, rather than letting the provider fail. */
function contentFor(
  provider: LLMProvider,
  opts: CallOptionsBase,
): LLMContentPart[] {
  if (provider.supportsVision) return opts.content;
  const images = opts.content.filter((p) => p.type === "image").length;
  if (!images) return opts.content;
  emit(
    opts,
    "warn",
    `${opts.purpose}: ${connectionLabel(opts.connection)} cannot read images — sending text only (${images} image(s) left out).`,
  );
  return [
    ...opts.content.filter((p) => p.type === "text"),
    {
      type: "text",
      text: `(${images} image(s) were omitted because this model cannot read images.)`,
    },
  ];
}

function cancelledOr(err: unknown, signal: AbortSignal | undefined): unknown {
  if (err instanceof CancelledError || signal?.aborted)
    return err instanceof CancelledError ? err : new CancelledError();
  return err;
}

/**
 * One provider call: limiter slot → complete → usage + debug log, retried with backoff on
 * retryable errors. Non-LLM errors from adapters are wrapped so callers only ever see LLMError.
 */
async function callProvider(
  provider: LLMProvider,
  request: LLMRequest,
  opts: CallOptionsBase,
  mode: string,
): Promise<LLMResponse> {
  const limiter = limiterFor(opts.connection);
  const label = connectionLabel(opts.connection);
  return withRetry(
    async () => {
      try {
        return await limiter.run(async () => {
          throwIfAborted(opts.signal);
          // Inside the slot, so calls queued behind a rate-limited one see the limit too.
          await beforeCall(opts.connection, opts.signal, (ms) =>
            emit(
              opts,
              "debug",
              `${opts.purpose}: waiting ${Math.max(1, Math.round(ms / 1000))} s for ${label}'s rate limit.`,
            ),
          );
          const started = Date.now();
          const live = opts.live?.start(opts.purpose, opts.connection.model);
          let response: LLMResponse;
          try {
            response = await provider.complete(
              live
                ? { ...request, onStream: (delta) => live.stream(delta) }
                : request,
            );
          } catch (err) {
            // A failed attempt can still be billed (a stream stopped midway): count it.
            if (err instanceof ProviderError && err.partial)
              reportUsage(opts, usageReportFor(opts.connection, err.partial));
            // Shared before the slot is released, so the next queued call already sees the limit.
            throw shareRateLimit(err, opts, label);
          } finally {
            live?.end();
          }
          const usage = usageReportFor(opts.connection, response);
          reportUsage(opts, usage);
          emit(
            opts,
            "debug",
            `${opts.purpose}: ${label} (${mode}) → ${usage.inputTokens} in / ${usage.outputTokens} out tokens in ${Date.now() - started} ms, stop: ${response.stopReason}${usage.reasoningTokens !== undefined ? `; reasoning ${usage.reasoningTokens}` : ""}`,
          );
          return response;
        }, opts.signal);
      } catch (err) {
        const settled = cancelledOr(err, opts.signal);
        if (settled instanceof LLMError || settled instanceof CancelledError)
          throw settled;
        throw new LLMError(`${label} failed: ${errorMessage(settled)}`);
      }
    },
    runtime,
    {
      signal: opts.signal,
      onRetry: ({ attempt, attempts, delayMs, error }) =>
        emit(
          opts,
          "warn",
          `${opts.purpose}: ${error.message} — retrying in ${Math.max(1, Math.round(delayMs / 1000))} s (attempt ${attempt + 1} of ${attempts}).`,
        ),
    },
  ).catch((err: unknown) => {
    // Retries ran out on a rate limit: stop this model's other calls as well.
    if (
      err instanceof ProviderError &&
      err.failure === "rate_limit" &&
      err.retryable
    )
      throw rateLimitExhausted(opts.connection, err);
    throw err;
  });
}

/** A retryable 429: share its wait with the other calls of this connection and model (owner test note 5). */
function shareRateLimit(
  err: unknown,
  opts: CallOptionsBase,
  label: string,
): unknown {
  if (
    !(err instanceof ProviderError) ||
    err.failure !== "rate_limit" ||
    !err.retryable
  )
    return err;
  const note = noteRateLimit(opts.connection, err);
  if (note.started?.long)
    emit(
      opts,
      "warn",
      `${label} rate limit reached: pausing calls to ${opts.connection.model} until ${new Date(note.started.untilMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}. Completed work is kept.`,
    );
  return note.error;
}

function refusalError(opts: CallOptionsBase, response: LLMResponse): LLMError {
  const why = undefined; // Untrusted refusals may echo confidential request content.
  return new ModelDeclinedError(
    `The AI model (${connectionLabel(opts.connection)}) declined the "${opts.purpose}" request${why ? `: ${why}` : "."} ` +
      "Rephrase the project description or screen notes, or try another model.",
  );
}

function truncationError(
  opts: CallOptionsBase,
  maxTokens: number,
  configuredLimit: boolean,
): LLMError {
  return new CapacityError(
    "output",
    configuredLimit
      ? "The selected model could not finish this task within your saved output cap. Coherence kept completed readings and respected that cap. Review the connection limit or explicitly choose another model."
      : "The selected model could not finish this task within Coherence’s bounded automatic recovery. Completed readings are retained. Coherence will try smaller screen sections where possible; otherwise choose another model explicitly.",
  );
}

const OUTPUT_BUDGET_PARAM =
  /max_(?:completion_|output_)?tokens|maxOutputTokens|output tokens/i;
const OUTPUT_BUDGET_LIMIT =
  /too large|at most|maximum|exceed|greater than|supported range|less than or equal/i;

/**
 * The provider refused the requested output budget as more than the model (or its context) allows —
 * after a truncation retry this means the doubled budget, so the real problem is the cut-off answer.
 */
function rejectsOutputBudget(err: unknown): boolean {
  return (
    err instanceof ProviderError &&
    (err.providerStatus === 400 ||
      err.providerStatus === 413 ||
      err.providerStatus === 422) &&
    OUTPUT_BUDGET_PARAM.test(err.message) &&
    OUTPUT_BUDGET_LIMIT.test(err.message)
  );
}

/* ------------------------------------------------------------------ */
/* Structured output                                                   */
/* ------------------------------------------------------------------ */

type StructuredMode = "native" | "json" | "prompt";
const MODE_ORDER: StructuredMode[] = ["native", "json", "prompt"];

/** Per connection version: modes the endpoint rejected, so later calls skip straight to what works. */
const modeFloor = new Map<string, StructuredMode>();

function modeKey(connection: LLMConnection): string {
  return `${connection.id}|${providerFingerprint(connection)}`;
}

function chooseMode(
  provider: LLMProvider,
  connection: LLMConnection,
  schema: JsonSchema,
): StructuredMode {
  let mode: StructuredMode =
    connection.structuredOutput === "prompt" ||
    (connection.structuredOutput === "auto" &&
      connection.modelStructuredMode === "prompt")
      ? "prompt"
      : provider.supportsNativeSchema
        ? "native"
        : "json";
  // OpenAI strict mode needs an object at the root.
  if (
    mode === "native" &&
    dialectFor(connection.provider) === "openai" &&
    schema.type !== "object"
  )
    mode = "json";
  const floor = modeFloor.get(modeKey(connection));
  if (floor && MODE_ORDER.indexOf(floor) > MODE_ORDER.indexOf(mode))
    mode = floor;
  return mode;
}

function nextMode(from: StructuredMode): StructuredMode {
  return MODE_ORDER[
    Math.min(MODE_ORDER.indexOf(from) + 1, MODE_ORDER.length - 1)
  ];
}

function rememberFloor(connection: LLMConnection, mode: StructuredMode): void {
  const current = modeFloor.get(modeKey(connection));
  if (!current || MODE_ORDER.indexOf(mode) > MODE_ORDER.indexOf(current))
    modeFloor.set(modeKey(connection), mode);
}

/** System prompt suffix for prompt/JSON mode: the schema itself plus strict output instructions. */
export function promptModeInstructions(
  schemaName: string,
  schema: JsonSchema,
): string {
  return [
    "## Output format",
    "Respond with ONLY a JSON object that conforms to the JSON Schema below — no prose before or after it, no explanations and no markdown code fences.",
    'Use exactly the property names in the schema, include every required property, keep the value types exact, and use "" or [] when a value is unknown instead of leaving a property out.',
    "",
    `JSON Schema (${schemaName}):`,
    JSON.stringify(schema),
  ].join("\n");
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Recursively drop null-valued object keys (models often write null for "not applicable"). */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value))
      if (v !== null) out[key] = stripNulls(v);
    return out;
  }
  return value;
}

function formatIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length ? issue.path.map(String).join(".") : "(root)",
    message: issue.message,
  }));
}

export type ParseOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "json"; error: string }
  | { ok: false; kind: "schema"; issues: ValidationIssue[] };

/** Extract JSON from the model text and validate it (a second try with nulls removed). */
export function parseStructured<T>(
  text: string,
  schema: z.ZodType<T>,
): ParseOutcome<T> {
  const extracted = extractJson(text);
  if (!extracted.ok) return { ok: false, kind: "json", error: extracted.error };
  const first = schema.safeParse(extracted.value);
  if (first.success) return { ok: true, data: first.data };
  const second = schema.safeParse(stripNulls(extracted.value));
  if (second.success) return { ok: true, data: second.data };
  return { ok: false, kind: "schema", issues: formatIssues(first.error) };
}

const MAX_LISTED_ISSUES = 25;

function issueLines(issues: ValidationIssue[]): string[] {
  const lines = issues
    .slice(0, MAX_LISTED_ISSUES)
    .map((i) => `- ${i.path}: ${i.message}`);
  if (issues.length > MAX_LISTED_ISSUES)
    lines.push(
      `- … and ${issues.length - MAX_LISTED_ISSUES} more problems of the same kind`,
    );
  return lines;
}

/** The user turn sent back after an unusable answer. */
export function repairPrompt(
  outcome: Exclude<ParseOutcome<unknown>, { ok: true }>,
): string {
  const problem =
    outcome.kind === "json"
      ? [`Your previous answer was not a valid JSON object (${outcome.error}).`]
      : [
          "Your previous answer did not match the required JSON structure:",
          ...issueLines(outcome.issues),
        ];
  return [
    ...problem,
    "",
    "Reply again with the complete, corrected JSON object only — no prose, no code fences. Keep everything that was already correct.",
  ].join("\n");
}

function summariseFailure(
  outcome: Exclude<ParseOutcome<unknown>, { ok: true }>,
): string {
  if (outcome.kind === "json") return "the answer was not valid JSON";
  return `${outcome.issues.length} schema validation problem(s); response excerpts withheld`;
}

async function runMock<T>(opts: CallOptionsBase, produce: () => T): Promise<T> {
  throwIfAborted(opts.signal);
  await limiterFor(opts.connection).run(
    () => sleep(runtime.mockDelayMs, opts.signal),
    opts.signal,
  );
  const value = produce();
  reportUsage(opts, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
  emit(
    opts,
    "debug",
    `${opts.purpose}: ${connectionLabel(opts.connection)} (offline demo) → generated locally`,
  );
  return value;
}

/** Call the model and return a value validated against `schema`. @throws LLMError | CancelledError */
export async function generateStructured<T>(
  opts: StructuredCallOptions<T>,
): Promise<T> {
  try {
    return await structuredCall(opts);
  } catch (err) {
    throw withOrigin(err, opts.connection);
  }
}

async function structuredCall<T>(opts: StructuredCallOptions<T>): Promise<T> {
  throwIfAborted(opts.signal);
  const { connection } = opts;
  const schemaName = safeSchemaName(opts.schemaName);

  if (connection.provider === "mock") {
    const value = await runMock(opts, () => {
      try {
        return opts.mock();
      } catch (err) {
        throw new LLMError(
          `The offline demo generator for "${opts.purpose}" failed: ${errorMessage(err)}`,
        );
      }
    });
    const checked = opts.schema.safeParse(value);
    if (!checked.success) {
      const issues = formatIssues(checked.error)
        .slice(0, 8)
        .map((i) => `${i.path}: ${i.message}`)
        .join("; ");
      throw new LLMError(
        `The offline demo output for "${opts.purpose}" does not match the ${schemaName} schema: ${issues}`,
      );
    }
    return checked.data;
  }

  const provider = createProvider(connection);
  const dialect = dialectFor(connection.provider);
  const nativeSchema = schemaFor(opts.schema, dialect);
  const promptSchema = schemaFor(opts.schema, "prompt");
  const messages: LLMMessage[] = [
    { role: "user", content: contentFor(provider, opts) },
  ];
  const budget = tokenBudget(connection, opts.maxOutputTokens);
  let maxTokens = budget.initial;
  const attemptBudget = new RequestBudget({
    requests: 12,
    outputAllowance: Math.max(budget.ceiling * 4, budget.initial),
  });
  /** The budget that was cut off, until the doubled one has been accepted. */
  let budgetRaisedFrom: number | undefined;
  /** Fallback after a 400 that may not be about the format: remembered once the simpler mode worked. */
  let unconfirmedFloor: StructuredMode | undefined;
  let repairs = 0;
  let reductions = 0;
  let mode = chooseMode(provider, connection, nativeSchema);

  for (;;) {
    throwIfAborted(opts.signal);
    const reservations = new AttemptReservations();
    const request: LLMRequest = {
      system:
        mode === "native"
          ? opts.system
          : `${opts.system.trimEnd()}\n\n${promptModeInstructions(schemaName, promptSchema)}`,
      messages,
      maxOutputTokens: maxTokens,
      signal: opts.signal,
      purpose: opts.purpose,
      ...(mode === "native"
        ? { jsonSchema: { name: schemaName, schema: nativeSchema } }
        : {}),
      ...(mode === "json" ? { json: true } : {}),
      structuredTask: true,
      beforeAttempt: () => {
        throwIfAborted(opts.signal);
        reservations.begin(
          attemptBudget.admit(request.maxOutputTokens!, fit.input),
          opts.resources?.admit(request.maxOutputTokens!, fit.input),
        );
      },
    };
    const fit = fitRequest(connection, request);
    request.maxOutputTokens = Math.min(maxTokens, fit.output);
    emit(
      opts,
      "debug",
      `${opts.purpose}: allowance ${request.maxOutputTokens}, estimated input ${fit.input}; ${fit.source}; ${connection.maxOutputTokens ? "saved cap retained" : "automatic"}.`,
    );

    let response: LLMResponse;
    try {
      response = await callProvider(provider, request, opts, mode);
    } catch (err) {
      if (
        err instanceof ProviderError &&
        err.failure === "format_unsupported" &&
        mode !== "prompt"
      ) {
        const next = nextMode(mode);
        if (err.rememberFallback) rememberFloor(connection, next);
        else unconfirmedFloor = next;
        const scope = err.rememberFallback ? "this connection" : "this request";
        emit(
          opts,
          "warn",
          `${opts.purpose}: ${err.message} — switching to ${next === "json" ? "JSON mode" : "prompt-based JSON"} for ${scope}.`,
        );
        mode = next;
        continue;
      }
      if (budgetRaisedFrom !== undefined && rejectsOutputBudget(err))
        throw truncationError(opts, budgetRaisedFrom, false);
      if (rejectsOutputBudget(err) && reductions < 2 && maxTokens > 1) {
        reductions++;
        maxTokens = Math.max(1, Math.floor(maxTokens / 2));
        emit(
          opts,
          "info",
          `${opts.purpose}: adjusting the automatic request to the provider's capacity; the saved cap remains unchanged.`,
        );
        continue;
      }
      if (rejectsOutputBudget(err))
        throw new CapacityError(
          "output",
          "The provider could not accept this task's output allowance. Coherence will retain completed work and try smaller screen sections where possible.",
        );
      throw err;
    }
    reservations.settle(response.usage);
    budgetRaisedFrom = undefined;
    if (unconfirmedFloor) {
      rememberFloor(connection, unconfirmedFloor);
      unconfirmedFloor = undefined;
    }

    if (response.stopReason === "refusal") throw refusalError(opts, response);
    if (response.stopReason === "max_tokens") {
      if (
        request.maxOutputTokens! <
        fitRequest(connection, { ...request, maxOutputTokens: budget.ceiling })
          .output
      ) {
        budgetRaisedFrom = request.maxOutputTokens!;
        const next = Math.min(
          maxTokens * 2,
          fitRequest(connection, {
            ...request,
            maxOutputTokens: budget.ceiling,
          }).output,
        );
        emit(
          opts,
          "warn",
          `${opts.purpose}: the answer was cut off at ${request.maxOutputTokens} tokens — retrying with ${next}.`,
        );
        maxTokens = next;
        continue;
      }
      throw truncationError(
        opts,
        request.maxOutputTokens!,
        connection.maxOutputTokens !== undefined &&
          budget.ceiling === connection.maxOutputTokens &&
          request.maxOutputTokens! >= budget.ceiling,
      );
    }

    if (response.stopReason !== "end")
      throw new LLMError(
        "The provider did not confirm that this answer finished. Coherence did not accept it as a complete result. Completed readings are retained.",
      );
    const outcome = parseStructured(response.text, opts.schema);
    if (outcome.ok) return outcome.data;
    if (repairs >= runtime.maxRepairs) {
      throw new LLMError(
        `The AI answer for "${opts.purpose}" (${connectionLabel(connection)}) did not match the expected structure after ${repairs} correction attempt(s): ${summariseFailure(outcome)}. Try again or use a more capable model.`,
      );
    }
    repairs += 1;
    emit(
      opts,
      "warn",
      `${opts.purpose}: answer did not match the expected structure (${summariseFailure(outcome)}) — asking the model to correct it (${repairs} of ${runtime.maxRepairs}).`,
    );
    messages.splice(1);
    messages.push(
      {
        role: "assistant",
        content: [
          { type: "text", text: response.text.trim() || "(empty answer)" },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: repairPrompt(outcome) }],
      },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Plain text                                                          */
/* ------------------------------------------------------------------ */

export interface TextCallOptions extends CallOptionsBase {
  mock: () => string;
}

/** Plain-text completion (used rarely, e.g. summaries). @throws LLMError | CancelledError */
export async function generateText(opts: TextCallOptions): Promise<string> {
  try {
    return await textCall(opts);
  } catch (err) {
    throw withOrigin(err, opts.connection);
  }
}

async function textCall(opts: TextCallOptions): Promise<string> {
  throwIfAborted(opts.signal);
  const { connection } = opts;
  if (connection.provider === "mock") {
    return runMock(opts, () => {
      try {
        return opts.mock();
      } catch (err) {
        throw new LLMError(
          `The offline demo generator for "${opts.purpose}" failed: ${errorMessage(err)}`,
        );
      }
    });
  }

  const provider = createProvider(connection);
  const messages: LLMMessage[] = [
    { role: "user", content: contentFor(provider, opts) },
  ];
  const budget = tokenBudget(connection, opts.maxOutputTokens);
  let maxTokens = budget.initial;
  let cutOff: { response: LLMResponse; maxTokens: number } | undefined;
  for (;;) {
    const reservations = new AttemptReservations();
    const request: LLMRequest = {
      system: opts.system,
      messages,
      purpose: opts.purpose,
      maxOutputTokens: maxTokens,
      signal: opts.signal,
      beforeAttempt: () => {
        throwIfAborted(opts.signal);
        reservations.begin(
          opts.resources?.admit(request.maxOutputTokens!, fit.input),
        );
      },
    };
    const fit = fitRequest(connection, request);
    request.maxOutputTokens = fit.output;
    let response: LLMResponse;
    try {
      response = await callProvider(provider, request, opts, "text");
      reservations.settle(response.usage);
    } catch (err) {
      // The doubled budget is more than this model allows: the cut-off answer is the best there is.
      if (!cutOff || !rejectsOutputBudget(err)) throw err;
      emit(
        opts,
        "warn",
        `${opts.purpose}: the answer is incomplete (cut off at ${cutOff.maxTokens} tokens).`,
      );
      throw truncationError(
        opts,
        cutOff.maxTokens,
        connection.maxOutputTokens !== undefined &&
          cutOff.maxTokens >= connection.maxOutputTokens,
      );
    }
    if (response.stopReason === "refusal") throw refusalError(opts, response);
    if (
      response.stopReason === "max_tokens" &&
      !cutOff &&
      request.maxOutputTokens! <
        fitRequest(connection, { ...request, maxOutputTokens: budget.ceiling })
          .output
    ) {
      cutOff = { response, maxTokens: request.maxOutputTokens! };
      const next = Math.min(
        maxTokens * 2,
        fitRequest(connection, { ...request, maxOutputTokens: budget.ceiling })
          .output,
      );
      emit(
        opts,
        "warn",
        `${opts.purpose}: the answer was cut off at ${request.maxOutputTokens} tokens — retrying with ${next}.`,
      );
      maxTokens = next;
      continue;
    }
    if (response.stopReason === "max_tokens") {
      emit(
        opts,
        "warn",
        `${opts.purpose}: the answer is incomplete (cut off at ${request.maxOutputTokens} tokens).`,
      );
    }
    if (response.stopReason === "other")
      throw new LLMError(
        "The provider did not confirm that this answer finished. Coherence did not accept it as a complete result.",
      );
    if (response.stopReason !== "end")
      throw truncationError(
        opts,
        request.maxOutputTokens!,
        connection.maxOutputTokens !== undefined &&
          request.maxOutputTokens! >= connection.maxOutputTokens,
      );
    return response.text.trim();
  }
}
