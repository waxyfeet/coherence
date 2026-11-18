import {
  internalFailure,
  redactDiagnostic,
  safeDiagnosticValue,
} from "./security/diagnostics";
/** Errors that map to HTTP responses. The error middleware turns these into ApiError bodies. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(redactDiagnostic(message));
    this.details = safeDiagnosticValue(details);
    this.name = "HttpError";
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found", details?: unknown) {
    super(404, message, "NOT_FOUND", details);
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, message, "VALIDATION", details);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(409, message, "CONFLICT", details);
  }
}

/** Raised by the LLM layer; message must be safe to show to the BA (never include API keys). */
export class LLMError extends HttpError {
  constructor(
    message: string,
    public readonly retryable = false,
    details?: unknown,
  ) {
    super(502, message, "LLM_ERROR", details);
  }
}

/** Raised by exporters for tracker API failures. */
export class IntegrationError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(502, message, "INTEGRATION_ERROR", details);
  }
}

export class CancelledError extends Error {
  constructor(message = "Cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof HttpError || err instanceof CancelledError)
    return redactDiagnostic(err.message);
  return internalFailure();
}
