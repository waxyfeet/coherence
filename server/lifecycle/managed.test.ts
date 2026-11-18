import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { afterAll, expect, it } from "vitest";

// The launcher contract (installer report §3.4), exercised against the real server started with --managed.
const cleanup: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const step of cleanup.reverse()) await step();
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function blockPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}
async function profile(label: string) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), `coherence-test-${label}-`),
  );
  cleanup.push(() =>
    fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    }),
  );
  return {
    data: path.join(dir, "profile"),
    workspace: path.join(dir, "workspace"),
  };
}

type ControlEvent = { event: string; [key: string]: unknown };
function startManaged(
  folders: { data: string; workspace: string },
  ports: number[],
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("SCREENSCRIBE_V2_"),
    ),
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "server/index.ts", "--managed", ...extraArgs],
    {
      cwd: process.cwd(),
      env: {
        ...env,
        SCREENSCRIBE_V2_DATA_DIR: folders.data,
        SCREENSCRIBE_V2_WORKSPACE_DIR: folders.workspace,
        SCREENSCRIBE_V2_PORT: ports.join(","),
        ...extraEnv,
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const events: ControlEvent[] = [];
  const stray: string[] = [];
  let stderr = "";
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.startsWith("@coherence ")) events.push(JSON.parse(line.slice(11)));
    else stray.push(line);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  cleanup.push(async () => {
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
  });
  const next = async (event: string, after = 0, timeoutMs = 45_000) => {
    const started = Date.now();
    for (;;) {
      const found = events.slice(after).find((e) => e.event === event);
      if (found) return found;
      if (child.exitCode !== null || Date.now() - started > timeoutMs)
        throw Error(
          `No "${event}" event. Server output:\n${stderr.slice(-1500)}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const send = (command: unknown) =>
    child.stdin.write(`${JSON.stringify(command)}\n`);
  return { child, events, stray, exited, next, send, stderr: () => stderr };
}

/** Raw HTTP, so the Host header can name another port as a development proxy would. */
function rawRequest(
  port: number,
  method: string,
  route: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: route, headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body: text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
const proof = (key: string, purpose: string, value: string) =>
  createHmac("sha256", key).update(`${purpose}\n${value}`).digest("hex");

it(
  "starts on a free candidate port, opens sessions over stdio and stops gracefully when the launcher goes",
  { timeout: 180_000 },
  async () => {
    const folders = await profile("managed");
    const blocked = await blockPort();
    const fallback = await freePort();
    const app = startManaged(folders, [blocked, fallback]);
    const ready = await app.next("ready");
    expect(ready.origin).toBe(`http://127.0.0.1:${fallback}`);
    const origin = String(ready.origin);

    app.send({ op: "status" });
    expect(await app.next("status")).toMatchObject({
      ready: true,
      activeJobs: 0,
      origin,
    });
    app.send("not a command");
    expect(await app.next("error")).toMatchObject({ code: "UNKNOWN_COMMAND" });

    // The launcher's handoff: a one-use bootstrap page in the owner-only folder; posting its ticket opens a session.
    app.send({ op: "open" });
    const file = String((await app.next("bootstrap")).file);
    expect(path.dirname(file)).toBe(path.join(folders.data, ".local-auth"));
    expect(path.basename(file)).toMatch(/^bootstrap-[a-f0-9]+\.html$/);
    const ticket = /name="ticket" value="([^"]+)"/.exec(
      await fs.readFile(file, "utf8"),
    )![1];
    const bootstrap = await fetch(`${origin}/api/auth/bootstrap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "null",
      },
      body: new URLSearchParams({ ticket }),
    });
    const token = /token\\":\\"([a-f0-9]{64})/.exec(
      await bootstrap.text(),
    )?.[1];
    expect(token).toBeTruthy();
    await app.next("session-opened");

    // An in-app Quit only asks the launcher.
    const quit = await fetch(`${origin}/api/app/quit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-ScreenScribe": "1" },
    });
    expect(quit.status).toBe(202);
    await app.next("quit-requested");

    // Production mode has no development UI: its address cannot open a session even with every secret in hand
    // (a valid ticket for that origin and a valid development-proxy proof), and a forged proof fails the same way.
    const { capability } = JSON.parse(
      await fs.readFile(
        path.join(folders.data, ".local-auth", "launch.json"),
        "utf8",
      ),
    );
    const devHost = "127.0.0.1:5417";
    const payload = Buffer.from(
      JSON.stringify({
        nonce: randomBytes(32).toString("hex"),
        expiresAt: Date.now() + 60_000,
        origin: `http://${devHost}`,
      }),
    ).toString("base64url");
    for (const proxyProof of [
      proof(capability, "dev-proxy", devHost),
      randomBytes(32).toString("hex"),
    ]) {
      const proxied = await rawRequest(
        fallback,
        "POST",
        "/api/auth/bootstrap",
        {
          Host: devHost,
          Origin: "null",
          "Content-Type": "application/x-www-form-urlencoded",
          "X-ScreenScribe-Dev-Proxy": proxyProof,
        },
        new URLSearchParams({
          ticket: `${payload}.${proof(capability, "bootstrap", payload)}`,
        }).toString(),
      );
      expect(proxied.status).toBe(403);
      expect(proxied.body).toContain("UNVERIFIED_PROXY");
    }

    // A second copy on the same profile explains itself instead of failing generically.
    const second = startManaged(folders, [await freePort()]);
    expect(await second.exited).toBe(2);
    expect(second.events).toContainEqual({
      event: "error",
      code: "ALREADY_RUNNING",
    });

    // stdin closing means the launcher is gone: shut down gracefully and release everything.
    const before = app.events.length;
    app.child.stdin.end();
    expect(await app.next("stopping", before)).toMatchObject({
      reason: "launcher-gone",
    });
    expect(await app.exited).toBe(0);
    for (const name of [
      ".instance-lock.json",
      path.join(".local-auth", "launch.json"),
    ])
      await expect(fs.access(path.join(folders.data, name))).rejects.toThrow();
    expect(app.stray).toEqual([]);
  },
);

it(
  "stops on the launcher's shutdown command and refuses damaged, newer or foreign profiles with their own exit codes",
  { timeout: 240_000 },
  async () => {
    const folders = await profile("managed-codes");
    const app = startManaged(folders, [await freePort()]);
    await app.next("ready");
    app.send({ op: "shutdown" });
    expect(await app.next("stopping")).toMatchObject({ reason: "launcher" });
    expect(await app.exited).toBe(0);

    const refuses = async (
      target: { data: string; workspace: string },
      code: string,
      exitCode: number,
    ) => {
      const run = startManaged(target, [await freePort()]);
      expect(await run.exited, run.stderr()).toBe(exitCode);
      expect(run.events).toContainEqual({ event: "error", code });
      expect(run.stray).toEqual([]);
    };
    // Settings saved by a newer Coherence: refused, and the file is left exactly as it was.
    const settings = path.join(folders.data, "settings.json");
    const original = await fs.readFile(settings, "utf8");
    const newer = JSON.stringify({ ...JSON.parse(original), version: 99 });
    await fs.writeFile(settings, newer);
    await refuses(folders, "DATA_NEWER", 17);
    expect(await fs.readFile(settings, "utf8")).toBe(newer);
    await fs.writeFile(settings, original);

    // A damaged lock record is never guessed at or removed.
    const lock = path.join(folders.data, ".instance-lock.json");
    await fs.writeFile(lock, "not-json");
    await refuses(folders, "PROFILE_INVALID", 11);
    expect(await fs.readFile(lock, "utf8")).toBe("not-json");

    // A new profile folder that already holds someone else's files is not adopted.
    const foreign = await profile("managed-foreign");
    await fs.mkdir(foreign.data, { recursive: true });
    await fs.writeFile(path.join(foreign.data, "notes.txt"), "mine");
    await refuses(foreign, "PROFILE_NOT_EMPTY", 12);
    expect(await fs.readdir(foreign.data)).toEqual(["notes.txt"]);
  },
);

it(
  "uses a restored or copied profile only when asked to, and never changes a refused one",
  { timeout: 180_000 },
  async () => {
    const original = await profile("managed-restored");
    const first = startManaged(original, [await freePort()]);
    await first.next("ready");
    first.child.stdin.end();
    expect(await first.exited).toBe(0);
    // A backup restored to another place: same files, new folder identity.
    const restored = {
      data: original.data + "-restored",
      workspace: original.workspace,
    };
    await fs.cp(original.data, restored.data, { recursive: true });
    cleanup.push(() =>
      fs.rm(restored.data, { recursive: true, force: true, maxRetries: 10 }),
    );
    const record = path.join(restored.data, ".coherence-global.json");
    const before = await fs.readFile(record, "utf8");

    const refused = startManaged(restored, [await freePort()]);
    expect(await refused.exited, refused.stderr()).toBe(30);
    expect(refused.events).toContainEqual({
      event: "error",
      code: "PROFILE_RESTORED",
    });
    expect(await fs.readFile(record, "utf8")).toBe(before);

    const adopted = startManaged(restored, [await freePort()], {}, [
      "--adopt-restored-profile",
    ]);
    await adopted.next("ready");
    const owner = JSON.parse(await fs.readFile(record, "utf8"));
    expect(owner.identity).not.toBe(JSON.parse(before).identity);
    expect(owner.adoptedFrom).toBe(JSON.parse(before).identity);
    adopted.child.stdin.end();
    expect(await adopted.exited).toBe(0);

    // From now on it is simply this folder's profile: no flag needed.
    const again = startManaged(restored, [await freePort()]);
    await again.next("ready");
    again.child.stdin.end();
    expect(await again.exited).toBe(0);

    // A record from a newer Coherence is refused as such, flag or not, and left alone.
    const newer = JSON.stringify({ ...owner, version: 2 });
    await fs.writeFile(record, newer);
    const future = startManaged(restored, [await freePort()], {}, [
      "--adopt-restored-profile",
    ]);
    expect(await future.exited).toBe(17);
    expect(await fs.readFile(record, "utf8")).toBe(newer);
  },
);

it(
  "removes temporaries orphaned by an interrupted write when it next starts",
  { timeout: 120_000 },
  async () => {
    const folders = await profile("managed-orphans");
    const first = startManaged(folders, [await freePort()]);
    await first.next("ready");
    first.child.stdin.end();
    expect(await first.exited).toBe(0);
    const orphan = path.join(folders.data, "settings.json.tmp-0123456789ab");
    await fs.writeFile(orphan, '{"half":');
    const second = startManaged(folders, [await freePort()]);
    await second.next("ready");
    await expect(fs.access(orphan)).rejects.toThrow();
    second.child.stdin.end();
    expect(await second.exited).toBe(0);
  },
);

it(
  "shuts down gracefully when the launcher dies and takes all three pipes with it",
  { timeout: 120_000 },
  async () => {
    // A crashed launcher closes stdin, stdout and stderr together: shutdown logging then hits broken pipes.
    const folders = await profile("managed-orphan");
    const app = startManaged(folders, [await freePort()]);
    await app.next("ready");
    app.child.stdout.destroy();
    app.child.stderr.destroy();
    app.child.stdin.destroy();
    expect(await app.exited).toBe(0);
    for (const name of [
      ".instance-lock.json",
      path.join(".local-auth", "launch.json"),
    ])
      await expect(fs.access(path.join(folders.data, name))).rejects.toThrow();
  },
);

it(
  "reports PORT_UNAVAILABLE with its own exit code when every candidate port is taken",
  { timeout: 120_000 },
  async () => {
    const app = startManaged(await profile("managed-ports"), [
      await blockPort(),
      await blockPort(),
    ]);
    expect(await app.exited).toBe(10);
    expect(app.events).toContainEqual({
      event: "error",
      code: "PORT_UNAVAILABLE",
    });
    expect(app.stray).toEqual([]);
  },
);

it(
  "still reports a typed error when the app fails while its modules load",
  { timeout: 120_000 },
  async () => {
    // Configuration is read while modules load; an obsolete layout request makes that fail before any data is touched.
    const folders = await profile("managed-load");
    const app = startManaged(folders, [await freePort()], {
      SCREENSCRIBE_V2_STORAGE_LAYOUT: "legacy",
    });
    expect(await app.exited).toBe(1);
    expect(app.events.map((e) => e.event)).toEqual(["starting", "error"]);
    expect(app.events[1]).toEqual({ event: "error", code: "OTHER" });
    expect(app.stderr()).toMatch(/Coherence failed to start: .*Reference/);
    expect(app.stderr()).not.toContain("no longer supported");
    expect(app.stray).toEqual([]);
    await expect(fs.access(folders.data)).rejects.toThrow();
  },
);
