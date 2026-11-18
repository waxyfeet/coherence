import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeDir, useTempDataDir } from "./testUtils";

// Installer review ST-06: an older build must neither rewrite newer settings nor drop what it does not understand.
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeDir(dir);
});
async function profileWith(label: string, settings: unknown) {
  const dir = await useTempDataDir(label);
  dirs.push(dir);
  const file = path.join(dir, "settings.json");
  await fs.writeFile(file, JSON.stringify(settings, null, 2));
  vi.resetModules();
  return { file, store: await import("./settingsStore") };
}

it("refuses settings saved by a newer version without changing them", async () => {
  const { file, store } = await profileWith("settings-newer", {
    version: 2, // newer than SETTINGS_FORMAT_VERSION
    connections: [{ id: "conn_mock", provider: "mock", name: "Offline" }],
  });
  const before = await fs.readFile(file, "utf8");
  await expect(store.getSettings()).rejects.toMatchObject({
    name: "StartupError",
    code: "DATA_NEWER",
  });
  expect(await fs.readFile(file, "utf8")).toBe(before);
});

it("keeps unknown fields and unknown-provider connections, with their secrets protected, through a save", async () => {
  const futureKey = "synthetic-future-provider-key-561";
  const { file, store } = await profileWith("settings-roundtrip", {
    version: 1,
    connections: [
      { id: "conn_mock", provider: "mock", name: "Offline" },
      {
        id: "conn_future",
        provider: "provider-from-the-future",
        name: "Future",
        apiKey: futureKey,
        futureOption: { keep: true },
      },
    ],
    defaultConnectionId: "conn_mock",
    futureTopLevel: { keep: "me" },
  });
  expect((await store.getSettings()).connections.map((c) => c.id)).toEqual([
    "conn_mock",
  ]);
  await store.setDefaultConnection("conn_mock");

  const text = await fs.readFile(file, "utf8");
  if (process.platform === "win32") expect(text).not.toContain(futureKey);
  const saved = await (
    await import("./protectedSecrets")
  ).unprotectSettings(JSON.parse(text));
  expect(saved).toMatchObject({
    version: 1,
    futureTopLevel: { keep: "me" },
  });
  expect(
    (saved.connections as { id: string }[]).find((c) => c.id === "conn_future"),
  ).toEqual({
    id: "conn_future",
    provider: "provider-from-the-future",
    name: "Future",
    apiKey: futureKey,
    futureOption: { keep: true },
  });
});
