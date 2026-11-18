import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, expect, it } from "vitest";
import { zip } from "./zip";

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "coherence-test-zip-"));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

it("writes archives that Windows' own tar extracts byte for byte", async () => {
  const files = {
    "Acme Orders-abc123/project.json": Buffer.from('{"id":"acme"}'.repeat(200)),
    "Acme Orders-abc123/screens/s1/v1.png": randomBytes(5000),
    "Acme Orders-abc123/specs/Écran d'accueil — UC-001.md": Buffer.from(
      "# Accueil\n".repeat(50),
    ),
    "Acme Orders-abc123/history/empty.json": Buffer.alloc(0),
  };
  const archive = path.join(dir, "project.zip");
  await fs.writeFile(
    archive,
    zip(
      Object.entries(files).map(([p, data]) => ({
        path: p,
        data,
        modified: new Date(2026, 10, 2, 13, 45, 30),
      })),
    ),
  );
  const out = path.join(dir, "out");
  await fs.mkdir(out);
  const tar = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "tar.exe",
  );
  execFileSync(tar, ["-xf", archive, "-C", out], { windowsHide: true });
  for (const [p, data] of Object.entries(files))
    expect(await fs.readFile(path.join(out, ...p.split("/"))), p).toEqual(data);
});

it("refuses paths that could escape the folder they are extracted into", () => {
  for (const bad of ["../x", "/abs", "a//b", "a/../b", ""])
    expect(() =>
      zip([{ path: bad, data: Buffer.from("x"), modified: new Date() }]),
    ).toThrow(RangeError);
});
