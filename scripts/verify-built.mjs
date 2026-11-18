import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { authenticatedFixture } from "./authenticated-fixture.mjs";
const root = process.cwd(),
  temp = path.join(root, ".cache/browser-temp");
await mkdir(temp, { recursive: true });
process.env.TEMP = temp;
process.env.TMP = temp;
process.env.TMPDIR = temp;
const fixture = JSON.parse(
  await readFile(
    path.join(root, "artifacts/extended-verification.json"),
    "utf8",
  ),
);
if (!fixture.dataDir)
  throw Error(
    "Run npm run test:extended first to create an isolated authenticated fixture.",
  );
const backend = await authenticatedFixture(4494, fixture.dataDir);
const browser = await chromium.launch({
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
  localStorage.setItem(
    "screenscribe.local-session.v1",
    JSON.stringify(session),
  );
}, backend.session);
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [],
  external = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (url.origin === backend.origin) return route.continue();
  external.push(url.href);
  return route.abort();
});
function check(message) {
  checks.push(message);
  console.log("PASS " + message);
}
try {
  await page.goto(backend.origin + "/");
  await expect(page.locator(".library-page")).toBeVisible();
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  check("Compiled application and Settings load from API port without Vite");
  await page.goto(
    `${backend.origin}/#/projects/${encodeURIComponent(fixture.projectId)}/graph`,
  );
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  check("Compiled lazy graph chunks render actual project evidence");
  await page.goto(
    `${backend.origin}/#/projects/${encodeURIComponent(fixture.projectId)}/use-cases?file=README.md`,
  );
  await expect(page.locator(".mermaid-diagram svg").first()).toBeVisible({
    timeout: 20000,
  });
  await page.screenshot({
    path: path.join(root, "artifacts/built-application.png"),
    animations: "disabled",
  });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  check(
    "Compiled Markdown deep link and Mermaid render without browser errors or other origins",
  );
  await writeFile(
    path.join(root, "artifacts/built-verification.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        checks,
        errors,
        external,
        scope:
          "Compiled UI on isolated authenticated loopback API 4494. Read-only existing offline fixture; no model, Figma or tracker request.",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  backend.stop();
}
