/**
 * Turns the error that stopped a job into a JobFailure: a category, the one next step, and a message in
 * Coherence's own words. Provider response text never reaches the message; it stays in Job.error and the log.
 */
import type {
  JobFailure,
  JobFailureAction,
  JobFailureKind,
} from "@shared/types";
import { CancelledError, HttpError } from "../errors";
import { CapacityError, RunAllowanceError } from "../llm/capacity";
import { ModelDeclinedError, ProviderError } from "../llm/errors";
import { originOf } from "../llm/origin";
import { PROVIDER_NAMES } from "../llm/providers/common";

const ACTIONS: Record<JobFailureKind, JobFailureAction> = {
  "no-key": "fix-connection",
  "key-refused": "fix-connection",
  "access-refused": "change-model",
  "model-not-found": "change-model",
  "rate-limited": "wait",
  quota: "change-model",
  "cannot-read-images": "change-model",
  "too-large": "change-model",
  declined: "change-model",
  timeout: "try-again",
  unreachable: "try-again",
  "service-error": "try-again",
  "request-rejected": "change-model",
  other: "try-again",
};

/** A wait shorter than this is not worth naming a reset time for. */
const NAMED_RESET_MS = 60_000;

/** The error that carries the facts: the first provider or refusal error along the `cause` chain. */
function rootCause(err: unknown): unknown {
  let current = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      current instanceof ProviderError ||
      current instanceof ModelDeclinedError
    )
      return current;
    current = (current as { cause?: unknown }).cause;
  }
  return err;
}

function kindOf(err: unknown, keySent: boolean | undefined): JobFailureKind {
  if (err instanceof ModelDeclinedError) return "declined";
  if (err instanceof RunAllowanceError) return "other";
  if (err instanceof CapacityError) return "too-large";
  if (!(err instanceof ProviderError)) return "other";
  switch (err.failure) {
    case "auth":
      return keySent === false ? "no-key" : "key-refused";
    case "forbidden":
      return "access-refused";
    case "not_found":
      return "model-not-found";
    case "rate_limit":
      return "rate-limited";
    case "quota":
      return "quota";
    case "image_unsupported":
      return "cannot-read-images";
    case "too_large":
      return "too-large";
    case "timeout":
      return "timeout";
    case "network":
    case "unreachable":
      return "unreachable";
    case "server":
      return "service-error";
    case "bad_request":
    case "format_unsupported":
      return "request-rejected";
    default:
      return "other";
  }
}

function clockTime(at: Date, now: number): string {
  const sameDay = at.getTime() - now < 20 * 60 * 60 * 1000;
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { weekday: "long" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

export function describeFailure(
  err: unknown,
  now = Date.now(),
): JobFailure | undefined {
  if (err instanceof CancelledError) return undefined;
  const cause = rootCause(err);
  const origin = originOf(cause) ?? originOf(err);
  const kind = kindOf(cause, origin?.keySent);
  const name =
    origin?.connectionName.trim() ||
    (origin ? PROVIDER_NAMES[origin.provider] : "The AI service");
  const model = origin?.model || "this model";
  const waitMs =
    cause instanceof ProviderError ? cause.retryAfterMs : undefined;
  const resetAt =
    kind === "rate-limited" && waitMs !== undefined && waitMs > 0
      ? new Date(now + waitMs)
      : undefined;
  const own =
    cause instanceof HttpError
      ? cause.message
      : err instanceof HttpError
        ? err.message
        : "";

  const messages: Record<JobFailureKind, () => string> = {
    "no-key": () =>
      `No API key is saved for ${name}, so the request went without one. Add the key in Settings → AI connections, then try again.`,
    "key-refused": () =>
      `${name} refused the API key. Check or replace the key in Settings → AI connections, then try again.`,
    "access-refused": () =>
      `${name} accepted the key but refused access to ${model}. The account may not include this model: choose another model, or check the account with the service.`,
    "model-not-found": () =>
      `${name} doesn't recognise the model ${model}. Choose another model, or check its exact ID in Settings → AI connections.`,
    "rate-limited": () =>
      resetAt && waitMs! >= NAMED_RESET_MS
        ? `${name}'s rate limit for ${model} was reached. It should reset at about ${clockTime(resetAt, now)}: try again then, or choose another model.`
        : `${name}'s rate limit for ${model} was reached. Wait a few minutes and try again, or choose another model.`,
    quota: () =>
      `${name} says the account's quota or credits are used up. Add credits with the service, or choose another model.`,
    "cannot-read-images": () =>
      `${model} can't read screenshots, so it can't read screens. Choose a model that reads images for Read screens.`,
    "too-large": () =>
      cause instanceof CapacityError && own
        ? own
        : `The request was too large for ${model} on ${name}. Choose a model with larger limits, or use smaller screen images.`,
    declined: () =>
      `${model} declined the request. Rephrase the project description or screen notes, or choose another model.`,
    timeout: () =>
      `${name} stopped responding while ${model} was working. Try again; if it keeps happening, choose a faster model.`,
    unreachable: () =>
      `Coherence couldn't reach ${name}. Check the internet connection and the address in Settings → AI connections, then try again.`,
    "service-error": () =>
      `${name} had a temporary problem. Try again in a few minutes, or choose another model.`,
    "request-rejected": () =>
      `${name} rejected the request for ${model}. Another model may work: choose one, or check the connection in Settings → AI connections.`,
    other: () =>
      cause instanceof RunAllowanceError ||
      (own && !(cause instanceof ProviderError))
        ? own
        : cause instanceof ProviderError
          ? `${name} returned an unexpected error for ${model}. Try again, or choose another model.`
          : "The run stopped because of an unexpected problem. Try again; the activity log has the details.",
  };

  return {
    kind,
    action: ACTIONS[kind],
    message: messages[kind](),
    ...(origin
      ? {
          connectionId: origin.connectionId,
          connectionName: origin.connectionName,
          model: origin.model,
        }
      : {}),
    ...(resetAt ? { resetAt: resetAt.toISOString() } : {}),
  };
}
