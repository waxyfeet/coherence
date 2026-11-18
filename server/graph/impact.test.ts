/**
 * The impact jobs against real storage (isolated data dir) and the offline AI: overlapping reports, reports
 * made stale by a re-generation, and BA edits made on disk before or during an apply.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ChangeRequest,
  ImpactReport,
  Project,
  SolutionModel,
  UseCase,
} from "@shared/types";
import { recordingContext } from "../agents/testContext";
import { makePng, removeDir, useTempDataDir } from "../storage/testUtils";
import { fixtureModel } from "./testFixtures";

type Impact = typeof import("./impact");
type Store = typeof import("../storage/projectStore");
type Specs = typeof import("../specs/specStore");

let dataDir: string;
let impact: Impact;
let store: Store;
let specs: Specs;
/** Runs after the (offline) Use Case Writer rewrote a use case, while the apply job is still in flight. */
let duringRewrite: ((uc: UseCase) => Promise<void>) | undefined;

beforeAll(async () => {
  dataDir = await useTempDataDir("impact");
  for (const k of [
    "SCREENSCRIBE_V2_ANTHROPIC_API_KEY",
    "SCREENSCRIBE_V2_OPENAI_API_KEY",
    "SCREENSCRIBE_V2_GEMINI_API_KEY",
  ])
    delete process.env[k];
  vi.resetModules();
  vi.doMock("../agents/writer", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../agents/writer")>();
    return {
      ...actual,
      writeUseCaseContent: async (
        args: Parameters<typeof actual.writeUseCaseContent>[0],
      ) => {
        const out = await actual.writeUseCaseContent(args);
        await duringRewrite?.(args.useCase);
        return out;
      },
    };
  });
  store = await import("../storage/projectStore");
  specs = await import("../specs/specStore");
  impact = await import("./impact");
  (await import("../llm/structured")).configureLLMRuntime({ mockDelayMs: 0 });
  await store.ensureDataDirs();
});

afterAll(async () => {
  vi.doUnmock("../agents/writer");
  await removeDir(dataDir);
});

function remapModel(p: Project): SolutionModel {
  const map: Record<string, string> = {
    scr_login: p.screens[0].id,
    scr_dash: p.screens[1].id,
    scr_orders: p.screens[2].id,
  };
  const model = JSON.parse(
    JSON.stringify({ ...fixtureModel(), projectId: p.id }).replace(
      /scr_(login|dash|orders)/g,
      (m) => map[m],
    ),
  ) as SolutionModel;
  for (const uc of model.useCases) delete uc.filePath;
  return model;
}

async function newProject(
  name: string,
  edit?: (model: SolutionModel) => void,
): Promise<Project> {
  const created = await store.createProject({
    name,
    description: "Orders portal",
  });
  const png = await makePng(64, 48);
  await store.addScreens(
    created.id,
    ["Login", "Dashboard", "Orders"].map((n) => ({
      originalName: `${n}.png`,
      mimeType: "image/png",
      buffer: png,
    })),
  );
  const project = await store.getProject(created.id);
  for (const s of project.screens) s.analysedVersion = s.version;
  await store.saveProject(project);
  const model = remapModel(project);
  edit?.(model);
  await specs.writeSpecs(project, model, {
    preserveEdited: false,
    embedScreenImages: false,
  });
  await store.saveModel(project.id, model);
  return project;
}

const approve = (id: string) => (model: SolutionModel) => {
  model.useCases.find((u) => u.id === id)!.status = "approved";
};

function analyse(
  pid: string,
  change: Omit<ChangeRequest, "source">,
): Promise<ImpactReport> {
  return impact.runImpactAnalysis(recordingContext(pid), pid, {
    change: { ...change, source: "manual" },
  });
}

function apply(pid: string, reportId: string, useCaseIds?: string[]) {
  return impact.runApplyImpact(
    recordingContext(pid),
    pid,
    reportId,
    useCaseIds ? { useCaseIds } : {},
  );
}

async function useCase(pid: string, id: string): Promise<UseCase> {
  return (await store.loadModel(pid))!.useCases.find((u) => u.id === id)!;
}

async function ucFile(project: Project, id: string): Promise<string> {
  const uc = await useCase(project.id, id);
  return path.join(project.outputDir, ...uc.filePath!.split("/"));
}

const passwordChange = {
  targetKind: "element",
  targetId: "login.password",
  description: "Password minimum length from 8 to 12",
} as const;
const buttonChange = {
  targetKind: "element",
  targetId: "login.sign_in",
  description: "Rename the button from Sign in to Log in",
} as const;
const forgotChange = {
  targetKind: "element",
  targetId: "login.forgot",
  description: "Rename the link from Forgot password? to Reset password",
} as const;

describe("overlapping impact reports", () => {
  it("discarding one report keeps the use case stale for the other, which then keeps the BA protection", async () => {
    const project = await newProject("Overlap discard", approve("UC-001"));
    const a = await analyse(project.id, passwordChange);
    const b = await analyse(project.id, buttonChange);
    expect(a.previousStatuses["UC-001"]).toBe("approved");
    expect(b.previousStatuses["UC-001"]).toBe("approved");
    expect(await useCase(project.id, "UC-001")).toMatchObject({
      status: "stale",
      staleReason: a.id,
    });

    await impact.discardImpact(project.id, a.id);
    expect(await useCase(project.id, "UC-001")).toMatchObject({
      status: "stale",
      staleReason: b.id,
    });
    expect(
      await fs.readFile(await ucFile(project, "UC-001"), "utf8"),
    ).toContain(`staleReason: ${b.id}`);

    const result = await apply(project.id, b.id, ["UC-001"]);
    expect(result.updatedUseCaseIds).toEqual(["UC-001"]);
    const after = await useCase(project.id, "UC-001");
    expect(after.status).toBe("edited");
    expect(after.staleReason).toBeUndefined();
  });

  it("applying one report keeps the use case flagged by the other open report", async () => {
    const project = await newProject("Overlap apply", approve("UC-001"));
    const a = await analyse(project.id, passwordChange);
    const b = await analyse(project.id, buttonChange);

    const result = await apply(project.id, b.id, ["UC-001"]);
    expect(result.updatedUseCaseIds).toEqual(["UC-001"]);
    expect(result.warnings.join("\n")).toContain(
      `UC-001 stays marked stale: impact report ${a.id}`,
    );
    expect(await useCase(project.id, "UC-001")).toMatchObject({
      status: "stale",
      staleReason: a.id,
      revision: 2,
    });
    expect(
      (await store.getImpactReport(project.id, a.id)).previousStatuses[
        "UC-001"
      ],
    ).toBe("edited");

    // Discarding the other report later gives the rewritten (edited) content back its protected status.
    await impact.discardImpact(project.id, a.id);
    expect((await useCase(project.id, "UC-001")).status).toBe("edited");
  });
});

describe("impact report analysed before a re-generation", () => {
  it("records the model it was analysed against and refuses to apply after a re-generation", async () => {
    const project = await newProject("Regenerated");
    const report = await analyse(project.id, forgotChange);
    expect(
      (report as ImpactReport & { modelGeneratedAt?: string }).modelGeneratedAt,
    ).toBe((await store.loadModel(project.id))!.generatedAt);

    const model = (await store.loadModel(project.id))!;
    model.generatedAt = new Date(
      Date.parse(report.createdAt) + 60_000,
    ).toISOString();
    await store.saveModel(project.id, model);
    const before = await useCase(project.id, "UC-002");
    await expect(apply(project.id, report.id)).rejects.toThrow(
      /regenerated after this impact analysis/,
    );
    expect((await useCase(project.id, "UC-002")).revision).toBe(
      before.revision,
    );

    // Reports saved before modelGeneratedAt was recorded fall back to their creation time.
    const legacy: ImpactReport & { modelGeneratedAt?: string } =
      await store.getImpactReport(project.id, report.id);
    delete legacy.modelGeneratedAt;
    await store.saveImpactReport(legacy);
    await expect(apply(project.id, report.id)).rejects.toThrow(
      /regenerated after this impact analysis/,
    );
  });
});

describe("BA edits on disk", () => {
  it("picks up edits made outside the app before rewriting", async () => {
    const project = await newProject("External edit");
    const report = await analyse(project.id, forgotChange);
    const file = await ucFile(project, "UC-002");
    const md = await fs.readFile(file, "utf8");
    expect(md).toContain("**So that** I get my work done");
    await fs.writeFile(
      file,
      md.replace(
        "**So that** I get my work done",
        "**So that** I can get back into my account",
      ),
    );

    const result = await apply(project.id, report.id, ["UC-002"]);
    expect(result.updatedUseCaseIds).toEqual(["UC-002"]);
    expect((await useCase(project.id, "UC-002")).story.soThat).toBe(
      "I can get back into my account",
    );
    expect(await fs.readFile(file, "utf8")).toContain(
      "**So that** I can get back into my account",
    );
  });

  it("does not overwrite a use case file edited while the rewrite was running", async () => {
    const project = await newProject("Edit during apply");
    const report = await analyse(project.id, forgotChange);
    const file = await ucFile(project, "UC-002");
    duringRewrite = async (uc) => {
      if (uc.id !== "UC-002") return;
      await fs.appendFile(file, "\n<!-- edited while the AI was working -->\n");
      const later = new Date(Date.now() + 5_000);
      await fs.utimes(file, later, later);
    };
    try {
      const result = await apply(project.id, report.id, ["UC-002"]);
      expect(result.updatedUseCaseIds).toEqual([]);
      expect(result.warnings.join("\n")).toContain(
        "UC-002 was edited while the impact was being applied",
      );
    } finally {
      duringRewrite = undefined;
    }
    expect(await fs.readFile(file, "utf8")).toContain(
      "<!-- edited while the AI was working -->",
    );
    const saved = await store.getImpactReport(project.id, report.id);
    expect(saved.status).toBe("partially-applied");
    expect(await useCase(project.id, "UC-002")).toMatchObject({
      status: "stale",
      staleReason: report.id,
      revision: 1,
    });
  });
});
