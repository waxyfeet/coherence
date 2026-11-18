import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { useTempDataDir, removeDir } from "../storage/testUtils";
import { LocalAuth, makeTicket } from "./localAuth";
import type { BrowserSession } from "@shared/localAuth";

let dir: string;
let launcher: typeof import("./localLauncher");
let claim: import("../storage/instanceLock").InstanceLock;
beforeAll(async () => {
  dir = await useTempDataDir("s02-ipv4-continuity");
  vi.resetModules();
  launcher = await import("./localLauncher");
  claim = await (await import("../storage/instanceLock")).acquireInstanceLock();
});
afterAll(async () => {
  await claim?.();
  await removeDir(dir);
});

/** Resolve localhost to the separately owned IPv6 socket, without changing process/OS DNS. */
function browserRequest(
  origin: string,
  pathname: string,
  options: { body?: string; token?: string; host?: string } = {},
): Promise<{ status: number; body: string }> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname === "localhost" ? "::1" : url.hostname,
        port: Number(url.port),
        path: pathname,
        method: options.body === undefined ? "GET" : "POST",
        headers: {
          Host: options.host ?? url.host,
          ...(options.token
            ? { Authorization: `Bearer ${options.token}` }
            : {}),
          ...(options.body === undefined
            ? {}
            : {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(options.body),
                Origin: "null",
              }),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}
function bootstrapSession(html: string): BrowserSession | undefined {
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) return;
  let session: BrowserSession | undefined;
  // Only the genuine app's synthetic bootstrap script is executed. Never run external content.
  vm.runInNewContext(
    script,
    {
      localStorage: {
        setItem: (_key: string, value: string) => {
          session = JSON.parse(value) as BrowserSession;
        },
      },
      location: { replace() {} },
    },
    { timeout: 1000 },
  );
  return session;
}

it("S02-V1: an IPv6-first localhost relay cannot intercept or reuse the real launcher's session", async () => {
  const { createApp } = await import("../app");
  const store = await import("../storage/projectStore");
  await store.ensureDataDirs();
  const project = await store.createProject({
    name: "Private IPv4-only fixture",
    description: "S02_LITERAL_ADDRESS_ONLY",
  });
  const origins: string[] = [];
  const auth = new LocalAuth({ origins });
  const genuine = http.createServer(createApp(auth));
  const relayed: string[] = [],
    captured: BrowserSession[] = [];
  let cleanup: (() => Promise<void>) | undefined;
  const relay = http.createServer((req, res) => {
    relayed.push(req.url ?? "");
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: (genuine.address() as { port: number }).port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        const buffers: Buffer[] = [];
        response.on("data", (chunk: Buffer) => buffers.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(buffers);
          if (req.url === "/api/auth/bootstrap") {
            const session = bootstrapSession(body.toString("utf8"));
            if (session) captured.push(session);
          }
          res.writeHead(response.statusCode!, response.headers);
          res.end(body);
        });
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  try {
    await new Promise<void>((resolve) =>
      genuine.listen(0, "127.0.0.1", resolve),
    );
    const port = (genuine.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`,
      hostname = `http://localhost:${port}`;
    // Deliberately include the old alias in the fixture allow-list; production must still refuse it.
    origins.push(base, hostname);
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen({ host: "::1", port, ipv6Only: true }, resolve);
    });
    expect([401, 403]).toContain(
      (await browserRequest(hostname, "/api/projects")).status,
    );
    relayed.length = 0;
    cleanup = await launcher.publishLaunchRecord(auth.capability, port, claim);
    const handoff = await launcher.prepareBrowserLaunch(false);
    const html = await fs.readFile(handoff.file, "utf8");
    const ticket = /name="ticket" value="([^"]+)"/.exec(html)![1];
    const response = await browserRequest(
      handoff.origin,
      "/api/auth/bootstrap",
      { body: new URLSearchParams({ ticket }).toString() },
    );
    expect(response.status).toBe(200);
    const session = bootstrapSession(response.body)!;
    expect(session).toBeDefined();
    expect(
      (
        await browserRequest(handoff.origin, `/api/projects/${project.id}`, {
          token: session.token,
        })
      ).status,
    ).toBe(200);
    const stolen = captured[0]?.token ?? "0".repeat(64);
    const attackerRead = await browserRequest(
      base,
      `/api/projects/${project.id}`,
      { host: new URL(handoff.origin).host, token: stolen },
    );
    // This was HTTP 200 before the fix; do not put captured synthetic credentials in assertions/logs.
    expect(attackerRead.status).toBe(401);
    expect(relayed).toHaveLength(0);
    expect(captured).toHaveLength(0);
    expect(handoff.origin).toBe(base);
    expect(html).toContain(`action="${base}/api/auth/bootstrap"`);
  } finally {
    auth.invalidate();
    relay.closeAllConnections();
    genuine.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => relay.close(() => r())),
      new Promise<void>((r) => genuine.close(() => r())),
    ]);
    await cleanup?.();
  }
});

it.each([
  "http://localhost:4417",
  "http://[::1]:4417",
  "http://127.1:4417",
  "http://2130706433:4417",
  "https://127.0.0.1:4417",
  "http://127.0.0.1:04417",
  "http://127.0.0.1:4417/",
  "http://user:secret@127.0.0.1:4417",
  "http://127.0.0.1:65536",
])(
  "rejects an ambiguous/noncanonical authentication target before network use: %s",
  async (origin) => {
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(Error("Unexpected network request"));
    try {
      await expect(
        launcher.verifyLocalServer("a".repeat(64), origin),
      ).rejects.toThrow("literal IPv4");
      expect(transport).not.toHaveBeenCalled();
      expect(() =>
        launcher.bootstrapHtml(makeTicket("a".repeat(64), origin), origin),
      ).toThrow("launch target");
      const auth = new LocalAuth({ origins: [origin] });
      expect(
        auth.consume(makeTicket(auth.capability, origin), origin),
      ).toBeUndefined();
    } finally {
      transport.mockRestore();
    }
  },
);
