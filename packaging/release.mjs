/**
 * One command from a committed checkout to a release candidate (installer report §8, Stage 7). It builds the app with
 * --release (no missing notice allowed), the launcher and platform helper, and the installer; runs the three packaged
 * checks; and writes build/release/: the Setup, SHA256SUMS.txt and release.json (commit, versions, hashes, checks,
 * signing status).
 * Usage: node packaging/release.mjs [--allow-dirty]
 *   --allow-dirty  build from uncommitted changes (recorded in release.json; never for a candidate you hand out)
 * Signing is not part of it: the Setup is not signed yet, and release.json says so. Publish its SHA-256 with it.
 * Prerequisites are in packaging/README.md.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "build", "release");
const META = path.join(ROOT, "build", "meta");
const allowDirty = process.argv.includes("--allow-dirty");
const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};
const git = (...args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const sha256 = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain") !== "";
if (dirty && !allowDirty)
  fail(
    "the working tree has uncommitted changes. Commit them first, or pass --allow-dirty for a local trial.",
  );

const begun = Date.now();
const steps = [
  ["build-app.mjs", "--release"],
  ["build-launcher.mjs", "--stage"],
  ["build-launcher.mjs", "--test"],
  ["verify-staged.mjs"],
  ["verify-launcher.mjs"],
  ["build-installer.mjs"],
  ["verify-installer.mjs"],
];
for (const [script, ...args] of steps) {
  console.log(`release: ${script} ${args.join(" ")}`.trim());
  try {
    execFileSync(
      process.execPath,
      [path.join(ROOT, "packaging", script), ...args],
      { cwd: ROOT, stdio: "inherit" },
    );
  } catch {
    fail(`${script} failed; nothing was written to build/release.`);
  }
}

const manifest = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, "build", "stage", "Coherence", "build-manifest.json"),
    "utf8",
  ),
);
const setupName = `Coherence-${manifest.version}-Setup.exe`;
const setup = path.join(ROOT, "build", "installer", setupName);
if (!fs.existsSync(setup)) fail(`${setupName} is missing.`);
// Each check writes its own report; only one written by this run counts.
const outcome = (name) => {
  const file = path.join(META, name);
  const report = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  if (!report.started || Date.parse(report.started) < begun) return "MISSING";
  return report.result ?? "MISSING";
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(setup, path.join(OUT, setupName));
const setupSha256 = sha256(setup);
fs.writeFileSync(
  path.join(OUT, "SHA256SUMS.txt"),
  `${setupSha256} *${setupName}\n`,
);
const release = {
  version: manifest.version,
  commit,
  dirty,
  node: manifest.node,
  launcher: manifest.launcher,
  installedFiles: Object.keys(manifest.files).length,
  setup: {
    name: setupName,
    bytes: fs.statSync(setup).size,
    sha256: setupSha256,
  },
  signed: false,
  distribution:
    "Not signed: Windows SmartScreen warns about it. Compare the SHA-256 with SHA256SUMS.txt before running it.",
  checks: {
    staged: outcome("verify-report.json"),
    launcher: outcome("verify-launcher-report.json"),
    installer: outcome("verify-installer-report.json"),
  },
};
if (Object.values(release.checks).some((result) => result !== "PASS"))
  fail(`a check did not pass: ${JSON.stringify(release.checks)}`);
fs.writeFileSync(
  path.join(OUT, "release.json"),
  JSON.stringify(release, null, 2) + "\n",
);
console.log(
  `release: ${setupName} — ${release.setup.bytes} bytes, sha256 ${setupSha256}${dirty ? " (UNCOMMITTED CHANGES)" : ""}, commit ${commit.slice(0, 12)}`,
);
console.log(`release: written to ${path.relative(ROOT, OUT)}`);
