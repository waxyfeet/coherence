import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalAuth, makeTicket, proof, TICKET_TTL_MS } from "./localAuth";
import { removeDir, useTempDataDir } from "../storage/testUtils";
import { safeDiagnosticValue } from "./diagnostics";

let server: http.Server, base: string, dir: string, imagePath: string;
let claim: import("../storage/instanceLock").InstanceLock;
let now = Date.now();
const origins: string[] = [];
const auth = new LocalAuth({ origins, now: () => now, sessionTtlMs: 5000 });
const h = { "X-ScreenScribe": "1" };
function session() {
  return auth.consume(makeTicket(auth.capability, base, now), base)!;
}
function get(url: string, token?: string, headers?: Record<string, string>) {
  return fetch(base + url, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}
function rawGet(
  host: string,
  token: string,
  extra: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      base + "/api/projects",
      { headers: { Host: host, Authorization: `Bearer ${token}`, ...extra } },
      (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode!));
      },
    );
    req.on("error", reject);
  });
}
beforeAll(async () => {
  dir = await useTempDataDir("s02-auth");
  vi.resetModules();
  claim = await (await import("../storage/instanceLock")).acquireInstanceLock();
  const store = await import("../storage/projectStore");
  await store.ensureDataDirs();
  const project = await (await import("../storage/demo")).createDemoProject();
  imagePath = `/api/projects/${project.id}/screens/${project.screens[0].id}/image`;
  const { createApp } = await import("../app");
  server = http.createServer(createApp(auth));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  origins.push(base);
});
afterAll(async () => {
  auth.invalidate();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await claim?.();
  await removeDir(dir);
});

describe("S02 authenticated local API", () => {
  it.each([
    "/api/health",
    "/api/projects",
    "/api/settings",
    "/api/trash",
    "/api/jobs/job_synthetic",
    "/api/jobs/job_synthetic/events",
    "/api/projects/synthetic/files/raw?path=test.md",
    "/api/projects/synthetic/files/content?path=test.md",
    "/api/projects/synthetic/export/csv",
    "/api/projects/synthetic/screens/scr_test/image",
    "/api/nope",
  ])("rejects unauthenticated reads: %s", async (url) => {
    const res = await get(url);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "SESSION_REQUIRED" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD"])(
    "rejects unauthenticated %s operations even with the static CSRF header",
    async (method) => {
      expect(
        (await fetch(base + "/api/projects", { method, headers: h })).status,
      ).toBe(401);
    },
  );
  it("does not treat cookies, URL parameters or a launch capability as a session", async () => {
    const valid = session();
    expect(
      (
        await get(
          `/api/projects?token=${valid.token}&capability=${auth.capability}`,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await get("/api/projects", undefined, {
          Cookie: `session=${valid.token}`,
        })
      ).status,
    ).toBe(401);
    expect((await get("/api/projects", auth.capability)).status).toBe(401);
    expect((await get("/api/projects", "f".repeat(64))).status).toBe(401);
  });
  it("allows authenticated navigation/read/write and private screenshot bytes without disclosing a capability", async () => {
    const valid = session();
    for (const url of [
      "/api/auth/session",
      "/api/health",
      "/api/projects",
      "/api/settings",
    ]) {
      const res = await get(url, valid.token);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(auth.capability);
      expect(text).not.toContain(valid.token);
    }
    const created = await fetch(base + "/api/projects", {
      method: "POST",
      headers: {
        ...h,
        Authorization: `Bearer ${valid.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "S02 synthetic authenticated write" }),
    });
    expect(created.status).toBe(201);
    expect((await get(imagePath)).status).toBe(401);
    const image = await get(imagePath, valid.token);
    expect(image.status).toBe(200);
    expect(image.headers.get("cache-control")).toBe("no-store");
    expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(100);
  });
  it("proves launch identity without allowing an unrelated caller to acquire a session", async () => {
    const challenge = "1".repeat(64);
    const identity = await fetch(base + "/api/auth/identity", {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ challenge }),
    });
    const result = (await identity.json()) as { proof: string };
    expect(result.proof).toBe(proof(auth.capability, "identity", challenge));
    expect(JSON.stringify(result)).not.toContain(auth.capability);
    for (const ticket of [
      "",
      makeTicket("a".repeat(64), base, now),
      result.proof,
    ]) {
      const rejected = await fetch(base + "/api/auth/bootstrap", {
        method: "POST",
        body: new URLSearchParams({ ticket }),
      });
      expect(rejected.status).toBe(401);
      expect(await rejected.text()).not.toContain(auth.capability);
    }
  });
  it("accepts exactly one short-lived launch ticket, and refuses old, foreign and forged tickets", async () => {
    const ticket = makeTicket(auth.capability, base, now);
    const exchange = () =>
      fetch(base + "/api/auth/bootstrap", {
        method: "POST",
        headers: { Origin: "null" },
        body: new URLSearchParams({ ticket }),
      });
    const res = await exchange();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("localStorage.setItem");
    expect(html).not.toContain(ticket);
    expect(html).not.toContain(auth.capability);
    expect((await exchange()).status).toBe(401);
    expect(
      auth.consume(
        makeTicket(auth.capability, base, now - TICKET_TTL_MS),
        base,
      ),
    ).toBeUndefined();
    expect(
      auth.consume(
        makeTicket(auth.capability, "http://localhost:9999", now),
        base,
      ),
    ).toBeUndefined();
    expect(
      auth.consume(makeTicket(auth.capability, base, now + 100), base),
    ).toBeUndefined();
    expect(
      new LocalAuth({ origins }).consume(
        makeTicket(auth.capability, base, now),
        base,
      ),
    ).toBeUndefined();
  });
  it("retains Host, CSRF, exact Origin and browser fetch-site restrictions on valid sessions", async () => {
    const token = session().token;
    expect(
      (
        await fetch(base + "/api/projects", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
    for (const origin of [
      "https://evil.invalid",
      "http://localhost:9999",
      "null",
    ]) {
      expect(
        (await get("/api/projects", token, { Origin: origin })).status,
      ).toBe(403);
      expect(
        (
          await fetch(base + "/api/projects", {
            method: "POST",
            headers: { ...h, Origin: origin, Authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(403);
    }
    for (const site of ["cross-site", "same-site"])
      expect(
        (await get("/api/projects", token, { "Sec-Fetch-Site": site })).status,
      ).toBe(403);
    expect((await get("/api/projects", token, { Origin: base })).status).toBe(
      200,
    );
    expect(await rawGet("evil.invalid", token)).toBe(403);
  });
  it("refuses a spoofed development proxy and never bootstraps a foreign origin", async () => {
    expect(await rawGet("localhost:5417", session().token)).toBe(403);
    expect(
      await rawGet("localhost:5417", session().token, {
        "X-ScreenScribe-Dev-Proxy": "a".repeat(64),
      }),
    ).toBe(403);
    const res = await fetch(base + "/api/auth/bootstrap", {
      method: "POST",
      headers: { Origin: "https://evil.invalid" },
      body: new URLSearchParams({
        ticket: makeTicket(auth.capability, base, now),
      }),
    });
    expect(res.status).toBe(401);
  });
  it("rejects expired and explicitly invalidated sessions and closes open responses on revocation", async () => {
    const valid = session();
    now += 5001;
    expect((await get("/api/projects", valid.token)).status).toBe(401);
    const current = session();
    expect((await get("/api/projects", current.token)).status).toBe(200);
    auth.invalidate();
    expect((await get("/api/projects", current.token)).status).toBe(401);
  });
  it.each(["expiry", "invalidation"])(
    "closes an already-authenticated SSE stream on %s",
    async (mode) => {
      const { createApp } = await import("../app");
      const streamOrigins: string[] = [];
      const streamAuth = new LocalAuth({
        origins: streamOrigins,
        sessionTtlMs: mode === "expiry" ? 300 : 5000,
      });
      const app = createApp(streamAuth);
      // Protected probe uses the real API middleware, without starting model/provider work.
      // apiNotFound terminates unknown routes, so mount a known live synthetic job instead.
      const jobs = await import("../jobs/jobManager");
      const store = await import("../storage/projectStore");
      const project = await store.createProject({
        name: "Synthetic stream " + mode,
        description: "Synthetic authentication fixture",
      });
      let finish!: () => void;
      const job = await jobs.startJob(
        "export",
        project.id,
        () =>
          new Promise<void>((r) => {
            finish = r;
          }),
      );
      const temporary = http.createServer(app);
      await new Promise<void>((r) => temporary.listen(0, "127.0.0.1", r));
      const origin = `http://127.0.0.1:${(temporary.address() as { port: number }).port}`;
      streamOrigins.push(origin);
      const valid = streamAuth.consume(
        makeTicket(streamAuth.capability, origin),
        origin,
      )!;
      const response = await fetch(origin + `/api/jobs/${job.id}/events`, {
        headers: { Authorization: `Bearer ${valid.token}` },
      });
      const reader = response.body!.getReader();
      expect(response.status).toBe(200);
      expect((await reader.read()).done).toBe(false);
      if (mode === "invalidation") streamAuth.invalidate();
      let ended = false;
      try {
        while (!(await reader.read()).done) {
          /* drain until the authenticated stream closes */
        }
        ended = true;
      } catch {
        ended = true;
      }
      expect(ended).toBe(true);
      expect(
        (
          await fetch(origin + `/api/jobs/${job.id}/events`, {
            headers: { Authorization: `Bearer ${valid.token}` },
          })
        ).status,
      ).toBe(401);
      finish();
      await jobs.waitForJob(job.id);
      streamAuth.invalidate();
      temporary.closeAllConnections();
      await new Promise<void>((r) => temporary.close(() => r()));
    },
  );
  it("omits authentication fields from diagnostic serialization and keeps launch capabilities non-enumerable", () => {
    const valid = session();
    const diagnostic = JSON.stringify(
      safeDiagnosticValue({
        capability: auth.capability,
        session: valid,
        token: valid.token,
        ticket: makeTicket(auth.capability, base, now),
        authorization: `Bearer ${valid.token}`,
      }),
    );
    expect(diagnostic).not.toContain(auth.capability);
    expect(diagnostic).not.toContain(valid.token);
    expect(JSON.stringify(auth)).not.toContain(auth.capability);
  });
  it("creates an owner-only launch directory and verifies server identity before launching", async () => {
    const { publishLaunchRecord, verifyLocalServer, bootstrapHtml } =
      await import("./localLauncher");
    const folder = path.join(dir, ".local-auth");
    const cleanup = await publishLaunchRecord(
      auth.capability,
      Number(new URL(base).port),
      claim,
    );
    const manifest = JSON.parse(
      await fs.readFile(path.join(folder, "launch.json"), "utf8"),
    );
    expect(manifest.capability).toBe(auth.capability);
    if (process.platform === "win32") {
      const script =
        "$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $d=[System.IO.Directory]::GetAccessControl($p); $f=[System.IO.File]::GetAccessControl([System.IO.Path]::Combine($p,'launch.json')); $ok=$d.AreAccessRulesProtected -and ($d.Owner -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().Name); foreach($acl in @($d,$f)) { foreach($rule in $acl.Access) { if($rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid) {$ok=$false} } }; [Console]::Out.Write($ok)";
      const result = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
        );
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0
            ? resolve(output)
            : reject(Error("ACL verification failed")),
        );
        child.stdin.end(folder);
      });
      expect(result).toBe("True");
    } else {
      expect((await fs.stat(folder)).mode & 0o777).toBe(0o700);
      expect(
        (await fs.stat(path.join(folder, "launch.json"))).mode & 0o777,
      ).toBe(0o600);
    }
    await verifyLocalServer(auth.capability, base);
    await expect(verifyLocalServer("0".repeat(64), base)).rejects.toThrow(
      "verified",
    );
    const html = bootstrapHtml(makeTicket(auth.capability, base, now), base);
    expect(html).not.toContain(auth.capability);
    expect(html).toContain(`action="${base}/api/auth/bootstrap"`);
    await cleanup();
    await expect(fs.stat(path.join(folder, "launch.json"))).rejects.toThrow();
  });
});
