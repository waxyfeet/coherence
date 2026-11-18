import type { LLMConnection } from "@shared/types";
import type { LLMRequest } from "./types";
import { ProviderError } from "./errors";

/** A classified capacity failure permits smaller tasks. Authentication/quota/format failures do not. */
export class CapacityError extends ProviderError {
  constructor(
    readonly boundary: "input" | "output",
    message: string,
  ) {
    super(message, { failure: "too_large" });
    this.name = "CapacityError";
  }
}

/** The run used up its automatic request allowance (a runaway guard, not a provider limit). */
export class RunAllowanceError extends ProviderError {
  constructor() {
    super(
      "Coherence stopped at this run's automatic request allowance. Completed readings are retained. Review the activity and resume or choose another model; no replacement destination was used.",
      { failure: "other" },
    );
    this.name = "RunAllowanceError";
  }
}

const positive = (n?: number) =>
  Number.isSafeInteger(n) && n! > 0 ? n : undefined;

/** Conservative estimate, NOT a tokenizer or a provider guarantee. Images are never counted as base64 text. */
export function estimateInput(
  request: Pick<LLMRequest, "system" | "messages" | "jsonSchema">,
): number {
  let bytes = Buffer.byteLength(request.system, "utf8") + 128;
  let images = 0;
  if (request.jsonSchema)
    bytes += Buffer.byteLength(
      JSON.stringify(request.jsonSchema.schema),
      "utf8",
    );
  for (const message of request.messages) {
    bytes += 32;
    for (const part of message.content) {
      if (part.type === "text") bytes += Buffer.byteLength(part.text, "utf8");
      else {
        images++;
        bytes += Buffer.byteLength(part.image.label ?? "", "utf8");
      }
    }
  }
  // UTF-8/3 plus a safety margin; image accounting differs by provider/model and is deliberately approximate.
  return Math.ceil((bytes / 3) * 1.2) + images * 2048;
}

export function fitRequest(
  connection: LLMConnection,
  request: LLMRequest,
): { input: number; output: number; source: string } {
  const input = estimateInput(request);
  // Match the existing native Ollama allocation; metadata must never silently enlarge local RAM allocation.
  const combined =
    connection.provider === "ollama"
      ? Math.min(32768, positive(connection.modelContextWindow) ?? 32768)
      : positive(connection.modelContextWindow);
  const inputLimit = positive(connection.modelInputTokenLimit);
  const reserve = combined ? Math.max(128, Math.ceil(combined * 0.05)) : 0;
  if (
    (inputLimit && input >= inputLimit) ||
    (combined && input + reserve >= combined)
  )
    throw new CapacityError(
      "input",
      "The estimated request size exceeds the selected model's reported capacity. Coherence will keep completed readings and try smaller tasks where possible. No request was sent for this task.",
    );
  const output = Math.min(
    request.maxOutputTokens ?? 8192,
    combined ? combined - input - reserve : Infinity,
  );
  if (output < 1)
    throw new CapacityError(
      "input",
      "The selected model has no reported capacity remaining for this answer. No request was sent.",
    );
  return {
    input,
    output: Math.floor(output),
    source:
      combined || inputLimit
        ? "reported capacity and estimated input"
        : "capacity unknown; bounded automatic allowance",
  };
}

export interface RequestBudgetLimits {
  requests: number;
  outputAllowance: number;
  inputAllowance?: number;
}

/**
 * Run limits for `units` units of work (screens for a generate run). Generous runaway guards that grow with the
 * work, never per-model figures: a model's own output limit and the per-call attempt guard bound each call.
 */
export function workLimits(units: number): Required<RequestBudgetLimits> {
  const n = Math.max(1, Math.ceil(units));
  return {
    requests: 64 + 48 * n,
    outputAllowance: 2_000_000 + 1_000_000 * n,
    inputAllowance: 2_000_000 + 1_000_000 * n,
  };
}

/** One admitted attempt. Settling replaces its reservation with the usage the provider reported. */
export interface BudgetReservation {
  settle(usage: { inputTokens: number; outputTokens: number }): void;
}

/**
 * Application resource guards, not model capacity claims or dollar estimates. Admission is synchronous/atomic.
 * An attempt reserves its whole output allowance and estimated input while it runs; a finished attempt counts what
 * the provider reported instead. Unknown usage (failures, servers that report none) stays reserved in full.
 */
export class RequestBudget {
  private requests = 0;
  private reserved = 0;
  private inputReserved = 0;
  private current: RequestBudgetLimits;
  constructor(
    limits: RequestBudgetLimits = {
      requests: 256,
      outputAllowance: 2_000_000,
      inputAllowance: 2_000_000,
    },
  ) {
    this.current = { ...limits };
  }
  get limits(): Readonly<RequestBudgetLimits> {
    return this.current;
  }
  /** The run now knows its size: raise the limits to `workLimits(units)` (never lowers them). */
  expectWork(units: number): void {
    const next = workLimits(units);
    this.current = {
      requests: Math.max(this.current.requests, next.requests),
      outputAllowance: Math.max(
        this.current.outputAllowance,
        next.outputAllowance,
      ),
      inputAllowance: Math.max(
        this.current.inputAllowance ?? 2_000_000,
        next.inputAllowance,
      ),
    };
  }
  admit(outputAllowance: number, estimatedInput = 0): BudgetReservation {
    if (
      !Number.isSafeInteger(outputAllowance) ||
      outputAllowance < 1 ||
      !Number.isSafeInteger(estimatedInput) ||
      estimatedInput < 0 ||
      this.requests >= this.current.requests ||
      this.reserved + outputAllowance > this.current.outputAllowance ||
      this.inputReserved + estimatedInput >
        (this.current.inputAllowance ?? 2_000_000)
    )
      throw new RunAllowanceError();
    this.requests++;
    this.reserved += outputAllowance;
    this.inputReserved += estimatedInput;
    let settled = false;
    return {
      settle: ({ inputTokens, outputTokens }) => {
        const valid = (n: number) => Number.isSafeInteger(n) && n > 0;
        // Both zero: the provider reported no usage, so the reservation stands.
        if (settled || (!valid(outputTokens) && !valid(inputTokens))) return;
        settled = true;
        if (valid(outputTokens))
          this.reserved += outputTokens - outputAllowance;
        if (valid(inputTokens))
          this.inputReserved += inputTokens - estimatedInput;
      },
    };
  }
  snapshot() {
    return {
      requests: this.requests,
      reservedOutputAllowance: this.reserved,
      ...(this.inputReserved
        ? { reservedInputEstimate: this.inputReserved }
        : {}),
    };
  }
}
