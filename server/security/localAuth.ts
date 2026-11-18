import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import {
  SESSION_STORAGE_KEY,
  isLiteralLoopbackOrigin,
  type BrowserSession,
} from "@shared/localAuth";
export {
  isLiteralLoopbackOrigin,
  literalLoopbackOrigin,
} from "@shared/localAuth";
import { config } from "../config";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const TICKET_TTL_MS = 60_000;
const hex = () => randomBytes(32).toString("hex");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function proof(
  capability: string,
  purpose: string,
  value: string,
): string {
  return createHmac("sha256", capability)
    .update(`${purpose}\n${value}`)
    .digest("hex");
}
export function equalSecret(a: string, b: string): boolean {
  return (
    /^[a-f0-9]{64}$/.test(a) &&
    /^[a-f0-9]{64}$/.test(b) &&
    timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
  );
}
export interface LaunchTicket {
  nonce: string;
  expiresAt: number;
  origin: string;
}
/** Owner-side operation. Only the private launcher holds the per-launch capability. */
export function makeTicket(
  capability: string,
  origin: string,
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ nonce: hex(), expiresAt: now + TICKET_TTL_MS, origin }),
  ).toString("base64url");
  return `${payload}.${proof(capability, "bootstrap", payload)}`;
}
const reject = (res: Response) => {
  res.status(401).set("Cache-Control", "no-store").json({
    error:
      "Your local session is missing or has expired. Reopen Coherence using the local launcher, then reconnect this tab. Unsaved edits have not been submitted.",
    code: "SESSION_REQUIRED",
  });
};

export class LocalAuth {
  readonly #capability = hex();
  get capability() {
    return this.#capability;
  }
  private readonly sessions = new Map<
    string,
    { origin: string; expiresAt: number; close: Set<() => void> }
  >();
  private readonly usedTickets = new Map<string, number>();
  constructor(
    private readonly options: {
      now?: () => number;
      sessionTtlMs?: number;
      origins?: string[];
      /** The installed app has no development proxy, so it never accepts a proxied Host port. */
      allowDevProxy?: boolean;
      /** Called after a bootstrap ticket created a session (the launcher's handoff succeeded). */
      onSessionOpened?: () => void;
    } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private allowedOrigin(origin: string) {
    if (!isLiteralLoopbackOrigin(origin)) return false;
    return (
      this.options.origins ?? [
        `http://127.0.0.1:${config.port}`,
        `http://127.0.0.1:${config.devPort}`,
      ]
    ).includes(origin);
  }
  consume(ticket: unknown, requestOrigin: string): BrowserSession | undefined {
    if (typeof ticket !== "string" || ticket.length > 1500) return;
    const [payload, signature, extra] = ticket.split(".");
    if (
      !payload ||
      !signature ||
      extra ||
      !equalSecret(signature, proof(this.capability, "bootstrap", payload))
    )
      return;
    let record: LaunchTicket;
    try {
      record = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as LaunchTicket;
    } catch {
      return;
    }
    const now = this.now();
    for (const [key, expires] of this.usedTickets)
      if (expires <= now) this.usedTickets.delete(key);
    for (const [key, session] of this.sessions)
      if (session.expiresAt <= now) this.revoke(key);
    if (
      !/^[a-f0-9]{64}$/.test(record.nonce) ||
      !Number.isSafeInteger(record.expiresAt) ||
      record.expiresAt <= now ||
      record.expiresAt > now + TICKET_TTL_MS ||
      !this.allowedOrigin(record.origin) ||
      record.origin !== requestOrigin ||
      this.usedTickets.has(record.nonce)
    )
      return;
    if (this.usedTickets.size >= 1024) return;
    this.usedTickets.set(record.nonce, record.expiresAt);
    if (this.sessions.size >= 64)
      this.revoke(this.sessions.keys().next().value!);
    const token = hex();
    const expiresAt = now + (this.options.sessionTtlMs ?? SESSION_TTL_MS);
    this.sessions.set(digest(token), {
      origin: record.origin,
      expiresAt,
      close: new Set(),
    });
    return { token, expiresAt };
  }
  private revoke(key: string) {
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    for (const close of session?.close ?? []) close();
  }
  invalidate() {
    for (const key of this.sessions.keys()) this.revoke(key);
  }
  transportGuard = (req: Request, res: Response, next: NextFunction): void => {
    const host = req.headers.host ?? "";
    if (!isLiteralLoopbackOrigin(`http://${host}`)) {
      res.status(403).json({
        error: "Open Coherence using its verified local launcher at 127.0.0.1.",
        code: "UNVERIFIED_ORIGIN",
      });
      return;
    }
    const port = Number(new URL(`http://${host}`).port || 80);
    // A second local listener cannot impersonate the development proxy by spoofing Host.
    if (
      port !== req.socket.localPort &&
      (this.options.allowDevProxy === false ||
        !equalSecret(
          req.get("X-ScreenScribe-Dev-Proxy") ?? "",
          proof(this.capability, "dev-proxy", host),
        ))
    ) {
      res.status(403).json({
        error: "Unverified local proxy. Restart the V2 development server.",
        code: "UNVERIFIED_PROXY",
      });
      return;
    }
    next();
  };
  guard = (req: Request, res: Response, next: NextFunction): void => {
    // Never accept cookies or query-string credentials. Origin includes the port.
    const match = /^Bearer ([a-f0-9]{64})$/.exec(
      req.get("authorization") ?? "",
    );
    const key = match ? digest(match[1]) : "";
    const session = this.sessions.get(key);
    if (!session || session.expiresAt <= this.now()) {
      if (session) this.revoke(key);
      reject(res);
      return;
    }
    const origin = `http://${req.headers.host}`;
    if (
      session.origin !== origin ||
      (req.get("origin") !== undefined && req.get("origin") !== origin) ||
      ["cross-site", "same-site"].includes(req.get("sec-fetch-site") ?? "")
    ) {
      res.status(403).json({
        error: "Requests must come from the authenticated Coherence origin.",
        code: "CSRF",
      });
      return;
    }
    res.set("Cache-Control", "no-store");
    // Terminate already-open streams at expiry/revocation, not just their next reconnect.
    const close = () => {
      if (!res.writableEnded) res.destroy();
    };
    session.close.add(close);
    const timer = setTimeout(
      () => {
        this.revoke(key);
      },
      Math.max(1, session.expiresAt - this.now()),
    );
    timer.unref();
    res.once("close", () => {
      clearTimeout(timer);
      session.close.delete(close);
    });
    next();
  };
  /** These two bootstrap routes disclose no data and cannot mint a session without the private capability. */
  router() {
    const router = express.Router({ caseSensitive: true });
    router.post("/identity", express.json({ limit: "2kb" }), (req, res) => {
      if (
        req.get("origin") &&
        req.get("origin") !== `http://${req.headers.host}`
      ) {
        res
          .status(403)
          .json({ error: "Foreign launch origin rejected.", code: "CSRF" });
        return;
      }
      const challenge: unknown = req.body?.challenge;
      if (
        req.get("X-ScreenScribe") !== "1" ||
        typeof challenge !== "string" ||
        !/^[a-f0-9]{64}$/.test(challenge)
      ) {
        res.status(400).json({ error: "Invalid launch challenge." });
        return;
      }
      res
        .set("Cache-Control", "no-store")
        .json({ proof: proof(this.capability, "identity", challenge) });
    });
    router.post(
      "/bootstrap",
      express.urlencoded({ extended: false, limit: "2kb" }),
      (req, res) => {
        const target = `http://${req.headers.host}`;
        const source = req.get("origin");
        // The private local HTML launcher posts a one-use ticket via a top-level file navigation.
        if (source !== undefined && source !== "null" && source !== target) {
          reject(res);
          return;
        }
        const session = this.consume(req.body?.ticket, target);
        if (!session) {
          reject(res);
          return;
        }
        this.options.onSessionOpened?.();
        const nonce = randomBytes(18).toString("base64");
        res.set({
          "Cache-Control": "no-store",
          "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
        });
        res
          .type("html")
          .send(
            `<!doctype html><html><head><meta charset="utf-8"><title>Opening Coherence</title></head><body><p id="message">Opening your local workspace…</p><script nonce="${nonce}">try { localStorage.setItem(${JSON.stringify(SESSION_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(session))}); location.replace('/'); } catch { document.getElementById('message').textContent = 'Allow local browser storage for Coherence and reopen it using the local launcher.'; }</script></body></html>`,
          );
      },
    );
    return router;
  }
}
