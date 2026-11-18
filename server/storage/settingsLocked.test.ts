import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { removeDir, useTempDataDir } from "./testUtils";

// Installer finding ST-05: keys saved by another Windows account (new PC, restored profile, password reset) must not
// stop Coherence from starting, and must never be overwritten.
let dir: string;
let store: typeof import("./settingsStore");
beforeEach(async () => {
  dir = await useTempDataDir("settings-locked");
  await fs.mkdir(dir, { recursive: true });
  vi.resetModules();
  store = await import("./settingsStore");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await removeDir(dir);
});

const file = () => path.join(dir, "settings.json");
const lockedSettings = (envelopeVersion = 1) =>
  JSON.stringify({
    version: 1,
    revision: 7,
    connections: [{ id: "offline", provider: "mock", name: "Offline demo" }],
    integrations: {},
    preferences: { theme: "dark" },
    // Ciphertext from another account: Windows cannot unprotect it here.
    _protectedSecrets: {
      version: envelopeVersion,
      scheme: "windows-dpapi-current-user",
      ciphertext: "AAAA",
    },
  });

it("starts without saved keys it cannot unlock, writes nothing, and resets only on request", async () => {
  const original = lockedSettings();
  await fs.writeFile(file(), original);

  const locked = await store.getPublicSettings();
  expect(locked.keysLocked).toBe(true);
  expect(locked.connections.map((c) => c.id)).toEqual(["offline"]);
  expect(locked.preferences).toEqual({ theme: "dark" });
  await expect(store.setFigmaToken("figd_x")).rejects.toMatchObject({
    status: 409,
  });
  expect(await fs.readFile(file(), "utf8")).toBe(original);

  await store.resetLockedKeys();
  const kept = (await fs.readdir(dir)).filter((name) =>
    name.startsWith("settings.json.locked-"),
  );
  expect(kept).toHaveLength(1);
  expect(await fs.readFile(path.join(dir, kept[0]), "utf8")).toBe(original);
  const rewritten = JSON.parse(await fs.readFile(file(), "utf8"));
  expect(rewritten._protectedSecrets).toBeUndefined();
  expect(rewritten.connections.map((c: { id: string }) => c.id)).toEqual([
    "offline",
  ]);
  expect(rewritten.preferences).toEqual({ theme: "dark" });

  const unlocked = await store.getPublicSettings();
  expect(unlocked.keysLocked).toBeUndefined();
  await store.setFigmaToken("figd_x");
  expect((await store.getPublicSettings()).figma?.hasToken).toBe(true);
});

it("refuses keys protected by a newer Coherence instead of treating them as locked", async () => {
  const original = lockedSettings(2);
  await fs.writeFile(file(), original);
  await expect(store.getSettings()).rejects.toMatchObject({
    code: "DATA_NEWER",
  });
  expect(await fs.readFile(file(), "utf8")).toBe(original);
});
