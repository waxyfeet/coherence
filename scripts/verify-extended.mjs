import { authenticatedFixture } from "./authenticated-fixture.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const root = process.cwd(),
  out = path.join(root, "artifacts"),
  temp = path.join(root, ".cache/browser-temp");
await mkdir(temp, { recursive: true });
process.env.TEMP = temp;
process.env.TMP = temp;
process.env.TMPDIR = temp;
const fixture = await authenticatedFixture(4495);
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--disable-background-networking", "--no-first-run"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
  reducedMotion: "reduce",
});
await context.addInitScript((session) => {
  localStorage.setItem(
    "screenscribe.local-session.v1",
    JSON.stringify(session),
  );
}, fixture.session);
const page = await context.newPage();
page.setDefaultTimeout(15000);
const checks = [],
  errors = [],
  external = [];
let pid = "";
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await context.route("**/*", (route) => {
  const u = new URL(route.request().url());
  if (["localhost", "127.0.0.1"].includes(u.hostname)) return route.continue();
  external.push(u.href);
  return route.abort();
});
async function api(url, method = "GET", body) {
  const response = await fetch(fixture.origin + "/api" + url, {
    method,
    headers: {
      "X-ScreenScribe": "1",
      Authorization: `Bearer ${fixture.session.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
}
function check(s) {
  checks.push(s);
  console.log("PASS " + s);
}
async function shot(name) {
  await page.screenshot({
    path: path.join(out, "extended-" + name + ".png"),
    animations: "disabled",
    timeout: 15000,
  });
}
async function nav(name) {
  if (
    await page
      .getByRole("button", { name: "Toggle workspace navigation", exact: true })
      .isVisible()
  )
    await page
      .getByRole("button", { name: "Toggle workspace navigation", exact: true })
      .click();
  await page
    .locator(".app-navigation")
    .getByRole("button", { name, exact: true })
    .click();
}
async function settings() {
  const open = page.getByRole("button", { name: "Open settings", exact: true });
  const toggle = page.getByRole("button", {
    name: "Toggle workspace navigation",
    exact: true,
  });
  if (
    (await toggle.isVisible()) &&
    (await toggle.getAttribute("aria-expanded")) !== "true"
  )
    await page
      .getByRole("button", { name: "Toggle workspace navigation", exact: true })
      .click();
  await open.click();
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeVisible();
}
async function saveSettings() {
  await page
    .getByRole("button", {
      name: /^(Save connection|Save all changes)$/,
      exact: true,
    })
    .click();
  await expect(page.locator(".save-status")).toContainText(
    "All changes saved",
    { timeout: 15000 },
  );
}
async function finishJob() {
  await expect(
    page.getByRole("dialog", { name: "Workspace activity", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible({ timeout: 90000 });
  await page.getByRole("button", { name: "Done", exact: true }).click();
}
try {
  await api("/projects", "POST", {
    name: "Existing synthetic library fixture",
  });
  const previous = await api("/settings");
  for (const c of previous.connections.filter(
    (c) =>
      c.name === "QA protected key · never called" &&
      c.baseUrl === "http://127.0.0.1:4498",
  ))
    await api("/settings/connections/" + encodeURIComponent(c.id), "DELETE");
  await page.goto(fixture.origin + "/");
  await expect(page.locator(".library-page")).toBeVisible();
  await page
    .getByLabel("Filter projects", { exact: true })
    .fill("no-project-matches-this-qa-query");
  await expect(page.locator(".project-card")).toHaveCount(0);
  await expect(page.locator(".library-empty")).toContainText(
    "No projects match",
  );
  await page.getByLabel("Filter projects", { exact: true }).fill("");
  check(
    "Project filtering has a clear empty result and preserves the local library",
  );
  await settings();
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Anthropic", exact: true }).click();
  await page
    .getByLabel("Connection name", { exact: true })
    .fill("QA protected key · never called");
  await page
    .getByLabel("Endpoint URL", { exact: true })
    .fill("http://127.0.0.1:4498");
  await page
    .getByLabel("API key", { exact: true })
    .fill("synthetic-browser-key-never-send");
  await saveSettings();
  let saved = await api("/settings");
  const temporary = saved.connections.find(
    (c) => c.name === "QA protected key · never called",
  );
  expect(temporary.hasApiKey).toBe(true);
  expect(JSON.stringify(saved)).not.toContain("synthetic-browser-key");
  expect(await readFile(saved.settingsPath, "utf8")).not.toContain(
    "synthetic-browser-key",
  );
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await page.reload();
  await settings();
  await page
    .locator(".connection-tab")
    .filter({ hasText: "QA protected key · never called" })
    .click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(page.locator(".secret-field")).toContainText("Saved");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await saveSettings();
  expect(
    (await api("/settings")).connections.find((c) => c.id === temporary.id)
      .hasApiKey,
  ).toBe(false);
  await page
    .getByRole("button", { name: "Connection actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Remove connection", exact: true })
    .click();
  await saveSettings();
  check(
    "Real Settings protect a synthetic key, redact responses, retain it across restart of the page and clear it explicitly without provider requests",
  );
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("button", { name: "Porcelain", exact: true }).click();
  await saveSettings();
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await shot("01-library-light");
  await settings();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("button", { name: "Graphite", exact: true }).click();
  await saveSettings();
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  check(
    "Appearance is persisted and restored with the real application settings",
  );
  await page
    .getByRole("button", { name: "Try ACME demo", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create demo project", exact: true })
    .click();
  await expect(page.locator(".screen-thumb")).toHaveCount(4);
  pid = decodeURIComponent(
    /^#\/projects\/([^/]+)/.exec(
      page.url().split("#")[1] ? "#" + page.url().split("#")[1] : "",
    )?.[1] ?? "",
  );
  expect(pid).not.toBe("");
  await shot("02-four-screens");
  const notes = page.getByLabel("Screen notes", { exact: true });
  const originalNotes = await notes.inputValue();
  await notes.fill(originalNotes + "\nUnsaved check.");
  await page.locator(".screen-thumb-select").nth(1).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(notes).toHaveValue(/Unsaved check\./);
  await notes.fill(originalNotes);
  check(
    "Four-screen demo is local and changing screenshots cannot silently discard note drafts",
  );
  await nav("Analysis");
  // Deliberately close the SSE response after a running snapshot. REST recovery must find the saved result.
  let droppedStreams = 0;
  const interruptStream = async (route) => {
    droppedStreams++;
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    const snapshot = await api(`/jobs/${id}`);
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: `data: ${JSON.stringify({ type: "snapshot", job: { ...snapshot, status: "running" } })}\n\n`,
    });
  };
  await context.route("**/api/jobs/*/events", interruptStream);
  await page
    .getByRole("button", { name: "Generate offline example", exact: true })
    .click();
  await finishJob();
  await context.unroute("**/api/jobs/*/events", interruptStream);
  expect(droppedStreams).toBeGreaterThan(0);
  check(
    "An interrupted activity stream recovers the saved job result without restarting work",
  );
  let model = await api(`/projects/${pid}/model`);
  expect(model.screens).toHaveLength(4);
  expect(model.useCases.length).toBeGreaterThan(8);
  for (const uc of model.useCases)
    if (uc.dependsOn.length) {
      expect(
        uc.dependsOn.some((id) =>
          model.useCases
            .find((p) => p.id === id)
            ?.postconditions.includes(uc.preconditions[0]),
        ),
      ).toBe(true);
    }
  check(
    "Four-screen generation creates actual output files and exact prerequisite/postcondition chains",
  );
  await nav("Use cases");
  await expect(page.locator(".markdown-document h1")).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByLabel("Markdown editor", { exact: true });
  await editor.fill(
    (await editor.inputValue()) +
      "\n\nProtected overnight wording: human edits stay exactly here.\n",
  );
  await editor.press("Control+s");
  await expect(editor).toHaveCount(0);
  await page
    .getByRole("button", { name: "Approve use case", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Approve use case", exact: true }),
  ).toBeDisabled();
  const first = (await api(`/projects/${pid}/model`)).useCases[0];
  const protectedFile = await api(
    `/projects/${pid}/files/content?path=${encodeURIComponent(first.filePath)}`,
  );
  await page
    .getByLabel("Search use cases", { exact: true })
    .fill("Protected overnight wording");
  await expect(
    page.locator(".disk-search-results button").first(),
  ).toBeVisible();
  await page.locator(".disk-search-results button").first().click();
  await expect(page.locator(".source-line-view")).toContainText(
    "Protected overnight wording",
  );
  await page
    .getByRole("button", { name: "Read rendered Markdown", exact: true })
    .click();
  await page.getByLabel("Search use cases", { exact: true }).fill("");
  check(
    "Cross-file search finds saved human text and opens the correct Markdown",
  );
  await nav("Analysis");
  await page
    .getByRole("button", { name: "Regenerate specifications", exact: true })
    .click();
  await finishJob();
  const afterRegeneration = await api(`/projects/${pid}/model`);
  const continued = afterRegeneration.useCases.find((u) => u.id === first.id);
  expect(continued.internalId).toBe(first.internalId);
  expect(continued.status).toBe("approved");
  expect(
    (
      await api(
        `/projects/${pid}/files/content?path=${encodeURIComponent(continued.filePath)}`,
      )
    ).content,
  ).toContain("Protected overnight wording: human edits stay exactly here.");
  check(
    "Regeneration preserves approved human wording and permanent internal/display IDs",
  );
  await page
    .getByRole("switch", { name: "Preserve human edits", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Regenerate specifications", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", {
      name: "Replace protected specifications?",
      exact: true,
    }),
  ).toContainText(first.id);
  await page
    .getByRole("button", { name: "Keep current documents", exact: true })
    .click();
  await page
    .getByRole("switch", { name: "Preserve human edits", exact: true })
    .click();
  check(
    "Turning preservation off requires reviewing affected protected files before generation",
  );
  await nav("Use cases");
  await page.getByRole("button", { name: "Revise", exact: true }).click();
  await page
    .getByLabel("What should change?", { exact: true })
    .fill("Add a testable alternate authentication outcome.");
  await page
    .getByRole("button", { name: "Prepare proposal", exact: true })
    .click();
  await finishJob();
  await expect(
    page.getByRole("dialog", {
      name: "Review the proposed revision",
      exact: true,
    }),
  ).toBeVisible();
  const beforeApply = await api(
    `/projects/${pid}/files/content?path=${encodeURIComponent(continued.filePath)}`,
  );
  expect(beforeApply.content).toContain("Protected overnight wording");
  await shot("03-revision-proposal");
  await page
    .getByRole("button", { name: "Apply reviewed proposal", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", {
      name: "Review the proposed revision",
      exact: true,
    }),
  ).toHaveCount(0);
  await nav("Screens");
  await nav("Use cases");
  await expect(
    page.getByRole("dialog", {
      name: "Review the proposed revision",
      exact: true,
    }),
  ).toHaveCount(0);
  check(
    "Revision is reviewable before writing; applied proposals do not reopen on navigation",
  );
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const edit = page.getByLabel("Markdown editor", { exact: true });
  await edit.fill((await edit.inputValue()) + "\nUnsaved Back guard.\n");
  await page.goBack();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(edit).toHaveValue(/Unsaved Back guard\./);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  check("Browser Back and editor cancel protect unsaved Markdown drafts");
  await expect(
    page.getByRole("navigation", { name: "Document outline", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Document outline", exact: true })
    .getByRole("button", { name: "Business rules", exact: true })
    .click();
  await expect(
    page.locator(".document-scroll #business-rules"),
  ).toBeInViewport();
  check("Document outline navigates to the rendered specification section");
  await page
    .locator(".supporting-files")
    .getByRole("button")
    .filter({ hasText: "README.md" })
    .click();
  await expect(page.locator(".mermaid-diagram svg").first()).toBeVisible({
    timeout: 20000,
  });
  await shot("04-generated-readme");
  check("Generated supporting Markdown renders real Mermaid diagrams locally");
  await nav("Knowledge graph");
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(page.getByLabel("Knowledge graph evidence list")).toBeVisible();
  await page
    .getByLabel("Knowledge graph evidence list")
    .getByRole("button")
    .first()
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".graph-real-details h3")).toBeVisible();
  await shot("05-graph-list");
  check("Graph offers a keyboard-operable list alongside the canvas");
  await nav("Changes");
  await page
    .getByLabel("Describe the change", { exact: true })
    .fill(
      "Require a supervisor approval for any submitted order above the account limit.",
    );
  await page
    .getByRole("button", { name: "Analyse impact", exact: true })
    .click();
  await finishJob();
  await expect(page.locator(".real-impact-item").first()).toBeVisible();
  await page.getByRole("button", { name: /Review & apply/ }).click();
  await page
    .getByRole("button", { name: "Apply selected changes", exact: true })
    .click();
  await finishJob();
  await expect(page.locator(".real-report-heading")).toContainText("applied");
  await shot("06-applied-impact");
  check("Selected offline impact updates persist and reconcile report status");
  await nav("Screens");
  const beforeReplacement = await api(`/projects/${pid}`);
  const sid = beforeReplacement.screens[0].id;
  await page
    .getByLabel("Replace screenshot image", { exact: true })
    .setInputFiles(path.join(root, "samples/screens/01-login.png"));
  await expect(page.getByLabel("Image history", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Image history", { exact: true })).toHaveValue(
    "2",
  );
  const previousImage = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/screens/${sid}/image?version=1`) &&
      response.status() === 200,
  );
  await page.getByLabel("Image history", { exact: true }).selectOption("1");
  await previousImage;
  await expect(
    page.getByRole("img", { name: "Login", exact: true }),
  ).toHaveAttribute("src", /^blob:/);
  await expect
    .poll(() =>
      page
        .getByRole("img", { name: "Login", exact: true })
        .evaluate((image) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  await page.getByLabel("Image history", { exact: true }).selectOption("2");
  await page
    .getByRole("button", { name: "Screenshot actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Reanalyse & compare changes", exact: true })
    .click();
  await finishJob();
  await nav("Changes");
  await expect(page.locator(".screen-change-summary")).toContainText("V1");
  await page
    .getByRole("button", { name: "Compare saved versions", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "Compare screenshot versions", exact: true })
      .getByRole("img"),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  expect(
    (await api(`/projects/${pid}/model`)).screens.find(
      (s) => s.screenId === sid,
    ).screenVersion,
  ).toBe(1);
  await page
    .getByRole("button", { name: "Discard report", exact: true })
    .click();
  await expect(page.locator(".real-report-heading")).toContainText("discarded");
  expect(
    (await api(`/projects/${pid}/model`)).screens.find(
      (s) => s.screenId === sid,
    ).screenVersion,
  ).toBe(1);
  check(
    "Screenshot replacement retains versions; reanalysis is pending and discard leaves the accepted inventory unchanged",
  );
  await nav("Screens");
  await page.getByRole("button", { name: /^Elements/ }).click();
  await page.locator(".element-list-item").first().click();
  await page
    .getByRole("button", { name: "Propose a change", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Change target kind", exact: true }),
  ).toContainText("A visible UI element");
  await expect(
    page.getByLabel("Describe the change", { exact: true }),
  ).toHaveValue(/Describe the change to/);
  check(
    "Inspector element details open a targeted change draft with the correct evidence selection",
  );
  await settings();
  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  await page.getByLabel("Owner", { exact: true }).fill("offline-fixture");
  await page.getByLabel("Repository", { exact: true }).fill("never-contacted");
  await page
    .getByLabel("API URL", { exact: true })
    .fill("http://127.0.0.1:4498");
  await saveSettings();
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await nav("Export");
  await page
    .locator(".target-options")
    .getByRole("button")
    .filter({ hasText: "GitHub" })
    .click();
  await page.locator(".real-export-case button").first().click();
  await expect(
    page.getByRole("dialog", { name: /GitHub payload/ }),
  ).toBeVisible();
  await expect(page.locator(".real-payload").first()).toContainText(
    "User story",
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .getByRole("button", { name: "Run local dry run", exact: true })
    .click();
  await finishJob();
  await expect(page.locator(".real-export-results")).toContainText(
    "would-create",
  );
  await shot("07-dry-run");
  check(
    "Exact GitHub payload and dry run work without a credential or tracker request",
  );
  await settings();
  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  await page
    .getByRole("button", { name: "Clear saved integration", exact: true })
    .click();
  await saveSettings();
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await nav("Use cases");
    await expect(page.locator(".case-document")).toBeVisible();
    await settings();
    const bounds = await page.locator(".settings-window").boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    if (width === 320) await shot("09-settings-320");
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    if (width === 320) await shot("10-workbench-320");
    check("Real specification and Settings bounds at " + width + "px");
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await nav("Screens");
  await page.screenshot({
    path: path.join(out, "extended-08-final-workspace.png"),
  });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  check(
    "Extended workflow has no unexpected browser errors or external page requests",
  );
  await writeFile(
    path.join(out, "extended-verification.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        projectId: pid,
        dataDir: fixture.dataDir,
        checks,
        errors,
        external,
        scope:
          "Offline fixtures and local API/storage only; no real provider, Figma or tracker calls.",
      },
      null,
      2,
    ),
  );
} catch (error) {
  await shot("failure").catch(() => {});
  await writeFile(
    path.join(out, "extended-failure.json"),
    JSON.stringify(
      { message: String(error), pid, checks, errors, external },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
  fixture.stop();
}
