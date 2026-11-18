/**
 * Silent install / repair / upgrade-refusal / uninstall check of the installer (installer report §4,
 * Stage 5), per-user, into a disposable %TEMP% folder with no shortcuts. The installed Coherence is never started with
 * the standard folders: the only app run here is the *test* launcher with a disposable --profile, to prove Setup
 * refuses to replace files under a running copy. It aborts before doing anything if Coherence is already installed on
 * this PC, and afterwards checks that the uninstall entry, program files and shortcuts are gone and that the owner's
 * standard folders and launcher preferences are as they were.
 * Usage: node packaging/verify-installer.mjs [--keep]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = path.join(ROOT, "build", "stage", "Coherence");
const manifest = JSON.parse(
  fs.readFileSync(path.join(STAGE, "build-manifest.json"), "utf8"),
);
const SETUP = path.join(
  ROOT,
  "build",
  "installer",
  `Coherence-${manifest.version}-Setup.exe`,
);
const TEST_LAUNCHER = path.join(
  ROOT,
  "build",
  "launcher",
  "test",
  "Coherence.exe",
);
const APP_GUID = "618DBBDC-AAC3-4AAF-A721-8B86390289F5";
const UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${APP_GUID}}_is1`;
const UNINSTALL_KEY_HKLM = `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${APP_GUID}}_is1`;
const keep = process.argv.includes("--keep");
class VerifyError extends Error {}
const check = (condition, message) => {
  if (!condition) throw new VerifyError(message);
};
const steps = [];
const step = (name, detail = "") => {
  steps.push({ name, detail });
  console.log(`verify-installer: ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (what, test, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await test()) return;
    check(Date.now() < deadline, `Timed out waiting for ${what}.`);
    await sleep(250);
  }
};
const sha256File = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const regValue = (key, name) => {
  const result = spawnSync("reg.exe", ["query", key, "/v", name], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return undefined;
  return new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`)
    .exec(result.stdout)?.[1]
    ?.trim();
};
const regKeyExists = (key) =>
  spawnSync("reg.exe", ["query", key], { windowsHide: true }).status === 0;
const regExport = (key) => {
  const result = spawnSync("reg.exe", ["query", key, "/s"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout : "(absent)";
};
const topLevel = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).sort().join("|") : "(absent)";
const runSetup = (args) =>
  new Promise((resolve) => {
    const child = spawn(SETUP, args, { windowsHide: true, stdio: "ignore" });
    child.once("exit", (code) => resolve(code));
  });
const powershell = (command) =>
  execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true },
  ).trim();

check(fs.existsSync(SETUP), "Run packaging/build-installer.mjs first.");
check(
  fs.existsSync(TEST_LAUNCHER),
  "Run packaging/build-launcher.mjs --test first.",
);
const localAppData = process.env.LOCALAPPDATA;
const documents = powershell("[Environment]::GetFolderPath('MyDocuments')");
const startMenu = powershell("[Environment]::GetFolderPath('Programs')");
const desktop = powershell("[Environment]::GetFolderPath('Desktop')");
// Refuse to run where it could touch a real installation or the launcher's real logs.
check(
  !regKeyExists(UNINSTALL_KEY) && !regKeyExists(UNINSTALL_KEY_HKLM),
  "Coherence is already installed on this PC; this check only runs where it is not.",
);
check(
  !fs.existsSync(path.join(localAppData, "CoherenceLauncher")),
  "%LOCALAPPDATA%\\CoherenceLauncher exists; uninstall would remove it, so this check does not run here.",
);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "coherence-installer-"));
const app = path.join(work, "Programs", "Coherence");
const report = { started: new Date().toISOString(), work, steps };
const before = {
  profile: topLevel(path.join(localAppData, "Coherence")),
  documents: topLevel(path.join(documents, "Coherence")),
  preferences: regExport("HKCU\\Software\\Coherence"),
  startMenu: fs.existsSync(path.join(startMenu, "Coherence.lnk")),
  desktop: fs.existsSync(path.join(desktop, "Coherence.lnk")),
};
let failed = false;
let testLauncher;
const silent = (log, ...more) => [
  "/VERYSILENT",
  "/SUPPRESSMSGBOXES",
  "/NORESTART",
  "/CURRENTUSER",
  "/NOSHORTCUTS=1",
  `/DIR=${app}`,
  `/LOG=${path.join(work, log)}`,
  ...more,
];
const installedMatchesManifest = () => {
  const expected = new Set([
    ...Object.keys(manifest.files),
    "build-manifest.json",
    "unins000.exe",
    "unins000.dat",
  ]);
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory()
        ? walk(full)
        : [path.relative(app, full).split(path.sep).join("/")];
    });
  const present = walk(app);
  const extra = present.filter((file) => !expected.has(file));
  const wrong = Object.keys(manifest.files).filter(
    (file) =>
      !fs.existsSync(path.join(app, file)) ||
      sha256File(path.join(app, file)) !== manifest.files[file].sha256,
  );
  check(
    !extra.length && !wrong.length,
    `Install differs from the manifest. Extra: ${extra.join(", ") || "none"}. Missing or changed: ${wrong.join(", ") || "none"}.`,
  );
  return present.length;
};

try {
  // 1. Fresh per-user install, silent, no shortcuts.
  check(
    (await runSetup(silent("install.log"))) === 0,
    "Silent install failed.",
  );
  const count = installedMatchesManifest();
  check(
    regValue(UNINSTALL_KEY, "DisplayVersion") === manifest.version,
    "The uninstall entry does not show this version.",
  );
  check(
    !fs.existsSync(path.join(startMenu, "Coherence.lnk")) &&
      !fs.existsSync(path.join(desktop, "Coherence.lnk")),
    "Shortcuts were created despite /NOSHORTCUTS=1.",
  );
  step(
    "install",
    `${count} files, identical to build-manifest.json; HKCU uninstall entry ${manifest.version}; no shortcuts`,
  );

  // 2. Repair over an existing install: stale files from an older build must not survive.
  const stale = [
    path.join(app, "server", "stale.mjs"),
    path.join(app, "node_modules", "stale-package", "index.js"),
    path.join(app, "dist", "assets", "stale.js"),
    path.join(app, "runtime", "stale.dll"),
  ];
  for (const file of stale) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "stale");
  }
  check((await runSetup(silent("repair.log"))) === 0, "Silent repair failed.");
  check(
    stale.every((file) => !fs.existsSync(file)),
    "Stale files survived a repair.",
  );
  installedMatchesManifest();
  step(
    "repair",
    "stale server, module, asset and runtime files removed; install matches the manifest again",
  );

  // 3. A copy running from the program folder is never force-closed: Setup refuses (exit 7) and changes nothing.
  const testExe = path.join(app, "Coherence-test.exe");
  fs.copyFileSync(TEST_LAUNCHER, testExe);
  const profile = path.join(work, "profile");
  const noBrowser = `"${process.execPath}" -e "0"`;
  testLauncher = spawn(
    testExe,
    ["--profile", profile, "--unattended", "--browser-command", noBrowser],
    { windowsHide: true, stdio: "ignore" },
  );
  const log = path.join(profile, "launcher-logs", "launcher.log");
  await until("the test copy to be ready", () =>
    fs.existsSync(log)
      ? /backend ready on port/.test(fs.readFileSync(log, "utf8"))
      : false,
  );
  const runningCode = await runSetup(silent("running.log"));
  const runningLog = fs.readFileSync(path.join(work, "running.log"), "utf8");
  check(
    runningCode === 7,
    `Expected exit 7 with Coherence running, got ${runningCode}.`,
  );
  check(
    /still running, possibly for another user/.test(runningLog),
    "Setup did not explain why it stopped.",
  );
  const quit = spawnSync(
    testExe,
    ["--profile", profile, "--unattended", "--quit", "--wait"],
    { windowsHide: true },
  );
  check(quit.status === 0, "The test copy did not quit.");
  await until(
    "the test copy to exit",
    () => testLauncher.exitCode !== null,
    20_000,
  );
  fs.rmSync(testExe, { force: true, maxRetries: 10, retryDelay: 200 });
  installedMatchesManifest();
  step(
    "running copy",
    "Setup refused with exit 7 and a reason; nothing was closed or replaced",
  );

  // 4. Downgrade: refused when silent unless /ALLOWDOWNGRADE=1 (decision D11).
  execFileSync(
    "reg.exe",
    ["add", UNINSTALL_KEY, "/v", "DisplayVersion", "/d", "9.9.9", "/f"],
    {
      windowsHide: true,
      stdio: "ignore",
    },
  );
  const downgrade = await runSetup(silent("downgrade.log"));
  check(
    downgrade === 1,
    `Expected a refused downgrade (exit 1), got ${downgrade}.`,
  );
  check(
    regValue(UNINSTALL_KEY, "DisplayVersion") === "9.9.9",
    "A refused downgrade changed the installation.",
  );
  check(
    (await runSetup(silent("downgrade-allowed.log", "/ALLOWDOWNGRADE=1"))) ===
      0,
    "An allowed downgrade failed.",
  );
  check(
    regValue(UNINSTALL_KEY, "DisplayVersion") === manifest.version,
    "The allowed downgrade did not install this version.",
  );
  installedMatchesManifest();
  step(
    "downgrade",
    "refused silently (exit 1, nothing changed); allowed with /ALLOWDOWNGRADE=1",
  );

  // 5. Silent uninstall: program files and the uninstall entry go; data, projects and preferences stay.
  const uninstaller = path.join(app, "unins000.exe");
  spawnSync(
    uninstaller,
    [
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
      `/LOG=${path.join(work, "uninstall.log")}`,
    ],
    { windowsHide: true },
  );
  await until(
    "the uninstaller to finish",
    () => !regKeyExists(UNINSTALL_KEY) && !fs.existsSync(uninstaller),
    90_000,
  );
  await until(
    "the program folder to be removed",
    () => !fs.existsSync(app),
    30_000,
  );
  step("uninstall", "program folder and HKCU uninstall entry removed");
} catch (error) {
  failed = true;
  report.error =
    error instanceof VerifyError
      ? error.message
      : String(error?.stack ?? error);
  console.error(`verify-installer: FAILED — ${report.error}`);
} finally {
  if (testLauncher && testLauncher.exitCode === null)
    spawnSync("taskkill.exe", ["/F", "/T", "/PID", String(testLauncher.pid)], {
      windowsHide: true,
    });
  // Leave nothing installed, even after a failure.
  const uninstaller = path.join(app, "unins000.exe");
  if (fs.existsSync(uninstaller)) {
    spawnSync(uninstaller, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], {
      windowsHide: true,
    });
    for (let i = 0; i < 240 && regKeyExists(UNINSTALL_KEY); i++)
      await sleep(250);
  }
  const after = {
    profile: topLevel(path.join(localAppData, "Coherence")),
    documents: topLevel(path.join(documents, "Coherence")),
    preferences: regExport("HKCU\\Software\\Coherence"),
    startMenu: fs.existsSync(path.join(startMenu, "Coherence.lnk")),
    desktop: fs.existsSync(path.join(desktop, "Coherence.lnk")),
  };
  const changed = Object.keys(before).filter(
    (key) => before[key] !== after[key],
  );
  if (regKeyExists(UNINSTALL_KEY) || changed.length) {
    failed = true;
    console.error(
      `verify-installer: FAILED — left behind or changed: ${[
        ...(regKeyExists(UNINSTALL_KEY) ? ["uninstall entry"] : []),
        ...changed,
      ].join(", ")}`,
    );
  } else
    step(
      "owner's machine unchanged",
      "standard data and Documents folders, HKCU\\Software\\Coherence and shortcuts as before; no uninstall entry",
    );
  report.result = failed ? "FAIL" : "PASS";
  fs.mkdirSync(path.join(ROOT, "build", "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "build", "meta", "verify-installer-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (keep || failed) console.log(`verify-installer: kept ${work}`);
  else
    fs.rmSync(work, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  console.log(`verify-installer: ${report.result}`);
  process.exitCode = failed ? 1 : 0;
}
