import type { LLMConnection } from "@shared/types";
import { PROVIDER_PRESETS } from "@shared/providers";
import { rememberCredentials, rememberSecret } from "./diagnostics";
import { BadRequestError } from "../errors";
import { isIP } from "node:net";
import { isLoopback } from "@shared/localModelPolicy";
import {
  outboundDispatcher,
  permitsAddress,
  type AddressPolicy,
} from "./outboundPolicy";

function isPrivateLan(host: string): boolean {
  return (
    (isIP(host) === 4 &&
      (/^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(?:1[6-9]|2\d|3[01])\./.test(host))) ||
    host.endsWith(".local") ||
    /^[a-z][a-z0-9-]*$/i.test(host) ||
    /^\[f[cd][0-9a-f:]+\]$/i.test(host)
  );
}

/** Configured endpoints carry no authentication in URLs. SDKs add their own ordinary request queries. */
export function validateEndpoint(
  value: string,
  options: {
    credentialed?: boolean;
    localModel?: boolean;
    request?: boolean;
  } = {},
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestError(
      "Enter a valid endpoint URL including https:// (or http:// for a local model).",
    );
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new BadRequestError("The endpoint must use HTTP or HTTPS.");
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) && !permitsAddress(literal, "configured"))
    throw new BadRequestError(
      "Metadata, link-local and reserved network addresses cannot be used as endpoints.",
    );
  if (
    url.username ||
    url.password ||
    url.hash ||
    (!options.request && url.search)
  )
    throw new BadRequestError(
      "Endpoint URLs cannot contain credentials, query parameters or fragments. Put credentials in the protected API key/token field.",
    );
  if (
    url.protocol !== "https:" &&
    !isLoopback(url.hostname) &&
    !(options.localModel && !options.credentialed && isPrivateLan(url.hostname))
  ) {
    throw new BadRequestError(
      "Remote connections require HTTPS. HTTP is supported for loopback connections and uncredentialed local models on a trusted private LAN.",
    );
  }
  return url;
}

export function providerEndpoint(
  connection: Pick<LLMConnection, "provider" | "baseUrl">,
): string {
  return (
    connection.baseUrl?.trim() ||
    PROVIDER_PRESETS[connection.provider].defaultBaseUrl ||
    (connection.provider === "gemini"
      ? "https://generativelanguage.googleapis.com"
      : "")
  );
}
const canonical = (value: string): string =>
  new URL(value).href.replace(/\/+$/, "");

/** Ambient vendor credentials are never inherited by arbitrary gateways/resources. */
export function mayUseEnvironmentKey(
  connection: Pick<LLMConnection, "provider" | "baseUrl">,
): boolean {
  if (
    connection.provider === "mock" ||
    connection.provider === "ollama" ||
    connection.provider === "openai-compatible"
  )
    return false;
  const approved =
    connection.provider === "azure-openai"
      ? process.env.SCREENSCRIBE_V2_AZURE_OPENAI_ENDPOINT?.trim()
      : providerEndpoint({ provider: connection.provider });
  if (!approved) return false;
  try {
    validateEndpoint(approved, { credentialed: true });
    const endpoint = providerEndpoint(connection);
    validateEndpoint(endpoint, { credentialed: true });
    const normalize = (value: string) =>
      canonical(value).replace(
        connection.provider === "anthropic" ? /\/v1$/i : /$^/,
        "",
      );
    return normalize(endpoint) === normalize(approved);
  } catch {
    return false;
  }
}

export function validateProviderEndpoint(
  connection: Pick<LLMConnection, "provider" | "baseUrl" | "apiKey">,
): void {
  if (connection.provider === "mock") return;
  validateEndpoint(providerEndpoint(connection), {
    credentialed: !!connection.apiKey || mayUseEnvironmentKey(connection),
    localModel: ["ollama", "openai-compatible"].includes(connection.provider),
  });
}

/** SDKs cannot follow redirects with project payloads/credentials or leave the configured origin. */
export function providerFetch(
  connection: LLMConnection,
  resolvedKey = connection.apiKey,
): typeof fetch {
  rememberSecret(resolvedKey);
  validateProviderEndpoint(connection);
  const origin = new URL(providerEndpoint(connection)).origin;
  return async (input, init) => {
    const value = input instanceof Request ? input.url : String(input);
    const url = validateEndpoint(value, {
      request: true,
      credentialed: !!connection.apiKey || mayUseEnvironmentKey(connection),
      localModel: ["ollama", "openai-compatible"].includes(connection.provider),
    });
    if (url.origin !== origin)
      throw new BadRequestError(
        "The provider request destination differs from the configured endpoint. No request was sent.",
      );
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    // Vendor SDKs read conventional custom-header variables independently of their API key argument.
    // Discard every ambient custom header, then set only ScreenScribe's resolved authentication.
    for (const variable of [
      "ANTHROPIC_CUSTOM_HEADERS",
      "OPENAI_CUSTOM_HEADERS",
    ]) {
      for (const line of (process.env[variable] ?? "").split("\n")) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.delete(line.slice(0, colon).trim());
      }
    }
    for (const name of [
      "authorization",
      "x-api-key",
      "api-key",
      "x-goog-api-key",
    ])
      headers.delete(name);
    if (resolvedKey) {
      const name =
        connection.provider === "anthropic"
          ? "x-api-key"
          : connection.provider === "gemini"
            ? "x-goog-api-key"
            : connection.provider === "azure-openai"
              ? "api-key"
              : "authorization";
      headers.set(
        name,
        name === "authorization" ? `Bearer ${resolvedKey}` : resolvedKey,
      );
    }
    rememberCredentials(Object.fromEntries(headers.entries()));
    const localModel = ["ollama", "openai-compatible"].includes(
      connection.provider,
    );
    const canonicalVendor =
      ["openai", "anthropic", "gemini"].includes(connection.provider) &&
      origin ===
        new URL(providerEndpoint({ provider: connection.provider })).origin;
    const policy: AddressPolicy = canonicalVendor
      ? "public"
      : isLoopback(url.hostname)
        ? "loopback"
        : url.protocol === "http:" && localModel
          ? "lan"
          : "configured";
    return fetch(input, {
      ...init,
      headers,
      redirect: "error",
      dispatcher: outboundDispatcher(url, policy),
    } as RequestInit);
  };
}

/** Public metadata must not expose unsafe legacy URLs even before the user repairs them. */
export function publicEndpoint(value: string | undefined): string | undefined {
  if (!value) return value;
  try {
    validateEndpoint(value, { localModel: true });
    return value;
  } catch {
    return "[invalid endpoint — re-enter in Settings]";
  }
}
