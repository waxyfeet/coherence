import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { Job } from "../shared/types";
import { JobProgressPanel } from "./JobProgressPanel";
const progress = {
  stage: "Reading screens",
  stageIndex: 1,
  stageCount: 7,
  current: 0,
  total: 4,
};
function render(status: Job["status"], changes: Partial<Job["progress"]> = {}) {
  return renderToStaticMarkup(
    <JobProgressPanel
      job={{ status, progress: { ...progress, ...changes } }}
    />,
  );
}
it("shows actual stage and zero completions with a working state while model responses are pending", () => {
  const markup = render("running");
  expect(markup).toContain("Step 2 of 7");
  expect(markup).toContain("0 of 4 screens complete in this step");
  expect(markup).toContain('aria-valuenow="0"');
  expect(markup).toContain("Working");
  expect(markup).toContain("width:0%");
});
it("does not fabricate a percentage or ETA for a stage with no known total", () => {
  const markup = render("running", { total: 0 });
  expect(markup).toContain("duration unknown");
  expect(markup).not.toContain("aria-valuenow=");
});
it("retains partial counts and visibly stops on failure", () => {
  const markup = render("failed", { current: 3, label: "Login" });
  expect(markup).toContain("3 of 4 screens complete in this step");
  expect(markup).toContain("Stopped · failed");
  expect(markup).toContain("width:75%");
  expect(markup).toContain("Latest update: Login");
  expect(markup).not.toContain("is-working");
});

it("shows each AI request in flight by work received, never by time (tester build WP6)", () => {
  const markup = renderToStaticMarkup(
    <JobProgressPanel
      job={{
        status: "running",
        progress: { ...progress, stage: "Writing use cases", total: 17 },
        live: [
          {
            id: 1,
            purpose: "use-case-writer:UC-007",
            model: "vendor/model",
            phase: "writing",
            received: 12400,
          },
          {
            id: 2,
            purpose: "use-case-writer:UC-008",
            model: "vendor/model",
            phase: "thinking",
            received: 0,
          },
          {
            id: 3,
            purpose: "screen-analysis:Login",
            model: "vendor/model",
            phase: "waiting",
            received: 0,
          },
        ],
      }}
    />,
  );
  expect(markup).toContain("Writing UC-007");
  expect(markup).toContain(`${(12400).toLocaleString()} characters so far`);
  expect(markup).toContain("Writing UC-008");
  expect(markup).toContain("thinking…");
  expect(markup).toContain("Reading Login");
  expect(markup).toContain("waiting for the answer…");
  expect(markup).not.toMatch(/\bseconds?\b|\bminutes?\b/);
});

it("hides live requests once the run has stopped", () => {
  const markup = renderToStaticMarkup(
    <JobProgressPanel
      job={{
        status: "failed",
        progress,
        live: [
          {
            id: 1,
            purpose: "review",
            model: "m",
            phase: "writing",
            received: 5,
          },
        ],
      }}
    />,
  );
  expect(markup).not.toContain("Reviewing");
});
