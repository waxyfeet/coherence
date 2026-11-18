import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SAMPLE_SCREENS } from "../agents/mock/sampleScreens";
import { checkInstallation } from "./installCheck";

let root: string;
beforeEach(async () => {
  // A minimal install: the UI entry page and the four demo screens copied from the repository.
  root = await fs.mkdtemp(path.join(os.tmpdir(), "coherence-install-"));
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(
    path.join(root, "dist", "index.html"),
    '<div id="root"></div>',
  );
  await fs.mkdir(path.join(root, "samples", "screens"), { recursive: true });
  for (const { file } of SAMPLE_SCREENS)
    await fs.copyFile(
      path.join("samples", "screens", file),
      path.join(root, "samples", "screens", file),
    );
  await fs.writeFile(path.join(root, "CoherencePlatform.exe"), "MZ");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it("accepts a complete install", async () => {
  await expect(checkInstallation(root)).resolves.toBeUndefined();
});

it("refuses a missing UI or a missing or altered demo screen, naming only install-relative files", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await fs.rm(path.join(root, "dist", "index.html"));
  await fs.appendFile(
    path.join(root, "samples", "screens", SAMPLE_SCREENS[0].file),
    "x",
  );
  await fs.rm(path.join(root, "samples", "screens", SAMPLE_SCREENS[1].file));
  await expect(checkInstallation(root)).rejects.toMatchObject({
    code: "INSTALL_DAMAGED",
  });
  expect(log).toHaveBeenCalledWith(
    `[install-check] missing or altered: dist/index.html, samples/screens/${SAMPLE_SCREENS[0].file}, samples/screens/${SAMPLE_SCREENS[1].file}`,
  );
  expect(String(log.mock.calls)).not.toContain(root);
});

it.runIf(process.platform === "win32")(
  "refuses an install without the native platform helper",
  async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await fs.rm(path.join(root, "CoherencePlatform.exe"));
    await expect(checkInstallation(root)).rejects.toMatchObject({
      code: "INSTALL_DAMAGED",
    });
    expect(log).toHaveBeenCalledWith(
      "[install-check] missing or altered: CoherencePlatform.exe",
    );
  },
);
