/**
 * Generation runs that go wrong half-way (an agent call fails, the job is cancelled, files cannot be written,
 * a connection was deleted) and re-generations next to open impact reports — offline, isolated data dir.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GENERATION_OPTIONS,
  type GenerationOptions,
  type ImpactReport,
  type Project,
  type SolutionModel,
} from "@shared/types";
import { removeDir, useTempDataDir } from "../storage/testUtils";
import { recordingContext } from "./testContext";
import { useCase } from "./testFixtures";

/** Agent calls (by purpose) that fail as a live model's would after its retries. */
const failing = new Set<string>();
let duringCall: (() => Promise<void>) | undefined;
let duringInspection: (() => void) | undefined;
const observedCalls: string[] = [];

let dataDir: string;
let mods: {
  pipeline: typeof import("./pipeline");
  revise: typeof import("./revise");
  reviewer: typeof import("./reviewer");
  runState: typeof import("./runState");
  store: typeof import("../storage/projectStore");
  demo: typeof import("../storage/demo");
  settings: typeof import("../storage/settingsStore");
  specs: typeof import("../specs/specStore");
};
let options: GenerationOptions;

beforeAll(async () => {
  dataDir = await useTempDataDir("agents-recovery");
  vi.resetModules();
  vi.doMock("../llm/structured", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../llm/structured")>();
    const generateStructured = (async (
      opts: Parameters<typeof actual.generateStructured>[0],
    ) => {
      observedCalls.push(opts.purpose);
      if (duringInspection && opts.purpose.startsWith("screen-inspection:")) {
        const action = duringInspection;
        duringInspection = undefined;
        action();
      }
      if (duringCall) {
        const action = duringCall;
        duringCall = undefined;
        await action();
      }
      if (failing.has(opts.purpose))
        throw new Error(`the answer for ${opts.purpose} was cut off twice`);
      return actual.generateStructured(opts);
    }) as typeof actual.generateStructured;
    return { ...actual, generateStructured };
  });
  mods = {
    pipeline: await import("./pipeline"),
    revise: await import("./revise"),
    reviewer: await import("./reviewer"),
    runState: await import("./runState"),
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
  options = {
    ...DEFAULT_GENERATION_OPTIONS,
    visionConnectionId: connection.id,
    textConnectionId: connection.id,
  };
});

afterAll(async () => {
  vi.doUnmock("../llm/structured");
  await removeDir(dataDir);
});

async function demoProject(): Promise<Project> {
  return mods.demo.createDemoProject();
}

async function model(projectId: string): Promise<SolutionModel> {
  const m = await mods.store.loadModel(projectId);
  if (!m) throw new Error("no model");
  return m;
}

const warnings = (ctx: ReturnType<typeof recordingContext>): string[] =>
  ctx.logs.filter((l) => l.level === "warn").map((l) => l.message);

describe("a failing agent call after the screens were read", () => {
  it("falls back to the inventory for the journey map and the plan instead of failing the run", async () => {
    const project = await demoProject();
    failing.add("journey-map");
    failing.add("use-case-plan");
    try {
      const ctx = recordingContext(project.id);
      const result = await mods.pipeline.runGeneration(
        ctx,
        project.id,
        options,
      );
      expect(
        warnings(ctx).some((w) =>
          w.startsWith("The Journey Mapper agent failed"),
        ),
      ).toBe(true);
      expect(
        warnings(ctx).some((w) => w.startsWith("The Planner agent failed")),
      ).toBe(true);
      expect(result.useCaseCount).toBeGreaterThan(5);
      const m = await model(project.id);
      expect(m.personas.length).toBeGreaterThan(0);
      expect(
        mods.reviewer
          .deterministicReview(m)
          .filter((f) => f.severity === "error"),
      ).toEqual([]);
    } finally {
      failing.clear();
    }
  }, 120_000);

  it("reuses the readings of a run that stopped before it was saved", async () => {
    const project = await demoProject();
    const first = recordingContext(project.id);
    const enter = first.stage;
    first.stage = (name, total) => {
      enter(name, total);
      if (name === "Mapping journeys") first.cancel();
    };
    await expect(
      mods.pipeline.runGeneration(first, project.id, options),
    ).rejects.toThrow(/cancel/i);
    expect(
      first.logs.filter((l) => l.message.startsWith("Read '")),
    ).toHaveLength(4);
    expect(await mods.store.loadModel(project.id)).toBeNull();

    const second = recordingContext(project.id);
    await mods.pipeline.runGeneration(second, project.id, options);
    expect(
      second.logs.filter((l) => l.message.startsWith("Read '")),
    ).toHaveLength(0);
    expect(
      second.logs.filter((l) => l.message.startsWith("Reused the reading of")),
    ).toHaveLength(4);
    // Saved with the model: the cache is gone.
    expect((await mods.runState.readCachedAnalyses(project.id)).size).toBe(0);
  }, 120_000);
  it("reuses complete validated readings when only the output ceiling changes", async () => {
    const project = await demoProject(),
      first = recordingContext(project.id);
    const enter = first.stage;
    first.stage = (name, total) => {
      enter(name, total);
      if (name === "Mapping journeys") first.cancel();
    };
    await expect(
      mods.pipeline.runGeneration(first, project.id, options),
    ).rejects.toThrow(/cancel/i);
    const c = await mods.settings.getConnection(options.visionConnectionId!);
    await mods.settings.updateConnection(c.id, {
      ...c,
      maxOutputTokens: 32768,
    });
    const second = recordingContext(project.id);
    await mods.pipeline.runGeneration(second, project.id, options);
    expect(
      second.logs.filter((l) => l.message.startsWith("Reused the reading of")),
    ).toHaveLength(4);
    expect(
      second.logs.filter((l) => l.message.startsWith("Read '")),
    ).toHaveLength(0);
  }, 120_000);
  it("checkpoints a complete first pass before cancelled inspection and resumes inspection without buying that reading again", async () => {
    const project = await demoProject(),
      first = recordingContext(project.id);
    duringInspection = () => first.cancel();
    try {
      await expect(
        mods.pipeline.runGeneration(first, project.id, {
          ...options,
          thoroughness: "thorough",
        }),
      ).rejects.toThrow(/cancel/i);
      const cached = await mods.runState.readCachedAnalyses(project.id);
      const firstPasses = [...cached.values()].filter(
        (entry) => entry.phase === "first-pass",
      );
      expect(firstPasses.length).toBeGreaterThan(0);
      expect(await mods.store.loadModel(project.id)).toBeNull();
      const start = observedCalls.length,
        second = recordingContext(project.id);
      await mods.pipeline.runGeneration(second, project.id, {
        ...options,
        thoroughness: "thorough",
      });
      const resumedCalls = observedCalls.slice(start);
      for (const entry of firstPasses) {
        const name = project.screens.find(
          (s) => s.id === entry.analysis.screenId,
        )!.name;
        expect(resumedCalls).not.toContain(`screen-analysis:${name}`);
        expect(resumedCalls).toContain(`screen-inspection:${name}`);
      }
      expect((await mods.runState.readCachedAnalyses(project.id)).size).toBe(0);
    } finally {
      duringInspection = undefined;
    }
  }, 120_000);
  it("ignores damaged or unrecognised checkpoint records and rereads only the affected screen", async () => {
    const project = await demoProject(),
      first = recordingContext(project.id),
      enter = first.stage;
    first.stage = (name, total) => {
      enter(name, total);
      if (name === "Mapping journeys") first.cancel();
    };
    await expect(
      mods.pipeline.runGeneration(first, project.id, options),
    ).rejects.toThrow(/cancel/i);
    const filename = path.join(
      project.projectPath!,
      "analysis-cache",
      `${project.screens[0].id}.json`,
    );
    const entry = JSON.parse(await fs.readFile(filename, "utf8"));
    await fs.writeFile(
      filename,
      JSON.stringify({ ...entry, phase: "unverified-partial" }),
    );
    expect((await mods.runState.readCachedAnalyses(project.id)).size).toBe(3);
    entry.analysis.elements[0].regionId = "synthetic-missing-region";
    await fs.writeFile(filename, JSON.stringify(entry));
    expect((await mods.runState.readCachedAnalyses(project.id)).size).toBe(3);
    const second = recordingContext(project.id);
    await mods.pipeline.runGeneration(second, project.id, options);
    expect(
      second.logs.filter((l) => l.message.startsWith("Read '")),
    ).toHaveLength(1);
    expect(
      second.logs.filter((l) => l.message.startsWith("Reused the reading of")),
    ).toHaveLength(3);
  }, 120_000);
});

describe("a deleted AI connection", () => {
  it("fails closed on missing saved routes and permits deliberate replacements", async () => {
    const project = await demoProject();
    const fresh = await mods.store.getProject(project.id);
    fresh.llm = {
      visionConnectionId: "conn_deleted1",
      textConnectionId: "conn_deleted2",
    };
    await mods.store.saveProject(fresh);
    const ctx = recordingContext(project.id);
    await expect(
      mods.pipeline.runGeneration(ctx, project.id, {
        ...DEFAULT_GENERATION_OPTIONS,
      }),
    ).rejects.toThrow(/No replacement provider/);
    expect(ctx.usage.calls).toBe(0);
    expect(await mods.store.loadModel(project.id)).toBeNull();
    // Both roles must be deliberately supplied to bypass both dangling choices.
    await expect(
      mods.pipeline.runGeneration(recordingContext(project.id), project.id, {
        ...options,
        textConnectionId: undefined,
      }),
    ).rejects.toThrow(/writing the specs/);
    const result = await mods.pipeline.runGeneration(
      recordingContext(project.id),
      project.id,
      options,
    );
    expect(result.useCaseCount).toBeGreaterThan(5);
    const saved = await mods.store.getProject(project.id);
    expect(saved.generationPreferences?.visionConnectionId).toBe(
      options.visionConnectionId,
    );
    await expect(
      mods.pipeline.runGeneration(recordingContext(project.id), project.id, {
        ...options,
        visionConnectionId: "conn_deleted1",
      }),
    ).rejects.toThrow(/no longer exists/);
  }, 120_000);
});

describe("unverifiable edit preservation", () => {
  it("enforces the saved local-only policy across all AI workflows and retains it in copies", async () => {
    const project = await demoProject();
    await mods.pipeline.runGeneration(
      recordingContext(project.id),
      project.id,
      options,
    );
    const cloud = await mods.settings.createConnection({
      name: "Synthetic cloud destination - never called",
      provider: "gemini",
      model: "fixture",
      apiKey: "synthetic-policy-key-114",
    });
    await mods.store.updateProject(project.id, { localOnly: true });
    const ctx = recordingContext(project.id);
    await expect(
      mods.pipeline.runGeneration(ctx, project.id, {
        ...options,
        visionConnectionId: cloud.id,
      }),
    ).rejects.toThrow(/local-only/);
    await expect(
      mods.pipeline.runGeneration(ctx, project.id, {
        ...options,
        textConnectionId: cloud.id,
      }),
    ).rejects.toThrow(/local-only/);
    await expect(
      mods.revise.runReviseUseCase(ctx, project.id, "UC-002", {
        instructions: "Synthetic change",
        connectionId: cloud.id,
      }),
    ).rejects.toThrow(/local-only/);
    const impact = await import("../graph/impact");
    await expect(
      impact.runImpactAnalysis(ctx, project.id, {
        connectionId: cloud.id,
        change: {
          targetKind: "free",
          description: "Synthetic change",
          source: "manual",
        },
      }),
    ).rejects.toThrow(/local-only/);
    await expect(
      impact.runScreenReanalysis(ctx, project.id, project.screens[0].id, {
        connectionId: cloud.id,
      }),
    ).rejects.toThrow(/local-only/);
    expect(ctx.usage.calls).toBe(0);
    const local = await mods.settings.createConnection({
      name: "Local fixture",
      provider: "ollama",
      model: "fixture",
      baseUrl: "http://127.0.0.1:11434",
    });
    const resolver = await import("./connections");
    const current = await mods.store.getProject(project.id);
    expect(
      (
        await resolver.resolveJobConnection(current, local.id, [], undefined, {
          modelId: "fixture",
        })
      ).connection.id,
    ).toBe(local.id);
    const copy = await (
      await import("../storage/projectLifecycle")
    ).duplicateProject(project.id);
    expect(copy.localOnly).toBe(true);
    await expect(
      mods.pipeline.runGeneration(
        recordingContext(project.id),
        project.id,
        options,
      ),
    ).resolves.toBeDefined();
  }, 120_000);

  it("retains an external edit made while model calls are running instead of committing over it", async () => {
    const project = await demoProject();
    await mods.pipeline.runGeneration(
      recordingContext(project.id),
      project.id,
      options,
    );
    const saved = await model(project.id);
    const current = await mods.store.getProject(project.id);
    const file = path.join(
      current.outputDir,
      ...saved.useCases[0].filePath!.split("/"),
    );
    const before = await fs.readFile(file, "utf8");
    duringCall = () =>
      fs.writeFile(file, before + "\nHuman change during processing.\n");
    try {
      await expect(
        mods.pipeline.runGeneration(recordingContext(project.id), project.id, {
          ...options,
          reuseScreenAnalyses: false,
        }),
      ).rejects.toThrow(/changed during generation/);
      expect(await fs.readFile(file, "utf8")).toBe(
        before + "\nHuman change during processing.\n",
      );
      expect(JSON.stringify(await model(project.id))).toBe(
        JSON.stringify(saved),
      );
      expect(await mods.runState.readCommitMarker(project.id)).toBeUndefined();
    } finally {
      duringCall = undefined;
    }
  }, 120_000);
  it("blocks missing saved routes for revision, impact and screen reanalysis even with an available default", async () => {
    const project = await demoProject();
    await mods.pipeline.runGeneration(
      recordingContext(project.id),
      project.id,
      options,
    );
    const current = await mods.store.getProject(project.id);
    current.generationPreferences = {
      ...options,
      visionConnectionId: "deleted-local-reader",
      textConnectionId: "deleted-local-writer",
    };
    await mods.store.saveProject(current);
    const impact = await import("../graph/impact");
    const ctx = recordingContext(project.id);
    await expect(
      mods.revise.runReviseUseCase(ctx, project.id, "UC-002", {
        instructions: "Synthetic change",
      }),
    ).rejects.toThrow(/No replacement provider/);
    await expect(
      impact.runImpactAnalysis(ctx, project.id, {
        change: {
          targetKind: "free",
          description: "Synthetic change",
          source: "manual",
        },
      }),
    ).rejects.toThrow(/No replacement provider/);
    await expect(
      impact.runScreenReanalysis(ctx, project.id, current.screens[0].id, {}),
    ).rejects.toThrow(/No replacement provider/);
    expect(ctx.usage.calls).toBe(0);
  }, 120_000);
  it.each([
    "missing",
    "malformed",
    "unreadable",
    "corrupt-model",
    "missing-model",
  ])(
    "stops before provider calls and leaves original bytes intact: %s",
    async (damage) => {
      const project = await demoProject();
      await mods.pipeline.runGeneration(
        recordingContext(project.id),
        project.id,
        options,
      );
      const current = await mods.store.getProject(project.id);
      const saved = await model(project.id);
      const file = path.join(
        current.outputDir,
        ...saved.useCases[0].filePath!.split("/"),
      );
      const { paths } = await import("../config");
      if (damage === "missing") await fs.rm(file);
      if (damage === "malformed")
        await fs.writeFile(
          file,
          "Human edit with broken required front matter. DO NOT REPLACE.",
        );
      if (damage === "unreadable") {
        await fs.rm(file);
        await fs.mkdir(file);
      }
      if (damage === "corrupt-model")
        await fs.writeFile(paths.modelFile(project.id), "{broken-human-data");
      if (damage === "missing-model") await fs.rm(paths.modelFile(project.id));
      const beforeModel = await fs
        .readFile(paths.modelFile(project.id), "utf8")
        .catch(() => null);
      const before =
        damage === "missing" || damage === "unreadable"
          ? undefined
          : await fs.readFile(file, "utf8");
      const ctx = recordingContext(project.id);
      await expect(
        mods.pipeline.runGeneration(ctx, project.id, options),
      ).rejects.toThrow();
      expect(ctx.usage.calls).toBe(0);
      expect(
        await fs
          .readFile(paths.modelFile(project.id), "utf8")
          .catch(() => null),
      ).toBe(beforeModel);
      if (before) expect(await fs.readFile(file, "utf8")).toBe(before);
      if (damage === "unreadable")
        expect((await fs.stat(file)).isDirectory()).toBe(true);
      await expect(
        mods.revise.runReviseUseCase(
          recordingContext(project.id),
          project.id,
          saved.useCases[0].id,
          { instructions: "Change it" },
        ),
      ).rejects.toThrow();
    },
    120_000,
  );
});

describe("re-generating next to an open impact report", () => {
  it("keeps an approved use case the report flagged stale, still flagged", async () => {
    const project = await demoProject();
    await mods.pipeline.runGeneration(
      recordingContext(project.id),
      project.id,
      options,
    );
    const before = await model(project.id);
    const target = before.useCases[1];
    const rule = target.businessRules.find((r) => r.rules.length)!;
    rule.rules[0] = `${rule.rules[0]} (BA wording)`;
    target.notes = "Approved by the product owner.";
    target.status = "stale";
    target.staleReason = "IR-20261015-abc123";
    await mods.store.saveModel(project.id, before);
    await mods.specs.rerenderSpecs(
      await mods.store.getProject(project.id),
      true,
    );
    const report = {
      id: "IR-20261015-abc123",
      projectId: project.id,
      createdAt: new Date().toISOString(),
      modelGeneratedAt: before.generatedAt,
      change: {
        targetKind: "free",
        description: "Customers may now order in NZD.",
        source: "manual",
      },
      deterministic: {
        seedNodeIds: [],
        directUseCaseIds: [],
        downstreamUseCaseIds: [],
        upstreamUseCaseIds: [],
        relatedUseCaseIds: [],
        affectedElementIds: [],
        affectedScreenIds: [],
      },
      items: [],
      summary: "",
      risks: [],
      suggestedNewUseCases: [],
      status: "analysed",
      analysedBy: "mock/demo",
      previousStatuses: { [target.id]: "approved" },
    } as unknown as ImpactReport;
    await mods.store.saveImpactReport(report);

    const ctx = recordingContext(project.id);
    await mods.pipeline.runGeneration(ctx, project.id, options);
    const kept = (await model(project.id)).useCases.find(
      (u) => u.id === target.id,
    )!;
    expect(kept).toMatchObject({
      status: "stale",
      staleReason: report.id,
      notes: "Approved by the product owner.",
      title: target.title,
    });
    expect(JSON.stringify(kept.businessRules)).toContain("(BA wording)");
    expect(
      ctx.logs.some(
        (l) =>
          l.message.startsWith(
            "Keeping 1 edited or approved use case unchanged",
          ) && l.message.includes(target.id),
      ),
    ).toBe(true);
  }, 120_000);
});

describe("writing the files fails half-way", () => {
  it("saves the generation, and a later run does not read the files it left behind as BA edits", async () => {
    const project = await demoProject();
    await mods.pipeline.runGeneration(
      recordingContext(project.id),
      project.id,
      options,
    );
    const out = (await mods.store.getProject(project.id)).outputDir;
    const readme = path.join(out, "README.md");
    await fs.rm(readme, { force: true });
    await fs.mkdir(readme); // EISDIR when the README is written

    const failed = recordingContext(project.id);
    const result = await mods.pipeline.runGeneration(failed, project.id, {
      ...options,
      granularity: "fine",
    });
    expect(
      warnings(failed).some((w) =>
        w.startsWith(
          "The specs were generated and saved, but the files could not all be written",
        ),
      ),
    ).toBe(true);
    const saved = await model(project.id);
    expect(saved.options.granularity).toBe("fine");
    expect(result.useCaseCount).toBe(saved.useCases.length);
    const marker = await mods.runState.readCommitMarker(project.id);
    expect(marker).toMatchObject({ generatedAt: saved.generatedAt });
    expect(marker?.failedAt).toBeTypeOf("number");

    // A file the failed run never reached still holds other content (old mtime) …
    const [leftover, edited] = saved.useCases
      .filter((u) => u.businessRules.some((r) => r.rules.length))
      .slice(0, 2);
    const leftoverFile = path.join(out, ...leftover.filePath!.split("/"));
    const leftoverRule = leftover.businessRules.find((r) => r.rules.length)!
      .rules[0];
    await fs.writeFile(
      leftoverFile,
      (await fs.readFile(leftoverFile, "utf8")).replace(
        `- ${leftoverRule}`,
        `- ${leftoverRule} (from the previous plan)`,
      ),
    );
    const old = new Date(marker!.failedAt! - 60_000);
    await fs.utimes(leftoverFile, old, old);
    // … while the BA really edited another one after the failure.
    const editedFile = path.join(out, ...edited.filePath!.split("/"));
    const editedRule = edited.businessRules.find((r) => r.rules.length)!
      .rules[0];
    await fs.writeFile(
      editedFile,
      (await fs.readFile(editedFile, "utf8")).replace(
        `- ${editedRule}`,
        `- ${editedRule} (BA edit)`,
      ),
    );
    await fs.rm(readme, { recursive: true });

    const next = recordingContext(project.id);
    await mods.pipeline.runGeneration(next, project.id, {
      ...options,
      granularity: "fine",
    });
    const after = await model(project.id);
    expect(after.useCases.find((u) => u.id === edited.id)).toMatchObject({
      status: "edited",
    });
    expect(
      JSON.stringify(
        after.useCases.find((u) => u.id === edited.id)!.businessRules,
      ),
    ).toContain("(BA edit)");
    expect(JSON.stringify(after.useCases)).not.toContain(
      "(from the previous plan)",
    );
    expect(
      after.useCases.filter((u) => u.status === "edited").map((u) => u.id),
    ).toEqual([edited.id]);
    expect(await mods.runState.readCommitMarker(project.id)).toBeUndefined();
    expect((await fs.stat(readme)).isFile()).toBe(true);
  }, 120_000);

  it("does not read the files back at all when the run stopped before its model was saved", async () => {
    const project = await demoProject();
    await mods.pipeline.runGeneration(
      recordingContext(project.id),
      project.id,
      options,
    );
    const saved = await model(project.id);
    await mods.runState.writeCommitMarker(project.id, {
      generatedAt: "2026-10-15T00:00:00.000Z",
      startedAt: Date.now(),
    });
    const out = (await mods.store.getProject(project.id)).outputDir;
    const file = path.join(out, ...saved.useCases[0].filePath!.split("/"));
    const rule = saved.useCases[0].businessRules.find((r) => r.rules.length)!
      .rules[0];
    await fs.writeFile(
      file,
      (await fs.readFile(file, "utf8")).replace(
        `- ${rule}`,
        `- ${rule} (unsaved plan)`,
      ),
    );

    const ctx = recordingContext(project.id);
    const before = await fs.readFile(file, "utf8");
    const beforeModel = JSON.stringify(await model(project.id));
    await expect(
      mods.pipeline.runGeneration(ctx, project.id, options),
    ).rejects.toThrow(/preserving human edits could not be verified/);
    expect(await fs.readFile(file, "utf8")).toBe(before);
    expect(JSON.stringify(await model(project.id))).toBe(beforeModel);
    expect(ctx.usage.calls).toBe(0);
    expect(await mods.runState.readCommitMarker(project.id)).toBeDefined();
  }, 120_000);
});

describe("carryOver", () => {
  const base = {
    screenIds: ["scr_login"],
    elementIds: [
      "login.email",
      "login.password",
      "login.sign_in",
      "login.remember",
    ],
  };
  const link = {
    system: "jira" as const,
    key: "ABC-12",
    url: "https://jira.example/browse/ABC-12",
    exportedAt: "2026-10-14T00:00:00.000Z",
    revision: 2,
  };

  it("continues a rephrased use case by its elements and keeps its tracker links", () => {
    const previous = [
      useCase("UC-001", {
        ...base,
        title: "Sign in with email and password",
        slug: "sign-in-with-email-and-password",
        external: [link],
        notes: "Keep",
        revision: 2,
      }),
    ];
    const now = [
      useCase("UC-001", {
        ...base,
        title: "Sign in with email & password",
        elementIds: [...base.elementIds, "login.show_password"],
      }),
    ];
    const { useCases, orphaned } = mods.pipeline.carryOver(now, previous);
    expect(useCases[0]).toMatchObject({
      external: [link],
      notes: "Keep",
      revision: 3,
    });
    expect(orphaned).toEqual([]);
  });

  it("lets each previous use case continue in one new use case only, and reports the ones nobody continues", () => {
    const previous = [
      useCase("UC-001", { ...base, title: "Sign in", external: [link] }),
      useCase("UC-002", {
        screenIds: ["scr_dash"],
        elementIds: ["dash.kpi"],
        title: "View metrics",
        external: [{ ...link, key: "ABC-13" }],
      }),
    ];
    const now = [
      useCase("UC-001", { ...base, title: "Sign in" }),
      useCase("UC-002", { ...base, title: "Sign in" }),
      useCase("UC-003", {
        screenIds: ["scr_orders"],
        elementIds: ["orders.table"],
        title: "Browse orders",
      }),
    ];
    const { useCases, orphaned } = mods.pipeline.carryOver(now, previous);
    expect(useCases.map((u) => u.external.map((x) => x.key))).toEqual([
      ["ABC-12"],
      [],
      [],
    ]);
    expect(orphaned.map((u) => u.id)).toEqual(["UC-002"]);
  });
});
