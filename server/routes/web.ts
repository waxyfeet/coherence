/**
 * OWNER: server-core builder.
 * Serves the built web UI (dist/web) with an SPA fallback: any non-/api GET without a file extension gets
 * index.html so React Router can handle deep links. When the UI is not built yet, a small help page explains
 * what to run.
 */
import fs from "node:fs";
import path from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { API_PREFIX } from "@shared/api";
import { APP_VERSION, config } from "../config";

const NOT_BUILT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coherence</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; margin: 0; }
  main { max-width: 560px; margin: 12vh auto; padding: 32px; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; }
  h1 { font-size: 20px; margin: 0 0 12px; color: #4338ca; }
  code { background: #eef2ff; padding: 2px 6px; border-radius: 4px; }
  p { line-height: 1.6; }
</style>
</head>
<body>
<main>
  <h1>Coherence ${APP_VERSION} — the server is running</h1>
  <p>The web interface has not been built yet.</p>
  <p>Run <code>npm run build</code> and reload this page, or use <code>npm run dev</code> for development
  (the UI is then served at <code>http://127.0.0.1:5417</code>).</p>
  <p>The API is available under <code>/api</code> (try <a href="/api/health">/api/health</a>).</p>
</main>
</body>
</html>`;

function isApiPath(p: string): boolean {
  return p === API_PREFIX || p.startsWith(`${API_PREFIX}/`);
}

/**
 * S08: the page holds the session token, so only this origin's scripts may run. The bundle needs no eval;
 * inline styles stay allowed for React, Mermaid and KaTeX; the elk layout runs in a Worker.
 */
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function webRouter(): express.Router {
  const router = express.Router();

  router.use(
    express.static(config.webDistDir, {
      index: false,
      setHeaders(res, filePath) {
        // Vite fingerprints everything under /assets, so those files never change.
        const rel = path.relative(config.webDistDir, filePath).split(path.sep);
        res.setHeader(
          "Cache-Control",
          rel[0] === "assets"
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
        if (filePath.endsWith(".html"))
          res.setHeader("Content-Security-Policy", PAGE_CSP);
      },
    }),
  );

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (
      (req.method !== "GET" && req.method !== "HEAD") ||
      isApiPath(req.path)
    ) {
      next();
      return;
    }
    // A missing /assets/x.js must 404, not return HTML (that would surface as a confusing script error).
    if (path.posix.extname(req.path) && !req.path.endsWith(".html")) {
      next();
      return;
    }
    res.set({
      "Cache-Control": "no-cache",
      "Content-Security-Policy": PAGE_CSP,
    });
    if (fs.existsSync(path.join(config.webDistDir, "index.html"))) {
      res.sendFile("index.html", { root: config.webDistDir });
      return;
    }
    res.status(200).type("html").send(NOT_BUILT_PAGE);
  });

  return router;
}
