/**
 * Offline end-to-end run of the generation pipeline (mock provider) against the bundled demo project, in an
 * isolated data dir. Exercises every agent module plus storage, formats and spec writing.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GENERATION_OPTIONS,
  type GenerationOptions,
  type SolutionModel,
} from "@shared/types";
import { makePng, removeDir, useTempDataDir } from "../storage/testUtils";
import { recordingContext } from "./testContext";

let dataDir: string;
let mods: {
  pipeline: typeof import("./pipeline");
  revise: typeof import("./revise");
  reviewer: typeof import("./reviewer");
  chain: typeof import("./chain");
  store: typeof import("../storage/projectStore");
  demo: typeof import("../storage/demo");
  settings: typeof import("../storage/settingsStore");
  specs: typeof import("../specs/specStore");
};
let projectId: string;
let options: GenerationOptions;

beforeAll(async () => {
  dataDir = await useTempDataDir("agents");
  vi.resetModules();
  mods = {
    pipeline: await import("./pipeline"),
    revise: await import("./revise"),
    reviewer: await import("./reviewer"),
    chain: await import("./chain"),
    store: await import("../storage/projectStore"),
    demo: await import("../storage/demo"),
    settings: await import("../storage/settingsStore"),
    specs: await import("../specs/specStore"),
  };
  await mods.store.ensureDataDirs();
  const connection = await mods.settings.createConnection({
    name: "Offline test",
    provider: "mock",
    model: "demo",
  });
  const project = await mods.demo.createDemoProject();
  projectId = project.id;
  options = {
    ...DEFAULT_GENERATION_OPTIONS,
    visionConnectionId: connection.id,
    textConnectionId: connection.id,
  };
});

afterAll(async () => {
  await removeDir(dataDir);
});

async function model(): Promise<SolutionModel> {
  const m = await mods.store.loadModel(projectId);
  if (!m) throw new Error("no model");
  return m;
}

/** Model and .md files agree in the app (every status change or edit is written to both); keep them so here. */
async function saveAsTheAppWould(m: SolutionModel): Promise<void> {
  await mods.store.saveModel(projectId, m);
  await mods.specs.rerenderSpecs(await mods.store.getProject(projectId), true);
}

describe("runGeneration (offline, demo project)", () => {
  it("produces a chained, fully covered, multi-use-case spec and writes the files", async () => {
    const ctx = recordingContext(projectId);
    const result = await mods.pipeline.runGeneration(ctx, projectId, options);

    expect(ctx.stages).toEqual([...mods.pipeline.GENERATION_STAGES]);
    expect(result.screenCount).toBe(4);
    expect(result.useCaseCount).toBeGreaterThanOrEqual(10);
    expect(result.useCaseCount).toBeLessThanOrEqual(20);
    expect(result.featureCount).toBeGreaterThanOrEqual(3);
    expect(result.featureCount).toBeLessThanOrEqual(5);
    expect(result.fileCount).toBeGreaterThan(result.useCaseCount);

    const m = await model();
    // Ids and order follow the build order.
    m.useCases.forEach((uc, i) => {
      expect(uc.id).toBe(`UC-${String(i + 1).padStart(3, "0")}`);
      expect(uc.order).toBe(i + 1);
    });
    expect(m.features.map((f) => f.id)).toEqual(
      m.features.map((_, i) => `FEAT-${String(i + 1).padStart(2, "0")}`),
    );
    expect(m.useCases[0].title).toMatch(/sign in/i);
    expect(
      m.useCases.some(
        (u) =>
          u.title === "Application shell & navigation" &&
          u.screenIds.length >= 3,
      ),
    ).toBe(true);

    // Every element covered; every covered element governed by a rule; chain valid.
    const blocking = mods.reviewer
      .deterministicReview(m)
      .filter((f) => f.severity !== "info");
    expect(blocking).toEqual([]);
    const byId = new Map(m.useCases.map((u) => [u.id, u]));
    for (const uc of m.useCases) {
      for (const dep of uc.dependsOn)
        expect(byId.get(dep)!.order).toBeLessThan(uc.order);
      if (uc.dependsOn.length)
        expect(
          mods.chain.chainHolds(
            uc,
            uc.dependsOn.map((d) => byId.get(d)!),
          ),
        ).toBe(true);
      // Three or more, except a group of buttons whose destinations the screens do not show (happy path + edge).
      expect(uc.scenarios.length).toBeGreaterThanOrEqual(2);
      expect(uc.scenarios[0].type).toBe("happy");
      expect(mods.chain.happyPathCoversPreconditions(uc)).toBe(true);
      expect(mods.chain.happyPathCoversPostconditions(uc)).toBe(true);
      expect(uc.story.iWant).not.toBe("");
    }
    // Dropdown options are listed in the rules.
    const rulesText = m.useCases
      .flatMap((u) => u.businessRules.flatMap((r) => r.rules))
      .join("\n");
    expect(rulesText).toMatch(/Options, in this order: /);

    // Files and project state.
    const project = await mods.store.getProject(projectId);
    expect(
      project.status === "specified" || project.status === "needs-review",
    ).toBe(true);
    expect(project.lastGeneratedAt).toBeTruthy();
    for (const s of project.screens) expect(s.analysedVersion).toBe(s.version);
    const readme = await fs.readFile(
      path.join(project.outputDir, "README.md"),
      "utf8",
    );
    expect(readme).toContain("UC-001");
    const files = await fs.readdir(path.join(project.outputDir, "use-cases"));
    expect(files.filter((f) => f.endsWith(".md"))).toHaveLength(
      m.useCases.length,
    );
    expect(
      ctx.logs.some((l) =>
        /^Read 'Login': \d+ regions, \d+ elements/.test(l.message),
      ),
    ).toBe(true);
    expect(
      ctx.logs.some((l) =>
        /^Planned \d+ use cases in \d+ features/.test(l.message),
      ),
    ).toBe(true);
    expect(ctx.usage.calls).toBeGreaterThan(result.useCaseCount);
  }, 120_000);

  it("reuses unchanged screen analyses and keeps edited use cases on re-generation", async () => {
    const before = await model();
    const edited = before.useCases[2];
    edited.status = "edited";
    edited.notes = "BA note that must survive.";
    await saveAsTheAppWould(before);

    const ctx = recordingContext(projectId);
    const result = await mods.pipeline.runGeneration(ctx, projectId, options);
    expect(
      ctx.logs.filter((l) => l.message.startsWith("Reused the analysis of")),
    ).toHaveLength(4);
    expect(result.preservedFiles.length).toBe(1);

    const after = await model();
    const kept = after.useCases.find((u) => u.id === edited.id)!;
    expect(kept.status).toBe("edited");
    expect(kept.notes).toBe("BA note that must survive.");
    expect(kept.title).toBe(edited.title);
    // Nobody else re-plans the locked elements.
    const others = after.useCases.filter((u) => u.id !== edited.id);
    for (const id of edited.elementIds)
      expect(others.some((u) => u.elementIds.includes(id))).toBe(false);
    expect(
      mods.reviewer
        .deterministicReview(after)
        .filter((f) => f.severity === "error"),
    ).toEqual([]);
    const history = await fs.readdir(
      path.join(
        (await mods.store.getProject(projectId)).projectPath!,
        "history",
      ),
    );
    expect(history.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("chains new use cases onto locked sign-in and shell use cases on re-generation", async () => {
    const before = await model();
    const signIn = before.useCases.find((u) =>
      /sign in with email/i.test(u.title),
    )!;
    const shell = before.useCases.find(
      (u) => u.title === "Application shell & navigation",
    )!;
    signIn.status = "approved";
    shell.status = "edited";
    await saveAsTheAppWould(before);

    await mods.pipeline.runGeneration(
      recordingContext(projectId),
      projectId,
      options,
    );
    const after = await model();
    const byId = new Map(after.useCases.map((u) => [u.id, u]));
    expect(byId.get(signIn.id)?.status).toBe("approved");
    expect(byId.get(shell.id)?.status).toBe("edited");
    // The dashboard still follows the email sign-in (not single sign-on); the order list follows the shell.
    const metrics = after.useCases.find((u) =>
      /key order metrics/i.test(u.title),
    )!;
    expect(metrics.dependsOn).toEqual([signIn.id]);
    const browse = after.useCases.find((u) =>
      /browse the order list/i.test(u.title),
    )!;
    expect(browse.dependsOn).toEqual([shell.id]);
    for (const uc of after.useCases) {
      if (uc.dependsOn.length)
        expect(
          mods.chain.chainHolds(
            uc,
            uc.dependsOn.map((d) => byId.get(d)!),
          ),
        ).toBe(true);
    }
  }, 120_000);

  it("keeps a use case edited outside the app and refreshes the links in every kept file", async () => {
    const project = await mods.store.getProject(projectId);
    const before = await model();
    // The last generated use case: keeping it makes every other new use case get a new id (ids continue after it).
    const target = [...before.useCases]
      .reverse()
      .find(
        (u) =>
          u.status === "generated" &&
          u.businessRules.some((r) => r.rules.length),
      )!;
    const file = path.join(project.outputDir, ...target.filePath!.split("/"));
    const md = await fs.readFile(file, "utf8");
    const rule = target.businessRules.find((r) => r.rules.length)!.rules[0];
    expect(md).toContain(`- ${rule}`);
    // The BA edits the file in their own editor and never presses "Sync from disk".
    await fs.writeFile(
      file,
      md.replace(`- ${rule}`, `- ${rule} (edited outside the app)`),
    );

    const ctx = recordingContext(projectId);
    const result = await mods.pipeline.runGeneration(ctx, projectId, options);
    expect(
      ctx.logs.some(
        (l) =>
          l.message.startsWith("Picked up edits made outside the app first") &&
          l.message.includes(target.id),
      ),
    ).toBe(true);
    const after = await model();
    const kept = after.useCases.find((u) => u.id === target.id)!;
    expect(kept.status).toBe("edited");
    expect(JSON.stringify(kept.businessRules)).toContain(
      "(edited outside the app)",
    );
    expect(await fs.readFile(file, "utf8")).toContain(
      "(edited outside the app)",
    );

    // Kept files link only to use case files that exist, and their front matter matches the new model.
    const names = new Set(
      await fs.readdir(path.join(project.outputDir, "use-cases")),
    );
    expect(result.preservedFiles.length).toBeGreaterThanOrEqual(3);
    for (const rel of result.preservedFiles) {
      const content = await fs.readFile(
        path.join(project.outputDir, ...rel.split("/")),
        "utf8",
      );
      const links = [
        ...content.matchAll(/\]\((UC-\d{3}-[a-z0-9-]+\.md)\)/g),
      ].map((m) => m[1]);
      for (const link of links)
        expect(names.has(link), `${rel} links to ${link}`).toBe(true);
      const uc = after.useCases.find((u) => u.filePath === rel)!;
      expect(content).toContain(`dependsOn: [${uc.dependsOn.join(", ")}]`);
      const leadsTo = [...after.useCases]
        .sort((a, b) => a.order - b.order)
        .filter((u) => u.dependsOn.includes(uc.id))
        .map((u) => u.id);
      expect(content, rel).toContain(`leadsTo: [${leadsTo.join(", ")}]`);
      for (const id of leadsTo)
        expect(content, rel).toContain(
          `[${id}](${after.useCases
            .find((u) => u.id === id)!
            .filePath!.split("/")
            .pop()})`,
        );
    }
  }, 120_000);

  it("runs the thorough mode (inspector + self-repair) offline", async () => {
    const ctx = recordingContext(projectId);
    const result = await mods.pipeline.runGeneration(ctx, projectId, {
      ...options,
      thoroughness: "thorough",
      reuseScreenAnalyses: false,
      preserveEdited: false,
      granularity: "fine",
    });
    expect(
      ctx.logs.some((l) => l.message.startsWith("Inspected 'Login'")),
    ).toBe(true);
    expect(result.useCaseCount).toBeGreaterThan(5);
    const m = await model();
    expect(m.useCases.every((u) => u.status === "generated")).toBe(true);
  }, 120_000);

  it("specs a project with arbitrary screen names (fine granularity) without blocking findings", async () => {
    const created = await mods.store.createProject({
      name: "Garden shop",
      description: "Online shop where gardeners buy plants and tools.",
      additionalContext: "",
    });
    const names = [
      "Register",
      "Home",
      "Products",
      "Product details",
      "Checkout",
      "Quarterly widget thing",
    ];
    const added = await mods.store.addScreens(
      created.id,
      await Promise.all(
        names.map(async (name) => ({
          originalName: `${name}.png`,
          mimeType: "image/png",
          buffer: await makePng(64, 48),
        })),
      ),
    );
    expect(added).toHaveLength(names.length);
    const ctx = recordingContext(created.id);
    const result = await mods.pipeline.runGeneration(ctx, created.id, {
      ...options,
      granularity: "fine",
    });
    expect(result.screenCount).toBe(names.length);
    const m = await mods.store.loadModel(created.id);
    expect(m!.useCases.length).toBeGreaterThan(names.length);
    expect(
      mods.reviewer
        .deterministicReview(m!)
        .filter((f) => f.severity === "error"),
    ).toEqual([]);
    expect(m!.personas.length).toBeGreaterThan(0);
  }, 120_000);

  it("stops when the job is cancelled", async () => {
    const ctx = recordingContext(projectId);
    ctx.cancel();
    await expect(
      mods.pipeline.runGeneration(ctx, projectId, options),
    ).rejects.toThrow(/cancel/i);
  }, 120_000);

  it("revises one use case offline: records the instructions, bumps the revision and marks it edited", async () => {
    const before = (await model()).useCases[1];
    const ctx = recordingContext(projectId);
    const result = await mods.revise.runReviseUseCase(
      ctx,
      projectId,
      before.id,
      { instructions: "Add a scenario for an expired session." },
    );
    expect(result.useCase.status).toBe("edited");
    expect(result.useCase.revision).toBe(before.revision + 1);
    expect(result.useCase.assumptions.join(" ")).toContain("expired session");
    expect(result.diff.changedSections).toContain("assumptions");
    expect(result.writtenFiles.some((f) => f.startsWith("use-cases/"))).toBe(
      true,
    );
    const after = (await model()).useCases.find((u) => u.id === before.id)!;
    expect(after.revision).toBe(before.revision + 1);
    expect(after.businessRules).toEqual(before.businessRules);
  });
});
