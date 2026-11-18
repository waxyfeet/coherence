import fs from "node:fs/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { removeDir, useTempDataDir } from "./testUtils";

// Decision D8: when Documents is synced by OneDrive (or on a network), the launcher picks a local default workspace
// and the app says why — only while that default is the workspace in use.
let dir: string;
let registry: typeof import("./projectRegistry");
beforeAll(async () => {
  dir = await useTempDataDir("workspace-note");
  process.env.SCREENSCRIBE_V2_WORKSPACE_NOTE = "onedrive";
  vi.resetModules();
  const store = await import("./projectStore");
  registry = await import("./projectRegistry");
  await store.ensureDataDirs();
});
afterAll(async () => {
  delete process.env.SCREENSCRIBE_V2_WORKSPACE_NOTE;
  await removeDir(`${dir}-chosen`);
  await removeDir(dir);
});

it("explains a default workspace outside Documents until the user chooses another folder", async () => {
  expect((await registry.workspaceSettings()).workspaceNote).toMatch(
    /Documents folder is synced by OneDrive/,
  );
  await fs.mkdir(`${dir}-chosen`);
  await registry.changeWorkspace(`${dir}-chosen`);
  expect((await registry.workspaceSettings()).workspaceNote).toBeUndefined();
});
