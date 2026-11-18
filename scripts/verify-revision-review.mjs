/** Focused R1 acceptance. All documents/credentials and service responses are isolated synthetic fixtures. */
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const root = process.cwd(),
  port = 4498,
  out = path.join(root, "artifacts");
const temp = path.join(root, ".cache/browser-temp");
await mkdir(temp, { recursive: true });
const dataDir = path.join(root, ".cache", "revision-review-" + Date.now());
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("SCREENSCRIBE_V2_"),
  ),
);
Object.assign(env, {
  TEMP: temp,
  TMP: temp,
  TMPDIR: temp,
  SCREENSCRIBE_V2_PORT: String(port),
  SCREENSCRIBE_V2_DATA_DIR: dataDir,
  SCREENSCRIBE_V2_WORKSPACE_DIR: dataDir + "-workspace",
  SCREENSCRIBE_V2_MOCK_DELAY_MS: "0",
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
let output = "",
  browser;
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));
const checks = [],
  errors = [],
  external = [];
const check = (text) => {
  checks.push(text);
  console.log("PASS " + text);
};
async function api(url, method = "GET", body) {
  const response = await fetch(`http://127.0.0.1:${port}/api${url}`, {
    method,
    headers: {
      "X-ScreenScribe": "1",
      Authorization: `Bearer ${testSession.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
}
async function waitJob(id) {
  for (let i = 0; i < 300; i++) {
    const job = await api("/jobs/" + id);
    if (["succeeded", "failed", "cancelled"].includes(job.status)) {
      expect(job.status).toBe("succeeded");
      return job;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Synthetic job did not finish");
}
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(Error("Fixture startup timeout: " + output));
    }, 15000);
    const poll = setInterval(() => {
      if (output.includes("PARITY_API_READY")) {
        clearTimeout(timeout);
        clearInterval(poll);
        resolve();
      }
    }, 100);
    child.once("exit", (code) => {
      clearInterval(poll);
      clearTimeout(timeout);
      reject(Error("Fixture exited " + code));
    });
  });
  const project = await api("/projects/demo", "POST", {}),
    pid = project.id;
  await waitJob((await api(`/projects/${pid}/generate`, "POST", {})).jobId);
  let model = await api(`/projects/${pid}/model`);
  const uc = model.useCases[0];
  const fileUrl = `/projects/${pid}/files/content?path=${encodeURIComponent(uc.filePath)}`;
  const firstFile = await api(fileUrl);
  await api(`/projects/${pid}/files/content`, "PUT", {
    path: uc.filePath,
    baseHash: firstFile.contentHash,
    content:
      firstFile.content +
      "\n\n" +
      "Retained synthetic narrative.\n".repeat(600) +
      "BASELINE_REMOVE_LATE\nMODIFY_OLD_LATE\n",
  });
  await api(`/projects/${pid}/use-cases/${uc.id}/status`, "PATCH", {
    status: "approved",
  });
  const approved = (await api(fileUrl)).content;
  const modelPath = path.join(dataDir, "projects", pid, "model.json");
  const approvedModel = await readFile(modelPath, "utf8");
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
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of 409/.test(m.text()))
      errors.push(m.text());
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" && url.port === String(port))
      return route.continue();
    external.push(url.href);
    return route.abort();
  });
  await page.goto(
    `http://127.0.0.1:${port}/#/projects/${pid}/use-cases?case=${uc.id}`,
  );
  async function prepare(marker) {
    await page.getByRole("button", { name: "Revise", exact: true }).click();
    await page
      .getByLabel("What should change?", { exact: true })
      .fill("Synthetic proposal review fixture only.");
    const started = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/use-cases/${uc.id}/revise`) &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Prepare proposal", exact: true })
      .click();
    const id = (await (await started).json()).jobId;
    const job = await waitJob(id);
    expect(job.result.baselineMarkdown.length).toBeGreaterThan(12000);
    // Seed canonical fixture changes while Activity still covers review. The job copy is deliberately stale.
    const proposalPath = path.join(
      dataDir,
      "projects",
      pid,
      "proposals",
      job.result.proposalId + ".json",
    );
    const proposal = JSON.parse(await readFile(proposalPath, "utf8"));
    proposal.proposedMarkdown =
      proposal.baselineMarkdown
        .replace(/^status:.*$/m, "status: edited")
        .replace(/^revision:.*$/m, `revision: ${proposal.revision + 1}`)
        .replace("BASELINE_REMOVE_LATE\n", "")
        .replace("MODIFY_OLD_LATE", "MODIFY_NEW_LATE") +
      "\n" +
      marker +
      "\n";
    expect(proposal.proposedMarkdown.indexOf(marker)).toBeGreaterThan(4000);
    await writeFile(proposalPath, JSON.stringify(proposal));
    await page
      .getByRole("dialog", { name: "Workspace activity", exact: true })
      .getByRole("button", { name: "Done", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Review the proposed revision",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("region", {
        name: "Complete revision diff",
        exact: true,
      }),
    ).toContainText(marker);
    return { dialog, proposal, proposalPath };
  }
  let current = await prepare("CANCELLED_LATE_ADDITION");
  await expect(
    current.dialog.locator(".proposal-diff-line.removed"),
  ).toContainText(["BASELINE_REMOVE_LATE", "MODIFY_OLD_LATE"]);
  await current.dialog
    .getByRole("button", { name: "Full current", exact: true })
    .click();
  expect(
    await current.dialog
      .getByRole("region", { name: "Complete current Markdown", exact: true })
      .textContent(),
  ).toBe(current.proposal.baselineMarkdown);
  await current.dialog
    .getByRole("button", { name: "Full proposed", exact: true })
    .click();
  expect(
    await current.dialog
      .getByRole("region", { name: "Complete proposed Markdown", exact: true })
      .textContent(),
  ).toBe(current.proposal.proposedMarkdown);
  await current.dialog
    .getByRole("button", { name: "Keep current document", exact: true })
    .click();
  await expect(current.dialog).not.toBeVisible();
  expect((await api(fileUrl)).content).toBe(approved);
  expect(await readFile(modelPath, "utf8")).toBe(approvedModel);
  check(
    "Complete canonical proposal and both full documents are reviewable beyond 4000 characters; Cancel preserves approved file/model bytes",
  );

  current = await prepare("REVIEWED_LATE_ADDITION");
  await current.dialog
    .getByRole("region", { name: "Complete revision diff", exact: true })
    .getByText("REVIEWED_LATE_ADDITION", { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(out, "revision-review-01-late-diff.png"),
    animations: "disabled",
  });
  const reviewed = await api(
    `/projects/${pid}/proposals/${current.proposal.id}`,
  );
  current.proposal.proposedMarkdown += "\nCHANGED_AFTER_REVIEW_LATE\n";
  await writeFile(current.proposalPath, JSON.stringify(current.proposal));
  const rejected = page.waitForResponse((r) =>
    r.url().endsWith(`/proposals/${current.proposal.id}/apply`),
  );
  await current.dialog
    .getByRole("button", { name: "Apply reviewed proposal", exact: true })
    .click();
  expect((await rejected).status()).toBe(409);
  await expect(
    current.dialog.getByRole("button", {
      name: "Apply reviewed proposal",
      exact: true,
    }),
  ).toBeDisabled();
  expect((await api(fileUrl)).content).toBe(approved);
  await current.dialog
    .getByRole("button", { name: "Review latest proposal", exact: true })
    .click();
  await expect(
    current.dialog.getByRole("region", {
      name: "Complete revision diff",
      exact: true,
    }),
  ).toContainText("CHANGED_AFTER_REVIEW_LATE");
  const fresh = await api(`/projects/${pid}/proposals/${current.proposal.id}`);
  expect(fresh.reviewToken).not.toBe(reviewed.reviewToken);
  await page.setViewportSize({ width: 320, height: 780 });
  await current.dialog
    .getByRole("button", { name: "Full proposed", exact: true })
    .click();
  const full = current.dialog.getByRole("region", {
    name: "Complete proposed Markdown",
    exact: true,
  });
  expect(await full.textContent()).toBe(fresh.proposedMarkdown);
  await full.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await current.dialog.locator(".dialog-body").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const toast = page.getByRole("button", {
    name: "Dismiss notification",
    exact: true,
  });
  if (await toast.count()) await toast.click();
  const bounds = await current.dialog.boundingBox();
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: path.join(out, "revision-review-02-full-320.png"),
    animations: "disabled",
  });
  const applied = page.waitForRequest((r) =>
    r.url().endsWith(`/proposals/${current.proposal.id}/apply`),
  );
  await current.dialog
    .getByRole("button", { name: "Apply reviewed proposal", exact: true })
    .click();
  expect((await applied).postDataJSON()).toEqual({
    reviewToken: fresh.reviewToken,
  });
  await expect(current.dialog).not.toBeVisible();
  expect((await api(fileUrl)).content).toBe(fresh.proposedMarkdown);
  check(
    "Changed proposal rejects old review evidence, disables Apply, requires explicit re-review and applies exactly the new full version; 320px controls remain usable",
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  current = await prepare("DOCUMENT_CONFLICT_LATE");
  const absolute = path.join(project.outputDir, uc.filePath);
  const externalEdit =
    (await api(fileUrl)).content + "\nLater synthetic human edit.\n";
  await writeFile(absolute, externalEdit);
  const conflict = page.waitForResponse((r) =>
    r.url().endsWith(`/proposals/${current.proposal.id}/apply`),
  );
  await current.dialog
    .getByRole("button", { name: "Apply reviewed proposal", exact: true })
    .click();
  expect((await conflict).status()).toBe(409);
  await expect(
    current.dialog.getByRole("button", {
      name: "Apply reviewed proposal",
      exact: true,
    }),
  ).toBeDisabled();
  await current.dialog
    .getByRole("button", { name: "Keep current document", exact: true })
    .click();
  await expect(current.dialog).not.toBeVisible();
  expect((await api(fileUrl)).content).toBe(externalEdit);
  check(
    "Underlying document change rejects Apply, requires new review and survives Cancel unchanged",
  );
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  check(
    "Isolated review acceptance has no unexpected browser errors or external requests",
  );
  await writeFile(
    path.join(out, "revision-review-browser.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        checks,
        errors,
        external,
        dataDir,
        scope:
          "Actual V2 UI/API/files with synthetic long proposals and offline generation only; no real provider or tracker access.",
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  child.kill();
}
