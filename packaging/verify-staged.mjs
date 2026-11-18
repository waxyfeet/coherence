/**
 * Proves the staged app runs on its own (installer report §8, Stages 1–2). It copies build/stage/Coherence to a fresh
 * temporary folder with no node_modules above it, starts runtime/node.exe --managed with a minimal environment (no
 * Node on PATH, isolated data, ports 4490–4499), records every module the app resolves, drives the launcher's control
 * channel (§3.4: ready → open → bootstrap page → session), creates the offline demo (sample screens through sharp),
 * stops it by closing stdin as a vanished launcher would, and fails if anything was loaded from outside the copy, the
 * stop was not graceful or anything was left behind. The owner's profile, projects and running apps are never used.
 * Usage: node packaging/verify-staged.mjs [--port <4490-4499>] [--keep] [--remove <path in the app>]
 * --remove deletes a file or folder from the test copy first: a negative self-test that must FAIL.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = path.join(ROOT, "build", "stage", "Coherence");
const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const requestedPort = argv.includes("--port")
  ? Number(argv[argv.indexOf("--port") + 1])
  : undefined;
const steps = [];
const step = (name, detail = "") => {
  steps.push({ name, detail });
  console.log(`verify-staged: ${name}${detail ? ` — ${detail}` : ""}`);
};
class VerifyError extends Error {}
const check = (condition, message) => {
  if (!condition) throw new VerifyError(message);
};
const hmac = (key, purpose, value) =>
  crypto.createHmac("sha256", key).update(`${purpose}\n${value}`).digest("hex");
const free = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

check(
  fs.existsSync(path.join(STAGE, "build-manifest.json")),
  "Run packaging/build-app.mjs first.",
);
check(
  fs.existsSync(path.join(STAGE, "CoherencePlatform.exe")),
  "Run packaging/build-launcher.mjs --stage first: the stage has no CoherencePlatform.exe.",
);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "coherence-verify-"));
const dataRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "coherence-verify-data-"),
);
const app = path.join(work, "Coherence");
const resolveLog = path.join(dataRoot, "resolved.txt");
const output = { stray: [], stderr: "" };
const events = [];
let child;
let failed = false;
const report = { started: new Date().toISOString(), app, steps };

try {
  // 1. A copy with no node_modules above it, so a missing module cannot be found by accident.
  for (let dir = path.dirname(app); ; dir = path.dirname(dir)) {
    check(
      !fs.existsSync(path.join(dir, "node_modules")),
      `${path.join(dir, "node_modules")} exists above the test copy and would hide missing modules.`,
    );
    if (path.dirname(dir) === dir) break;
  }
  fs.cpSync(STAGE, app, { recursive: true });
  step("copied stage", app);
  if (argv.includes("--remove")) {
    const target = path.resolve(app, argv[argv.indexOf("--remove") + 1] ?? "");
    check(
      target.startsWith(app + path.sep) && fs.existsSync(target),
      "--remove needs an existing path inside the app.",
    );
    fs.rmSync(target, { recursive: true, force: true });
    report.removed = path.relative(app, target);
    step("negative self-test: removed", report.removed);
  }

  // 2. Minimal environment: Windows folders only, no Node or npm, isolated data, no inherited app settings.
  const port =
    requestedPort ??
    (await (async () => {
      for (let candidate = 4490; candidate <= 4499; candidate++)
        if (await free(candidate)) return candidate;
      throw new VerifyError("No free port in 4490-4499.");
    })());
  check(
    port >= 4490 && port <= 4499 && (await free(port)),
    `Port ${port} is not a free test port.`,
  );
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  const env = {
    SystemRoot: windows,
    windir: windows,
    SystemDrive: process.env.SystemDrive ?? "C:",
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    USERNAME: process.env.USERNAME,
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    // The launcher's PATH: no PowerShell, so any use of it by the installed app fails this run (installer Stage 6).
    PATH: [
      path.join(windows, "System32"),
      windows,
      path.join(windows, "System32", "Wbem"),
    ].join(";"),
    NoDefaultCurrentDirectoryInExePath: "1",
    SCREENSCRIBE_V2_DATA_DIR: path.join(dataRoot, "profile"),
    SCREENSCRIBE_V2_WORKSPACE_DIR: path.join(dataRoot, "workspace"),
    SCREENSCRIBE_V2_PORT: String(port),
    COHERENCE_VERIFY_RESOLVE_LOG: resolveLog,
  };

  // 3. Start the packaged backend exactly as the launcher will, plus the resolution logger.
  const started = Date.now();
  child = spawn(
    path.join(app, "runtime", "node.exe"),
    [
      "--no-global-search-paths",
      "--use-system-ca",
      "--import",
      pathToFileURL(path.join(ROOT, "packaging", "verify", "resolve-log.mjs"))
        .href,
      path.join("server", "index.mjs"),
      "--managed",
    ],
    { cwd: app, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  // In managed mode stdout carries only control events; anything else there would corrupt the launcher's channel.
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.startsWith("@coherence ")) events.push(JSON.parse(line.slice(11)));
    else output.stray.push(line);
  });
  child.stderr
    .setEncoding("utf8")
    .on("data", (chunk) => (output.stderr += chunk));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const next = async (event, after = 0, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.slice(after).find((e) => e.event === event);
      if (found) return found;
      check(
        child.exitCode === null,
        `The backend exited (code ${child.exitCode}, ${events.find((e) => e.event === "error")?.code ?? "no error event"}) before "${event}".`,
      );
      check(
        Date.now() < deadline,
        `No "${event}" event within ${timeoutMs} ms.`,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const send = (command) => child.stdin.write(`${JSON.stringify(command)}\n`);
  const origin = String((await next("ready")).origin);
  report.readyMs = Date.now() - started;
  step("backend ready", `${origin} in ${report.readyMs} ms`);
  send({ op: "status" });
  check(
    (await next("status")).origin === origin,
    "The status event does not match the ready event.",
  );

  // 4. Identity proof, then the launcher's handoff: a one-use bootstrap page whose ticket opens a session.
  const launch = JSON.parse(
    fs.readFileSync(
      path.join(env.SCREENSCRIBE_V2_DATA_DIR, ".local-auth", "launch.json"),
      "utf8",
    ),
  );
  check(
    launch.backend === origin && /^[a-f0-9]{64}$/.test(launch.capability),
    "launch.json is not as expected.",
  );
  const challenge = crypto.randomBytes(32).toString("hex");
  const identity = await fetch(`${origin}/api/auth/identity`, {
    method: "POST",
    headers: { "X-ScreenScribe": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ challenge }),
  }).then((response) => response.json());
  check(
    identity.proof === hmac(launch.capability, "identity", challenge),
    "The backend failed the identity proof.",
  );
  step("identity verified");
  send({ op: "open" });
  const bootstrapFile = String((await next("bootstrap")).file);
  check(
    path.dirname(bootstrapFile) ===
      path.join(env.SCREENSCRIBE_V2_DATA_DIR, ".local-auth"),
    "The bootstrap page is outside the protected launcher folder.",
  );
  const ticket = /name="ticket" value="([^"]+)"/.exec(
    fs.readFileSync(bootstrapFile, "utf8"),
  )?.[1];
  check(ticket, "The bootstrap page has no ticket.");
  const bootstrap = await fetch(`${origin}/api/auth/bootstrap`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "null",
    },
    body: new URLSearchParams({ ticket }),
  });
  const token = /token\\":\\"([a-f0-9]{64})/.exec(await bootstrap.text())?.[1];
  check(bootstrap.ok && token, "Bootstrap did not create a session.");
  await next("session-opened");
  step("browser session created", "through the control channel");
  const api = async (method, route, body) => {
    const response = await fetch(`${origin}/api${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-ScreenScribe": "1",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    check(
      response.ok,
      `${method} /api${route} returned ${response.status}: ${text.slice(0, 200)}`,
    );
    return text ? JSON.parse(text) : undefined;
  };

  // 5. Real work through the compiled backend: health, the offline demo (sharp decodes every screen), listing.
  await api("GET", "/health");
  const demo = await api("POST", "/projects/demo");
  const projects = await api("GET", "/projects");
  check(
    typeof demo?.id === "string" && JSON.stringify(projects).includes(demo.id),
    "The demo project is not listed.",
  );
  check(
    demo.screens?.length === 4,
    `The demo has ${demo.screens?.length ?? 0} screens instead of 4.`,
  );
  step(
    "offline demo created",
    `${demo.id}, ${demo.screens.length} screens decoded`,
  );
  step(
    "no PowerShell",
    "not on the backend's PATH; the guarded writes above went through CoherencePlatform.exe",
  );
  const page = await fetch(`${origin}/`).then((response) => response.text());
  check(page.includes('id="root"'), "The built UI was not served.");
  const assets = fs.readdirSync(path.join(app, "dist", "assets"));
  check(
    !assets.some((name) => /^App-.*\.js$/.test(name)),
    "The development prototype is in the release UI.",
  );
  step("UI served", `${assets.length} assets, no prototype chunk`);

  // 6. The launcher vanishing (stdin closes) must stop the backend gracefully and release the profile.
  const before = events.length;
  const stopStarted = Date.now();
  child.stdin.end();
  check(
    (await next("stopping", before, 15_000)).reason === "launcher-gone",
    "The backend did not stop for a closed control channel.",
  );
  const code = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 15_000)),
  ]);
  check(code === 0, `The backend stopped with ${code} instead of exit code 0.`);
  report.stopMs = Date.now() - stopStarted;
  for (const name of [
    ".instance-lock.json",
    path.join(".local-auth", "launch.json"),
  ])
    check(
      !fs.existsSync(path.join(env.SCREENSCRIBE_V2_DATA_DIR, name)),
      `${name} was not removed on shutdown.`,
    );
  check(
    !output.stray.length,
    `Non-event output on stdout: ${output.stray.slice(0, 3).join(" | ")}`,
  );
  step(
    "graceful stop",
    `exit 0 in ${report.stopMs} ms, lock and launch record released`,
  );
} catch (error) {
  failed = true;
  report.error =
    error instanceof VerifyError
      ? error.message
      : String(error?.stack ?? error);
  console.error(`verify-staged: FAILED — ${report.error}`);
} finally {
  // 7. Confirm nothing is left behind, and check every resolved module came from the copy.
  if (child) {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const leftovers = execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}").Count`,
      ],
      { encoding: "utf8" },
    ).trim();
    report.leftoverChildren = Number(leftovers);
    if (report.leftoverChildren) {
      failed = true;
      console.error(
        `verify-staged: FAILED — ${leftovers} child process(es) outlived the backend.`,
      );
    }
  }
  const resolved = fs.existsSync(resolveLog)
    ? [
        ...new Set(
          fs.readFileSync(resolveLog, "utf8").split(/\r?\n/).filter(Boolean),
        ),
      ]
    : [];
  const appUrl = pathToFileURL(app + path.sep).href.toLowerCase();
  const outside = resolved.filter(
    (url) => url.startsWith("file:") && !url.toLowerCase().startsWith(appUrl),
  );
  report.resolvedModules = resolved.length;
  report.outside = outside;
  if (!resolved.length || outside.length) {
    failed = true;
    console.error(
      outside.length
        ? `verify-staged: FAILED — loaded from outside the app:\n  ${outside.join("\n  ")}`
        : "verify-staged: FAILED — no module resolutions were recorded.",
    );
  } else
    step(
      "all modules resolved inside the app",
      `${resolved.length} resolutions`,
    );
  report.events = events.map((e) => e.event);
  report.stderr = output.stderr.slice(-4000);
  report.result = failed ? "FAIL" : "PASS";
  fs.mkdirSync(path.join(ROOT, "build", "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "build", "meta", "verify-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (keep || failed)
    console.log(`verify-staged: kept ${work} and ${dataRoot}`);
  else
    for (const dir of [work, dataRoot])
      fs.rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
  console.log(`verify-staged: ${report.result}`);
  process.exitCode = failed ? 1 : 0;
}
