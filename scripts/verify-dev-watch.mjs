/** P0 watcher acceptance: disposable application copy, private dependency copy and offline AI only. */
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import {
  access,
  appendFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
  utimes,
} from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
const root = process.cwd();
const fixture = path.join(root, ".cache", "dev-watch-" + Date.now());
const temp = path.join(root, ".cache/browser-temp");
await mkdir(fixture, { recursive: true });
await mkdir(temp, { recursive: true });
for (const folder of ["server", "shared", "samples", "dist"])
  await cp(path.join(root, folder), path.join(fixture, folder), {
    recursive: true,
  });
for (const file of ["package.json", "tsconfig.json", "tsconfig.server.json"])
  await cp(path.join(root, file), path.join(fixture, file));
await mkdir(path.join(fixture, "node_modules"));
// Only ws is writable here. Other dependency junctions are read-only inputs and never mutated.
for (const entry of await readdir(path.join(root, "node_modules"), {
  withFileTypes: true,
})) {
  if (!entry.isDirectory() || entry.name === ".bin") continue;
  const source = path.join(root, "node_modules", entry.name);
  const target = path.join(fixture, "node_modules", entry.name);
  if (entry.name === "ws") await cp(source, target, { recursive: true });
  else await symlink(source, target, "junction");
}
const entryPath = path.join(fixture, "server/index.ts");
await writeFile(
  entryPath,
  'import "../node_modules/ws/lib/event-target.js";\n' +
    (await readFile(entryPath, "utf8")),
);
const dependency = path.join(fixture, "node_modules/ws/lib/event-target.js");
const dependencyBefore = await readFile(
  path.join(root, "node_modules/ws/lib/event-target.js"),
);
const dataDir = path.join(fixture, "server/runtime-data");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("SCREENSCRIBE_V2_") &&
      !/(?:API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET)$/i.test(key),
  ),
);
Object.assign(env, {
  SCREENSCRIBE_V2_DATA_DIR: dataDir,
  SCREENSCRIBE_V2_WORKSPACE_DIR: dataDir + "-workspace",
  SCREENSCRIBE_V2_PORT: "0",
  SCREENSCRIBE_V2_MOCK_DELAY_MS: "600",
  TEMP: temp,
  TMP: temp,
  TMPDIR: temp,
});
for (const key of Object.keys(process.env))
  if (key.startsWith("SCREENSCRIBE_V2_")) delete process.env[key];
Object.assign(process.env, env);
const { prepareBrowserLaunch } =
  await import("../server/security/localLauncher.ts");
let child,
  output = "",
  browser,
  page,
  backend;
const checks = [],
  external = [],
  browserErrors = [];
const check = (message) => {
  checks.push(message);
  console.log("PASS " + message);
};
const manifestPath = path.join(dataDir, ".local-auth/launch.json");
async function manifest() {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }
}
async function ready(previous) {
  await expect
    .poll(
      async () => {
        const value = await manifest();
        return !!value && value.capability !== previous;
      },
      { timeout: 20000 },
    )
    .toBe(true);
  backend = (await manifest()).backend;
}
function start(legacy) {
  output = "";
  const args = legacy
    ? [
        "--watch",
        "--watch-preserve-output",
        "--import",
        "tsx",
        "server/index.ts",
      ]
    : [path.join(root, "scripts/dev-server.mjs")];
  child = spawn(process.execPath, args, {
    cwd: fixture,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
}
async function stopTree() {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise((resolve) => child.once("exit", resolve));
  if (process.platform === "win32") {
    // Only the test process tree created above; never terminate an existing user instance.
    await new Promise((resolve, reject) => {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.once("error", reject);
      killer.once("exit", resolve);
    });
  } else child.kill("SIGTERM");
  await ended;
}
async function api(url, method = "GET", body) {
  return page.evaluate(
    async ({ url, method, body }) => {
      const session = JSON.parse(
        localStorage.getItem("screenscribe.local-session.v1"),
      );
      const response = await fetch("/api" + url, {
        method,
        headers: {
          Authorization: `Bearer ${session.token}`,
          "X-ScreenScribe": "1",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    { url, method, body },
  );
}
async function launch() {
  const handoff = await prepareBrowserLaunch();
  await page.goto(pathToFileURL(handoff.file).href);
  await page.waitForURL(handoff.origin + "/");
  await expect(
    page.getByRole("heading", { name: "Your projects" }),
  ).toBeVisible();
}
async function generate() {
  const created = await api("/projects/demo", "POST", {});
  expect(created.status).toBe(201);
  const pid = created.body.id;
  await page.goto(`${backend}/#/projects/${pid}/analysis`);
  await expect(
    page.getByRole("heading", { name: "A thoughtful analysis." }),
  ).toBeVisible();
  const started = await api(`/projects/${pid}/generate`, "POST", {});
  expect(started.status).toBe(202);
  await expect
    .poll(async () => (await api("/jobs/" + started.body.jobId)).body.status)
    .toBe("running");
  return { pid, id: started.body.jobId };
}
try {
  start(true);
  await ready();
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ??
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
    args: ["--disable-background-networking", "--no-first-run"],
    env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "file:" || url.hostname === "127.0.0.1")
      return route.continue();
    external.push(url.origin);
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", () => browserErrors.push("Unexpected browser error"));
  await launch();
  const interrupted = await generate();
  const old = await manifest();
  await appendFile(dependency, "\n// isolated dependency reproduction\n");
  await ready(old.capability);
  expect(
    output.includes("Restarting") && output.includes("event-target.js"),
  ).toBe(true);
  const oldSession = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("screenscribe.local-session.v1")),
  );
  expect(
    (
      await fetch(backend + "/api/auth/session", {
        headers: { Authorization: `Bearer ${oldSession.token}` },
      })
    ).status,
  ).toBe(401);
  await launch();
  expect((await api("/jobs/" + interrupted.id)).body.status).toBe("failed");
  expect(
    output.includes(
      "Reset 1 project(s) that were interrupted while generating",
    ),
  ).toBe(true);
  check(
    "Original Node import watcher reproduces ws dependency restart, invalid session and interrupted offline generation",
  );
  await stopTree();
  const previous = (await manifest()).capability;
  start(false);
  await ready(previous);
  await launch();
  const job = await generate();
  const stable = await manifest();
  const pidBefore = JSON.parse(
    await readFile(path.join(dataDir, ".instance-lock.json"), "utf8"),
  ).pid;
  await appendFile(dependency, "\n// irrelevant private dependency update\n");
  for (const file of [
    "server/node_modules/synthetic/index.ts",
    "server/logs/event.json",
    "server/tmp/temporary.ts",
    "server/index.tmp.ts",
    "server/ignored.test.ts",
    "server/runtime-data/projects/synthetic/generated.ts",
    ".cache/temp.ts",
    "dist/temporary.js",
    "artifacts/temp.log",
    "src/temporary.tsx",
    "package-lock.json",
  ]) {
    const target = path.join(fixture, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "// irrelevant isolated fixture\n");
  }
  await new Promise((resolve) => setTimeout(resolve, 1600));
  expect((await manifest()).capability === stable.capability).toBe(true);
  expect(
    JSON.parse(
      await readFile(path.join(dataDir, ".instance-lock.json"), "utf8"),
    ).pid,
  ).toBe(pidBefore);
  expect((await api("/auth/session")).status).toBe(200);
  expect((await api("/jobs/" + job.id)).body.status).toBe("running");
  expect(output.includes("restarting backend")).toBe(false);
  // Metadata and identical saves of eligible source/configuration must also preserve the job.
  for (const file of [
    "server/config.ts",
    "shared/types.ts",
    "package.json",
    "tsconfig.json",
    "tsconfig.server.json",
  ]) {
    const target = path.join(fixture, file),
      original = await readFile(target);
    await utimes(target, new Date(0), new Date(0));
    await writeFile(target, original);
    await writeFile(target + ".tmp", original);
    await rename(target + ".tmp", target);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect((await manifest()).capability === stable.capability).toBe(true);
  expect((await api("/auth/session")).status).toBe(200);
  expect(output.includes("restarting backend")).toBe(false);
  check(
    "Dependency, generated storage and unchanged source/configuration saves preserve the same backend and authenticated running job",
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "A thoughtful analysis." }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Local session required" }),
  ).not.toBeVisible();
  await expect
    .poll(async () => (await api("/jobs/" + job.id)).body.status, {
      timeout: 60000,
      intervals: [500],
    })
    .toBe("succeeded");
  expect(
    (await api(`/projects/${job.pid}/model`)).body.useCases.length,
  ).toBeGreaterThan(0);
  expect((await manifest()).capability === stable.capability).toBe(true);
  await page.screenshot({
    path: path.join(root, "artifacts/dev-watch-generation.png"),
    animations: "disabled",
  });
  check(
    "Authenticated browser refresh and actual offline specification generation complete despite irrelevant filesystem activity",
  );
  for (const file of ["server/config.ts", "shared/types.ts", "tsconfig.json"]) {
    const before = await manifest();
    const sessionBefore = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("screenscribe.local-session.v1")),
    );
    const target = path.join(fixture, file);
    if (file.endsWith(".json")) {
      const changed = JSON.parse(await readFile(target, "utf8"));
      changed.compilerOptions.target =
        changed.compilerOptions.target === "ES2022" ? "ES2023" : "ES2022";
      await writeFile(target + ".tmp", JSON.stringify(changed));
      await rename(target + ".tmp", target);
    } else await appendFile(target, "\n// intentional isolated source edit\n");
    await ready(before.capability);
    expect(
      (
        await fetch(backend + "/api/auth/session", {
          headers: { Authorization: `Bearer ${sessionBefore.token}` },
        })
      ).status,
    ).toBe(401);
    await launch();
    expect((await api("/auth/session")).status).toBe(200);
  }
  check(
    "Backend source, shared source and atomic configuration replacement still restart; authentication remains per-launch and launcher recovery works",
  );
  expect(
    (
      await readFile(path.join(root, "node_modules/ws/lib/event-target.js"))
    ).equals(dependencyBefore),
  ).toBe(true);
  expect(browserErrors.length).toBe(0);
  expect(external.length).toBe(0);
  check(
    "Actual installed dependency is byte-identical; no external requests, paid APIs or live tracker writes",
  );
  await writeFile(
    path.join(root, "artifacts/dev-watch-verification.json"),
    JSON.stringify(
      {
        checks,
        errors: browserErrors,
        externalRequests: external.length,
        scope:
          "Actual application copy and production authentication with original and corrected development launchers. Synthetic offline generation only; all writable fixtures isolated under V2 .cache.",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser?.close();
  await stopTree();
}
