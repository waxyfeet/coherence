/** Real local lifecycle, disposable authenticated data only; no paid AI or external writes. */
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { authenticatedFixture } from "./authenticated-fixture.mjs";
import { mkdir, readFile, readdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import net from "node:net";

const root = process.cwd(),
  out = path.join(root, "artifacts/local-trash");
await mkdir(out, { recursive: true });
const temp = path.join(root, ".cache/trash-browser-temp");
await mkdir(temp, { recursive: true });
for (const key of ["TEMP", "TMP", "TMPDIR"]) process.env[key] = temp;
const probe = net.createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const fixture = await authenticatedFixture(port);
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--disable-background-networking", "--no-first-run"],
});
const context = await browser.newContext({
  viewport: { width: 1366, height: 768 },
  reducedMotion: "reduce",
});
await context.addInitScript(
  (s) =>
    localStorage.setItem("screenscribe.local-session.v1", JSON.stringify(s)),
  fixture.session,
);
const page = await context.newPage();
page.setDefaultTimeout(15000);
const checks = [],
  errors = [],
  external = [],
  writes = [],
  accessibility = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("request", (r) => {
  const p = new URL(r.url()).pathname;
  if (r.method() === "POST" && p.endsWith("/permanent-delete")) writes.push(p);
});
await context.route("**/*", (r) => {
  const u = new URL(r.request().url());
  if (u.origin === fixture.origin) return r.continue();
  external.push(u.origin);
  return r.abort();
});
async function api(url, method = "GET", body) {
  const r = await fetch(fixture.origin + "/api" + url, {
    method,
    redirect: "error",
    headers: {
      Authorization: "Bearer " + fixture.session.token,
      "X-ScreenScribe": "1",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw Error("Isolated fixture request failed: " + r.status);
  return r.json();
}
const nav = (label) =>
  page
    .getByRole("complementary", { name: "Workspace navigation" })
    .getByRole("button", { name: label, exact: true })
    .click();
const trash = () =>
  page.getByRole("dialog", { name: "Local project trash", exact: true });
const removal = () =>
  page.getByRole("dialog", {
    name: "Permanently delete this project?",
    exact: true,
  });
async function openTrash(keyboard = false) {
  const options = page.getByRole("button", {
    name: "Library options",
    exact: true,
  });
  if (keyboard) {
    await options.focus();
    await options.press("Enter");
    await page
      .getByRole("menuitem", { name: "Local trash", exact: true })
      .press("Enter");
  } else {
    await options.click();
    await page
      .getByRole("menuitem", { name: "Local trash", exact: true })
      .click();
  }
  await expect(trash()).toBeVisible();
}
async function screenshot(name) {
  await page.screenshot({
    path: path.join(out, name + ".png"),
    animations: "disabled",
  });
}
async function axe(name) {
  const result = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(result.violations).toEqual([]);
  accessibility.push({ name, violations: result.violations.length });
}
async function bytes(dir, prefix = "") {
  const result = {};
  for (const name of await readdir(path.join(dir, prefix))) {
    const rel = path.join(prefix, name);
    try {
      const data = await readFile(path.join(dir, rel));
      result[rel] = data.toString("base64");
    } catch (e) {
      if (e.code !== "EISDIR") throw e;
      Object.assign(result, await bytes(dir, rel));
    }
  }
  return result;
}
try {
  await page.goto(fixture.origin + "/#/projects");
  await openTrash(true);
  await expect(trash()).toContainText("Local trash is empty");
  await expect(trash()).toContainText(
    "Previously permanently deleted projects cannot be restored here",
  );
  await page.keyboard.press("Escape");
  await expect(trash()).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Library options", exact: true }),
  ).toBeFocused();
  checks.push(
    "Empty trash opens with keyboard, explains permanent-deletion limits and returns focus to Library options on close",
  );

  const project = await api("/projects/demo", "POST", {});
  const started = await api(`/projects/${project.id}/generate`, "POST", {});
  await expect
    .poll(async () => (await api(`/jobs/${started.jobId}`)).status, {
      timeout: 30000,
    })
    .toBe("succeeded");
  await page
    .getByRole("button", { name: "Refresh project list", exact: true })
    .click();
  await page
    .locator(".project-card")
    .filter({
      has: page.getByRole("heading", { name: project.name, exact: true }),
    })
    .click();
  await nav("Use cases");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  const marker = "Human trash/restore acceptance: preserve this exact wording.";
  await editor.fill(
    (await editor.inputValue()) +
      "\n\n" +
      marker +
      "\n" +
      "Preserved human context.\n".repeat(200),
  );
  await editor.press("Control+s");
  await expect(editor).toHaveCount(0);
  await page
    .getByRole("button", { name: "Approve use case", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Approve use case", exact: true }),
  ).toBeDisabled();
  const before = await api(`/projects/${project.id}`);
  const modelBefore = await api(`/projects/${project.id}/model`);
  const projectRoot = path.join(fixture.dataDir, "projects", project.id);
  const original = await bytes(projectRoot);
  await nav("Overview");
  await page
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  const move = () =>
    page.getByRole("dialog", {
      name: "Move this project to trash?",
      exact: true,
    });
  await expect(move()).toContainText(
    "You can restore this project from Local trash",
  );
  await move()
    .getByRole("button", { name: "Keep project", exact: true })
    .click();
  expect((await api("/projects")).some((p) => p.id === project.id)).toBe(true);
  expect(await bytes(projectRoot)).toEqual(original);
  checks.push(
    "Real offline generation, a long saved human edit and approval survive cancelling Move to trash byte-for-byte",
  );

  await page
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await move()
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await expect(page.locator(".library-page")).toBeVisible();
  expect((await api("/projects")).some((p) => p.id === project.id)).toBe(false);
  const entry = (await api("/trash")).find((e) => e.projectId === project.id);
  expect(entry).toBeDefined();
  expect(await bytes(path.join(fixture.dataDir, ".trash", entry.id))).toEqual(
    original,
  );
  await page.reload();
  await openTrash();
  let row = trash().locator(".recovery-row").filter({ hasText: project.name });
  await expect(row).toBeVisible();
  await screenshot("01-saved-project");
  await axe("trash list");
  checks.push(
    "Confirmed Move to trash removes the library card, retains all project bytes and remains recoverable after browser refresh",
  );

  await row.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(
    page.getByRole("dialog", {
      name: "Restore this saved version?",
      exact: true,
    }),
  ).toContainText(project.name);
  await page
    .getByRole("button", { name: "Back to saved versions", exact: true })
    .click();
  expect((await api("/projects")).some((p) => p.id === project.id)).toBe(false);
  await row.getByRole("button", { name: "Restore", exact: true }).click();
  await screenshot("02-restore-confirmation");
  await page
    .getByRole("button", { name: "Restore project", exact: true })
    .click();
  await expect(page.locator(".real-overview")).toBeVisible();
  const restored = await api(`/projects/${project.id}`);
  expect(restored).toMatchObject({
    name: before.name,
    description: before.description,
    additionalContext: before.additionalContext,
    screens: before.screens,
    outputDir: before.outputDir,
  });
  expect(await api(`/projects/${project.id}/model`)).toEqual(modelBefore);
  const restoredBytes = await bytes(projectRoot);
  delete original["project.json"];
  delete restoredBytes["project.json"];
  expect(restoredBytes).toEqual(original);
  await nav("Use cases");
  await expect(page.locator(".markdown-document")).toContainText(marker);
  await expect(
    page.getByRole("button", { name: "Approve use case", exact: true }),
  ).toBeDisabled();
  checks.push(
    "Restore cancellation leaves the entry saved; confirmed restore retains metadata/screens/model, long human wording and approval without regeneration",
  );

  await nav("Projects");
  await page
    .getByRole("button", { name: "Actions for " + project.name, exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Move to trash", exact: true })
    .click();
  await move()
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await openTrash();
  row = trash().locator(".recovery-row").filter({ hasText: project.name });
  await row
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(removal()).toContainText(
    "This cannot be undone through Local trash",
  );
  await expect(
    removal().getByRole("button", { name: "Delete permanently", exact: true }),
  ).toBeEnabled();
  expect(writes).toHaveLength(0);
  await removal()
    .getByRole("button", { name: "Keep in trash", exact: true })
    .click();
  await expect(row).toBeVisible();
  expect(writes).toHaveLength(0);
  checks.push(
    "Permanent deletion is available only inside Trash and requires a separate reviewed confirmation; Keep in trash performs no deletion request",
  );

  await row
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await page.setViewportSize({ width: 320, height: 768 });
  await expect(removal().locator(".deletion-paths")).toBeVisible();
  const bounds = await removal().boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  expect(await removal().evaluate((n) => n.scrollWidth <= n.clientWidth)).toBe(
    true,
  );
  await screenshot("03-permanent-confirmation-320");
  await axe("permanent confirmation mobile");
  await page.keyboard.press("Escape");
  await expect(removal()).toHaveCount(0);
  expect(writes).toHaveLength(0);
  await openTrash();
  row = trash().locator(".recovery-row").filter({ hasText: project.name });
  await row
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await removal()
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(trash()).toContainText("Local trash is empty");
  expect(writes).toHaveLength(1);
  expect((await api("/trash")).some((e) => e.projectId === project.id)).toBe(
    false,
  );
  await expect(access(projectRoot)).rejects.toThrow();
  const savedJob = await fetch(fixture.origin + `/api/jobs/${started.jobId}`, {
    headers: { Authorization: "Bearer " + fixture.session.token },
  });
  expect(savedJob.status).toBe(404);
  await screenshot("04-empty-trash-320");
  await axe("empty trash mobile");
  checks.push(
    "Mobile permanent-deletion review is readable at 320px; Escape cancels, explicit confirmation removes the exact saved project and its finished job records",
  );
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  await writeFile(
    path.join(out, "verification.json"),
    JSON.stringify(
      {
        passed: true,
        checks,
        accessibility,
        errors,
        external,
        permanentDeleteRequests: writes.length,
        scope:
          "Actual built UI, real local offline generation/edits/storage; synthetic isolated credentials/projects only. No paid APIs or external writes.",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      groups: checks.length,
      accessibility: accessibility.length,
    }),
  );
} finally {
  await context.close();
  await browser.close();
  fixture.stop();
}
