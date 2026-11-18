/**
 * The smarter OpenAI-compatible connection (owner test note 2, adopted 3 Nov 2026; tester build WP7).
 *
 * Recognised services are data rows, not provider types: a row only knows the documented address and, where the
 * service documents one, a request that checks a key without running a model. The UI calls them "recognised
 * addresses", never "verified": only a test or capability evidence on the user's own connection verifies anything.
 * Each base URL was read from the service's own API documentation on 3 Nov 2026.
 */

export interface RecognisedService {
  id: string;
  name: string;
  /** Exact host names that mean this service. */
  hosts: string[];
  /** The documented base URL for OpenAI-compatible clients (the part before /chat/completions). */
  baseUrl: string;
  /** A documented GET, relative to baseUrl, that checks the key without inference. */
  keyCheckPath?: string;
}

export const RECOGNISED_SERVICES: readonly RecognisedService[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    hosts: ["openrouter.ai"],
    baseUrl: "https://openrouter.ai/api/v1",
    // "To check the rate limit or credits left on an API key, make a GET request to .../api/v1/key".
    keyCheckPath: "/key",
  },
  {
    id: "groq",
    name: "Groq",
    hosts: ["api.groq.com"],
    baseUrl: "https://api.groq.com/openai/v1",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    hosts: ["api.deepseek.com"],
    baseUrl: "https://api.deepseek.com",
  },
  {
    id: "together",
    name: "Together AI",
    hosts: ["api.together.ai"],
    baseUrl: "https://api.together.ai/v1",
  },
  {
    id: "mistral",
    name: "Mistral",
    hosts: ["api.mistral.ai"],
    baseUrl: "https://api.mistral.ai/v1",
  },
  {
    id: "xai",
    name: "xAI",
    hosts: ["api.x.ai"],
    baseUrl: "https://api.x.ai/v1",
    // GET /v1/api-key: "Get information about an API key".
    keyCheckPath: "/api-key",
  },
];

/** The address a "server on this computer" usually has (LM Studio's default). */
export const LOCAL_SERVER_ADDRESS = "http://localhost:1234/v1";

function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h === "::1" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

export function recognisedService(
  address: string | undefined,
): RecognisedService | undefined {
  try {
    const url = new URL(address ?? "");
    return RECOGNISED_SERVICES.find((s) =>
      s.hosts.includes(url.hostname.toLowerCase()),
    );
  } catch {
    return undefined;
  }
}

export interface NormalisedAddress {
  url: string;
  service?: RecognisedService;
  /** What was changed, in plain words; empty when the address was already in its final form. */
  changes: string[];
}

const ENDPOINT_SUFFIX = /\/(?:chat\/completions|completions|models)\/?$/i;

/**
 * Accepts what people paste: adds the scheme, removes an endpoint path copied from documentation, and maps a
 * recognised host to its documented API address. Never changes the host of an address it does not recognise.
 * Returns undefined for text that is not an address yet.
 */
export function normaliseCompatibleAddress(
  input: string,
): NormalisedAddress | undefined {
  const text = input.trim();
  if (!text) return undefined;
  const changes: string[] = [];
  let candidate = text;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) {
    const host = candidate.split(/[/:?#]/)[0];
    candidate = `${isLocalHost(host) ? "http" : "https"}://${candidate}`;
    changes.push(
      `added ${candidate.startsWith("https") ? "https://" : "http://"}`,
    );
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname)
    return undefined;
  let path = url.pathname;
  if (ENDPOINT_SUFFIX.test(path)) {
    const removed = path.match(ENDPOINT_SUFFIX)![0].replace(/\/$/, "");
    path = path.replace(ENDPOINT_SUFFIX, "");
    changes.push(`removed ${removed}`);
  }
  path = path.replace(/\/+$/, "");
  let result = `${url.protocol}//${url.host}${path}${url.search}${url.hash}`;
  const service = recognisedService(result);
  if (service && result !== service.baseUrl) {
    result = service.baseUrl;
    changes.push(`used ${service.name}'s API address`);
  }
  return { url: result, service, changes };
}
