import { authenticatedTestApp } from "../security/authTestUtils";
let authenticated: Awaited<ReturnType<typeof authenticatedTestApp>>;
/**
 * HTTP test of the routes backed by the spec store, graph, impact (offline mock) and CSV export, against a
 * project whose solution model is written directly (no generation run — that belongs to the agents).
 */
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  JobStarted,
  RerenderResult,
  SaveSpecFileResponse,
  SearchHit,
  SpecFileContent,
  SyncResult,
} from "@shared/api";
import type {
  DeterministicImpact,
  ImpactReport,
  Job,
  Project,
  SolutionGraph,
  SolutionModel,
  SpecFileNode,
  UseCase,
} from "@shared/types";
import { fixtureModel } from "../graph/testFixtures";
import { makePng, removeDir, useTempDataDir } from "../storage/testUtils";

type Jobs = typeof import("../jobs/jobManager");
type Store = typeof import("../storage/projectStore");

let dataDir: string;
let server: http.Server;
let base: string;
let jobs: Jobs;
let store: Store;
let project: Project;

const H = { "X-ScreenScribe": "1" };

async function api<T>(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: T; headers: Headers }> {
  const init: RequestInit = { method, headers: { ...H } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] =
      "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await authenticated.fetch(`${base}${url}`, init);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

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

beforeAll(async () => {
  dataDir = await useTempDataDir("spec-routes");
  for (const k of [
    "SCREENSCRIBE_V2_ANTHROPIC_API_KEY",
    "SCREENSCRIBE_V2_OPENAI_API_KEY",
    "SCREENSCRIBE_V2_GEMINI_API_KEY",
  ])
    delete process.env[k];
  vi.resetModules();
  const { createApp } = await import("../app");
  store = await import("../storage/projectStore");
  jobs = await import("../jobs/jobManager");
  const structured = await import("../llm/structured");
  structured.configureLLMRuntime({ mockDelayMs: 0 });
  await store.ensureDataDirs();
  authenticated = await authenticatedTestApp();
  server = http.createServer(authenticated.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  authenticated.authenticate(base);

  const created = await store.createProject({
    name: "Routes project",
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
  project = await store.getProject(created.id);
  for (const s of project.screens) s.analysedVersion = s.version;
  await store.saveProject(project);
  await store.saveModel(project.id, remapModel(project));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await removeDir(dataDir);
});

describe("spec file routes", () => {
  const ucPath = (id: string, model: SolutionModel) =>
    model.useCases.find((u) => u.id === id)!.filePath!;

  it("re-renders, lists, reads, saves, searches and syncs", async () => {
    const pid = project.id;
    const rerender = await api<RerenderResult>(
      "POST",
      `/api/projects/${pid}/rerender`,
      { force: true },
    );
    expect(rerender.status).toBe(200);
    expect(rerender.body.fileCount).toBeGreaterThan(10);

    const tree = await api<SpecFileNode>("GET", `/api/projects/${pid}/files`);
    expect(tree.body.children!.map((c) => c.name)).toContain("use-cases");

    const model = (
      await api<SolutionModel>("GET", `/api/projects/${pid}/model`)
    ).body;
    const rel = ucPath("UC-001", model);
    const file = await api<SpecFileContent>(
      "GET",
      `/api/projects/${pid}/files/content?path=${encodeURIComponent(rel)}`,
    );
    expect(file.body.useCaseId).toBe("UC-001");

    const edited = file.body.content.replace(
      "- Minimum 8 characters",
      "- Minimum 12 characters",
    );
    const saved = await api<SaveSpecFileResponse>(
      "PUT",
      `/api/projects/${pid}/files/content`,
      { path: rel, content: edited, baseMtimeMs: file.body.mtimeMs },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.diff?.changedSections).toContain("rules");
    const stale = await api<{ code: string }>(
      "PUT",
      `/api/projects/${pid}/files/content`,
      { path: rel, content: edited, baseMtimeMs: 1 },
    );
    expect(stale.status).toBe(409);

    const hits = await api<SearchHit[]>(
      "GET",
      `/api/projects/${pid}/search?q=${encodeURIComponent("minimum 12")}`,
    );
    expect(hits.status).toBe(200);
    expect(
      hits.body.some((h) => h.path === rel && h.useCaseId === "UC-001"),
    ).toBe(true);
    expect(
      (await api<SearchHit[]>("GET", `/api/projects/${pid}/search?q=a`)).body,
    ).toEqual([]);
    expect(
      (await api<SearchHit[]>("GET", `/api/projects/${pid}/search`)).body,
    ).toEqual([]);

    const sync = await api<SyncResult>("POST", `/api/projects/${pid}/sync`, {});
    expect(sync.status).toBe(200);
    expect(sync.body.missingFiles).toEqual([]);

    const raw = await authenticated.fetch(
      `${base}/api/projects/${pid}/files/raw?path=screens/images/login.png`,
    );
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("image/png");
    expect(
      (
        await api(
          "GET",
          `/api/projects/${pid}/files/raw?path=${encodeURIComponent("../project.json")}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await api(
          "GET",
          `/api/projects/${pid}/files/content?path=${encodeURIComponent("C:\\Windows\\win.ini")}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (await api("GET", `/api/projects/${pid}/files/content`)).status,
    ).toBe(400);
  });

  it("changes a use case status and serves the graph, preview and CSV", async () => {
    const pid = project.id;
    const status = await api<UseCase>(
      "PATCH",
      `/api/projects/${pid}/use-cases/UC-002/status`,
      { status: "approved" },
    );
    expect(status.status).toBe(200);
    expect(status.body.status).toBe("approved");
    expect(
      (
        await api("PATCH", `/api/projects/${pid}/use-cases/UC-999/status`, {
          status: "approved",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api("PATCH", `/api/projects/${pid}/use-cases/UC-002/status`, {
          status: "done",
        })
      ).status,
    ).toBe(400);

    const graph = await api<SolutionGraph>("GET", `/api/projects/${pid}/graph`);
    expect(
      graph.body.nodes.some((n) => n.id === "UC-001" && n.kind === "usecase"),
    ).toBe(true);

    const preview = await api<DeterministicImpact>(
      "POST",
      `/api/projects/${pid}/impact/preview`,
      {
        targetKind: "element",
        targetId: "login.password",
        description: "Minimum length becomes 12",
        source: "manual",
      },
    );
    expect(preview.status).toBe(200);
    expect(preview.body.directUseCaseIds).toEqual(["UC-001"]);
    expect(preview.body.downstreamUseCaseIds).toEqual(
      expect.arrayContaining(["UC-003", "UC-004"]),
    );

    // The change dialog traces a concrete target before the BA has typed a description.
    const earlyPreview = await api<DeterministicImpact>(
      "POST",
      `/api/projects/${pid}/impact/preview`,
      {
        targetKind: "usecase",
        targetId: "UC-001",
        description: "",
        source: "manual",
      },
    );
    expect(earlyPreview.status).toBe(200);
    expect(earlyPreview.body.directUseCaseIds).toEqual(["UC-001"]);
    // Starting a real analysis still needs a description.
    const noDescription = await api("POST", `/api/projects/${pid}/impact`, {
      change: {
        targetKind: "usecase",
        targetId: "UC-001",
        description: "",
        source: "manual",
      },
    });
    expect(noDescription.status).toBe(400);

    const csv = await authenticated.fetch(
      `${base}/api/projects/${pid}/export/csv?useCaseIds=UC-001,UC-002`,
    );
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.headers.get("content-disposition")).toMatch(/attachment/);
    const text = await csv.text();
    expect(text.split("\n")[0]).toContain("ID,Title");
    expect(text).toContain("UC-002");

    const exportPreview = await api<{ error: string }>(
      "GET",
      `/api/projects/${pid}/export/preview?target=jira&useCaseId=UC-001`,
    );
    expect(exportPreview.status).toBe(400);
    expect(exportPreview.body.error).toMatch(/Jira/);
  });

  it("refuses status changes and file saves while a generation is running", async () => {
    const pid = project.id;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = await jobs.startJob("generate", pid, async () => gate);
    try {
      const status = await api<{ code: string }>(
        "PATCH",
        `/api/projects/${pid}/use-cases/UC-002/status`,
        { status: "generated" },
      );
      expect(status.status).toBe(409);
      const save = await api<{ code: string; error: string }>(
        "PUT",
        `/api/projects/${pid}/files/content`,
        { path: "notes/x.md", content: "x" },
      );
      expect(save.status).toBe(409);
      expect(save.body.error).toMatch(/save changes to the spec files/);
      // Read-only routes keep working.
      expect(
        (await api("GET", `/api/projects/${pid}/search?q=sign`)).status,
      ).toBe(200);
    } finally {
      release();
      await jobs.waitForJob(job.id);
    }
  });

  it("runs an offline impact analysis that marks use cases stale in the front matter only, then discards it", async () => {
    const pid = project.id;
    const model = (
      await api<SolutionModel>("GET", `/api/projects/${pid}/model`)
    ).body;
    // A BA edit on disk that was never synced must survive the stale marking.
    const relDownstream = ucPath("UC-003", model);
    const absDownstream = path.join(
      project.outputDir,
      ...relDownstream.split("/"),
    );
    await fs.appendFile(absDownstream, "\n<!-- unsynced BA note -->\n");

    const started = await api<JobStarted>(
      "POST",
      `/api/projects/${pid}/impact`,
      {
        change: {
          targetKind: "element",
          targetId: "login.password",
          description: "Password minimum length becomes 12 characters",
          source: "manual",
        },
      },
    );
    expect(started.status).toBe(202);
    const job = (await jobs.waitForJob(
      started.body.jobId,
    )) as Job<ImpactReport>;
    expect(job.status, job.error).toBe("succeeded");
    const report = job.result!;
    expect(report.items.find((i) => i.useCaseId === "UC-001")?.relation).toBe(
      "direct",
    );

    const list = await api<ImpactReport[]>(
      "GET",
      `/api/projects/${pid}/impact`,
    );
    expect(list.body[0].id).toBe(report.id);
    const after = (
      await api<SolutionModel>("GET", `/api/projects/${pid}/model`)
    ).body;
    const marked = Object.keys(report.previousStatuses);
    expect(marked.length).toBeGreaterThan(0);
    for (const id of marked) {
      const uc = after.useCases.find((u) => u.id === id)!;
      expect(uc.status).toBe("stale");
      const md = await fs.readFile(
        path.join(project.outputDir, ...uc.filePath!.split("/")),
        "utf8",
      );
      expect(md).toMatch(/\nstatus: stale\b/);
      expect(md).toContain(`staleReason: ${report.id}`);
    }
    expect(await fs.readFile(absDownstream, "utf8")).toContain(
      "<!-- unsynced BA note -->",
    );

    const discarded = await api<ImpactReport>(
      "POST",
      `/api/projects/${pid}/impact/${report.id}/discard`,
      {},
    );
    expect(discarded.status).toBe(200);
    expect(discarded.body.status).toBe("discarded");
    const restored = (
      await api<SolutionModel>("GET", `/api/projects/${pid}/model`)
    ).body;
    for (const id of marked) {
      expect(restored.useCases.find((u) => u.id === id)!.status).toBe(
        report.previousStatuses[id],
      );
    }
    expect(await fs.readFile(absDownstream, "utf8")).toContain(
      "<!-- unsynced BA note -->",
    );
    expect(
      (await api("POST", `/api/projects/${pid}/impact/${report.id}/apply`, {}))
        .status,
    ).toBe(400);
    expect(
      (await api("GET", `/api/projects/${pid}/impact/IR-20990101-nope00`))
        .status,
    ).toBe(404);
  });
});
