/**
 * OWNER: server-core builder.
 * Express application: security guards → JSON API → built web UI → error handler.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { API_PREFIX } from "@shared/api";
import { apiNotFound, errorHandler } from "./middleware/errorHandler";
import { csrfGuard, hostGuard } from "./middleware/security";
import { apiRouter } from "./routes";
import { webRouter } from "./routes/web";
import { LocalAuth } from "./security/localAuth";
import { trackRequests } from "./lifecycle/inflight";

export const JSON_BODY_LIMIT = "5mb";

function securityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    // Other sites must not embed our screen images or API responses.
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
  next();
}

export function createApp(auth = new LocalAuth()): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  // The API lives at /api exactly, so path checks elsewhere (web router, guards) agree with the routing.
  // Must be set before the first app.use, which creates the app router.
  app.set("case sensitive routing", true);

  app.use(hostGuard);
  app.use(trackRequests);
  app.use(securityHeaders);
  app.use(API_PREFIX, auth.transportGuard);
  // Only one-use capability-proven bootstrap is exempt from the ordinary session/CSRF guards.
  // Neither public endpoint exposes workspace data or returns the per-launch capability.
  app.use("/api/auth", auth.router());
  app.use(csrfGuard);

  app.use(API_PREFIX, auth.guard);
  app.get("/api/auth/session", (_req, res) => {
    res.json({ authenticated: true });
  });
  app.use(API_PREFIX, express.json({ limit: JSON_BODY_LIMIT }));
  app.use(API_PREFIX, apiRouter());
  app.use(API_PREFIX, apiNotFound);

  app.use(webRouter());
  app.use(errorHandler);
  return app;
}
