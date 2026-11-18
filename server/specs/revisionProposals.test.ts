import { authenticatedTestApp } from "../security/authTestUtils";
let authenticated: Awaited<ReturnType<typeof authenticatedTestApp>>;
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { RevisionProposalReview } from "@shared/api";
import { fixtureModel } from "../graph/testFixtures";
import { useTempDataDir, removeDir } from "../storage/testUtils";
let dir: string, origin: string, server: http.Server;
let store: typeof import("../storage/projectStore"),
  specs: typeof import("./specStore"),
  proposals: typeof import("./revisionProposals"),
  jobs: typeof import("../jobs/jobManager"),
  cfg: typeof import("../config");
beforeAll(async () => {
  dir = await useTempDataDir("complete-proposal-review");
  vi.resetModules();
  store = await import("../storage/projectStore");
  specs = await import("./specStore");
  proposals = await import("./revisionProposals");
  jobs = await import("../jobs/jobManager");
  cfg = await import("../config");
  await store.ensureDataDirs();
  authenticated = await authenticatedTestApp();
  server = authenticated.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  authenticated.authenticate(origin);
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await removeDir(dir);
});
async function fixture() {
  const project = await store.createProject({
    name: "Long review fixture",
    description: "Synthetic only",
  });
  const model = fixtureModel();
  model.projectId = project.id;
  model.options.embedScreenImages = false;
  const before = model.useCases[0];
  before.status = "approved";
  before.notes =
    "Retained synthetic narrative.\n".repeat(600) +
    "REMOVE LATE REQUIREMENT\nMODIFY OLD REQUIREMENT\n";
  await store.saveModel(project.id, model);
  await specs.writeSpecs(project, model, {
    preserveEdited: false,
    embedScreenImages: false,
  });
  await store.saveModel(project.id, model);
  const file = await specs.readSpecFile(project, before.filePath!);
  const next = {
    ...before,
    notes:
      before.notes
        .replace("REMOVE LATE REQUIREMENT\n", "")
        .replace("MODIFY OLD REQUIREMENT", "MODIFY NEW REQUIREMENT") +
      "ADD LATE REQUIREMENT\n",
  };
  const proposal = await proposals.createRevisionProposal(
    project,
    model,
    before,
    next,
    file.contentHash!,
  );
  const review = await proposals.reviewRevisionProposal(
    project.id,
    proposal.id,
  );
  return { project, model, before, file, proposal, review };
}
async function post(pid: string, id: string, body: unknown, action = "apply") {
  return authenticated.fetch(
    `${origin}/projects/${pid}/proposals/${id}/${action}`,
    {
      method: "POST",
      headers: { "X-ScreenScribe": "1", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}
it("preserves complete long artifacts through job snapshots, SSE, persistence and canonical HTTP review, then applies exactly the reviewed bytes once", async () => {
  const { project, before, file, proposal, review } = await fixture();
  expect(review.proposedMarkdown.length).toBeGreaterThan(12000);
  expect(
    review.proposedMarkdown.indexOf("ADD LATE REQUIREMENT"),
  ).toBeGreaterThan(4000);
  const result = {
    proposalId: proposal.id,
    baselineMarkdown: proposal.baselineMarkdown,
    proposedMarkdown: proposal.proposedMarkdown,
    body: "A domain field, not diagnostics",
  };
  const job = await jobs.startJob("revise", project.id, async (ctx) => {
    ctx.info("Synthetic log");
    return result;
  });
  const events: unknown[] = [];
  const unsub = jobs.subscribe(job.id, (e) => events.push(e));
  const done = await jobs.waitForJob(job.id);
  unsub();
  expect(done.result).toEqual(result);
  expect(events.at(-1)).toMatchObject({ result });
  expect(
    JSON.parse(
      await fs.readFile(
        path.join(cfg.paths.jobsDir(project.id), job.id + ".json"),
        "utf8",
      ),
    ).result,
  ).toEqual(result);
  const response = await authenticated.fetch(
    `${origin}/projects/${project.id}/proposals/${proposal.id}`,
  );
  expect(response.status).toBe(200);
  const canonical = (await response.json()) as RevisionProposalReview;
  expect(canonical.baselineMarkdown).toBe(file.content);
  expect(canonical.proposedMarkdown).toBe(proposal.proposedMarkdown);
  expect(
    (
      await post(project.id, proposal.id, {
        reviewToken: canonical.reviewToken,
      })
    ).status,
  ).toBe(200);
  expect((await specs.readSpecFile(project, before.filePath!)).content).toBe(
    canonical.proposedMarkdown,
  );
  const applied = (await store.loadModel(project.id))!.useCases.find(
    (u) => u.id === before.id,
  )!;
  expect(applied.revision).toBe(before.revision + 1);
  expect(applied.status).toBe("edited");
  expect(
    (
      await post(project.id, proposal.id, {
        reviewToken: canonical.reviewToken,
      })
    ).status,
  ).toBe(409);
});
it("rejects a late proposal mutation, leaves approved bytes intact, and requires a new complete review before applying that version", async () => {
  const { project, before, file, proposal, review } = await fixture();
  proposal.proposedMarkdown += "\nIMPORTANT MUTATION AFTER REVIEW\n";
  await fs.writeFile(
    path.join(
      cfg.paths.projectDir(project.id),
      "proposals",
      proposal.id + ".json",
    ),
    JSON.stringify(proposal),
  );
  expect(
    (await post(project.id, proposal.id, { reviewToken: review.reviewToken }))
      .status,
  ).toBe(409);
  expect((await specs.readSpecFile(project, before.filePath!)).content).toBe(
    file.content,
  );
  const fresh = await proposals.reviewRevisionProposal(project.id, proposal.id);
  expect(fresh.reviewToken).not.toBe(review.reviewToken);
  await proposals.applyRevisionProposal(
    project.id,
    proposal.id,
    fresh.reviewToken,
  );
  expect((await specs.readSpecFile(project, before.filePath!)).content).toBe(
    fresh.proposedMarkdown,
  );
});
it.each(["document", "model"])(
  "rejects changed %s state between review and Apply without replacing human content",
  async (kind) => {
    const { project, before, file, proposal, review } = await fixture();
    if (kind === "document")
      await fs.writeFile(
        path.join(project.outputDir, before.filePath!),
        file.content + "\nLater human requirement.\n",
      );
    else {
      const current = (await store.loadModel(project.id))!;
      current.useCases[0].notes += "Model-only human requirement";
      await store.saveModel(project.id, current);
    }
    const bytes = await fs.readFile(
      path.join(project.outputDir, before.filePath!),
      "utf8",
    );
    const modelBytes = await fs.readFile(
      cfg.paths.modelFile(project.id),
      "utf8",
    );
    expect(
      (await post(project.id, proposal.id, { reviewToken: review.reviewToken }))
        .status,
    ).toBe(409);
    expect(
      await fs.readFile(path.join(project.outputDir, before.filePath!), "utf8"),
    ).toBe(bytes);
    expect(await fs.readFile(cfg.paths.modelFile(project.id), "utf8")).toBe(
      modelBytes,
    );
  },
);
it("requires explicit review evidence; missing/forged tokens cannot approve a long proposal", async () => {
  const { project, before, file, proposal } = await fixture();
  expect((await post(project.id, proposal.id, {})).status).toBe(400);
  expect(
    (await post(project.id, proposal.id, { reviewToken: "0".repeat(64) }))
      .status,
  ).toBe(409);
  expect((await specs.readSpecFile(project, before.filePath!)).content).toBe(
    file.content,
  );
});
it("cancel keeps the approved file and model byte-identical and cannot be followed by Apply", async () => {
  const { project, before, file, proposal, review } = await fixture();
  const modelBytes = await fs.readFile(cfg.paths.modelFile(project.id), "utf8");
  expect((await post(project.id, proposal.id, {}, "discard")).status).toBe(200);
  expect((await specs.readSpecFile(project, before.filePath!)).content).toBe(
    file.content,
  );
  expect(await fs.readFile(cfg.paths.modelFile(project.id), "utf8")).toBe(
    modelBytes,
  );
  expect((await store.loadModel(project.id))!.useCases[0].status).toBe(
    "approved",
  );
  expect(
    (await post(project.id, proposal.id, { reviewToken: review.reviewToken }))
      .status,
  ).toBe(409);
});
