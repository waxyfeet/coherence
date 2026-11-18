/**
 * runExport against a mocked GitHub with in-memory storage: which items it touches and what it records.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExportRequest,
  ExternalLink,
  GitHubSettings,
  Project,
  SolutionModel,
} from "@shared/types";
import type { JobContext } from "../jobs/jobManager";
import { runExport } from "./exporter";
import { httpDefaults } from "./http";
import {
  mockFetch,
  sampleModel,
  sampleProject,
  sampleUseCase,
} from "./testUtils";

const store = vi.hoisted(() => ({
  project: undefined as unknown as Project,
  model: undefined as unknown as SolutionModel,
  settings: undefined as unknown,
}));

vi.mock("../storage/projectStore", () => ({
  getProject: async () => structuredClone(store.project),
  loadModel: async () => structuredClone(store.model),
  saveModel: async (_projectId: string, model: SolutionModel) => {
    store.model = structuredClone(model);
  },
  withProjectLock: async <T>(_projectId: string, fn: () => Promise<T>) => fn(),
}));
vi.mock("../storage/settingsStore", () => ({
  getIntegration: async () => structuredClone(store.settings),
}));
// This suite isolates routing/link decisions with in-memory domain storage.
// Durable journals and real registered project IO are covered by journal.test
// and exporter.transport.test; production must never bypass missing ownership.
vi.mock("./journal", () => ({ createExportJournal: async () => undefined }));
vi.mock("../specs/specStore", () => ({
  // No spec files on disk: content comes from the model and links are re-rendered (writeSpecs is a no-op).
  resolveSpecPath: (_project: Project, rel: string) =>
    `${process.cwd()}/.screenscribe-test/no-such-dir/${rel}`,
  writeSpecs: async () => undefined,
}));

const github: GitHubSettings = {
  owner: "acme",
  repo: "production",
  token: "tok",
  labels: [],
  apiBaseUrl: "https://api.github.com",
  useMilestonesForFeatures: false,
};

const request: ExportRequest = {
  target: "github",
  useCaseIds: ["UC-003"],
  dryRun: false,
  createFeatureParents: false,
  linkDependencies: true,
  updateExisting: true,
  includeStoryPoints: false,
};

function ghLink(repo: string, n: number): ExternalLink {
  return {
    system: "github",
    key: `#${n}`,
    url: `https://github.com/acme/${repo}/issues/${n}`,
    revision: 1,
    exportedAt: "2026-10-01T00:00:00.000Z",
  };
}

function fakeCtx() {
  const warnings: string[] = [];
  const infos: string[] = [];
  const ctx: JobContext = {
    jobId: "job_1",
    projectId: "acme",
    signal: new AbortController().signal,
    log: (_level, message) => infos.push(message),
    info: (message) => infos.push(message),
    warn: (message) => warnings.push(message),
    setStages: () => undefined,
    stage: () => undefined,
    progress: () => undefined,
    tick: () => undefined,
    addUsage: () => undefined,
    throwIfCancelled: () => undefined,
  };
  return { ctx, warnings, infos };
}

beforeEach(() => {
  httpDefaults.baseDelayMs = 0;
  store.project = sampleProject();
  store.settings = github;
});
afterEach(() => {
  vi.unstubAllGlobals();
  httpDefaults.baseDelayMs = 800;
});

describe("runExport — links from another target", () => {
  function modelWithSandboxLinks(): SolutionModel {
    return sampleModel([
      sampleUseCase({
        id: "UC-001",
        title: "Open the app",
        dependsOn: [],
        external: [ghLink("sandbox", 1)],
      }),
      sampleUseCase({ external: [ghLink("sandbox", 5)] }),
    ]);
  }

  it("creates a new issue instead of updating #5 of the newly configured repository", async () => {
    store.model = modelWithSandboxLinks();
    const { calls } = mockFetch([
      [
        /POST https:\/\/api\.github\.com\/repos\/acme\/production\/issues$/,
        {
          status: 201,
          json: {
            number: 77,
            html_url: "https://github.com/acme/production/issues/77",
          },
        },
      ],
    ]);
    const { ctx, warnings } = fakeCtx();
    const result = await runExport(ctx, "acme", request);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.github.com/repos/acme/production/issues",
    ]);
    expect(result.items).toMatchObject([
      { useCaseId: "UC-003", action: "created", key: "#77" },
    ]);
    expect(warnings.join("\n")).toContain(
      "UC-003 was exported to https://github.com/acme/sandbox/issues/5",
    );
    // UC-001's #1 lives in the sandbox repository, so it is not linked as a dependency here.
    expect(result.links).toMatchObject([
      { fromUseCaseId: "UC-003", toUseCaseId: "UC-001", ok: false },
    ]);
    expect(
      store.model.useCases.find((u) => u.id === "UC-003")?.external,
    ).toEqual([
      expect.objectContaining({
        key: "#77",
        url: "https://github.com/acme/production/issues/77",
      }),
    ]);
  });

  it("reports would-create in a dry run", async () => {
    store.model = modelWithSandboxLinks();
    const { calls } = mockFetch([]);
    const result = await runExport(fakeCtx().ctx, "acme", {
      ...request,
      dryRun: true,
    });
    expect(calls).toHaveLength(0);
    expect(result.items).toMatchObject([
      { useCaseId: "UC-003", action: "would-create" },
    ]);
    expect(result.items[0].key).toBeUndefined();
  });

  it("still updates an issue of the configured repository", async () => {
    store.model = sampleModel([
      sampleUseCase({
        id: "UC-001",
        title: "Open the app",
        dependsOn: [],
        external: [ghLink("Production", 1)],
      }),
      sampleUseCase({ external: [ghLink("production", 5)] }),
    ]);
    const { calls } = mockFetch([
      [
        /GET .*\/repos\/acme\/production\/issues\/5$/,
        {
          json: {
            number: 5,
            html_url: "https://github.com/acme/production/issues/5",
            labels: [],
          },
        },
      ],
      [
        /PATCH .*\/repos\/acme\/production\/issues\/5$/,
        {
          json: {
            number: 5,
            html_url: "https://github.com/acme/production/issues/5",
          },
        },
      ],
    ]);
    const result = await runExport(fakeCtx().ctx, "acme", request);
    expect(result.items).toMatchObject([
      { useCaseId: "UC-003", action: "updated", key: "#5" },
    ]);
    expect(result.links).toEqual([
      { fromUseCaseId: "UC-003", toUseCaseId: "UC-001", ok: true },
    ]);
    expect((calls.at(-1)?.body as { body: string }).body).toContain(
      "**Depends on:** #1 (UC-001)",
    );
  });
});

describe("runExport — recorded revision", () => {
  it("records the revision that was sent when the use case is saved during the export", async () => {
    store.model = sampleModel([
      sampleUseCase({ id: "UC-001", dependsOn: [] }),
      sampleUseCase(),
    ]);
    mockFetch([
      [
        /POST .*\/issues$/,
        () => {
          // The BA saves UC-003 while its issue is being created.
          const uc = store.model.useCases.find((u) => u.id === "UC-003")!;
          uc.revision = 3;
          return {
            status: 201,
            json: {
              number: 12,
              html_url: "https://github.com/acme/production/issues/12",
            },
          };
        },
      ],
    ]);
    const { ctx, infos } = fakeCtx();
    await runExport(ctx, "acme", { ...request, linkDependencies: false });
    const uc = store.model.useCases.find((u) => u.id === "UC-003")!;
    expect(uc.revision).toBe(3);
    expect(uc.external).toEqual([
      expect.objectContaining({ key: "#12", revision: 2 }),
    ]);
    expect(infos.join("\n")).toContain(
      "UC-003 was edited while it was being exported",
    );
  });
});
