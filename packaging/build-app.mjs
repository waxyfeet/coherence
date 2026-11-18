/**
 * Builds the installable Coherence app folder (installer report §4.2) into build/stage/Coherence:
 *   server/index.mjs  one unsplit esbuild bundle (ROOT_DIR = the stage root, so dist/ and samples/ resolve)
 *   dist/             release UI build (no prototype)
 *   samples/screens/  the four offline-demo screens, hash-checked
 *   node_modules/     the sharp runtime closure only, taken from package-lock.json
 *   runtime/node.exe  the official, unmodified Node.js build, checksum- and signature-checked
 *   licenses/         Node.js licence, Odysseus permission, font and component notices
 *   build-manifest.json  version, source commit and SHA-256 of every file (no timestamps)
 *
 * Usage: node packaging/build-app.mjs [--node-zip <path>] [--node-candidate] [--release]
 * --node-candidate builds with the next Node major recorded in node-version.json, for evaluation only.
 * The Node zip is never downloaded here; by default it is read from build/cache/<zip>.
 * --release fails on anything a public release must not lack (for example the LGPL/GPL texts).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSbom } from "./sbom.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const option = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const release = argv.includes("--release");
const BUILD = path.join(ROOT, "build");
const STAGE = path.join(BUILD, "stage", "Coherence");
const META = path.join(BUILD, "meta");
const warnings = [];

const fail = (message) => {
  console.error(`build-app: ${message}`);
  process.exit(1);
};
const sha256File = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};

if (process.platform !== "win32")
  fail("the Windows package must be built on Windows.");
const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
);
const pinned = JSON.parse(
  fs.readFileSync(path.join(ROOT, "packaging", "node-version.json"), "utf8"),
);
const nodePin = argv.includes("--node-candidate") ? pinned.candidate : pinned;
if (release && nodePin !== pinned)
  fail("release builds use the pinned Node version only.");
const nodeMajor = Number(nodePin.version.split(".")[0]);

// 1. Fresh stage, only ever inside build/.
if (!inside(ROOT, STAGE)) fail("unexpected stage location.");
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
fs.mkdirSync(META, { recursive: true });

// 2. Release UI. VITE_COHERENCE_RELEASE removes the session-only prototype from the bundle.
console.log("build-app: building the UI…");
execFileSync(
  process.execPath,
  [
    path.join(ROOT, "node_modules", "vite", "bin", "vite.js"),
    "build",
    "--outDir",
    path.join(STAGE, "dist"),
    "--emptyOutDir",
    "--logLevel",
    "warn",
  ],
  {
    cwd: ROOT,
    stdio: "inherit",
    // The config-loader notice about extensionless server imports predates packaging and is expected.
    env: {
      ...process.env,
      VITE_COHERENCE_RELEASE: "1",
      VITE_CONFIG_NATIVE_IGNORE_WARNING: "true",
    },
  },
);

// 3. Backend bundle: one ESM file; CommonJS dependencies need a module-scoped require.
console.log("build-app: bundling the backend…");
const esbuild = require("esbuild");
const bundle = await esbuild.build({
  entryPoints: [path.join(ROOT, "server", "index.ts")],
  outfile: path.join(STAGE, "server", "index.mjs"),
  tsconfig: path.join(ROOT, "tsconfig.server.json"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: `node${nodeMajor}`,
  splitting: false,
  minify: false,
  sourcemap: false,
  legalComments: "eof",
  // `open` runs PowerShell on Windows. Only developer runs load it (on demand); the installed app uses the native
  // helper instead, so it is left out of the bundle and the stage (installer Stage 6).
  external: ["sharp", "open"],
  banner: {
    js: "import { createRequire as __coherenceCreateRequire } from 'node:module'; const require = __coherenceCreateRequire(import.meta.url);",
  },
  // ws's optional native helpers would otherwise be looked up at run time in any ancestor node_modules.
  define: {
    "process.env.WS_NO_BUFFER_UTIL": '"1"',
    "process.env.WS_NO_UTF_8_VALIDATE": '"1"',
  },
  metafile: true,
  logLevel: "warning",
});
fs.writeFileSync(
  path.join(META, "server-metafile.json"),
  JSON.stringify(bundle.metafile),
);
// Every import left outside the bundle must be a Node built-in, sharp, a helper disabled above, or the developer-only
// `open` (never staged, so an installed app cannot load it).
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const disabled = new Set(["bufferutil", "utf-8-validate", "open"]);
const externals = new Set();
for (const output of Object.values(bundle.metafile.outputs))
  for (const entry of output.imports)
    if (entry.external) externals.add(entry.path);
const unexpected = [...externals].filter(
  (name) => !builtins.has(name) && name !== "sharp" && !disabled.has(name),
);
if (unexpected.length)
  fail(
    `unresolved imports would be looked up outside the app: ${unexpected.join(", ")}`,
  );

// 4. Offline demo screens, identical to the hashes the mock reader expects.
const samples = path.join(ROOT, "samples", "screens");
const knownSampleHashes = new Set(
  fs
    .readFileSync(
      path.join(ROOT, "server", "agents", "mock", "sampleScreens.ts"),
      "utf8",
    )
    .match(/sha256:\s*"([a-f0-9]{64})"/g)
    .map((match) => match.slice(-65, -1)),
);
fs.mkdirSync(path.join(STAGE, "samples", "screens"), { recursive: true });
for (const name of fs
  .readdirSync(samples)
  .filter((file) => file.endsWith(".png"))) {
  const from = path.join(samples, name);
  if (!knownSampleHashes.has(sha256File(from)))
    fail(
      `sample screen ${name} does not match server/agents/mock/sampleScreens.ts.`,
    );
  fs.copyFileSync(from, path.join(STAGE, "samples", "screens", name));
}

// 5. Runtime dependency closure of the externals, from the lockfile (never `npm ci --omit=dev`).
const lock = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"),
);
const runtimePackages = new Map();
const platformMatches = (entry) =>
  (!entry.os || entry.os.includes("win32")) &&
  (!entry.cpu || entry.cpu.includes("x64"));
function addPackage(name, fromKey, optional) {
  const candidates = [];
  for (let base = fromKey; base;) {
    candidates.push(`${base}/node_modules/${name}`);
    const parent = base.lastIndexOf("/node_modules/");
    base = parent > 0 ? base.slice(0, parent) : "";
  }
  candidates.push(`node_modules/${name}`);
  const key = candidates.find((candidate) => lock.packages[candidate]);
  const entry = key && lock.packages[key];
  if (!entry || !platformMatches(entry)) {
    if (optional) return;
    fail(
      `runtime dependency ${name} is missing from package-lock.json for win32-x64.`,
    );
  }
  if (runtimePackages.has(key)) return;
  const installed = JSON.parse(
    fs.readFileSync(path.join(ROOT, key, "package.json"), "utf8"),
  );
  if (installed.version !== entry.version)
    fail(
      `${key} is ${installed.version}, but package-lock.json pins ${entry.version}. Run npm ci.`,
    );
  runtimePackages.set(key, entry.version);
  for (const dep of Object.keys(entry.dependencies ?? {}))
    addPackage(dep, key, false);
  for (const dep of Object.keys(entry.optionalDependencies ?? {}))
    addPackage(dep, key, true);
}
addPackage("sharp", "", false);
for (const key of runtimePackages.keys())
  fs.cpSync(path.join(ROOT, key), path.join(STAGE, key), {
    recursive: true,
    filter: (source) =>
      !path
        .relative(path.join(ROOT, key), source)
        .split(path.sep)
        .includes("node_modules"),
  });

// 6. Official Node.js runtime: checksum, then Authenticode signature, never modified.
const nodeZip = path.resolve(
  option("--node-zip") ?? path.join(BUILD, "cache", nodePin.zip),
);
if (!fs.existsSync(nodeZip))
  fail(
    `${nodeZip} is missing. Download ${nodePin.source}${nodePin.zip} (and SHASUMS256.txt) first.`,
  );
if (sha256File(nodeZip) !== nodePin.sha256)
  fail(
    `${path.basename(nodeZip)} does not match the SHA-256 pinned in packaging/node-version.json.`,
  );
const unpack = fs.mkdtempSync(path.join(os.tmpdir(), "coherence-node-"));
try {
  const folder = nodePin.zip.replace(/\.zip$/, "");
  execFileSync(
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
    ["-xf", nodeZip, "-C", unpack, `${folder}/node.exe`, `${folder}/LICENSE`],
    { stdio: "ignore" },
  );
  fs.mkdirSync(path.join(STAGE, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(STAGE, "licenses"), { recursive: true });
  fs.copyFileSync(
    path.join(unpack, folder, "node.exe"),
    path.join(STAGE, "runtime", "node.exe"),
  );
  fs.copyFileSync(
    path.join(unpack, folder, "LICENSE"),
    path.join(STAGE, "licenses", "Node.js-LICENSE.txt"),
  );
} finally {
  fs.rmSync(unpack, { recursive: true, force: true });
}
const signer = execFileSync(
  "powershell.exe",
  [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    '$s = Get-AuthenticodeSignature -LiteralPath $env:COHERENCE_NODE_EXE; "$($s.Status)|$($s.SignerCertificate.Subject)"',
  ],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      COHERENCE_NODE_EXE: path.join(STAGE, "runtime", "node.exe"),
    },
  },
).trim();
if (!/^Valid\|CN=OpenJS Foundation,/.test(signer))
  fail(
    `runtime/node.exe is not validly signed by the OpenJS Foundation (${signer}).`,
  );

// 7. Licences and notices. dist/THIRD_PARTY_NOTICES.txt already covers the npm packages and fonts.
for (const name of fs.readdirSync(path.join(ROOT, "docs", "licenses")))
  if (name !== "README.md")
    fs.copyFileSync(
      path.join(ROOT, "docs", "licenses", name),
      path.join(STAGE, "licenses", name),
    );
for (const text of ["LGPL-3.0.txt", "GPL-3.0.txt"]) {
  const source = path.join(ROOT, "packaging", "licenses", text);
  if (fs.existsSync(source))
    fs.copyFileSync(source, path.join(STAGE, "licenses", text));
  else
    warnings.push(
      `packaging/licenses/${text} is missing (required by libvips' LGPL licence before release).`,
    );
}
fs.writeFileSync(
  path.join(STAGE, "licenses", "README.txt"),
  [
    `Coherence ${pkg.version} — third-party notices`,
    "",
    "dist/THIRD_PARTY_NOTICES.txt   npm packages, fonts and UI components",
    "dist/notices/                  Odysseus and Fira Code notices",
    "licenses/Odysseus-themes-permission.md  permission for the adapted Odysseus themes",
    "licenses/Node.js-LICENSE.txt   the bundled Node.js runtime and its components",
    "node_modules/@img/sharp-win32-x64/README.md and versions.json  libvips and its bundled libraries (LGPL-3.0-or-later and others)",
    "licenses/LGPL-3.0.txt, licenses/GPL-3.0.txt  GNU licence texts for the LGPL components",
    "licenses/sbom.cdx.json         CycloneDX software bill of materials for this build",
    "",
    "The libvips DLLs are separate, replaceable files.",
    "",
  ].join("\r\n"),
);
const sbom = buildSbom({ root: ROOT, pkg, nodePin });
fs.writeFileSync(
  path.join(STAGE, "licenses", "sbom.cdx.json"),
  JSON.stringify(sbom, null, 2) + "\n",
);

// 8. Payload hygiene: nothing secret, nothing from development, nothing from a data folder.
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink())
      fail(`links are not allowed in the stage: ${full}`);
    if (entry.isDirectory()) walk(full);
    else files.push(path.relative(STAGE, full).split(path.sep).join("/"));
  }
})(STAGE);
const forbidden = [
  /(^|\/)\.env/i,
  /(^|\/)\.git(\/|$)/,
  /\.(pem|key|pfx|p12|map)$/i,
  /\.test\.[cm]?[jt]sx?$/i,
  /(^|\/)(\.cache|artifacts|\.local-auth|\.screenscribe-v2)(\/|$)/,
  /^node_modules\/(vite|vitest|tsx|esbuild|typescript|@esbuild|prettier|@playwright)(\/|$)/,
];
const offending = files.filter((file) =>
  forbidden.some((rule) => rule.test(file)),
);
if (offending.length)
  fail(`forbidden files in the stage:\n  ${offending.join("\n  ")}`);

// 9. Manifest without timestamps, so two builds of one commit can be compared.
const git = (...gitArgs) =>
  execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" }).trim();
const manifest = {
  product: "Coherence",
  version: pkg.version,
  node: { version: nodePin.version, zipSha256: nodePin.sha256 },
  source: {
    commit: git("rev-parse", "HEAD"),
    clean: git("status", "--porcelain") === "",
  },
  runtimePackages: Object.fromEntries(runtimePackages),
  files: Object.fromEntries(
    files.sort().map((file) => {
      const full = path.join(STAGE, file);
      return [file, { size: fs.statSync(full).size, sha256: sha256File(full) }];
    }),
  ),
};
fs.writeFileSync(
  path.join(STAGE, "build-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);

const total = Object.values(manifest.files).reduce(
  (sum, file) => sum + file.size,
  0,
);
const report = {
  version: pkg.version,
  node: nodePin.version,
  files: files.length,
  bytes: total,
  serverBundleBytes: manifest.files["server/index.mjs"].size,
  externals: [...externals].sort(),
  runtimePackages: manifest.runtimePackages,
  warnings,
};
fs.writeFileSync(
  path.join(META, "build-report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  `build-app: staged Coherence ${pkg.version} with Node ${nodePin.version}: ${files.length} files, ${(total / 1e6).toFixed(1)} MB at ${path.relative(ROOT, STAGE)}`,
);
for (const warning of warnings) console.warn(`build-app: warning: ${warning}`);
if (release && warnings.length) fail("release builds cannot have warnings.");
