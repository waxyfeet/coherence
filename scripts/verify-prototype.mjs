import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();
const output = path.join(root, "artifacts");
const temp = path.join(root, ".cache", "browser-temp");
await mkdir(output, { recursive: true });
await mkdir(temp, { recursive: true });
process.env.TEMP = temp;
process.env.TMP = temp;
process.env.TMPDIR = temp;
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--disable-background-networking", "--no-first-run"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  acceptDownloads: true,
  reducedMotion: "reduce",
});
const externalRequests = [];
const errors = [];
const checks = [];
await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (["127.0.0.1", "localhost"].includes(url.hostname))
    return route.continue();
  externalRequests.push(route.request().url());
  return route.abort();
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
const check = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
const screenshot = async (name) => {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  );
  await page.screenshot({ path: path.join(output, name + ".png") });
};
const nav = async (name) => {
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
};
const openSettings = async () => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeVisible();
};
const selectOption = async (label, text) => {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page
    .getByRole("option")
    .filter({ has: page.getByText(text, { exact: true }) })
    .click();
};
try {
  await page.goto(
    (process.env.PROTOTYPE_ORIGIN ?? "http://127.0.0.1:5417") +
      "/?prototype#/screens",
  );
  await page.locator(".screen-artboard").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await screenshot("01-screens-desktop");
  await openSettings();
  await screenshot("02-settings-desktop");
  check("Desktop screens and settings render");
  if (process.argv.includes("--capture-only")) {
    await writeFile(
      path.join(output, "capture-errors.json"),
      JSON.stringify({ errors, externalRequests }, null, 2),
    );
    console.log(JSON.stringify({ errors, externalRequests }));
  } else {
    await page.getByRole("button", { name: /^Test connection/ }).click();
    await expect(
      page.getByText("Mock connection successful", { exact: true }),
    ).toBeVisible();
    check("Mock connection test succeeds without a request");
    await page
      .getByLabel("Connection name", { exact: true })
      .fill("Claude · design review");
    await expect(
      page.getByText("Mock connection successful", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await screenshot("03-unsaved-settings");
    await page
      .getByRole("button", { name: "Keep editing", exact: true })
      .click();
    await expect(
      page.getByLabel("Connection name", { exact: true }),
    ).toHaveValue("Claude · design review");
    await page
      .getByRole("button", {
        name: /^(Save connection|Save all changes)$/,
        exact: true,
      })
      .click();
    await expect(page.locator(".save-status")).toContainText(
      "All changes saved",
    );
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    const focusLabel = await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    );
    assert.equal(focusLabel, "Settings");
    check(
      "Settings retain drafts, invalidate old tests, save and return focus",
    );
    await openSettings();
    await expect(
      page.getByLabel("Connection name", { exact: true }),
    ).toHaveValue("Claude · design review");
    await page.getByLabel("Search settings", { exact: true }).fill("timeout");
    await expect(
      page.getByRole("button", { name: "Connections", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Clear settings search", exact: true })
      .click();
    await page.getByRole("button", { name: /Advanced configuration/ }).click();
    await page.getByLabel("Request timeout", { exact: true }).fill("480");
    await page
      .getByRole("button", { name: "Reset tuning", exact: true })
      .click();
    await expect(
      page.getByLabel("Request timeout", { exact: true }),
    ).toHaveValue("180");
    await selectOption("Mock test outcome", "Unavailable");
    await page.getByRole("button", { name: /^Test connection/ }).click();
    await expect(
      page.getByText("Mock connection unavailable", { exact: true }),
    ).toBeVisible();
    check("Search, advanced tuning, reset and mock error state work");
    const separator = page.getByRole("separator", {
      name: "Resize settings navigation",
      exact: true,
    });
    const beforeWidth = Number(await separator.getAttribute("aria-valuenow"));
    await separator.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(
      Number(await separator.getAttribute("aria-valuenow")),
      beforeWidth + 12,
    );
    const beforeBox = await page.locator(".settings-window").boundingBox();
    const titleBox = await page.locator(".window-titlebar").boundingBox();
    await page.mouse.move(titleBox.x + 320, titleBox.y + 22);
    await page.mouse.down();
    await page.mouse.move(titleBox.x + 385, titleBox.y + 52, { steps: 6 });
    await page.mouse.up();
    const movedBox = await page.locator(".settings-window").boundingBox();
    assert(movedBox.x > beforeBox.x + 40);
    assert(movedBox.y > beforeBox.y + 15);
    assert(movedBox.x >= 16 && movedBox.y >= 16);
    await page
      .getByRole("button", { name: "Reset window position", exact: true })
      .click();
    const resetBox = await page.locator(".settings-window").boundingBox();
    assert(Math.abs(resetBox.x - beforeBox.x) < 2);
    check(
      "Settings rail resizes by keyboard; window dragging and reset respect boundaries",
    );
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByRole("button", { name: "Porcelain", exact: true }).click();
    await screenshot("04-settings-light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByRole("button", { name: "Graphite", exact: true }).click();
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    check("Appearance previews live; discard restores saved settings");
    await openSettings();
    await page.getByRole("button", { name: "Local", exact: true }).click();
    await expect(page.getByLabel("Endpoint URL", { exact: true })).toHaveValue(
      "http://localhost:11434",
    );
    await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Cloud", exact: true }).click();
    await selectOption("AI provider", "Azure OpenAI");
    await page.getByRole("button", { name: /Advanced configuration/ }).click();
    await expect(
      page.getByLabel("Azure API version", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    check(
      "Local and cloud forms expose appropriate model and credential controls",
    );
    await nav("Analysis");
    await page
      .getByRole("button", { name: "Run sample analysis", exact: true })
      .click();
    await nav("Screens");
    await nav("Analysis");
    await expect(page.getByText("Demo complete", { exact: true })).toBeVisible({
      timeout: 12000,
    });
    await screenshot("05-analysis-complete");
    check("Scripted analysis continues across page navigation");
    await selectOption("Analysis simulation scenario", "Connection error");
    await page.getByRole("button", { name: "Run again", exact: true }).click();
    await expect(page.getByText("Demo failed", { exact: true })).toBeVisible({
      timeout: 5000,
    });
    await selectOption("Analysis simulation scenario", "Successful run");
    await page
      .getByRole("button", { name: "Run sample analysis", exact: true })
      .click();
    await expect(page.getByText("Demo complete", { exact: true })).toBeVisible({
      timeout: 12000,
    });
    check("Analysis failure and retry are coherent");
    await nav("Use cases");
    await page.locator(".case-list-item").filter({ hasText: "UC-003" }).click();
    await page
      .locator(".document-toolbar")
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const edit = page.getByRole("textbox", {
      name: "Use-case Markdown editor",
      exact: true,
    });
    const original = await edit.inputValue();
    await edit.fill(
      original + "\n## Design review\n\nA session-only sample edit.\n",
    );
    await page.keyboard.press("Control+s");
    await expect(
      page.getByText("Saved in session", { exact: true }),
    ).toBeVisible();
    await edit.fill(original + "\nUnsaved extra text.");
    await nav("Changes");
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page
      .getByRole("button", { name: "Keep editing", exact: true })
      .click();
    await expect(edit).toHaveValue(original + "\nUnsaved extra text.");
    await nav("Changes");
    await page
      .getByRole("button", { name: "Discard edits", exact: true })
      .click();
    check("Markdown save and dirty navigation guards protect sample edits");
    await nav("Use cases");
    await page.getByRole("button", { name: /Revise with AI/ }).click();
    await page
      .getByLabel("What would you like to change?", { exact: true })
      .fill("Show a friendly empty state with a Create order action.");
    await page
      .getByRole("button", { name: "Create mock proposal", exact: true })
      .click();
    await expect(
      page.getByText("PROPOSED ADDITION · MOCK", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Apply sample revision", exact: true })
      .click();
    await expect(page.locator(".markdown-sample")).toContainText(
      "Show a friendly empty state",
    );
    await screenshot("06-use-cases-desktop");
    check("Revision proposal is reviewed before applying to sample content");
    await nav("Changes");
    await page
      .getByRole("button", { name: "Apply 2 sample updates", exact: true })
      .click();
    await expect(
      page.getByText("2 sample updates applied", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Select remaining", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Apply 1 sample updates", exact: true })
      .click();
    await expect(
      page.getByText("3 sample updates applied", { exact: true }),
    ).toBeVisible();
    await screenshot("07-changes-desktop");
    check(
      "Selected changes apply coherently and leave the remaining selection retryable",
    );
    await nav("Export");
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page
      .getByRole("button", { name: "Preview export plan", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", {
        name: "Your sample export plan",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close preview", exact: true })
      .click();
    await selectOption("Export simulation outcome", "One item fails");
    await page
      .getByRole("button", { name: "Simulate export to Jira", exact: true })
      .click();
    await expect(
      page.getByText("7 of 8 successful", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Retry failed sample items", exact: true })
      .click();
    await expect(
      page.getByText("8 of 8 successful", { exact: true }),
    ).toBeVisible();
    await screenshot("08-export-desktop");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Sample CSV", exact: true }).click();
    await (
      await downloadPromise
    ).saveAs(path.join(output, "sample-use-cases.csv"));
    check("Export plan, partial results, retry and local synthetic CSV work");
    await nav("Knowledge graph");
    await page
      .getByRole("button", { name: "Select graph node UC-008", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Open use case", exact: true })
      .click();
    await expect(page.locator(".markdown-sample h1")).toContainText("UC-008");
    check("Graph selection links to the correct sample use case");
    await nav("Screens");
    await page
      .getByLabel("Screen notes", { exact: true })
      .fill("QA sample note: preserve the empty and error states.");
    await page.getByRole("button", { name: "Save notes", exact: true }).click();
    await nav("Analysis");
    await nav("Screens");
    await expect(page.getByLabel("Screen notes", { exact: true })).toHaveValue(
      "QA sample note: preserve the empty and error states.",
    );
    check("Screen notes persist while navigating the sample session");
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Figma frames · mock", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Load sample frames", exact: true })
      .click();
    await page.locator(".figma-frame-grid input").nth(0).uncheck();
    await page.locator(".figma-frame-grid input").nth(1).uncheck();
    await page
      .getByRole("button", { name: "Import 2 sample frames", exact: true })
      .click();
    await expect(page.locator(".screen-thumb")).toHaveCount(6);
    check("Mock Figma frame selection adds only the chosen synthetic screens");
    await page
      .getByLabel("Choose local screenshot images", { exact: true })
      .setInputFiles(path.join(output, "01-screens-desktop.png"));
    await expect(page.locator(".screen-thumb")).toHaveCount(7);
    await expect(
      page.locator(".artboard-image .custom-screenshot"),
    ).toBeVisible();
    check("Local image preview decodes in the browser without uploading");
    await openSettings();
    await page
      .getByLabel("API key", { exact: true })
      .fill("placeholder-for-ui-check-only");
    await page
      .getByRole("button", {
        name: /^(Save connection|Save all changes)$/,
        exact: true,
      })
      .click();
    await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
    assert.deepEqual(
      await page.evaluate(() => ({
        local: localStorage.length,
        session: sessionStorage.length,
      })),
      { local: 0, session: 0 },
    );
    await page
      .getByRole("combobox", { name: "AI provider", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Settings", exact: true }),
    ).toBeVisible();
    for (let i = 0; i < 25; i++) await page.keyboard.press("Tab");
    assert(
      await page.evaluate(() =>
        document
          .querySelector(".settings-window")
          .contains(document.activeElement),
      ),
    );
    check(
      "Placeholder secrets are cleared; menus dismiss first; keyboard focus stays in Settings",
    );
    await page.getByRole("button", { name: /Advanced configuration/ }).click();
    await page.getByLabel("Request timeout", { exact: true }).fill("0");
    await page
      .getByRole("button", {
        name: /^(Save connection|Save all changes)$/,
        exact: true,
      })
      .click();
    await expect(
      page.getByText("Choose a timeout between 5 and 7,200 seconds.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByLabel("Request timeout", { exact: true }).fill("180");
    await expect(
      page.getByRole("button", {
        name: /^(Save connection|Save all changes)$/,
        exact: true,
      }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    check(
      "Invalid advanced values prevent saving; restoring the saved value returns the draft to clean",
    );
    await page
      .getByRole("button", { name: "Reset preview", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Reset sample workspace", exact: true })
      .click();
    await expect(page.locator(".screen-thumb")).toHaveCount(4);
    check("Reset restores the original sample workspace");
    await page.setViewportSize({ width: 390, height: 844 });
    await nav("Screens");
    await screenshot("09-screens-mobile");
    await openSettings();
    const mobileBox = await page.locator(".settings-window").boundingBox();
    assert(
      mobileBox.x >= 0 &&
        mobileBox.y >= 0 &&
        mobileBox.x + mobileBox.width <= 391 &&
        mobileBox.y + mobileBox.height <= 845,
    );
    await screenshot("10-settings-mobile");
    await page
      .getByRole("button", { name: "Analysis defaults", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Read screens with", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    check("Mobile settings remain within viewport and subcategories work");
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: width === 320 ? 740 : 900 });
      await expect(page.locator(".screen-artboard")).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      );
      assert.equal(overflow, false, `Page overflow at ${width}px`);
      await openSettings();
      const box = await page.locator(".settings-window").boundingBox();
      assert(box.x >= 0 && box.y >= 0);
      await page
        .getByRole("button", { name: "Close settings", exact: true })
        .click();
      check(`Responsive shell and settings at ${width}px`);
    }
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(errors, []);
    check("No external page requests or browser errors");
    await writeFile(
      path.join(output, "browser-verification.json"),
      JSON.stringify(
        {
          date: "2026-10-15",
          browser: "Installed Chrome via Playwright",
          checks,
          externalRequests,
          errors,
          screenshots: "01 through 10 PNGs in artifacts/",
          scope:
            "Stage 1 POC only. No real AI, tracker or Figma integration tested.",
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  await screenshot("failure");
  await writeFile(
    path.join(output, "browser-failure.json"),
    JSON.stringify(
      { checks, error: String(error), errors, externalRequests },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
