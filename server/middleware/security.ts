/**
 * OWNER: server-core builder.
 * Local-tool hardening. Secrets live in settings.json, so the API must not be reachable from other sites:
 *  - Host check: a DNS-rebinding page (evil.com resolving to 127.0.0.1) still sends "Host: evil.com".
 *  - CSRF check: every request other than GET/HEAD needs `X-ScreenScribe: 1`, whatever its path. A cross-site
 *    page cannot add a custom header without a CORS preflight, and we never answer preflights with CORS headers.
 *    The check is keyed on the method, not on "/api": Express matches mount paths case-insensitively, so a
 *    path test let POST /API/… reach the API unchecked. Only the API accepts methods other than GET/HEAD.
 */
import type { NextFunction, Request, Response } from "express";
import type { ApiError } from "@shared/api";
import { CSRF_HEADER } from "@shared/api";
import { config } from "../config";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", ""]);

/** Hostnames the server answers to: loopback names plus an explicitly configured bind host. */
export function allowedHostnames(): Set<string> {
  const allowed = new Set(LOOPBACK_HOSTNAMES);
  const configured = config.host.trim().toLowerCase();
  if (!WILDCARD_HOSTS.has(configured))
    allowed.add(
      configured.includes(":") && !configured.startsWith("[")
        ? `[${configured}]`
        : configured,
    );
  return allowed;
}

/** Hostname of a Host header value ("localhost:4317" → "localhost", "[::1]:4317" → "[::1]"), or undefined. */
export function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isAllowedHost(hostHeader: string | undefined): boolean {
  const hostname = hostnameOf(hostHeader);
  return hostname !== undefined && allowedHostnames().has(hostname);
}

/** An Origin header (when present) must point at an allowed host too. "null" origins (sandboxed frames, file://) are rejected. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      allowedHostnames().has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

function reject(
  res: Response,
  status: number,
  error: string,
  code: string,
): void {
  const body: ApiError = { error, code };
  res.status(status).json(body);
}

export function hostGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isAllowedHost(req.headers.host)) {
    reject(
      res,
      403,
      `Coherence only accepts loopback requests. Open its verified launcher at http://127.0.0.1:${config.port} instead.`,
      "FORBIDDEN_HOST",
    );
    return;
  }
  next();
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export function csrfGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  if (req.get(CSRF_HEADER) !== "1") {
    reject(
      res,
      403,
      `Missing ${CSRF_HEADER} header — requests must come from the Coherence app.`,
      "CSRF",
    );
    return;
  }
  if (!isAllowedOrigin(req.get("origin"))) {
    reject(res, 403, "Requests from other websites are not allowed.", "CSRF");
    return;
  }
  next();
}
