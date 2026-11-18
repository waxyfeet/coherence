/** S02 browser acceptance: production server/launcher, synthetic projects, no external egress. */
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const root = process.cwd();
let port = 0;
const devPort = await new Promise((resolve, reject) => {
  const reservation = http.createServer();
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", () => {
    const chosen = reservation.address().port;
    reservation.close(() => resolve(chosen));
  });
});
const temp = path.join(root, ".cache/browser-temp");
await mkdir(temp, { recursive: true });
const dataDir = path.join(root, ".cache", "local-auth-" + Date.now());
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("SCREENSCRIBE_V2_"),
  ),
);
Object.assign(env, {
  SCREENSCRIBE_V2_DATA_DIR: dataDir,
  SCREENSCRIBE_V2_WORKSPACE_DIR: dataDir + "-workspace",
  SCREENSCRIBE_V2_PORT: String(port),
  SCREENSCRIBE_V2_DEV_PORT: String(devPort),
  SCREENSCRIBE_V2_MOCK_DELAY_MS: "100",
  TEMP: temp,
  TMP: temp,
  TMPDIR: temp,
});
Object.assign(process.env, env);
const { prepareBrowserLaunch } =
  await import("../server/security/localLauncher.ts");
const { SESSION_STORAGE_KEY } = await import("../shared/localAuth.ts");
const { proof } = await import("../server/security/localAuth.ts");
let output = "",
  viteOutput = "",
  child,
  browser,
  vite;
const checks = [],
  errors = [],
  external = [],
  urls = [];
const authenticationMaterial = new Set(),
  browserConsole = [];
const relays = [];
async function alternateRelay(listenPort) {
  const observed = [],
    captured = [];
  let probes = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/__ipv6_relay_probe") {
      probes++;
      res.end("Isolated IPv6 relay");
      return;
    }
    observed.push({
      path: req.url,
      authorization: !!req.headers.authorization,
    });
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: listenPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        const body = [];
        response.on("data", (chunk) => body.push(chunk));
        response.on("end", () => {
          const bytes = Buffer.concat(body);
          if (req.url === "/api/auth/bootstrap") captured.push(bytes);
          res.writeHead(response.statusCode, response.headers);
          res.end(bytes);
        });
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "::1", port: listenPort, ipv6Only: true }, resolve);
  });
  const relay = {
    server,
    observed,
    captured,
    get probes() {
      return probes;
    },
  };
  relays.push(relay);
  return relay;
}
function start() {
  child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => {
    output += b;
  });
  child.stderr.on("data", (b) => {
    output += b;
  });
}
async function ready() {
  await expect
    .poll(
      async () => {
        try {
          await access(path.join(dataDir, ".local-auth/launch.json"));
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 20000 },
    )
    .toBe(true);
  const record = JSON.parse(
    await readFile(path.join(dataDir, ".local-auth/launch.json"), "utf8"),
  );
  port = Number(new URL(record.backend).port);
  // Preserve the same owned IPv4 port for the restart scenario and the isolated Vite proxy.
  env.SCREENSCRIBE_V2_PORT = String(port);
  process.env.SCREENSCRIBE_V2_PORT = String(port);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await ended;
}
function check(value) {
  checks.push(value);
  console.log("PASS " + value);
}
async function launch(page, dev = false) {
  const handoff = await prepareBrowserLaunch(dev);
  expect(handoff.origin).toBe(`http://127.0.0.1:${dev ? devPort : port}`);
  expect(await readFile(handoff.file, "utf8")).toContain(
    `action="${handoff.origin}/api/auth/bootstrap"`,
  );
  await page.goto(pathToFileURL(handoff.file).href);
  await page.waitForURL(handoff.origin + "/");
  await expect(
    page.getByRole("heading", { name: "Your projects" }),
  ).toBeVisible();
  const session = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    SESSION_STORAGE_KEY,
  );
  const capability = JSON.parse(
    await readFile(path.join(dataDir, ".local-auth/launch.json"), "utf8"),
  ).capability;
  authenticationMaterial.add(session.token);
  authenticationMaterial.add(capability);
  authenticationMaterial.add(
    proof(capability, "dev-proxy", `127.0.0.1:${devPort}`),
  );
  return handoff;
}
try {
  start();
  await ready();
  const builtRelay = await alternateRelay(port);
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ??
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
    args: [
      "--disable-background-networking",
      "--no-first-run",
      "--host-resolver-rules=MAP localhost [::1]",
    ],
    env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  context.on("page", (tab) =>
    tab.on("console", (message) => browserConsole.push(message.text())),
  );
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (
      url.protocol === "file:" ||
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
      return route.continue();
    external.push(url.origin);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", () => errors.push("Unexpected browser error"));
  page.on("request", (r) => urls.push(r.url()));
  // Confirm real browser hostname resolution reaches the independently bound IPv6 socket.
  const legacy = await context.newPage();
  await legacy.goto(`http://localhost:${port}/__ipv6_relay_probe`);
  await expect(legacy.locator("body")).toHaveText("Isolated IPv6 relay");
  expect(builtRelay.probes).toBe(1);
  // A hostname tab containing a synthetic stored credential must never send it to that relay.
  await legacy.evaluate(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          token: "b".repeat(64),
          expiresAt: Date.now() + 60000,
        }),
      ),
    SESSION_STORAGE_KEY,
  );
  await legacy.goto(`http://localhost:${port}/`);
  await expect(
    legacy.getByRole("dialog", { name: "Local session required" }),
  ).toBeVisible();
  await expect(
    legacy.getByRole("button", { name: "Reconnect this tab" }),
  ).toBeDisabled();
  expect(
    builtRelay.observed.some(
      (request) => request.authorization || request.path.startsWith("/api/"),
    ),
  ).toBe(false);
  await legacy.close();
  builtRelay.observed.length = 0;
  check(
    "IPv6-first hostname recovery refuses to send stored credentials to the alternate listener",
  );
  await page.goto(`http://127.0.0.1:${port}/`);
  await expect(
    page.getByRole("dialog", { name: "Local session required" }),
  ).toBeVisible();
  expect(
    (
      await context.request.get(`http://127.0.0.1:${port}/api/projects`)
    ).status(),
  ).toBe(401);
  check("A direct visit cannot authenticate or read projects");
  const handoff = await launch(page);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your projects" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Try offline demo", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create demo project", exact: true })
    .click();
  await expect(
    page.getByText("Acme Orders — demo", { exact: true }).first(),
  ).toBeVisible();
  await expect
    .poll(() => page.locator('img[src^="blob:"]').count())
    .toBeGreaterThan(0);
  const stored = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    SESSION_STORAGE_KEY,
  );
  const cap = JSON.parse(
    await readFile(path.join(dataDir, ".local-auth/launch.json"), "utf8"),
  ).capability;
  const api = async (url, method = "GET", body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${stored.token}`,
        "X-ScreenScribe": "1",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw Error("Synthetic API operation failed: " + res.status);
    return res.json();
  };
  // B3-02: exercise real expiry/restart recovery with an imported decoration.
  const workspaceSettings = await api("/settings");
  await api("/settings/workspace", "PUT", {
    baseRevision: workspaceSettings.revision,
    connections: workspaceSettings.connections,
    defaultConnectionId: workspaceSettings.defaultConnectionId,
    integrations: [],
    preferences: {
      density: "comfortable",
      reduceMotion: false,
      visionId: workspaceSettings.defaultConnectionId,
      textId: workspaceSettings.defaultConnectionId,
      thoroughness: "thorough",
      granularity: "fine",
      preserveEdits: true,
      embedImages: false,
      reuseAnalysis: false,
      ...workspaceSettings.preferences,
      theme: "ocean",
      backgroundEffects: true,
    },
  });
  await page.reload();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const scene = page.locator("#odysseus-background");
  await expect(scene).toHaveCount(1);
  await expect(scene).toHaveAttribute("data-motion", "running");
  const projects = await api("/projects");
  const pid = projects[0].id;
  check(
    "Private launch, browser refresh, project creation and authenticated screenshot bytes work",
  );
  // Exercise the real authenticated fetch stream, analysis, specification reads and CSV download.
  await page.goto(`http://127.0.0.1:${port}/#/projects/${pid}/analysis`);
  const startedResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/projects/${pid}/generate`) &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Generate offline example", exact: true })
    .click();
  const started = await (await startedResponse).json();
  await expect(
    page
      .getByRole("dialog", { name: "Workspace activity", exact: true })
      .getByRole("progressbar")
      .first(),
  ).toBeVisible();
  await expect
    .poll(async () => (await api("/jobs/" + started.jobId)).status, {
      timeout: 30000,
    })
    .toBe("succeeded");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByText("Your specification is ready for review.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^Export/ })
    .first()
    .click();
  await expect(
    page.getByText("Download real CSV", { exact: true }),
  ).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page.getByText("Download real CSV", { exact: true }).click();
  const download = await downloaded;
  const downloadPath = path.join(root, "artifacts/local-auth-use-cases.csv");
  await download.saveAs(downloadPath);
  expect(await readFile(downloadPath, "utf8")).toContain("ID,Title");
  check(
    "Offline generation, authenticated progress, specification navigation and real CSV download work",
  );
  const replay = await context.newPage();
  await replay.goto(pathToFileURL(handoff.file).href);
  await expect(
    replay.getByText(/session is missing or has expired/),
  ).toBeVisible();
  await replay.close();
  check("The browser handoff cannot be replayed");
  // Simulated expiry in the browser must block before submitting a mutation.
  await page
    .locator(".app-navigation")
    .getByRole("button", { name: "Use cases", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.locator('textarea[aria-label="Markdown editor"]');
  const unsaved =
    (await editor.inputValue()) + "\n\nS02_UNSAVED_HUMAN_EDIT_RETAIN_ME\n";
  await editor.fill(unsaved);
  const editorHandle = await editor.elementHandle();
  await page.evaluate((key) => {
    const session = JSON.parse(localStorage.getItem(key));
    session.expiresAt = Date.now() - 1;
    localStorage.setItem(key, JSON.stringify(session));
  }, SESSION_STORAGE_KEY);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("dialog", { name: "Local session required" }),
  ).toBeVisible();
  await expect(scene).toHaveCount(0);
  expect(await editorHandle.evaluate((node) => node.isConnected)).toBe(true);
  await expect(editor).toHaveValue(unsaved);
  const helper = await context.newPage();
  await launch(helper);
  await helper.close();
  if (
    await page.getByRole("button", { name: "Reconnect this tab" }).isVisible()
  )
    await page.getByRole("button", { name: "Reconnect this tab" }).click();
  await expect(
    page.getByRole("dialog", { name: "Local session required" }),
  ).toHaveCount(0);
  await expect(scene).toHaveCount(1);
  await expect(scene).toHaveAttribute("data-motion", "running");
  expect(await editorHandle.evaluate((node) => node.isConnected)).toBe(true);
  await expect(editor).toHaveValue(unsaved);
  check(
    "Expiry recovery releases the imported scene and reconnects without remounting or losing the dirty editor",
  );
  const beforeRestart = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)).token,
    SESSION_STORAGE_KEY,
  );
  await stop();
  // Windows child termination may not deliver SIGTERM to JS. The existing instance lock reaps dead PIDs.
  start();
  await expect
    .poll(
      async () => {
        try {
          const record = JSON.parse(
            await readFile(
              path.join(dataDir, ".local-auth/launch.json"),
              "utf8",
            ),
          );
          return record.capability !== cap;
        } catch {
          return false;
        }
      },
      { timeout: 20000 },
    )
    .toBe(true);
  expect(
    (
      await fetch(`http://127.0.0.1:${port}/api/projects`, {
        headers: { Authorization: `Bearer ${beforeRestart}` },
      })
    ).status,
  ).toBe(401);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("dialog", { name: "Local session required" }),
  ).toBeVisible();
  await expect(scene).toHaveCount(0);
  expect(await editorHandle.evaluate((node) => node.isConnected)).toBe(true);
  await expect(editor).toHaveValue(unsaved);
  const recovery = await context.newPage();
  await launch(recovery);
  await recovery.close();
  if (
    await page.getByRole("button", { name: "Reconnect this tab" }).isVisible()
  )
    await page.getByRole("button", { name: "Reconnect this tab" }).click();
  await expect(
    page.getByRole("dialog", { name: "Local session required" }),
  ).toHaveCount(0);
  await expect(scene).toHaveCount(1);
  await expect(scene).toHaveAttribute("data-motion", "running");
  expect(await editorHandle.evaluate((node) => node.isConnected)).toBe(true);
  await expect(editor).toHaveValue(unsaved);
  check(
    "A real server restart invalidates the old session, releases/restores exactly one imported scene and preserves the mounted unsaved editor",
  );
  expect(builtRelay.observed).toHaveLength(0);
  expect(builtRelay.captured).toHaveLength(0);
  check(
    "Built launch, navigation and restart handoffs never reach the same-port IPv6 relay",
  );
  const devRelay = await alternateRelay(devPort);
  // Use a separate dev server on a free port; its only backend is this isolated fixture.
  vite = spawn(
    process.execPath,
    [
      path.join(
        path.dirname(
          createRequire(import.meta.url).resolve("vite/package.json"),
        ),
        "bin/vite.js",
      ),
      "--host",
      "127.0.0.1",
      "--port",
      String(devPort),
      "--strictPort",
    ],
    { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  vite.stdout.on("data", (b) => {
    viteOutput += b;
  });
  vite.stderr.on("data", (b) => {
    viteOutput += b;
  });
  await expect
    .poll(() => viteOutput.includes("Local:"), { timeout: 20000 })
    .toBe(true);
  const probe = await context.newPage();
  await probe.goto(`http://localhost:${devPort}/__ipv6_relay_probe`);
  await expect(probe.locator("body")).toHaveText("Isolated IPv6 relay");
  await probe.close();
  expect(devRelay.probes).toBe(1);
  const development = await context.newPage();
  await launch(development, true);
  await development.reload();
  await expect(
    development.getByRole("heading", { name: "Your projects" }),
  ).toBeVisible();
  const currentCapability = JSON.parse(
    await readFile(path.join(dataDir, ".local-auth/launch.json"), "utf8"),
  ).capability;
  for (const privateUrl of [
    `http://127.0.0.1:${devPort}/.cache/` +
      path.basename(dataDir) +
      "/.local-auth/launch.json",
    `http://127.0.0.1:${devPort}/@fs/` +
      path.join(dataDir, ".local-auth/launch.json").replaceAll("\\", "/"),
  ]) {
    const privateFile = await fetch(privateUrl);
    expect(privateFile.status).toBe(403);
    expect(await privateFile.text()).not.toContain(currentCapability);
  }
  expect((await fetch(`http://127.0.0.1:${devPort}/api/projects`)).status).toBe(
    401,
  );
  check(
    "The verified development proxy uses literal IPv4 for launch, refresh and protected runtime files",
  );
  expect(devRelay.observed).toHaveLength(0);
  expect(devRelay.captured).toHaveLength(0);
  check(
    "Development verification and browser bootstrap never expose a ticket or session to the IPv6 relay",
  );
  await development.setViewportSize({ width: 320, height: 740 });
  await development.evaluate(
    (key) => localStorage.removeItem(key),
    SESSION_STORAGE_KEY,
  );
  await development.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    development.getByRole("dialog", { name: "Local session required" }),
  ).toBeVisible();
  await development.screenshot({
    path: path.join(root, "artifacts/local-auth-320.png"),
    fullPage: true,
  });
  expect(
    await development.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const diagnostics = [output, viteOutput, ...browserConsole].join("\n");
  for (const value of authenticationMaterial) {
    expect(diagnostics.includes(value)).toBe(false);
    expect(urls.some((url) => url.includes(value))).toBe(false);
  }
  expect(external).toHaveLength(0);
  expect(errors).toHaveLength(0);
  check(
    "Recovery fits 320px and authentication material is absent from URLs, server output and the diagnostic report",
  );
  await writeFile(
    path.join(root, "artifacts/local-auth-browser.json"),
    JSON.stringify(
      {
        checks,
        errors,
        externalRequests: external.length,
        ipv6RelayRegression: {
          builtRelayRequestsDuringLaunch: builtRelay.observed.length,
          developmentRelayRequestsDuringLaunch: devRelay.observed.length,
          capturedBootstrapResponses: relays.reduce(
            (sum, relay) => sum + relay.captured.length,
            0,
          ),
          browserResolutionProbePassed:
            builtRelay.probes === 1 && devRelay.probes === 1,
        },
        scope:
          "Synthetic isolated production server and development proxy; no paid AI calls or remote writes. No session material recorded.",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser?.close();
  vite?.kill("SIGTERM");
  await stop();
  for (const relay of relays) {
    relay.server.closeAllConnections();
    await new Promise((resolve) => relay.server.close(resolve));
  }
}
