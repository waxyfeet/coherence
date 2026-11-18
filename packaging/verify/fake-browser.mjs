/**
 * Stands in for a web browser in packaging/verify-launcher.mjs: the test launcher runs it in place of the default
 * browser with the bootstrap page's file:// URL. It does what the page's script does — post the one-use ticket to the
 * form's loopback action with Origin "null" — and appends the outcome to browser-log.jsonl beside the test profile.
 * Usage (by the launcher): node fake-browser.mjs <log file> <file:// URL>
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const [logFile, url] = process.argv.slice(2);
const record = { url, at: new Date().toISOString() };
try {
  const html = fs.readFileSync(fileURLToPath(url), "utf8");
  const action =
    /<form method="post" action="(http:\/\/127\.0\.0\.1:\d+\/api\/auth\/bootstrap)">/.exec(
      html,
    )?.[1];
  const ticket = /name="ticket" value="([^"]+)"/.exec(html)?.[1];
  if (!action || !ticket) throw new Error("not a bootstrap page");
  const response = await fetch(action, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "null",
    },
    body: new URLSearchParams({ ticket }),
  });
  const body = await response.text();
  record.status = response.status;
  record.origin = new URL(action).origin;
  // The disposable test session's token lets the check drive in-app actions (e.g. Quit) like the real page would.
  record.token = /token\\":\\"([a-f0-9]{64})/.exec(body)?.[1];
  record.session = Boolean(record.token);
} catch (error) {
  record.error = String(error?.message ?? error);
}
fs.appendFileSync(logFile, JSON.stringify(record) + "\n");
