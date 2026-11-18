/**
 * Which connection and exact model a failed request went to. Kept beside the error in a WeakMap, so errors keep
 * their classes and messages; server/jobs/failure.ts reads it to name the connection in the BA-facing failure.
 */
import type { LLMConnection, ProviderKind } from "@shared/types";
import { CancelledError } from "../errors";
import { resolveApiKey } from "./providers/common";

export interface ErrorOrigin {
  connectionId: string;
  connectionName: string;
  provider: ProviderKind;
  model: string;
  /** Whether a key (stored, or from the environment) went with the request. */
  keySent: boolean;
}

const origins = new WeakMap<object, ErrorOrigin>();

/** Records where `err` came from, unless an inner call already did. Returns `err` for rethrowing. */
export function withOrigin<E>(err: E, connection: LLMConnection): E {
  if (
    !err ||
    typeof err !== "object" ||
    err instanceof CancelledError ||
    origins.has(err)
  )
    return err;
  let keySent = false;
  try {
    keySent = !!resolveApiKey(connection);
  } catch {
    // An endpoint the policy refuses was never contacted, so no key was sent.
  }
  origins.set(err, {
    connectionId: connection.id,
    connectionName: connection.name,
    provider: connection.provider,
    model: connection.model,
    keySent,
  });
  return err;
}

export function originOf(err: unknown): ErrorOrigin | undefined {
  return err && typeof err === "object" ? origins.get(err) : undefined;
}
