/**
 * Lets shutdown finish what users already sent (installer report LC-10): once closing, new requests get 503, and
 * shutdown waits a bounded time for changes that are already in progress before connections are cut.
 */
import type { NextFunction, Request, Response } from "express";

let closing = false;
let active = 0;
const idle = new Set<() => void>();

export function trackRequests(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (closing) {
    res.status(503).set("Connection", "close").json({
      error: "Coherence is closing. Open it again to continue.",
      code: "CLOSING",
    });
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    next();
    return;
  }
  active++;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (--active === 0) for (const done of idle) done();
  };
  res.once("finish", finish);
  res.once("close", finish);
  next();
}

export function beginClosing(): void {
  closing = true;
}

/** Resolves true when no change is in progress, or false after `ms`. */
export function drainChanges(ms: number): Promise<boolean> {
  if (!active) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      idle.delete(done);
      resolve(true);
    };
    const timer = setTimeout(() => {
      idle.delete(done);
      resolve(false);
    }, ms);
    timer.unref();
    idle.add(done);
  });
}
