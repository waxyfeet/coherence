import fs from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Job } from "@shared/types";
import { removeDir, useTempDataDir } from "../storage/testUtils";

// Deliberately not registered in the current-secret registry: these are retired historical values.
const markers = ["synthetic-retired-export-key-718", "PRIVATE-EXPORT-ECHO-918"];
const failure = markers.join(" ");
const markdown =
  "Human-approved rule and exact UI label\n".repeat(400) + "LATE_HUMAN_EDIT";
const result = () => ({
  target: "github",
  dryRun: false,
  items: [
    {
      useCaseId: "UC-001",
      title: "Keep title",
      action: "failed",
      key: "#17",
      url: "https://github.com/fixture/fixture/issues/17",
      error: failure,
    },
  ],
  parents: [
    {
      featureId: "FG-001",
      name: "Keep name",
      action: "failed",
      key: "#3",
      error: failure,
    },
  ],
  links: [
    {
      fromUseCaseId: "UC-001",
      toUseCaseId: "UC-002",
      ok: false,
      error: failure,
    },
  ],
});
function safe(value: unknown): void {
  // Boolean assertions cannot print the original record on failure.
  expect(
    markers.every((marker) => !JSON.stringify(value).includes(marker)),
  ).toBe(true);
}

let dir: string;
let server: Server;
let base: string;
let pid: string;
let auth: Awaited<
  ReturnType<typeof import("./authTestUtils").authenticatedTestApp>
>;
let jobs: typeof import("../jobs/jobManager");
let clean: typeof import("./legacyDiagnostics").cleanLegacyDiagnostics;
let folder: string;
let trashFolder: string;

beforeAll(async () => {
  dir = await useTempDataDir("historical-export-errors");
  vi.resetModules();
  const store = await import("../storage/projectStore");
  await store.ensureDataDirs();
  pid = (
    await store.createProject({
      name: "Synthetic export history",
      description: "",
    })
  ).id;
  folder = (await store.getProject(pid)).projectPath!;
  const trash = await store.createProject({
    name: "Synthetic Trash diagnostics",
    description: "",
  });
  await store.deleteProject(trash.id);
  trashFolder = (await import("../storage/projectRegistry")).registryEntry(
    trash.id,
  ).root;
  await fs.mkdir(path.join(folder, "jobs"), { recursive: true });
  jobs = await import("../jobs/jobManager");
  clean = (await import("./legacyDiagnostics")).cleanLegacyDiagnostics;
  auth = await (await import("./authTestUtils")).authenticatedTestApp();
  await new Promise<void>((resolve) => {
    server = auth.app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  auth.authenticate(base);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(async () => {
  await jobs?.cancelAllJobs();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  vi.restoreAllMocks();
  await removeDir(dir);
});
function record(id: string, diagnosticsVersion?: number): Job {
  return {
    id,
    projectId: pid,
    kind: "export",
    diagnosticsVersion,
    status: "succeeded",
    createdAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:01:00Z",
    logs: diagnosticsVersion
      ? [
          {
            at: "2026-01-01",
            level: "info",
            message: "3 export attempts recorded",
          },
        ]
      : [],
    progress: {
      stage: "Export complete",
      stageIndex: 0,
      stageCount: 1,
      current: 3,
      total: 3,
    },
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    result: result(),
  };
}
async function response(url: string): Promise<string> {
  const res = await auth.fetch(base + "/api" + url);
  expect(res.status).toBe(200);
  const text = await res.text();
  safe(text);
  return text;
}
async function assertApis(id: string): Promise<void> {
  const detail = JSON.parse(await response(`/jobs/${id}`)) as Job<
    ReturnType<typeof result>
  >;
  expect(detail.result?.items[0].key).toBe("#17");
  expect(detail.result?.parents[0].key).toBe("#3");
  expect(detail.result?.links[0].ok).toBe(false);
  expect(detail.result?.items[0].title).toBe("Keep title");
  expect(detail.result?.parents[0].name).toBe("Keep name");
  const list = JSON.parse(await response(`/projects/${pid}/jobs`)) as Job[];
  expect(list.some((job) => job.id === id)).toBe(true);
  expect(await response(`/jobs/${id}/events`)).toContain('"type":"snapshot"');
}

describe("S05-V1 export diagnostic boundaries", () => {
  it.each([undefined, 1, 2])(
    "protects detail/list/finished SSE before and after cleanup for version %s",
    async (version) => {
      const id = `job_export${version ?? "old"}123`;
      const file = path.join(folder, "jobs", id + ".json");
      const original = record(id, version);
      await fs.writeFile(file, JSON.stringify(original));
      await assertApis(id);
      if (version === 2) {
        // Current-format read protection must not rely solely on a migration marker.
        safe(await jobs.getJob(id));
      } else {
        await clean();
        const bytes = await fs.readFile(file, "utf8");
        safe(bytes);
        const rewritten = JSON.parse(bytes);
        expect(rewritten.diagnosticsVersion).toBe(2);
        if (version === 1) expect(rewritten.logs).toEqual(original.logs);
        await assertApis(id);
        const stable = await fs.readFile(file, "utf8");
        expect(await clean()).toEqual({ cleaned: 0, unreadable: 0 });
        expect((await fs.readFile(file, "utf8")) === stable).toBe(true);
      }
    },
  );

  it.each([undefined, 1])(
    "preserves long proposals, approved bytes, uncertain IDs and trash while cleaning journal version %s",
    async (version) => {
      const id = "job_revision123";
      const proposal: Job = {
        ...record(id, 1),
        kind: "revise",
        result: { proposedMarkdown: markdown },
      };
      const journal = {
        diagnosticsVersion: version,
        id: "export_history123",
        projectId: pid,
        jobId: id,
        target: "github",
        targetFingerprint: "same-target",
        createdAt: "2026-01-01",
        operations: [
          {
            key: "item:UC-001",
            kind: "item",
            state: "uncertain",
            startedAt: "2026-01-01",
            result: {
              remoteId: "remote-17",
              ref: {
                key: "#17",
                url: "https://github.com/fixture/fixture/issues/17",
              },
            },
            error: failure,
          },
          {
            key: "links:UC-001",
            kind: "links",
            state: "complete",
            startedAt: "2026-01-01",
            result: [{ toUseCaseId: "UC-002", ok: false, error: failure }],
          },
        ],
      };
      for (const root of [folder, trashFolder]) {
        for (const sub of ["jobs", "export-journal"])
          await fs.mkdir(path.join(root, sub), { recursive: true });
        await fs.writeFile(
          path.join(root, "jobs", id + ".json"),
          JSON.stringify(proposal),
        );
        await fs.writeFile(
          path.join(root, "jobs", "job_trashexport123.json"),
          JSON.stringify(record("job_trashexport123", 1)),
        );
        await fs.writeFile(
          path.join(root, "export-journal", journal.id + ".json"),
          JSON.stringify(journal),
        );
      }
      await fs.mkdir(path.join(folder, "specs"), { recursive: true });
      const spec = path.join(folder, "specs", "approved.md");
      const model = path.join(folder, "model.json");
      await fs.writeFile(spec, markdown);
      await fs.writeFile(
        model,
        JSON.stringify({ humanNotes: markdown, approved: true }),
      );
      const before = [await fs.readFile(spec), await fs.readFile(model)];
      safe(await response(`/projects/${pid}/export/journal`));
      expect((await jobs.getJob(id)).result).toEqual({
        proposedMarkdown: markdown,
      });
      await clean();
      for (const root of [folder, trashFolder]) {
        safe(
          await fs.readFile(
            path.join(root, "jobs", "job_trashexport123.json"),
            "utf8",
          ),
        );
        const j = JSON.parse(
          await fs.readFile(
            path.join(root, "export-journal", journal.id + ".json"),
            "utf8",
          ),
        );
        safe(j);
        expect(j.operations[0].state).toBe("uncertain");
        expect(j.operations[0].key).toBe("item:UC-001");
        expect(j.operations[0].result).toEqual(journal.operations[0].result);
        expect(j.operations[1].result[0].ok).toBe(false);
        expect(j.operations[1].result[0].toUseCaseId).toBe("UC-002");
        expect(
          JSON.parse(
            await fs.readFile(path.join(root, "jobs", id + ".json"), "utf8"),
          ).result.proposedMarkdown === markdown,
        ).toBe(true);
      }
      safe(await response(`/projects/${pid}/export/journal`));
      expect(
        JSON.parse(await response(`/jobs/${id}`)).result.proposedMarkdown ===
          markdown,
      ).toBe(true);
      expect(await response(`/jobs/${id}/events`)).toContain("LATE_HUMAN_EDIT");
      expect((await fs.readFile(spec)).equals(before[0])).toBe(true);
      expect((await fs.readFile(model)).equals(before[1])).toBe(true);
      expect(await clean()).toEqual({ cleaned: 0, unreadable: 0 });
    },
  );

  it("sanitizes live completion events, snapshots and disk without disclosing runner error prose", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = await jobs.startJob("export", pid, async () => {
      await gate;
      return result();
    });
    const stream = await auth.fetch(`${base}/api/jobs/${started.id}/events`);
    expect(stream.status).toBe(200);
    const text = stream.text();
    release();
    const finished = await jobs.waitForJob(started.id);
    safe(finished);
    const events = await text;
    safe(events);
    expect(events).toContain('"type":"status","status":"succeeded"');
    safe(
      await fs.readFile(
        path.join(folder, "jobs", started.id + ".json"),
        "utf8",
      ),
    );
    await assertApis(started.id);
  });

  it("writes safe link journal results and retains reconciliation identity without remote calls", async () => {
    const journal = await (
      await import("../export/journal")
    ).createExportJournal(
      pid,
      "job_currentjournal",
      "github",
      "isolated-target",
    );
    await journal!.operation("links:synthetic", "links", async () => [
      { toUseCaseId: "UC-002", ok: false, error: failure },
    ]);
    safe(
      await fs.readFile(
        path.join(folder, "export-journal", journal!.record.id + ".json"),
        "utf8",
      ),
    );
    safe(await response(`/projects/${pid}/export/journal`));
  });

  it("fails cleanup safely on a version-1 export write failure while read protection remains effective", async () => {
    const id = "job_writefailure123";
    const file = path.join(folder, "jobs", id + ".json");
    await fs.writeFile(file, JSON.stringify(record(id, 1)));
    const before = await fs.readFile(file);
    const utils = await import("../storage/fsUtils");
    const failed = vi
      .spyOn(utils, "writeJsonAtomic")
      .mockRejectedValue(new Error("Synthetic cleanup write failure"));
    try {
      await expect(clean()).rejects.toThrow("Synthetic cleanup write failure");
      expect((await fs.readFile(file)).equals(before)).toBe(true);
      await assertApis(id);
    } finally {
      failed.mockRestore();
    }
    await clean();
    safe(await fs.readFile(file, "utf8"));
  });

  it.each([
    "HTTP 401 " + failure,
    "HTTP 429 " + failure,
    "TLS certificate " + failure,
    failure,
  ])("uses stable fixed current error categories (%#)", async (error) => {
    const { safeJobDiagnostics } = await import("./jobDiagnostics");
    const raw = record("job_categories123", 2);
    (raw.result as ReturnType<typeof result>).items[0].error = error;
    const once = safeJobDiagnostics(raw);
    safe(once);
    expect(
      JSON.stringify(safeJobDiagnostics(once)) === JSON.stringify(once),
    ).toBe(true);
  });
});
