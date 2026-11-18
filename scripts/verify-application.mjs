import { authenticatedFixture } from "./authenticated-fixture.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
const root = process.cwd(),
  output = path.join(root, "artifacts"),
  temp = path.join(root, ".cache/browser-temp");
await mkdir(temp, { recursive: true });
await mkdir(output, { recursive: true });
process.env.TEMP = temp;
process.env.TMP = temp;
process.env.TMPDIR = temp;
const fixture = await authenticatedFixture(4496);
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
const checks = [],
  errors = [],
  external = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (["127.0.0.1", "localhost"].includes(url.hostname))
    return route.continue();
  external.push(url.href);
  return route.abort();
});
function check(s) {
  checks.push(s);
  console.log("PASS " + s);
}
async function shot(name) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  );
  await page.screenshot({ path: path.join(output, "app-" + name + ".png") });
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
async function select(label, value) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page
    .getByRole("option")
    .filter({ has: page.getByText(value, { exact: true }) })
    .click();
}
try {
  await page.goto(fixture.origin + "/");
  await expect(
    page.getByRole("heading", { name: "Your projects" }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await shot("01-library");
  check("Real local project library opens");
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("note", { name: "Built-in Offline demo" }),
  ).toContainText(
    "It does not analyse your screenshots using a live AI model.",
  );
  await expect(page.getByLabel("Connection name", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /^Test connection/ }),
  ).toHaveCount(0);
  await expect(page.locator(".save-status")).toContainText("All changes saved");
  check(
    "Real settings load with the built-in Offline demo read-only and no spurious draft or connection test",
  );
  await shot("02-settings");
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  if (process.argv.includes("--capture-only")) {
    await writeFile(
      path.join(output, "application-capture.json"),
      JSON.stringify({ checks, errors, external }, null, 2),
    );
    process.exitCode = errors.length ? 1 : 0;
  } else {
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
    await page
      .getByLabel("Project name", { exact: true })
      .fill("V2 browser verification");
    await page
      .getByLabel("Description", { exact: true })
      .fill("Synthetic test workspace created through the real UI.");
    await page
      .getByLabel("Roles, business rules & constraints", { exact: true })
      .fill("Customers can submit an order. Human edits must survive.");
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Start with your screens." }),
    ).toBeVisible();
    await page
      .getByLabel("Upload screenshots", { exact: true })
      .setInputFiles(path.join(root, "samples/screens/01-login.png"));
    await expect(page.locator(".screen-thumb")).toHaveCount(1);
    await expect(page.locator(".real-artboard img")).toBeVisible();
    await page
      .getByLabel("Screen notes", { exact: true })
      .fill("Browser-persisted notes: exact label “Sign in”.");
    await page
      .getByRole("button", { name: "Save details", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Save details", exact: true }),
    ).toBeDisabled();
    await page.reload();
    await expect(page.getByLabel("Screen notes", { exact: true })).toHaveValue(
      "Browser-persisted notes: exact label “Sign in”.",
    );
    await shot("03-screens");
    check(
      "Project creation, real image upload and screen notes survive reload",
    );
    await nav("Analysis");
    await page
      .getByRole("button", { name: "Generate offline example", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Workspace activity" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Done", exact: true }),
    ).toBeVisible({ timeout: 90000 });
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Review use cases", exact: true }),
    ).toBeVisible();
    await shot("04-analysis");
    check(
      "Offline generation runs the real pipeline, saves files and reports durable activity",
    );
    await nav("Use cases");
    await expect(page.locator(".markdown-document h1")).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("textbox", {
      name: "Markdown editor",
      exact: true,
    });
    const original = await editor.inputValue();
    await editor.fill(
      original + "\n\nHuman verification note: retain this wording exactly.\n",
    );
    await nav("Screens");
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page
      .getByRole("button", { name: "Keep editing", exact: true })
      .click();
    await editor.press("Control+s");
    await expect(editor).toHaveCount(0);
    await expect(page.locator(".markdown-document")).toContainText(
      "Human verification note: retain this wording exactly.",
    );
    await page
      .getByRole("button", { name: "Approve use case", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Approve use case", exact: true }),
    ).toBeDisabled();
    await shot("05-specifications");
    check(
      "Canonical Markdown editing, guarded navigation, Ctrl+S and approval work",
    );
    await page.reload();
    await expect(page.locator(".markdown-document")).toContainText(
      "Human verification note: retain this wording exactly.",
    );
    check("Reviewed Markdown persists across browser reload");
    await nav("Knowledge graph");
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await page.locator(".react-flow__node").first().click();
    await expect(page.locator(".graph-real-details h3")).toBeVisible();
    await shot("06-graph");
    check(
      "Knowledge graph renders actual evidence and selectable typed relationships",
    );
    await nav("Changes");
    await page
      .getByLabel("Describe the change", { exact: true })
      .fill(
        "The sign-in button must show a loading state while authentication is pending.",
      );
    await page
      .getByRole("button", { name: "Trace connections", exact: true })
      .click();
    await expect(
      page.getByText("DETERMINISTIC TRACE · NO AI", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Analyse impact", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Done", exact: true }),
    ).toBeVisible({ timeout: 90000 });
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator(".real-impact-item").first()).toBeVisible();
    await shot("07-impact");
    check(
      "Deterministic trace and offline impact reports use real project relationships",
    );
    await nav("Export");
    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("link", { name: "Download real CSV", exact: true })
      .click();
    const download = await downloadPromise;
    await download.saveAs(path.join(output, "application-use-cases.csv"));
    const csv = await readFile(
      path.join(output, "application-use-cases.csv"),
      "utf8",
    );
    expect(csv).toContain("ID,Title");
    await page
      .getByRole("button", { name: "Review export plan", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Review the delivery plan" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Done reviewing", exact: true })
      .click();
    await shot("08-export");
    check("Real CSV and delivery plan work while tracker writes remain locked");
    await page.setViewportSize({ width: 390, height: 844 });
    await nav("Screens");
    await expect(page.locator(".real-artboard img")).toBeVisible();
    await shot("09-mobile");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Settings", exact: true }),
    ).toBeVisible();
    await shot("10-mobile-settings");
    const bounds = await page.locator(".settings-window").boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    check("Real screens and settings remain usable at mobile width");
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
    check("No external page requests or browser errors");
    await writeFile(
      path.join(output, "application-verification.json"),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          checks,
          external,
          errors,
          scope:
            "Real local application with offline fixture provider. No paid AI, Figma or tracker network calls.",
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  await shot("failure").catch(() => {});
  await writeFile(
    path.join(output, "application-failure.json"),
    JSON.stringify(
      { message: String(error), checks, errors, external },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
  fixture.stop();
}
