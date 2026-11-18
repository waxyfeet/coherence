/** Authentication material is never included in a URL, diagnostic or provider request. */
export const SESSION_STORAGE_KEY = "screenscribe.local-session.v1";
export const SESSION_REQUIRED_EVENT = "screenscribe-session-required";
export const SESSION_CHANGED_EVENT = "screenscribe-session-changed";
/** Never resolve a hostname while bootstrapping or sending a local session credential. */
export function isLiteralLoopbackOrigin(origin: unknown): origin is string {
  if (typeof origin !== "string") return false;
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(origin);
  return !!match && Number(match[1]) <= 65535;
}
export function literalLoopbackOrigin(port: number): string {
  const origin = `http://127.0.0.1:${port}`;
  if (!Number.isInteger(port) || !isLiteralLoopbackOrigin(origin))
    throw Error(
      "Local authentication requires a literal IPv4 loopback origin with a valid port.",
    );
  return origin;
}
export interface BrowserSession {
  token: string;
  expiresAt: number;
}
