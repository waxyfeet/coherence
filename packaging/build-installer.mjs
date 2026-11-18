/**
 * Builds the Windows installer (installer report §4, Stage 5) from build/stage/Coherence with the Inno Setup compiler
 * extracted (portable mode, nothing installed) to build/cache/innosetup-<version>/. The stage must be complete: every
 * file must match build-manifest.json, and Coherence.exe must be the release launcher (build-launcher.mjs --stage).
 * The installer is not signed yet: release.mjs records that, and its SHA-256, beside it.
 * Usage: node packaging/build-installer.mjs
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INNO = {
  version: "7.1.1",
  sha256: "8a5a6711c3766a6e5fb74f280ba0e3551e719ce94538d901fdbd1f8f9920b3f0",
};
const STAGE = path.join(ROOT, "build", "stage", "Coherence");
const OUT = path.join(ROOT, "build", "installer");
const iscc = path.join(
  ROOT,
  "build",
  "cache",
  `innosetup-${INNO.version}`,
  "ISCC.exe",
);
const fail = (message) => {
  console.error(`build-installer: ${message}`);
  process.exit(1);
};
const sha256File = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

if (!fs.existsSync(iscc))
  fail(
    `Inno Setup ${INNO.version} not found at ${path.dirname(iscc)}. Download innosetup-${INNO.version}-x64.exe from jrsoftware.org (SHA-256 ${INNO.sha256}) and run it with /PORTABLE=1 /CURRENTUSER /VERYSILENT /DIR=<that folder>.`,
  );
const manifestFile = path.join(STAGE, "build-manifest.json");
if (!fs.existsSync(manifestFile)) fail("Run packaging/build-app.mjs first.");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
if (manifest.launcher?.kind !== "release" || !manifest.files["Coherence.exe"])
  fail(
    "Stage the release launcher first: node packaging/build-launcher.mjs --stage",
  );

// The stage must be exactly what the manifest says: no missing, changed or extra files.
const listed = new Set(Object.keys(manifest.files));
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory()
      ? walk(full)
      : [path.relative(STAGE, full).split(path.sep).join("/")];
  });
const present = walk(STAGE).filter((file) => file !== "build-manifest.json");
const extra = present.filter((file) => !listed.has(file));
const wrong = [...listed].filter(
  (file) =>
    !fs.existsSync(path.join(STAGE, file)) ||
    sha256File(path.join(STAGE, file)) !== manifest.files[file].sha256,
);
if (extra.length || wrong.length)
  fail(
    `the stage does not match its manifest:\n  extra: ${extra.join(", ") || "none"}\n  missing or changed: ${wrong.join(", ") || "none"}`,
  );

fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  iscc,
  [
    "/Qp",
    `/DAppVersion=${manifest.version}`,
    `/DStageDir=${STAGE}`,
    `/DOutputDir=${OUT}`,
    `/DIconFile=${path.join(ROOT, "packaging", "launcher", "Coherence.ico")}`,
    "/DSigned=0",
    path.join(ROOT, "packaging", "installer", "Coherence.iss"),
  ],
  { cwd: ROOT, stdio: "inherit" },
);
const setup = path.join(OUT, `Coherence-${manifest.version}-Setup.exe`);
if (!fs.existsSync(setup)) fail(`expected ${setup}`);
console.log(
  `build-installer: ${path.relative(ROOT, setup)} — ${fs.statSync(setup).size} bytes, sha256 ${sha256File(setup)} (not signed)`,
);
