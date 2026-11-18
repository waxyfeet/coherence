import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { removeDir, useTempDataDir } from "./testUtils";

let dir: string;
let locks: typeof import("./instanceLock");
let launcher: typeof import("../security/localLauncher");
beforeAll(async () => {
  dir = await useTempDataDir("ownership");
  vi.resetModules();
  locks = await import("./instanceLock");
  launcher = await import("../security/localLauncher");
});
afterAll(async () => {
  await removeDir(dir);
});

it("refuses a forged ownership handle before touching protected launcher files", async () => {
  await expect(
    launcher.prepareLaunchDirectory(async () => {}),
  ).rejects.toThrow();
  expect(await fs.readdir(dir)).toEqual([]);
});
it("retains OS exclusion even if diagnostic metadata is removed", async () => {
  const claim = await locks.acquireInstanceLock();
  try {
    await fs.rm(path.join(dir, ".instance-lock.json"));
    await expect(locks.acquireInstanceLock()).rejects.toThrow(
      "Another V2 process",
    );
  } finally {
    await claim();
  }
});
it("drains launcher mutations before releasing, rejects new work, and release is idempotent", async () => {
  const claim = await locks.acquireInstanceLock();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const mutation = locks.withInstanceLock(claim, () => gate);
  const release = claim();
  try {
    await expect(locks.withInstanceLock(claim, async () => {})).rejects.toThrow(
      "ownership",
    );
    await expect(locks.acquireInstanceLock()).rejects.toThrow(
      "Another V2 process",
    );
  } finally {
    finish();
    await mutation;
    await release;
  }
  const replacement = await locks.acquireInstanceLock();
  try {
    const bytes = await fs.readFile(
      path.join(dir, ".instance-lock.json"),
      "utf8",
    );
    await claim();
    expect(
      await fs.readFile(path.join(dir, ".instance-lock.json"), "utf8"),
    ).toBe(bytes);
  } finally {
    await replacement();
  }
});
it("revokes prepared publishers and cleanup closures before a replacement owner prepares", async () => {
  const first = await locks.acquireInstanceLock();
  const publish = await launcher.prepareLaunchDirectory(first);
  const cleanup = await publish("a".repeat(64), 4417);
  await first();
  const next = await locks.acquireInstanceLock();
  try {
    const nextCleanup = await (
      await launcher.prepareLaunchDirectory(next)
    )("b".repeat(64), 4418);
    try {
      const file = path.join(dir, ".local-auth/launch.json");
      const bytes = await fs.readFile(file, "utf8");
      await expect(publish("a".repeat(64), 4417)).rejects.toThrow();
      await expect(cleanup()).rejects.toThrow();
      await expect(launcher.prepareLaunchDirectory(first)).rejects.toThrow();
      expect((await fs.readFile(file, "utf8")) === bytes).toBe(true);
    } finally {
      await nextCleanup();
    }
  } finally {
    await next();
  }
});
it("refuses live legacy PID claims, malformed claims and claim junctions without deleting them", async () => {
  const file = path.join(dir, ".instance-lock.json");
  for (const bytes of [
    JSON.stringify({ pid: process.pid }),
    "not-json",
    "null",
  ]) {
    await fs.writeFile(file, bytes);
    await expect(locks.acquireInstanceLock()).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(bytes);
    await fs.rm(file);
  }
  await fs.symlink(dir, file, "junction");
  await expect(locks.acquireInstanceLock()).rejects.toThrow("invalid");
  expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
  await fs.unlink(file);
  const claim = await locks.acquireInstanceLock();
  await claim();
});

it("replaces stale pipe-era claims, empty torn claims and PID-only claims of protected processes", async () => {
  const file = path.join(dir, ".instance-lock.json");
  for (const bytes of [
    // A crash left the claim behind and its PID now belongs to a live process (here: this test).
    JSON.stringify({
      pid: process.pid,
      nonce: "00000000-0000-4000-8000-000000000000",
      createdAt: "2026-11-02T00:00:00.000Z",
    }),
    "",
    JSON.stringify({ pid: process.platform === "win32" ? 4 : 1 }),
  ]) {
    await fs.writeFile(file, bytes);
    await fs.writeFile(`${file}.11111111-1111-4111-8111-111111111111.tmp`, "{");
    const claim = await locks.acquireInstanceLock();
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    expect(saved.pid).toBe(process.pid);
    expect(saved.nonce).not.toBe("00000000-0000-4000-8000-000000000000");
    expect((await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual(
      [],
    );
    await claim();
  }
});

it("adopts a fresh profile whose first claim was interrupted before its rename", async () => {
  const fresh = await useTempDataDir("ownership-interrupted");
  try {
    await fs.writeFile(path.join(fresh, ".coherence-global.json.tmp"), "");
    await fs.writeFile(path.join(fresh, ".instance-lock.json"), "");
    vi.resetModules();
    const freshLocks = await import("./instanceLock");
    const claim = await freshLocks.acquireInstanceLock();
    const owner = JSON.parse(
      await fs.readFile(path.join(fresh, ".coherence-global.json"), "utf8"),
    );
    expect(owner).toMatchObject({
      format: "screenscribe-v2-global",
      version: 1,
    });
    expect((await fs.readdir(fresh)).sort()).toEqual([
      ".coherence-global.json",
      ".instance-lock.json",
    ]);
    await claim();
  } finally {
    await removeDir(fresh);
  }
});

it("claims again a profile left with only an empty ownership record, but refuses one that holds data", async () => {
  const fresh = await useTempDataDir("ownership-torn");
  try {
    const record = path.join(fresh, ".coherence-global.json");
    await fs.writeFile(record, "");
    await fs.writeFile(path.join(fresh, "settings.json"), "{}");
    vi.resetModules();
    let freshLocks = await import("./instanceLock");
    await expect(freshLocks.acquireInstanceLock()).rejects.toMatchObject({
      code: "PROFILE_INVALID",
    });
    expect(await fs.readFile(record, "utf8")).toBe("");

    await fs.rm(path.join(fresh, "settings.json"));
    vi.resetModules();
    freshLocks = await import("./instanceLock");
    const claim = await freshLocks.acquireInstanceLock();
    expect(JSON.parse(await fs.readFile(record, "utf8"))).toMatchObject({
      format: "screenscribe-v2-global",
      version: 1,
    });
    await claim();
  } finally {
    await removeDir(fresh);
  }
});
