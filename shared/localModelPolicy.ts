import type { ProviderKind } from "./types";
import { PROVIDER_PRESETS } from "./providers";

export function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host === "[::1]" ||
    /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)
  );
}

/** Local-only is deliberately stricter than the ordinary, explicitly configured LAN model policy. */
export function allowsLocalAnalysis(connection: {
  provider: ProviderKind;
  baseUrl?: string;
}): boolean {
  if (connection.provider === "mock") return true;
  if (!["ollama", "openai-compatible"].includes(connection.provider))
    return false;
  try {
    return isLoopback(
      new URL(
        connection.baseUrl ||
          PROVIDER_PRESETS[connection.provider].defaultBaseUrl ||
          "",
      ).hostname,
    );
  } catch {
    return false;
  }
}
