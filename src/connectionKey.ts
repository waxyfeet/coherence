import { PROVIDER_PRESETS } from "../shared/providers";
import { connectionInput } from "./api";
import { matchesConnectionFilter } from "./connectionFilters";
import type { Connection } from "./data";

/** Where a connection's API key stands, for the Settings form and the analysis page (presentation only). */
export type KeyState =
  /** Typed in the form and not saved yet. */
  | "typed"
  /** Saved, and it will be sent to this address. */
  | "saved"
  /** Saved for another address or service: the server only sends a key to the address it was saved with. */
  | "saved-elsewhere"
  /** None, for an online service, which usually needs one. */
  | "missing"
  /** None, for a server on this computer or network, or the Offline demo. */
  | "not-needed";

const address = (endpoint: string) => endpoint.trim().replace(/\/+$/, "");

/** `saved` is the connection as last saved, when there is one. */
export function keyState(c: Connection, saved?: Connection): KeyState {
  if (c.provider === "mock") return "not-needed";
  if (c.apiKey.trim()) return "typed";
  if (c.keyPresent)
    return saved &&
      (saved.provider !== c.provider ||
        address(saved.endpoint) !== address(c.endpoint))
      ? "saved-elsewhere"
      : "saved";
  return matchesConnectionFilter(c, "cloud") ? "missing" : "not-needed";
}

/** Providers whose API always needs a key (a compatible gateway may not). */
export function keyRequired(c: Connection): boolean {
  return PROVIDER_PRESETS[connectionInput(c).provider].apiKeyRequired;
}
