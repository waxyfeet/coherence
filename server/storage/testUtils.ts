/**
 * OWNER: server-core builder.
 * Test-only helpers: an isolated data dir per test file and tiny generated images.
 * config.ts reads SCREENSCRIBE_V2_DATA_DIR at import time, so callers must set it (useTempDataDir) and then
 * import the modules under test dynamically after vi.resetModules().
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
const workspaces = new Map<string, string>();

async function releaseTestProfile() {
  await (await import("./projectRegistry")).releaseProjectLeases();
  await (await import("./windowsStorageGuard")).releaseFilesystemGuard();
}

export async function useTempDataDir(label: string): Promise<string> {
  if (workspaces.has(process.env.SCREENSCRIBE_V2_DATA_DIR ?? ""))
    await releaseTestProfile();
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), `coherence-test-${label}-`),
  );
  process.env.SCREENSCRIBE_V2_DATA_DIR = dir;
  const workspace = `${dir}-workspace`;
  await fs.mkdir(workspace);
  workspaces.set(dir, workspace);
  process.env.SCREENSCRIBE_V2_WORKSPACE_DIR = workspace;
  return dir;
}

export async function removeDir(dir: string): Promise<void> {
  const resolved = path.resolve(dir);
  const authorised = [
    os.tmpdir(),
    path.join(process.cwd(), ".cache", "test-temp"),
  ].some((parent) => {
    const rel = path.relative(path.resolve(parent), resolved);
    return (
      !!rel &&
      !path.isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(".." + path.sep)
    );
  });
  if (!path.isAbsolute(dir) || !authorised)
    throw Error(
      "Test cleanup refused a path outside disposable fixture roots.",
    );
  const workspace = workspaces.get(dir);
  if (workspace) {
    await releaseTestProfile();
    workspaces.delete(dir);
    await removeDir(workspace);
  }
  const info = await fs.lstat(resolved).catch((e) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (info?.isSymbolicLink())
    throw Error("Test cleanup refuses linked root folders.");
  await fs.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

export async function makePng(
  width = 40,
  height = 30,
  color = { r: 79, g: 70, b: 229 },
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { ...color, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

export async function makeJpeg(width = 32, height = 64): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 10, g: 200, b: 120 },
    },
  })
    .jpeg()
    .toBuffer();
}

export async function makeWebp(width = 24, height = 24): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 20, b: 20 },
    },
  })
    .webp()
    .toBuffer();
}
