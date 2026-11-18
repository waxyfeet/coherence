import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const root = process.cwd(),
  temp = path.join(root, ".cache/browser-temp"),
  out = path.join(root, "artifacts"),
  port = 4499;
await mkdir(temp, { recursive: true });
process.env.TEMP = temp;
process.env.TMP = temp;
process.env.TMPDIR = temp;
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("SCREENSCRIBE_V2_"),
  ),
);
const dataDir = path.join(root, ".cache", "parity-browser-" + Date.now());
Object.assign(env, {
  SCREENSCRIBE_V2_DATA_DIR: dataDir,
  SCREENSCRIBE_V2_WORKSPACE_DIR: dataDir + "-workspace",
  SCREENSCRIBE_V2_PORT: String(port),
  SCREENSCRIBE_V2_MOCK_DELAY_MS: "300",
});
const child = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/parity-api.ts"],
  {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  },
);
let testSession;
child.on("message", (message) => {
  if (message.type === "test-session") testSession = message.session;
});
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));
let browser;
const checks = [],
  errors = [],
  external = [];
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(Error("Fixture API startup timeout: " + output));
    }, 15000);
    const poll = setInterval(() => {
      if (output.includes("PARITY_API_READY")) {
        clearTimeout(timeout);
        clearInterval(poll);
        resolve();
      }
    }, 100);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      clearInterval(poll);
      reject(Error("Fixture API exited " + code + ": " + output));
    });
  });
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ??
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
    args: ["--disable-background-networking", "--no-first-run"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  await context.addInitScript((session) => {
    if (!localStorage.getItem("screenscribe.local-session.v1"))
      localStorage.setItem(
        "screenscribe.local-session.v1",
        JSON.stringify(session),
      );
  }, testSession);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (response) => {
    if (response.status() >= 400)
      console.log("HTTP failure", response.status(), response.url());
  });
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" && url.port === String(port))
      return route.continue();
    external.push(url.href);
    return route.abort();
  });
  async function api(url, method = "GET", body) {
    const response = await fetch(`http://127.0.0.1:${port}/api` + url, {
      method,
      headers: {
        "X-ScreenScribe": "1",
        Authorization: `Bearer ${testSession.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error);
    return result;
  }
  function check(text) {
    checks.push(text);
    console.log("PASS " + text);
  }
  async function nav(label) {
    await page
      .locator(".app-navigation")
      .getByRole("button", { name: label, exact: true })
      .click();
  }
  const project = await api("/projects", "POST", {
    name: "Parity recovery fixture",
    description: "Isolated local acceptance",
  });
  await api(`/projects/${project.id}`, "DELETE");
  await page.goto(`http://127.0.0.1:${port}/`);
  await page
    .getByRole("button", { name: "Library options", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Local trash", exact: true })
    .click();
  await page
    .locator(".recovery-row")
    .filter({ hasText: "Parity recovery fixture" })
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Restore project", exact: true })
    .click();
  await expect(page.locator(".real-overview")).toBeVisible();
  expect((await api(`/projects/${project.id}`)).name).toBe(project.name);
  check(
    "Local trash recovery restores an actual deleted project through the UI",
  );
  await nav("Screens");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByRole("menuitem", { name: /Figma/ }).click();
  await page
    .getByLabel("Figma file URL", { exact: true })
    .fill("https://www.figma.com/design/FixtureKey123/example");
  await page.getByRole("button", { name: "Load frames", exact: true }).click();
  await expect(page.locator(".real-frame-list label")).toHaveCount(1);
  await expect(page.locator(".real-frame-list img")).toHaveJSProperty(
    "naturalWidth",
    1440,
  );
  const listed = await api(`/projects/${project.id}/figma/frames`, "POST", {
    fileUrl: "FixtureKey123",
  });
  const thumbnail = listed.frames[0].thumbnailUrl;
  expect(thumbnail).toBe("/api/figma/thumbnail/FixtureKey123/1%3A1");
  expect(JSON.stringify(listed)).not.toContain("s3-alpha");
  expect((await fetch(`http://127.0.0.1:${port}${thumbnail}`)).status).toBe(
    401,
  );
  const privateThumbnail = await fetch(`http://127.0.0.1:${port}${thumbnail}`, {
    headers: { Authorization: `Bearer ${testSession.token}` },
  });
  expect(privateThumbnail.status).toBe(200);
  expect(privateThumbnail.headers.get("content-type")).toContain("image/png");
  check(
    "Figma previews load authenticated PNGs through the backend; signed CDN URLs and unauthenticated image reads are blocked",
  );
  await page.getByLabel("Filter frames", { exact: true }).fill("Parity login");
  await page.locator(".real-frame-list input").check();
  await page
    .getByRole("button", { name: "Import selected frames", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Workspace activity", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const imported = (await api(`/projects/${project.id}`)).screens;
  expect(imported).toHaveLength(1);
  expect(imported[0].width).toBe(1440);
  await page.screenshot({
    path: path.join(out, "parity-01-figma-import.png"),
    animations: "disabled",
  });
  check(
    "Figma listing, filtering, selection and job import save actual image bytes through fixture HTTP responses",
  );
  const textOnly = await api("/settings/connections", "POST", {
    name: "Preflight fixture — never called",
    provider: "ollama",
    model: "text-only-fixture",
    baseUrl: "http://127.0.0.1:11434",
    vision: "no",
  });
  const publicSettings = await api("/settings");
  await api(`/projects/${project.id}`, "PATCH", {
    llm: {
      visionConnectionId: textOnly.id,
      textConnectionId: publicSettings.defaultConnectionId,
    },
  });
  await page.goto(`http://127.0.0.1:${port}/#/projects/${project.id}/analysis`);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Generate specifications", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("status").filter({ hasText: "text-only" }),
  ).toBeVisible();
  await expect(page.locator(".analysis-estimate")).toContainText(
    "Rough planning estimate",
  );
  check(
    "Preflight blocks a text-only screen reader and shows an explicitly heuristic planning estimate without contacting a model",
  );
  const demo = await api("/projects/demo", "POST", {});
  await page.goto(`http://127.0.0.1:${port}/#/projects/${demo.id}/analysis`);
  const generationResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/projects/${demo.id}/generate`) &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Generate offline example", exact: true })
    .click();
  const start = await (await generationResponse).json();
  const activity = page.getByRole("dialog", {
    name: "Workspace activity",
    exact: true,
  });
  await expect(activity).toBeVisible();
  await expect(activity.locator(".job-progress-heading strong")).toHaveText(
    "Reading screens",
  );
  await expect(
    activity.getByRole("progressbar", { name: /Reading screens/ }),
  ).toBeInViewport();
  await expect(activity.locator(".job-progress-state")).toHaveText("Working");
  await page.screenshot({
    path: path.join(out, "parity-05-live-progress.png"),
    animations: "disabled",
  });
  await activity
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(
    page.locator(".pipeline-panel > .job-progress-panel"),
  ).toBeVisible();
  check(
    "A real offline job shows live progress above the Activity logs and retains it on Analysis when the dialog closes",
  );
  await page.setViewportSize({ width: 320, height: 780 });
  await page
    .getByRole("button", { name: "Toggle workspace navigation", exact: true })
    .click();
  await page
    .getByRole("complementary", { name: "Workspace navigation" })
    .getByRole("button", { name: "Activity", exact: true })
    .click();
  const progressBox = await activity
    .getByRole("region", { name: "Operation progress", exact: true })
    .boundingBox();
  expect(progressBox.x).toBeGreaterThanOrEqual(0);
  expect(progressBox.x + progressBox.width).toBeLessThanOrEqual(320);
  await expect(activity.getByRole("progressbar")).toBeInViewport();
  await page.screenshot({
    path: path.join(out, "parity-06-progress-320.png"),
    animations: "disabled",
  });
  check(
    "Activity progress stays visible within the 320px dialog without relying on the covered parent screen",
  );
  await activity
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  let job;
  for (let i = 0; i < 100; i++) {
    job = await api(`/jobs/${start.jobId}`);
    if (["succeeded", "failed"].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(job.status).toBe("succeeded");
  // A terminal backend job can precede the browser's final model refresh.
  // Begin document-link checks only after the real analysis UI has loaded that model.
  await expect(
    page.getByRole("button", { name: "Review use cases", exact: true }),
  ).toBeVisible();
  const model = await api(`/projects/${demo.id}/model`);
  for (const [file, content] of [
    [
      "PARITY-LINKS.md",
      "# Links\n\n[Exact section](PARITY-TARGET.md#exact-section)\n",
    ],
    [
      "PARITY-TARGET.md",
      "# Link target\n\n## Exact section\n\n" +
        Array.from({ length: 240 }, (_, i) => `Context line ${i + 1}.`).join(
          "\n",
        ) +
        "\nLiteral source line target.\n",
    ],
  ])
    await api(`/projects/${demo.id}/files/content`, "PUT", {
      path: file,
      content,
    });
  await page.goto(
    `http://127.0.0.1:${port}/#/projects/${demo.id}/use-cases?file=PARITY-LINKS.md`,
  );
  await page
    .getByRole("button", { name: "Exact section", exact: true })
    .click();
  await expect(page.locator("#exact-section")).toBeInViewport();
  await page
    .getByLabel("Search use cases", { exact: true })
    .fill("Literal source line");
  await page.locator(".disk-search-results button").first().click();
  await expect(page.locator('[data-source-line="245"]')).toBeInViewport();
  await expect(page.locator('[data-source-line="245"]')).toContainText(
    "Literal source line target",
  );
  await page.screenshot({
    path: path.join(out, "parity-02-source-navigation.png"),
    animations: "disabled",
  });
  check(
    "Relative Markdown anchors and saved-file search navigate to the exact section and source line",
  );
  await nav("Knowledge graph");
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await page
    .getByLabel("Knowledge graph evidence list")
    .getByRole("button")
    .first()
    .click();
  await page
    .getByRole("button", { name: "Focus neighbors", exact: true })
    .click();
  const graph = await api(`/projects/${demo.id}/graph`);
  expect(
    await page.locator(".graph-accessible-list button").count(),
  ).toBeLessThan(graph.nodes.length);
  await page
    .getByRole("button", { name: "Show whole graph", exact: true })
    .click();
  await expect(page.locator(".graph-accessible-list button")).toHaveCount(
    graph.nodes.length,
  );
  const feature = graph.nodes.find((n) => n.kind === "feature");
  await page
    .locator(".graph-accessible-list button")
    .filter({ hasText: feature.id })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Propose a change", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Change target kind", exact: true }),
  ).toContainText("A feature");
  await page
    .getByRole("button", { name: "Trace connections", exact: true })
    .click();
  await expect(page.locator(".real-trace")).toContainText("UC-");
  await page.screenshot({
    path: path.join(out, "parity-03-targeted-change.png"),
    animations: "disabled",
  });
  check(
    "Graph neighbor focus and feature-targeted change drafts use real graph relationships",
  );
  const first = model.useCases[0];
  const regenerated = await api(`/projects/${demo.id}/generate`, "POST", {});
  for (let i = 0; i < 100; i++) {
    const saved = await api(`/jobs/${regenerated.jobId}`);
    if (saved.status === "succeeded") break;
    if (saved.status === "failed") throw Error(saved.error);
    await new Promise((r) => setTimeout(r, 100));
  }
  expect((await api(`/projects/${demo.id}/history`)).length).toBeGreaterThan(0);
  const before = await api(
    `/projects/${demo.id}/files/content?path=${encodeURIComponent(first.filePath)}`,
  );
  await nav("Overview");
  await page
    .getByRole("button", { name: "Model history", exact: true })
    .click();
  await page
    .locator(".recovery-row")
    .first()
    .getByRole("button", { name: "Review restore", exact: true })
    .click();
  await page.screenshot({
    path: path.join(out, "parity-04-recovery-review.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Restore selected version", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Model history", exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await api(
        `/projects/${demo.id}/files/content?path=${encodeURIComponent(first.filePath)}`,
      )
    ).contentHash,
  ).toBe(before.contentHash);
  check("Model-history restore leaves human Markdown bytes unchanged");
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("button", { name: "New area", exact: true }).click();
  await page.getByLabel("Area name", { exact: true }).fill("Client delivery");
  await page.getByRole("button", { name: "Save area", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Client delivery/ }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: /^All projects/ }).click();
  await page
    .getByRole("button", { name: `Actions for ${demo.name}`, exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Move to area", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Project area", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Client delivery", exact: true })
    .click();
  await page.getByRole("button", { name: "Move project", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const grouped = await api(`/projects/${demo.id}`);
  expect(grouped.areaId).toBeTruthy();
  await page
    .getByRole("button", { name: "Manage area Client delivery", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Rename area", exact: true })
    .click();
  await page.getByLabel("Area name", { exact: true }).fill("Delivery trials");
  await page.getByRole("button", { name: "Save area", exact: true }).click();
  await expect(page.locator(".project-card")).toHaveCount(1);
  await page.screenshot({
    path: path.join(out, "parity-07-project-areas.png"),
    animations: "disabled",
  });
  check(
    "Named areas can be created, assigned, renamed and filtered through the library UI",
  );
  await page
    .getByRole("button", { name: `Actions for ${demo.name}`, exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Duplicate project", exact: true })
    .click();
  await page
    .getByLabel("Duplicate name", { exact: true })
    .fill("Independent trial copy");
  await page
    .getByRole("button", { name: "Create duplicate", exact: true })
    .click();
  await expect(page.locator(".screens-page")).toBeVisible();
  const copy = (await api("/projects")).find(
    (p) => p.name === "Independent trial copy",
  );
  const copyDetail = await api(`/projects/${copy.id}`);
  expect(copyDetail.status).toBe("draft");
  expect(copyDetail.hasModel).toBe(false);
  expect(copyDetail.useCaseCount).toBe(0);
  expect(copyDetail.areaId).toBe(grouped.areaId);
  expect(copyDetail.screens).toHaveLength(4);
  expect(copyDetail.description).toBe(grouped.description);
  expect(copyDetail.llm).toEqual(grouped.llm);
  expect(copyDetail.outputDir).not.toBe(grouped.outputDir);
  expect(copyDetail.generationPreferences).toEqual(
    grouped.generationPreferences,
  );
  await nav("Analysis");
  await page
    .getByRole("button", { name: "Generate offline example", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  expect((await api(`/projects/${copy.id}`)).hasModel).toBe(true);
  check(
    "Duplication retains project inputs and images, starts without analysis and can generate independently offline",
  );
  await nav("Overview");
  await page
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await expect(page.locator(".deletion-paths")).toBeVisible();
  await page.getByRole("button", { name: "Keep project", exact: true }).click();
  expect((await api(`/projects/${copy.id}`)).id).toBe(copy.id);
  await page
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "Move this project to trash?" })
      .getByRole("button", { name: "Move to trash", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: path.join(out, "parity-08-delete-confirmation.png"),
    animations: "disabled",
  });
  await page
    .getByRole("dialog", { name: "Move this project to trash?" })
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await expect(page.locator(".library-page")).toBeVisible();
  expect((await api("/projects")).some((p) => p.id === copy.id)).toBe(false);
  expect((await api("/trash")).some((p) => p.projectId === copy.id)).toBe(true);
  await page
    .getByRole("button", { name: "Library options", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Local trash", exact: true })
    .click();
  await page
    .locator(".recovery-row")
    .filter({ hasText: copy.name })
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  const permanent = page.getByRole("dialog", {
    name: "Permanently delete this project?",
    exact: true,
  });
  await expect(
    permanent.getByRole("button", { name: "Delete permanently", exact: true }),
  ).toBeEnabled();
  await permanent
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(
    page.locator(".recovery-row").filter({ hasText: copy.name }),
  ).toHaveCount(0);
  await page
    .getByRole("dialog", { name: "Local project trash", exact: true })
    .getByRole("button", { name: "Done", exact: true })
    .click();
  expect((await api("/trash")).some((p) => p.projectId === copy.id)).toBe(
    false,
  );
  expect((await api(`/projects/${demo.id}`)).hasModel).toBe(true);
  check(
    "Move to trash supports cancel and retains the duplicate; separately confirmed permanent deletion removes only that saved entry",
  );
  await page.setViewportSize({ width: 320, height: 780 });
  await page
    .getByRole("button", { name: "Manage area Delivery trials", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Remove area", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove area, keep projects", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await api(`/projects/${demo.id}`)).areaId).toBeUndefined();
  await expect(page.locator(".project-card")).toHaveCount(2);
  const bounds = await page.locator(".library-areas").boundingBox();
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: path.join(out, "parity-09-library-320.png"),
    animations: "disabled",
  });
  check(
    "Removing an area retains its projects in Unassigned and the library controls fit at 320px",
  );
  // Explicit UI provenance fixture: no Gemini request is made. Seed the same metadata transition
  // as the user's completed real run, while leaving the demo's saved project defaults on Offline.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const uiGemini = await api("/settings/connections", "POST", {
    name: "Gemini UI fixture (never called)",
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    apiKey: "synthetic-ui-only",
    vision: "yes",
  });
  await page.goto(`http://127.0.0.1:${port}/#/projects/${demo.id}/analysis`);
  await page.reload();
  async function chooseConnection(role, name) {
    await page.getByRole("combobox", { name: role, exact: true }).click();
    await page.getByRole("option").filter({ hasText: name }).click();
  }
  await chooseConnection("Vision connection", uiGemini.name);
  await chooseConnection("Text connection", uiGemini.name);
  const projectFile = path.join(dataDir, "projects", demo.id, "project.json");
  const modelFile = path.join(dataDir, "projects", demo.id, "model.json");
  const uiProject = JSON.parse(await readFile(projectFile, "utf8"));
  expect(uiProject.llm.visionConnectionId).not.toBe(uiGemini.id);
  uiProject.generationPreferences = {
    ...uiProject.generationPreferences,
    visionConnectionId: uiGemini.id,
    textConnectionId: uiGemini.id,
  };
  const uiModel = JSON.parse(await readFile(modelFile, "utf8"));
  uiModel.generator = {
    vision: "gemini/gemini-3.5-flash-lite",
    text: "gemini/gemini-3.5-flash-lite",
  };
  uiModel.options = { ...uiProject.generationPreferences };
  uiModel.summary =
    "Explicit saved-provider UI fixture only; no Gemini request was made.";
  await writeFile(projectFile, JSON.stringify(uiProject, null, 2));
  await writeFile(modelFile, JSON.stringify(uiModel, null, 2));
  const seededModelBytes = await readFile(modelFile, "utf8");
  await page
    .getByRole("button", { name: "Refresh workspace", exact: true })
    .click();
  const provenance = page.getByRole("region", {
    name: "Saved generation provenance",
    exact: true,
  });
  await expect(provenance).toContainText("gemini/gemini-3.5-flash-lite");
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(
    page.getByRole("combobox", { name: "Vision connection", exact: true }),
  ).toContainText(uiGemini.name);
  await expect(
    page.getByRole("combobox", { name: "Text connection", exact: true }),
  ).toContainText(uiGemini.name);
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Vision connection", exact: true }),
  ).toContainText(uiGemini.name);
  await nav("Use cases");
  await page.getByRole("button", { name: "Revise", exact: true }).click();
  await expect(page.locator(".revision-connection")).toContainText(
    uiGemini.name,
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await nav("Analysis");
  await page.screenshot({
    path: path.join(out, "parity-10-saved-provenance.png"),
    animations: "disabled",
  });
  check(
    "Explicit UI completion fixtures retain selected providers through refresh/reload and revision routing uses the remembered connection",
  );
  const mockName = publicSettings.connections.find(
    (c) => c.provider === "mock",
  ).name;
  await chooseConnection("Vision connection", mockName);
  await chooseConnection("Text connection", mockName);
  await expect(
    page.getByRole("combobox", { name: "Vision connection", exact: true }),
  ).toContainText(mockName);
  await expect(
    page.getByRole("combobox", { name: "Text connection", exact: true }),
  ).toContainText(mockName);
  await page
    .getByRole("button", { name: "Refresh workspace", exact: true })
    .click();
  await expect(page.locator(".next-run-banner")).toContainText(
    "Next run · Offline fixture provider",
  );
  await expect(provenance).toContainText("Provider-backed generation");
  const jobsBeforeConfirmation = (await api(`/projects/${demo.id}/jobs`))
    .length;
  await page
    .getByRole("button", { name: "Regenerate specifications", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", {
      name: "Use offline fixtures for this run?",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Keep current specification", exact: true })
    .click();
  expect((await api(`/projects/${demo.id}/jobs`)).length).toBe(
    jobsBeforeConfirmation,
  );
  expect(await readFile(modelFile, "utf8")).toBe(seededModelBytes);
  await page.setViewportSize({ width: 320, height: 780 });
  await expect(provenance).toBeVisible();
  const provenanceBounds = await provenance.boundingBox();
  expect(provenanceBounds.x + provenanceBounds.width).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: path.join(out, "parity-11-provenance-320.png"),
    animations: "disabled",
  });
  check(
    "Next-run Offline choices never relabel saved provider provenance, survive refresh and require confirmation before creating a synthetic replacement",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await nav("Overview");
  await page.getByRole("button", { name: "Edit brief", exact: true }).click();
  const projectDialog = page.getByRole("dialog", {
    name: "Shape the project brief.",
    exact: true,
  });
  await projectDialog
    .getByRole("switch", {
      name: "Keep AI analysis on this computer",
      exact: true,
    })
    .check();
  await projectDialog
    .getByRole("button", { name: "Save project", exact: true })
    .click();
  await expect(projectDialog).not.toBeVisible();
  expect((await api(`/projects/${demo.id}`)).localOnly).toBe(true);
  await nav("Analysis");
  await expect(
    page.getByRole("region", {
      name: "Next run data destinations",
      exact: true,
    }),
  ).toContainText("local-only policy enforced");
  await page.reload();
  await expect(
    page.getByRole("region", {
      name: "Next run data destinations",
      exact: true,
    }),
  ).toContainText("local-only policy enforced");
  await expect(
    page.getByRole("button", {
      name: "Regenerate specifications",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(page.locator(".next-run-banner")).toContainText(
    "Blocked by local-only policy",
  );
  await page.screenshot({
    path: path.join(out, "security-01-local-policy.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 320, height: 780 });
  const destinations = page.getByRole("region", {
    name: "Next run data destinations",
    exact: true,
  });
  const destinationBounds = await destinations.boundingBox();
  expect(destinationBounds.x + destinationBounds.width).toBeLessThanOrEqual(
    320,
  );
  await page.screenshot({
    path: path.join(out, "security-02-destinations-320.png"),
    animations: "disabled",
  });
  check(
    "Local-only AI policy saves through the project form, survives reload and exposes reading/writing destinations within the 320px workbench",
  );
  const checker = await api("/settings/connections", "POST", {
    name: "S05 response-check fixture",
    provider: "openai",
    model: "fixture-model",
    baseUrl: "https://models.fixture.invalid/v1",
    apiKey: "synthetic-ui-check-token",
    vision: "no",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page
    .locator(".connection-tab")
    .filter({ hasText: "S05 response-check fixture" })
    .click();
  const checked = page.waitForResponse((response) =>
    response.url().endsWith("/api/settings/connections/test"),
  );
  await page.getByRole("button", { name: /Test connection/ }).click();
  const checkResult = await (await checked).json();
  expect(checkResult.ok).toBe(true);
  expect(JSON.stringify(checkResult)).not.toContain(
    "UNTRUSTED-RESPONSE-MARKER",
  );
  expect(JSON.stringify(checkResult)).not.toContain("synthetic-ui-check-token");
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toContainText("Connected to");
  expect(await page.locator("body").innerText()).not.toContain(
    "UNTRUSTED-RESPONSE-MARKER",
  );
  await page.screenshot({
    path: path.join(out, "security-followup-settings.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await api(`/settings/connections/${checker.id}`, "DELETE");
  check(
    "Settings uses the real BYOK adapter against an isolated response fixture and shows safe connection status without echoed credentials or provider text",
  );
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  check(
    "Isolated acceptance has zero unexpected browser errors or external requests",
  );
  await writeFile(
    path.join(out, "parity-browser-verification.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        checks,
        errors,
        external,
        dataDir,
        scope:
          "Isolated V2 data, actual local API/files, offline AI, explicit saved-provider UI metadata fixtures and Figma HTTP/CDN fixtures. Gemini UI records are synthetic and do not prove real model inference. No real Figma/provider/tracker access.",
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  child.kill();
}
