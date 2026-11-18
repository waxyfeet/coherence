import { randomUUID } from "node:crypto";
import { redactDiagnostic, safeDiagnosticValue } from "../security/diagnostics";
/**
 * OWNER: server-core builder.
 * Turns thrown errors into ApiError JSON bodies. HttpError subclasses carry their own status and a
 * BA-readable message; body-parser / multer / zod errors are translated; anything else is a 500 (logged).
 */
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { ZodError } from "zod";
import type { ApiError } from "@shared/api";
import { CancelledError, HttpError } from "../errors";
import { MAX_UPLOAD_FILES, MAX_UPLOAD_FILE_MB } from "./upload";
import { describeIssues } from "./validate";

function multerMessage(err: multer.MulterError): {
  status: number;
  message: string;
} {
  const file = err.field ? ` ("${err.field}")` : "";
  switch (err.code) {
    case "LIMIT_FILE_SIZE":
      return {
        status: 413,
        message: `An image is larger than ${MAX_UPLOAD_FILE_MB} MB. Export it smaller (or as JPEG) and try again.`,
      };
    case "LIMIT_FILE_COUNT":
      return {
        status: 400,
        message: `Upload at most ${MAX_UPLOAD_FILES} images at a time.`,
      };
    case "LIMIT_UNEXPECTED_FILE":
      return {
        status: 400,
        message: `Unexpected upload field${file}. Images must be sent in the "files" field (or "file" when replacing one).`,
      };
    case "LIMIT_PART_COUNT":
    case "LIMIT_FIELD_COUNT":
    case "LIMIT_FIELD_KEY":
    case "LIMIT_FIELD_VALUE":
      return {
        status: 400,
        message: "The upload form contains too many or too large fields.",
      };
    default:
      return {
        status: 400,
        message:
          "The upload could not be processed. Check the upload fields and limits.",
      };
  }
}

/** Shape of body-parser errors (http-errors with a `type`). */
interface BodyParserError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
  expose?: boolean;
}

export function toApiError(err: unknown): { status: number; body: ApiError } {
  if (err instanceof HttpError) {
    const body: ApiError = {
      error: redactDiagnostic(err.message),
      code: err.code,
    };
    if (err.details !== undefined)
      body.details = safeDiagnosticValue(err.details);
    return { status: err.status, body };
  }
  if (err instanceof multer.MulterError) {
    const { status, message } = multerMessage(err);
    return { status, body: { error: message, code: "UPLOAD" } };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: `Invalid request: ${describeIssues(err.issues)}`,
        code: "VALIDATION",
      },
    };
  }
  if (err instanceof CancelledError) {
    return {
      status: 409,
      body: { error: redactDiagnostic(err.message), code: "CANCELLED" },
    };
  }
  const bp = err as BodyParserError;
  if (
    bp &&
    typeof bp === "object" &&
    typeof bp.type === "string" &&
    (bp.status ?? bp.statusCode)
  ) {
    const status = bp.status ?? bp.statusCode ?? 400;
    if (bp.type === "entity.parse.failed")
      return {
        status: 400,
        body: {
          error: "The request body is not valid JSON.",
          code: "VALIDATION",
        },
      };
    if (bp.type === "entity.too.large")
      return {
        status: 413,
        body: {
          error: "The request is too large (max 5 MB of JSON).",
          code: "TOO_LARGE",
        },
      };
    if (
      bp.type === "encoding.unsupported" ||
      bp.type === "charset.unsupported"
    ) {
      return {
        status: 415,
        body: {
          error: "Unsupported request encoding — send UTF-8 JSON.",
          code: "VALIDATION",
        },
      };
    }
    if (bp.expose)
      return {
        status,
        body: {
          error: "The request could not be processed.",
          code: "BAD_REQUEST",
        },
      };
  }
  const reference = randomUUID();
  return {
    status: 500,
    body: {
      error: `Something went wrong on the Coherence server. Reference ${reference}.`,
      code: "INTERNAL",
    },
  };
}

// Express recognises error middleware by its 4-argument signature.
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const { status, body } = toApiError(err);
  if (status >= 500 && !(err instanceof HttpError)) {
    console.error(`[http] ${req.method} failed: ${body.error}`);
  }
  if (res.headersSent) {
    // Mid-stream failure (e.g. SSE or a file download): nothing sensible to send, close the connection.
    res.destroy();
    return;
  }
  res.status(status).json(body);
}

/** JSON 404 for unknown /api routes (instead of the SPA's index.html). */
export function apiNotFound(req: Request, res: Response): void {
  const body: ApiError = {
    error: `No API endpoint for ${req.method}.`,
    code: "NOT_FOUND",
  };
  res.status(404).json(body);
}
