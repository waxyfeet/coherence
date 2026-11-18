import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** Fresh module state per test: closing is process-wide by design. */
async function serve() {
  vi.resetModules();
  const inflight = await import("./inflight");
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const app = express();
  app.use(inflight.trackRequests);
  app.get("/read", (_req, res) => void res.json({ ok: true }));
  app.post("/change", async (_req, res) => {
    await held;
    res.json({ saved: true });
  });
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { inflight, release, origin };
}

it("lets a change already sent finish before shutdown continues, and refuses new requests meanwhile", async () => {
  const { inflight, release, origin } = await serve();
  expect(await inflight.drainChanges(10)).toBe(true);
  const change = fetch(`${origin}/change`, { method: "POST" });
  await vi.waitFor(async () =>
    expect(await inflight.drainChanges(5)).toBe(false),
  );

  inflight.beginClosing();
  const refused = await fetch(`${origin}/read`);
  expect(refused.status).toBe(503);
  expect(await refused.json()).toMatchObject({ code: "CLOSING" });

  const drained = inflight.drainChanges(5_000);
  release();
  expect(await (await change).json()).toEqual({ saved: true });
  expect(await drained).toBe(true);
});

it("stops waiting after the bound when a change does not finish", async () => {
  const { inflight, release, origin } = await serve();
  const change = fetch(`${origin}/change`, { method: "POST" });
  await vi.waitFor(async () =>
    expect(await inflight.drainChanges(5)).toBe(false),
  );
  const started = Date.now();
  expect(await inflight.drainChanges(200)).toBe(false);
  expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  release();
  await change;
});

it("does not count reads, so an open event stream never delays shutdown", async () => {
  const { inflight, origin } = await serve();
  await fetch(`${origin}/read`);
  expect(await inflight.drainChanges(10)).toBe(true);
});
