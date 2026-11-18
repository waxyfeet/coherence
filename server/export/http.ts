import { rememberCredentials, remoteErrorFacts } from "../security/diagnostics";
/**
 * Small fetch wrapper shared by the tracker clients and the Figma importer:
 * per-request timeout, retries on 429/5xx with backoff (honouring Retry-After), cancellation via the
 * job's AbortSignal, and safe status-based errors that omit untrusted service response bodies.
 * Non-idempotent requests (POST/PATCH unless marked `idempotent`) are retried only when rate limited:
 * after a 5xx or a lost connection the item may already exist, and a retry would create a duplicate.
 * Never puts credentials in messages — callers pass auth via headers only.
 */
import { validateEndpoint } from "../security/endpointPolicy";
import { figmaImageUrl, outboundDispatcher } from "../security/outboundPolicy";
import { isLoopback } from "@shared/localModelPolicy";
import { STATUS_CODES } from "node:http";
import { CancelledError, IntegrationError } from "../errors";

/** Mutable so tests can shrink delays; production code never changes these. */
export const httpDefaults = {
  timeoutMs: 30_000,
  /** Publishing writes wait longer: a timed-out write has an unknown outcome and stops the run. */
  writeTimeoutMs: 60_000,
  /** Retries after the first attempt (so 3 attempts in total). */
  retries: 2,
  baseDelayMs: 800,
  /** A Retry-After longer than this is reported to the BA instead of waited out. */
  maxRetryAfterMs: 60_000,
};

/** How one remote service phrases its errors. */
export interface ServiceInfo {
  /** "Jira", "Azure DevOps", "GitHub", "Figma" */
  label: string;
  /** Pull the human message out of an error body (JSON already parsed when possible). */
  extractMessage(body: unknown): string;
  /** Appended to 401 messages, e.g. "Check the email and API token in Settings → Integrations." */
  authHint?: string;
  /** Extra advice for a rate-limit response (e.g. Figma's monthly quota for View seats). */
  rateLimitHint?(headers: Headers): string | undefined;
}

export interface HttpRequestOptions {
  /** Rendered Figma images require an approved CDN and public addresses, with no service credentials. */
  destination?: "figma-image";
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  /** Serialised with JSON.stringify. */
  json?: unknown;
  /** Defaults to application/json when `json` is given. */
  contentType?: string;
  signal?: AbortSignal;
  /** Bounded binary downloads (for example Figma image bytes), enforced while reading. */
  maxBytes?: number;
  /** Statuses returned to the caller instead of thrown (e.g. [404] to detect deleted items). */
  allowStatuses?: number[];
  timeoutMs?: number;
  retries?: number;
  /** A POST/PATCH that is safe to repeat (read-only query, or a plain field update) — retried like a GET. */
  idempotent?: boolean;
}

export interface HttpResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

/** A failed call to an external service. `remoteStatus` is the service's HTTP status (0 = no response). */
export class RemoteServiceError extends IntegrationError {
  readonly body: unknown;
  constructor(
    message: string,
    public readonly service: string,
    public readonly remoteStatus: number,
    body?: unknown,
  ) {
    super(message, { service, status: remoteStatus });
    this.name = "RemoteServiceError";
    this.body = remoteErrorFacts(body);
  }
}

const IDEMPOTENT = new Set(["GET", "PUT", "DELETE"]);

/** JSON request; the parsed body (or raw text when not JSON) is returned as `data`. */
export async function requestJson<T = unknown>(
  service: ServiceInfo,
  url: string,
  opts: HttpRequestOptions = {},
): Promise<HttpResponse<T>> {
  const res = await send(service, url, opts);
  const text = await res.text();
  const data = parseBody(text);
  const contentType = res.headers.get("content-type") ?? "";
  // Azure DevOps answers a bad PAT with 203 + an HTML sign-in page instead of 401.
  if (
    res.ok &&
    contentType.includes("text/html") &&
    text.trimStart().startsWith("<")
  ) {
    throw new RemoteServiceError(
      `${service.label} returned a sign-in page instead of data — the credentials were not accepted.${service.authHint ? ` ${service.authHint}` : ""}`,
      service.label,
      401,
    );
  }
  return { status: res.status, data: data as T, headers: res.headers };
}

/** Binary download (e.g. rendered Figma images from their CDN). */
export async function requestBuffer(
  service: ServiceInfo,
  url: string,
  opts: HttpRequestOptions = {},
): Promise<HttpResponse<Buffer>> {
  const res = await send(service, url, opts);
  const limit = opts.maxBytes;
  let buffer: Buffer;
  if (limit !== undefined) {
    if (Number(res.headers.get("content-length")) > limit) {
      await res.body?.cancel();
      throw new IntegrationError(
        `${service.label} download exceeds the ${Math.round(limit / 1024 / 1024)} MB limit.`,
      );
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (reader) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > limit) {
          await reader.cancel();
          throw new IntegrationError(
            `${service.label} download exceeds the ${Math.round(limit / 1024 / 1024)} MB limit.`,
          );
        }
        chunks.push(next.value);
      }
      buffer = Buffer.concat(chunks);
    } catch (error) {
      if (opts.signal?.aborted) throw new CancelledError();
      throw error;
    } finally {
      reader?.releaseLock();
    }
  } else buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, data: buffer, headers: res.headers };
}

async function send(
  service: ServiceInfo,
  url: string,
  opts: HttpRequestOptions,
): Promise<Response> {
  const endpoint =
    opts.destination === "figma-image"
      ? figmaImageUrl(url)
      : validateEndpoint(url, { request: true, credentialed: true });
  const method = opts.method ?? "GET";
  const idempotent = opts.idempotent ?? IDEMPOTENT.has(method);
  const retries = opts.retries ?? httpDefaults.retries;
  const timeoutMs = opts.timeoutMs ?? httpDefaults.timeoutMs;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...opts.headers,
  };
  if (
    opts.destination === "figma-image" &&
    Object.keys(headers).some(
      (name) => !["accept"].includes(name.toLowerCase()),
    )
  )
    throw new IntegrationError(
      "Figma image downloads cannot include service credentials or custom headers.",
    );
  rememberCredentials(headers);
  let body: string | undefined;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers["Content-Type"] = opts.contentType ?? "application/json";
  }

  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw new CancelledError();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : timeoutSignal;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        signal,
        redirect: "error",
        dispatcher: outboundDispatcher(
          endpoint,
          opts.destination === "figma-image" ||
            endpoint.hostname === "api.figma.com"
            ? "public"
            : isLoopback(endpoint.hostname)
              ? "loopback"
              : "configured",
        ),
      } as RequestInit);
    } catch (err) {
      if (opts.signal?.aborted) throw new CancelledError();
      const timedOut = timeoutSignal.aborted;
      // Retrying a POST/PATCH that may have reached the server could create duplicates.
      if (attempt < retries && idempotent) {
        await sleep(backoffMs(attempt), opts.signal);
        continue;
      }
      throw new RemoteServiceError(
        timedOut
          ? `${service.label} did not respond within ${Math.round(timeoutMs / 1000)} seconds (${method} ${describeUrl(url)}).${idempotent ? "" : ` ${mayHaveApplied(service)}`}`
          : `Could not reach ${service.label} at ${safeOrigin(url)}: ${networkCause(err)}.`,
        service.label,
        0,
      );
    }

    if (res.ok || opts.allowStatuses?.includes(res.status)) return res;

    const text = await res.text().catch(() => "");
    const parsed = parseBody(text);
    const rateLimited = isRateLimited(res);
    // A rate-limited request was not processed; a 5xx one may have been (gateway timeouts often are).
    if (
      (rateLimited || (res.status >= 500 && idempotent)) &&
      attempt < retries
    ) {
      const wait = retryAfterMs(res.headers) ?? backoffMs(attempt);
      if (wait <= httpDefaults.maxRetryAfterMs) {
        await sleep(wait, opts.signal);
        continue;
      }
    }
    let message = formatHttpError(
      service,
      res.status,
      res.statusText,
      parsed,
      res.headers,
    );
    if (res.status >= 500 && !idempotent)
      message = `${message} ${mayHaveApplied(service)}`;
    throw new RemoteServiceError(message, service.label, res.status, parsed);
  }
}

function mayHaveApplied(service: ServiceInfo): string {
  return `The request was not repeated because ${service.label} may have carried it out anyway — check ${service.label} before exporting again so nothing is created twice.`;
}

/** "<Service> returned HTTP 400 Bad Request: <service message>" plus targeted hints for auth/rate limits. */
export function formatHttpError(
  service: ServiceInfo,
  status: number,
  statusText: string,
  body: unknown,
  headers?: Headers,
): string {
  const detail = ""; // Never copy untrusted service bodies into diagnostics.
  // HTTP/2 responses carry no reason phrase — use the standard one.
  const reason = STATUS_CODES[status] || "";
  const head = `${service.label} returned HTTP ${status}${reason ? ` ${reason}` : ""}`;
  const withDetail = detail ? `${head}: ${detail}` : head;
  if (status === 401) {
    return `${service.label} rejected the credentials (HTTP 401)${detail ? `: ${detail}` : ""}.${service.authHint ? ` ${service.authHint}` : ""}`;
  }
  if (status === 403 && !(headers && isRateLimitedHeaders(status, headers))) {
    return `${withDetail}. The account behind the token is not allowed to do this — check its permissions.`;
  }
  if (status === 429 || (headers && isRateLimitedHeaders(status, headers))) {
    const wait = headers ? retryAfterMs(headers) : undefined;
    const when = wait
      ? ` Try again in about ${describeWait(wait)}.`
      : " Wait a minute and try again.";
    let hint: string | undefined;
    try {
      hint = headers ? service.rateLimitHint?.(headers) : undefined;
    } catch {
      hint = undefined;
    }
    return `${service.label} is rate limiting requests (HTTP ${status}).${hint ? ` ${hint}` : ""}${when}`;
  }
  return withDetail.endsWith(".") ? withDetail : `${withDetail}.`;
}

/** "5 minute(s)", "3 hours", "12 days" — Figma's monthly quotas answer with a Retry-After of days. */
function describeWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes <= 120) return `${minutes} minute(s)`;
  const hours = Math.ceil(minutes / 60);
  return hours <= 48 ? `${hours} hours` : `${Math.ceil(hours / 24)} days`;
}

function isRateLimited(res: Response): boolean {
  return isRateLimitedHeaders(res.status, res.headers);
}

function isRateLimitedHeaders(status: number, headers: Headers): boolean {
  if (status === 429) return true;
  // GitHub signals primary/secondary rate limits with 403 + these headers.
  return (
    status === 403 &&
    (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after"))
  );
}

/** Retry-After (seconds or HTTP date) or GitHub's x-ratelimit-reset (epoch seconds), in ms. */
export function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset && headers.get("x-ratelimit-remaining") === "0") {
    const epoch = Number(reset);
    if (Number.isFinite(epoch)) return Math.max(0, epoch * 1000 - Date.now());
  }
  return undefined;
}

function backoffMs(attempt: number): number {
  const base = httpDefaults.baseDelayMs * 2 ** attempt;
  return base + Math.floor(Math.random() * Math.min(250, base / 2 + 1));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseBody(text: string): unknown {
  if (!text) return undefined;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function networkCause(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  if (cause?.code === "ENOTFOUND")
    return "the host name could not be resolved (check the URL)";
  if (cause?.code === "ECONNREFUSED") return "the connection was refused";
  if (
    cause?.code === "CERT_HAS_EXPIRED" ||
    [
      "UNABLE_TO_GET_ISSUER_CERT",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ].includes(cause?.code ?? "") ||
    cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT"
  ) {
    return "the TLS certificate was not accepted";
  }
  return "network transport failed (check the endpoint, TLS certificate and connectivity)";
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Path without the query string (queries may contain JQL etc. — long and noisy in messages). */
function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return url;
  }
}

/* ── Error-body extractors for the services we talk to ─────────────────── */

/** Jira: { errorMessages: string[], errors: { field: message } } */
export function jiraErrorMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as {
    errorMessages?: unknown;
    errors?: unknown;
    message?: unknown;
  };
  const parts: string[] = [];
  if (Array.isArray(b.errorMessages))
    parts.push(
      ...b.errorMessages.filter(
        (m): m is string => typeof m === "string" && !!m,
      ),
    );
  if (b.errors && typeof b.errors === "object") {
    for (const [field, msg] of Object.entries(
      b.errors as Record<string, unknown>,
    )) {
      if (typeof msg === "string" && msg) parts.push(`${field}: ${msg}`);
    }
  }
  if (!parts.length && typeof b.message === "string") parts.push(b.message);
  return parts.join("; ");
}

/** Azure DevOps: { message, typeKey } */
export function azdoErrorMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as { message?: unknown; value?: { Message?: unknown } };
  if (typeof b.message === "string") return b.message;
  if (typeof b.value?.Message === "string") return b.value.Message;
  return "";
}

/** GitHub: { message, errors: [{ resource, field, code, message }] } */
export function githubErrorMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as { message?: unknown; errors?: unknown };
  const parts: string[] = [];
  if (typeof b.message === "string" && b.message) parts.push(b.message);
  if (Array.isArray(b.errors)) {
    for (const e of b.errors) {
      if (typeof e === "string") parts.push(e);
      else if (e && typeof e === "object") {
        const x = e as {
          message?: unknown;
          field?: unknown;
          code?: unknown;
          resource?: unknown;
        };
        if (typeof x.message === "string" && x.message) parts.push(x.message);
        else if (x.field || x.code)
          parts.push(
            `${String(x.resource ?? "")} ${String(x.field ?? "")} ${String(x.code ?? "")}`.trim(),
          );
      }
    }
  }
  return parts.join(" — ");
}

/** Figma: { status, err } or { error: true, status, message } */
export function figmaErrorMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as { err?: unknown; message?: unknown };
  if (typeof b.err === "string") return b.err;
  if (typeof b.message === "string") return b.message;
  return "";
}

export function basicAuth(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`, "utf8").toString("base64")}`;
}

/** Trim and drop trailing slashes; validates http(s). */
export function normaliseBaseUrl(value: string, what: string): string {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  validateEndpoint(trimmed, { credentialed: true });
  return trimmed;
}
