import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { removeDir, useTempDataDir } from "../storage/testUtils";
import { LauncherError, launcherFailureMessage } from "./launcherErrors";

const browser = vi.hoisted(() => vi.fn());
vi.mock("open", () => ({ default: browser }));
let dir: string;
let launcher: typeof import("./localLauncher");
let claim: import("../storage/instanceLock").InstanceLock;
let errors: typeof import("./launcherErrors");
const capability = "a".repeat(64);
const hostile =
  "synthetic-private-error-529 C:\\private\\sensitive-path " + "b".repeat(64);
const folder = () => path.join(dir, ".local-auth");
const manifest = () => path.join(folder(), "launch.json");
beforeAll(async () => {
  dir = await useTempDataDir("startup-readiness");
  vi.resetModules();
  launcher = await import("./localLauncher");
  claim = await (await import("../storage/instanceLock")).acquireInstanceLock();
  errors = await import("./launcherErrors");
});
afterEach(async () => {
  vi.restoreAllMocks();
  browser.mockReset();
  await fs.rm(folder(), { recursive: true, force: true });
});
afterAll(async () => {
  await claim?.();
  await removeDir(dir);
});
function assertPrivate(error: unknown, code: string): void {
  expect(error instanceof errors.LauncherError).toBe(true);
  expect((error as LauncherError).code).toBe(code);
  const output = errors.launcherFailureMessage(error);
  expect(
    [hostile, capability, "b".repeat(64), "sensitive-path"].every(
      (value) => !output.includes(value),
    ),
  ).toBe(true);
}
it("prepares permissions and removes only known stale launch artifacts before publication", async () => {
  await fs.mkdir(folder());
  await fs.writeFile(manifest(), "stale fixture");
  await fs.writeFile(
    path.join(folder(), "bootstrap-aaaa.html"),
    "expired fixture",
  );
  await fs.writeFile(path.join(folder(), "unrelated.txt"), "preserve fixture");
  const publish = await launcher.prepareLaunchDirectory(claim);
  expect(await fs.readdir(folder())).toEqual(["unrelated.txt"]);
  const cleanup = await publish(capability, 4417);
  try {
    const record = JSON.parse(await fs.readFile(manifest(), "utf8"));
    expect(record.backend).toBe("http://127.0.0.1:4417");
    expect(record.capability === capability).toBe(true);
    await expect(publish(capability, 4417)).rejects.toBeInstanceOf(
      errors.LauncherError,
    );
  } finally {
    await cleanup();
  }
});
it("refuses a record planted after preparation without overwriting it", async () => {
  const publish = await launcher.prepareLaunchDirectory(claim);
  await fs.writeFile(manifest(), "planted synthetic record");
  const error = await publish(capability, 4417).catch(
    (error: unknown) => error,
  );
  assertPrivate(error, "LAUNCHER_PREPARATION");
  expect(await fs.readFile(manifest(), "utf8")).toBe(
    "planted synthetic record",
  );
});
it("refuses a manifest symlink planted after preparation", async () => {
  const publish = await launcher.prepareLaunchDirectory(claim);
  const target = path.join(dir, "preserved-target.json");
  await fs.writeFile(target, "preserve target");
  // Directory junctions work without file-symlink privileges on Windows.
  await fs.symlink(dir, manifest(), "junction");
  assertPrivate(
    await publish(capability, 4417).catch((error: unknown) => error),
    "LAUNCHER_PREPARATION",
  );
  expect(await fs.readFile(target, "utf8")).toBe("preserve target");
});
it("refuses a launcher-directory junction before preparation and after preparation", async () => {
  const target = path.join(dir, "junction-target");
  await fs.mkdir(target);
  await fs.symlink(target, folder(), "junction");
  assertPrivate(
    await launcher
      .prepareLaunchDirectory(claim)
      .catch((error: unknown) => error),
    "LAUNCHER_PREPARATION",
  );
  expect(await fs.readdir(target)).toEqual([]);
  await fs.unlink(folder());
  const publish = await launcher.prepareLaunchDirectory(claim);
  await fs.rename(folder(), path.join(dir, "original-directory"));
  await fs.symlink(target, folder(), "junction");
  assertPrivate(
    await publish(capability, 4417).catch((error: unknown) => error),
    "LAUNCHER_PREPARATION",
  );
  expect(await fs.readdir(target)).toEqual([]);
});
it("refuses a different regular directory substituted after preparation", async () => {
  const publish = await launcher.prepareLaunchDirectory(claim);
  await fs.rename(folder(), path.join(dir, "original-regular"));
  await fs.mkdir(folder());
  assertPrivate(
    await publish(capability, 4417).catch((error: unknown) => error),
    "LAUNCHER_PREPARATION",
  );
  expect(await fs.readdir(folder())).toEqual([]);
});
it("distinguishes absent startup records and local permission failures", async () => {
  assertPrivate(
    await launcher.prepareBrowserLaunch().catch((error: unknown) => error),
    "SERVER_UNAVAILABLE",
  );
  const fault = vi
    .spyOn(fs, "mkdir")
    .mockRejectedValue(Object.assign(new Error(hostile), { code: "EACCES" }));
  try {
    assertPrivate(
      await launcher
        .prepareLaunchDirectory(claim)
        .catch((error: unknown) => error),
      "LAUNCHER_PREPARATION",
    );
  } finally {
    fault.mockRestore();
  }
});
it("distinguishes malformed records without attempting a network request", async () => {
  await fs.mkdir(folder());
  await fs.writeFile(manifest(), hostile);
  const transport = vi.spyOn(globalThis, "fetch");
  assertPrivate(
    await launcher.prepareBrowserLaunch().catch((error: unknown) => error),
    "VERIFICATION_MISMATCH",
  );
  expect(transport).not.toHaveBeenCalled();
});
it.each([500, 502, 503, 504])(
  "classifies HTTP %s as unavailable without copying service text",
  async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(hostile, { status }),
    );
    assertPrivate(
      await launcher
        .verifyLocalServer(capability, "http://127.0.0.1:4417")
        .catch((error: unknown) => error),
      "SERVER_UNAVAILABLE",
    );
  },
);
it("distinguishes transport failure from an unverified listener", async () => {
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error(hostile));
  assertPrivate(
    await launcher
      .verifyLocalServer(capability, "http://127.0.0.1:4417")
      .catch((error: unknown) => error),
    "SERVER_UNAVAILABLE",
  );
  transport.mockResolvedValue(Response.json({ proof: hostile }));
  assertPrivate(
    await launcher
      .verifyLocalServer(capability, "http://127.0.0.1:4417")
      .catch((error: unknown) => error),
    "VERIFICATION_MISMATCH",
  );
  transport.mockResolvedValue(new Response(hostile));
  assertPrivate(
    await launcher
      .verifyLocalServer(capability, "http://127.0.0.1:4417")
      .catch((error: unknown) => error),
    "VERIFICATION_MISMATCH",
  );
});
it("distinguishes browser launch failure after successful capability verification", async () => {
  const cleanup = await (
    await launcher.prepareLaunchDirectory(claim)
  )(capability, 4417);
  try {
    const { proof } = await import("./localAuth");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, options) => {
        const { challenge } = JSON.parse(options!.body as string);
        return Response.json({
          proof: proof(capability, "identity", challenge),
        });
      },
    );
    browser.mockRejectedValue(new Error(hostile));
    assertPrivate(
      await launcher.launchBrowser().catch((error: unknown) => error),
      "BROWSER_LAUNCH",
    );
  } finally {
    await cleanup();
  }
});
it("classifies handoff creation failure after verification as local preparation, not server unavailability", async () => {
  const cleanup = await (
    await launcher.prepareLaunchDirectory(claim)
  )(capability, 4417);
  try {
    const { proof } = await import("./localAuth");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, options) => {
        const { challenge } = JSON.parse(options!.body as string);
        return Response.json({
          proof: proof(capability, "identity", challenge),
        });
      },
    );
    const fault = vi
      .spyOn(fs, "writeFile")
      .mockRejectedValue(Object.assign(new Error(hostile), { code: "ENOENT" }));
    try {
      assertPrivate(
        await launcher.prepareBrowserLaunch().catch((error: unknown) => error),
        "LAUNCHER_PREPARATION",
      );
    } finally {
      fault.mockRestore();
    }
  } finally {
    await cleanup();
  }
});
it("cleanup does not remove a different launch record", async () => {
  const cleanup = await (
    await launcher.prepareLaunchDirectory(claim)
  )(capability, 4417);
  await fs.writeFile(
    manifest(),
    JSON.stringify({
      capability: "c".repeat(64),
      backend: "http://127.0.0.1:4417",
    }),
  );
  await cleanup();
  expect(
    JSON.parse(await fs.readFile(manifest(), "utf8")).capability ===
      "c".repeat(64),
  ).toBe(true);
});
it("fixed CLI messages ignore arbitrary error objects and mutated error messages", () => {
  for (const code of [
    "SERVER_UNAVAILABLE",
    "VERIFICATION_MISMATCH",
    "LAUNCHER_PREPARATION",
    "BROWSER_LAUNCH",
  ] as const) {
    const error = new errors.LauncherError(code);
    error.message = hostile;
    assertPrivate(error, code);
  }
  expect(launcherFailureMessage(new Error(hostile)).includes(hostile)).toBe(
    false,
  );
});
