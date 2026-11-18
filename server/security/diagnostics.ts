import { randomUUID } from "node:crypto";

const secrets = new Map<string, number>();
export const DIAGNOSTIC_SECRET_LIMIT = 512;
export const DIAGNOSTIC_SECRET_TTL_MS = 30 * 60_000;
let retirementTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRetirement(): void {
  if (retirementTimer || !secrets.size) return;
  retirementTimer = setTimeout(() => {
    retirementTimer = undefined;
    retireSecrets();
    scheduleRetirement();
  }, 60_000);
  retirementTimer.unref?.();
}
function retireSecrets(): void {
  const now = Date.now();
  for (const [value, expires] of secrets)
    if (expires <= now) secrets.delete(value);
  while (secrets.size > DIAGNOSTIC_SECRET_LIMIT)
    secrets.delete(secrets.keys().next().value!);
}
// SDK debug modes can contain complete request bodies; ScreenScribe owns diagnostic output instead.
export const quietSdkLogger = { debug() {}, info() {}, warn() {}, error() {} };
export function rememberSecret(value: string | undefined): void {
  if (!value || value.length < 4) return;
  retireSecrets();
  secrets.delete(value);
  secrets.set(value, Date.now() + DIAGNOSTIC_SECRET_TTL_MS);
  retireSecrets();
  scheduleRetirement();
}
/** Register named credentials without ever serializing settings or request objects to logs. */
export function rememberCredentials(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (
      /^(apiKey|apiToken|token|pat|authorization|x-api-key|api-key|x-goog-api-key|x-figma-token)$/i.test(
        key,
      ) &&
      typeof item === "string"
    )
      rememberSecret(item);
    else if (item && typeof item === "object") rememberCredentials(item);
  }
}

export function redactDiagnostic(value: string): string {
  let out = value;
  retireSecrets();
  for (const secret of [...secrets.keys()].sort(
    (a, b) => b.length - a.length,
  )) {
    out = out.split(secret).join("[redacted]");
    out = out.split(encodeURIComponent(secret)).join("[redacted]");
  }
  out = out.replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
    try {
      const trailing = /[):.,;]+$/.exec(raw)?.[0] ?? "";
      const url = new URL(trailing ? raw.slice(0, -trailing.length) : raw);
      if (!url.username && !url.password && !url.search && !url.hash)
        return raw;
      return `${url.protocol}//${url.host}${url.pathname}${url.search ? "?[redacted]" : ""}${trailing}`;
    } catch {
      return "[redacted URL]";
    }
  });
  return out
    .replace(/\b(?:Bearer|Basic)\s+[^\s,"'}]+/gi, "[redacted authorization]")
    .replace(
      /((?:["']?)(?:api[_-]?key|api[_-]?token|access[_-]?token|client[_-]?secret|password|authorization|secret|pat|token)["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;"'}]+)/gi,
      "$1[redacted]",
    )
    .replace(
      /\b(?:sk-[\w*-]{6,}|AIza[\w-]{20,}|gh[opusr]_[\w]{12,}|github_pat_[\w]+)\b/g,
      "[redacted]",
    )
    .slice(0, 4000);
}

export function safeDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[omitted]";
  if (typeof value === "string") return redactDiagnostic(value);
  if (Array.isArray(value))
    return value.slice(0, 2000).map((v) => safeDiagnosticValue(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 2000)
        .map(([k, v]) => [
          k,
          /^(apiKey|apiToken|token|pat|capability|ticket|session|authorization|headers|body|prompt|request|response|stack|cause)$/i.test(
            k,
          )
            ? "[omitted]"
            : safeDiagnosticValue(v, depth + 1),
        ]),
    );
  return value;
}

export function internalFailure(): string {
  return `An internal operation failed. Reference ${randomUUID()}. Check the local files and connection settings, then retry.`;
}

/** External responses may echo prompt fragments or credentials: retain classifications, never excerpts. */
export function remoteDetail(raw: string): string {
  if (/\bthink(?:ing)?\b/i.test(raw))
    return "The server rejected the think option";
  if (/TF51535:.*?field\s+([\w.]+)/i.test(raw))
    return "A configured Azure DevOps field is unavailable";
  if (
    /response_format|json_schema|responseJsonSchema|schema|structured output/i.test(
      raw,
    )
  )
    return "The server rejected the structured output format";
  if (/max[_ ]?(?:output[_ ]?)?tokens|output.*(?:budget|limit)/i.test(raw))
    return "The server rejected the output token configuration";
  return "Service response details withheld to protect credentials and project content";
}

/** Only the protocol facts needed for existing Jira/AzDO adaptive handling survive an error. */
export function remoteErrorFacts(body: unknown): unknown {
  if (!body || typeof body !== "object") return undefined;
  const obj = body as { errors?: Record<string, unknown>; message?: unknown };
  const facts: { errors?: Record<string, string>; message?: string } = {};
  if (obj.errors && typeof obj.errors === "object") {
    facts.errors = Object.fromEntries(
      Object.keys(obj.errors)
        .filter((k) =>
          /^(?:customfield_\d{1,12}|summary|description|project|issuetype|parent|labels|components|priority|fixVersions)$/.test(
            k,
          ),
        )
        .map((k) => [redactDiagnostic(k), "Field rejected by service"]),
    );
  }
  if (typeof obj.message === "string") {
    if (/already exists/i.test(obj.message))
      facts.message = "Link already exists";
    const field = /TF51535:[^.]*?field\s+([\w.]{1,128})\.?(?:\s|$)/i.exec(
      obj.message,
    )?.[1];
    if (field && /^Microsoft\.[\w.]+$/.test(field))
      facts.message = `TF51535: Cannot find field ${field.replace(/\.+$/, "")}.`;
    // Azure DevOps process rules name the field and the rule: destination metadata, not project content.
    const rule =
      /\bTF401320: Rule Error for field ([\w .-]{1,80})\. Error code: ([\w, ]{1,200})\./i.exec(
        obj.message,
      );
    if (rule)
      facts.message = `TF401320: Rule Error for field ${rule[1]} (${rule[2].trim()}).`;
    else if (!facts.message) {
      const code = /\b(TF\d{5,6})\b/.exec(obj.message)?.[1];
      if (code) facts.message = code;
    }
  }
  return facts;
}
