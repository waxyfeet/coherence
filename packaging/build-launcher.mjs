/**
 * Builds Coherence.exe, the Windows launcher (installer report §3.3), and CoherencePlatform.exe, the native platform
 * helper (Stage 6, packaging/helper), with the pinned .NET SDK from build/cache. Nothing is installed: the SDK runs from
 * its extracted folder, and its home, NuGet packages and caches stay under build/cache. The only packages restored are
 * Microsoft's .NET Framework 4.8 reference assemblies and the WebView2 SDK (pinned by the packages.lock.json files and
 * signature-verified here).
 * Usage: node packaging/build-launcher.mjs [--test] [--stage]
 *   --test   an "unsigned test" build: honours --profile, --browser-command and --unattended (never ship it)
 *   --stage  also copy Coherence.exe and the helper into build/stage/Coherence (after packaging/build-app.mjs)
 * The helper has no test build: both kinds build the same one into build/helper.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  HELPER_FILES,
  LAUNCHER_FILES,
  WEBVIEW2_VERSION,
} from "./launcher-files.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const kind = argv.includes("--test") ? "test" : "release";
const pin = JSON.parse(
  fs.readFileSync(path.join(ROOT, "packaging", "dotnet-version.json"), "utf8"),
);
const version = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
).version;
const cache = path.join(ROOT, "build", "cache");
const sdkRoot = path.join(cache, `dotnet-sdk-${pin.sdk}`);
const dotnet = path.join(sdkRoot, "dotnet.exe");
const project = path.join(
  ROOT,
  "packaging",
  "launcher",
  "Coherence.Launcher.csproj",
);
const out = path.join(ROOT, "build", "launcher", kind);
const fail = (message) => {
  console.error(`build-launcher: ${message}`);
  process.exit(1);
};

if (!fs.existsSync(dotnet))
  fail(
    `.NET SDK ${pin.sdk} not found at ${sdkRoot}. Download ${pin.url} (${pin.bytes} bytes), check SHA-512 ${pin.sha512}, and extract it there.`,
  );
const env = {
  SystemRoot: process.env.SystemRoot,
  windir: process.env.windir,
  SystemDrive: process.env.SystemDrive,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  USERPROFILE: process.env.USERPROFILE,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  APPDATA: process.env.APPDATA,
  ProgramFiles: process.env.ProgramFiles,
  "ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
  PATH: [sdkRoot, path.join(process.env.SystemRoot, "System32")].join(";"),
  DOTNET_ROOT: sdkRoot,
  DOTNET_MULTILEVEL_LOOKUP: "0",
  DOTNET_CLI_HOME: path.join(cache, "dotnet-home"),
  NUGET_PACKAGES: path.join(cache, "nuget-packages"),
  NUGET_HTTP_CACHE_PATH: path.join(cache, "nuget-http"),
  NUGET_PLUGINS_CACHE_PATH: path.join(cache, "nuget-plugins"),
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_NOLOGO: "1",
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
  DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: "0",
  DOTNET_GENERATE_ASPNET_CERTIFICATE: "0",
  MSBUILDDISABLENODEREUSE: "1",
};
const run = (args) =>
  execFileSync(dotnet, args, { cwd: ROOT, env, stdio: "inherit" });
const checks = path.join(
  ROOT,
  "packaging",
  "launcher",
  "tests",
  "LauncherChecks.csproj",
);

const helperProject = path.join(
  ROOT,
  "packaging",
  "helper",
  "CoherencePlatform.csproj",
);
const helperOut = path.join(ROOT, "build", "helper");

for (const proj of [project, checks, helperProject]) {
  const lock = path.join(path.dirname(proj), "packages.lock.json");
  run([
    "restore",
    proj,
    "--disable-build-servers",
    ...(fs.existsSync(lock) ? ["--locked-mode"] : []),
  ]);
  // Every restored package must carry a valid signature (nuget.org repository and Microsoft author signatures).
  const packages = JSON.parse(fs.readFileSync(lock, "utf8")).dependencies[
    ".NETFramework,Version=v4.8"
  ];
  for (const [name, entry] of Object.entries(packages)) {
    const nupkg = path.join(
      env.NUGET_PACKAGES,
      name.toLowerCase(),
      entry.resolved,
      `${name.toLowerCase()}.${entry.resolved}.nupkg`,
    );
    run(["nuget", "verify", "--all", nupkg]);
  }
}

// The launcher's validation and parsing rules, checked before anything is built for use.
const checksOut = path.join(ROOT, "build", "launcher", "checks");
run([
  "build",
  checks,
  "--no-restore",
  "--disable-build-servers",
  "-c",
  "Release",
  "-o",
  checksOut,
]);
execFileSync(path.join(checksOut, "LauncherChecks.exe"), [], {
  cwd: ROOT,
  stdio: "inherit",
});
fs.rmSync(out, { recursive: true, force: true });
run([
  "build",
  project,
  "--no-restore",
  "--disable-build-servers",
  "-c",
  "Release",
  "-o",
  out,
  `-p:Version=${version}`,
  `-p:CoherenceBuildKind=${kind}`,
]);
const exe = path.join(out, "Coherence.exe");
const sha256 = crypto
  .createHash("sha256")
  .update(fs.readFileSync(exe))
  .digest("hex");
console.log(
  `build-launcher: ${kind} Coherence.exe ${version} — ${fs.statSync(exe).size} bytes, sha256 ${sha256}`,
);
fs.rmSync(helperOut, { recursive: true, force: true });
run([
  "build",
  helperProject,
  "--no-restore",
  "--disable-build-servers",
  "-c",
  "Release",
  "-o",
  helperOut,
  `-p:Version=${version}`,
]);
const helperExe = path.join(helperOut, HELPER_FILES[0]);
const helperSha256 = crypto
  .createHash("sha256")
  .update(fs.readFileSync(helperExe))
  .digest("hex");
console.log(
  `build-launcher: CoherencePlatform.exe ${version} — ${fs.statSync(helperExe).size} bytes, sha256 ${helperSha256}`,
);
if (argv.includes("--stage")) {
  const stage = path.join(ROOT, "build", "stage", "Coherence");
  const manifestFile = path.join(stage, "build-manifest.json");
  if (!fs.existsSync(manifestFile)) fail("Run packaging/build-app.mjs first.");
  // Only a release launcher may enter the stage the installer packages.
  if (kind !== "release") fail("--stage takes the release build only.");
  const webview2 = path.join(
    env.NUGET_PACKAGES,
    "microsoft.web.webview2",
    WEBVIEW2_VERSION,
  );
  // The launcher, its app window (WebView2 SDK; the runtime itself is part of Windows 11), the platform helper and the
  // SDK's licence and notices. The SDK's WPF assembly and other architectures are not needed.
  const files = {
    ...Object.fromEntries(
      LAUNCHER_FILES.map((name) => [name, path.join(out, name)]),
    ),
    ...Object.fromEntries(
      HELPER_FILES.map((name) => [name, path.join(helperOut, name)]),
    ),
    "licenses/WebView2-LICENSE.txt": path.join(webview2, "LICENSE.txt"),
    "licenses/WebView2-NOTICE.txt": path.join(webview2, "NOTICE.txt"),
  };
  // The manifest lists every installed file, so the installer check can compare an install with it exactly.
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const record = (target, bytes) => {
    manifest.files[target] = {
      size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  };
  for (const [target, source] of Object.entries(files)) {
    if (!fs.existsSync(source)) fail(`missing ${source}`);
    fs.copyFileSync(source, path.join(stage, ...target.split("/")));
    record(target, fs.readFileSync(source));
  }
  // The SBOM (packaging/sbom.mjs, written by build-app) also lists what this step adds.
  const sbomFile = path.join(stage, "licenses", "sbom.cdx.json");
  if (fs.existsSync(sbomFile)) {
    const sbom = JSON.parse(fs.readFileSync(sbomFile, "utf8"));
    const added = [
      {
        type: "application",
        "bom-ref": "coherence-launcher",
        name: "Coherence launcher (Coherence.exe)",
        version,
        licenses: [{ license: { id: "MIT" } }],
        hashes: [{ alg: "SHA-256", content: sha256 }],
      },
      {
        type: "application",
        "bom-ref": "coherence-platform-helper",
        name: "Coherence platform helper (CoherencePlatform.exe)",
        version,
        licenses: [{ license: { id: "MIT" } }],
        hashes: [{ alg: "SHA-256", content: helperSha256 }],
      },
      {
        type: "library",
        "bom-ref": `pkg:nuget/Microsoft.Web.WebView2@${WEBVIEW2_VERSION}`,
        name: "Microsoft.Web.WebView2",
        version: WEBVIEW2_VERSION,
        purl: `pkg:nuget/Microsoft.Web.WebView2@${WEBVIEW2_VERSION}`,
        licenses: [{ license: { id: "BSD-3-Clause" } }],
      },
    ];
    sbom.components = [
      ...(sbom.components ?? []).filter(
        (c) => !added.some((a) => a["bom-ref"] === c["bom-ref"]),
      ),
      ...added,
    ];
    const text = JSON.stringify(sbom, null, 2) + "\n";
    fs.writeFileSync(sbomFile, text);
    record("licenses/sbom.cdx.json", Buffer.from(text));
  }
  manifest.launcher = {
    kind,
    sha256,
    helperSha256,
    webview2Sdk: WEBVIEW2_VERSION,
  };
  manifest.files = Object.fromEntries(
    Object.entries(manifest.files).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `build-launcher: ${Object.keys(files).length} files copied into ${stage} and added to its manifest`,
  );
}
