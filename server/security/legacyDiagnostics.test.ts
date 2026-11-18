import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDataDir, removeDir } from "../storage/testUtils";
import type { Job } from "@shared/types";

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await removeDir(dir);
});
const retired = "retired-plain-fixture-credential-839";
const privateEcho = "CONFIDENTIAL-RESPONSE-EXCERPT-NO-LONGER-SAFE";
const proposal =
  "Human-reviewed content\n".repeat(500) + "IMPORTANT_LATE_CHANGE";
const legacyJob = (projectId = "synthetic-project"): Job => ({
  ...{ rawProviderResponse: privateEcho },
  id: "job_legacy123",
  projectId,
  kind: "revise",
  status: "succeeded",
  createdAt: "2026-01-01",
  progress: {
    stage: privateEcho,
    label: retired,
    current: 1,
    total: 1,
    stageIndex: 0,
    stageCount: 1,
  },
  logs: [
    { at: "2026-01-01", level: "error", message: `${retired} ${privateEcho}` },
  ],
  usage: { calls: 1, inputTokens: 2, outputTokens: 3 },
  result: { proposedMarkdown: proposal },
  error: `${retired} ${privateEcho}`,
});

async function currentProject(label: string) {
  const dir = await useTempDataDir(label);
  dirs.push(dir);
  vi.resetModules();
  const store = await import("../storage/projectStore");
  const project = await store.createProject({
    name: "Synthetic diagnostics",
    description: "Synthetic",
  });
  return { dir, store, project, root: project.projectPath! };
}
describe("S05 historical diagnostics in the supported project format", () => {
  it("does not follow diagnostic-folder junctions into unrelated content", async () => {
    const { dir, project, root } = await currentProject("diagnostic-junction");
    await (
      await import("../storage/projectRegistry")
    ).releaseProjectPins(project.id);
    await fs.rmdir(path.join(root, "jobs"));
    const source = path.join(dir, "preserved");
    await fs.mkdir(source);
    const bytes = JSON.stringify(legacyJob(project.id)),
      file = path.join(source, "job_legacy123.json");
    await fs.writeFile(file, bytes);
    await fs.symlink(source, path.join(root, "jobs"), "junction");
    expect(
      await (await import("./legacyDiagnostics")).cleanLegacyDiagnostics(),
    ).toEqual({ cleaned: 0, unreadable: 1 });
    expect(await fs.readFile(file, "utf8")).toBe(bytes);
  });
  it("scrubs old diagnostics in registered active and Trash roots without truncating proposals or human files", async () => {
    const { store, project, root } = await currentProject("diagnostic-history");
    const other = await store.createProject({
      name: "Trash diagnostic fixture",
      description: "Synthetic",
    });
    await store.deleteProject(other.id);
    const trash = (await import("../storage/projectRegistry")).registryEntry(
      other.id,
    ).root;
    const io = await import("../storage/fsUtils");
    for (const [at, id] of [
      [root, project.id],
      [trash, other.id],
    ]) {
      await io.writeJsonAtomic(
        path.join(at, "jobs", "job_legacy123.json"),
        legacyJob(id),
      );
      await io.writeJsonAtomic(
        path.join(at, "export-journal", "export_legacy123.json"),
        {
          id: "export_legacy123",
          projectId: id,
          jobId: "job_legacy123",
          target: "github",
          targetFingerprint: "same-target",
          createdAt: "2026-01-01",
          operations: [
            {
              key: "same-operation",
              kind: "item",
              state: "uncertain",
              startedAt: "2026-01-01",
              result: { remoteId: "synthetic-remote-42" },
              error: retired + " " + privateEcho,
            },
          ],
        },
      );
    }
    const untouched = path.join(root, "specs", "approved.md");
    await fs.mkdir(path.dirname(untouched));
    await fs.writeFile(untouched, proposal);
    const safe = await (
      await import("../jobs/jobManager")
    ).getJob("job_legacy123");
    expect(JSON.stringify(safe)).not.toContain(retired);
    expect((safe.result as { proposedMarkdown: string }).proposedMarkdown).toBe(
      proposal,
    );
    const { cleanLegacyDiagnostics } = await import("./legacyDiagnostics");
    expect(await cleanLegacyDiagnostics()).toEqual({
      cleaned: 4,
      unreadable: 0,
    });
    for (const at of [root, trash])
      for (const rel of [
        "jobs/job_legacy123.json",
        "export-journal/export_legacy123.json",
      ]) {
        const bytes = await fs.readFile(path.join(at, rel), "utf8");
        expect(bytes).not.toContain(retired);
        expect(bytes).not.toContain(privateEcho);
        const record = JSON.parse(bytes);
        expect(record.diagnosticsVersion).toBe(2);
        if (record.result)
          expect(record.result.proposedMarkdown).toBe(proposal);
        else
          expect(record.operations[0]).toMatchObject({
            state: "uncertain",
            result: { remoteId: "synthetic-remote-42" },
          });
      }
    expect(await fs.readFile(untouched, "utf8")).toBe(proposal);
    expect(await cleanLegacyDiagnostics()).toEqual({
      cleaned: 0,
      unreadable: 0,
    });
  });
  it("fails safely on a diagnostic write error without altering the original proposal", async () => {
    const { project, root } = await currentProject("diagnostic-failure");
    const io = await import("../storage/fsUtils"),
      file = path.join(root, "jobs", "job_legacy123.json");
    await io.writeJsonAtomic(file, legacyJob(project.id));
    const before = await fs.readFile(file);
    vi.spyOn(io, "writeJsonAtomic").mockRejectedValue(
      new Error("Synthetic disk failure"),
    );
    await expect(
      (await import("./legacyDiagnostics")).cleanLegacyDiagnostics(),
    ).rejects.toThrow(/disk failure/);
    expect(await fs.readFile(file)).toEqual(before);
  });
  it("quarantines damaged diagnostic records without rewriting private content", async () => {
    const { root } = await currentProject("diagnostic-damaged"),
      file = path.join(root, "jobs", "job_damaged123.json");
    await fs.writeFile(file, '{"broken":');
    expect(
      await (await import("./legacyDiagnostics")).cleanLegacyDiagnostics(),
    ).toEqual({ cleaned: 0, unreadable: 1 });
    expect(await fs.readFile(file, "utf8")).toBe('{"broken":');
  });
});

describe("S05 diagnostic redaction context lifetime", () => {
  it("redacts quoted JSON fields and encoded current keys without keeping retired credentials indefinitely", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const d = await import("./diagnostics");
    const credential = "synthetic/active+credential=928";
    d.rememberSecret(credential);
    const safe = d.redactDiagnostic(
      JSON.stringify({
        apiKey: "unregistered-fixture-key",
        client_secret: "unregistered-fixture-secret",
        token: "unregistered-fixture-token",
      }) +
        " " +
        encodeURIComponent(credential),
    );
    for (const marker of [
      "unregistered-fixture-key",
      "unregistered-fixture-secret",
      "unregistered-fixture-token",
      encodeURIComponent(credential),
    ])
      expect(safe).not.toContain(marker);
    await vi.advanceTimersByTimeAsync(d.DIAGNOSTIC_SECRET_TTL_MS + 60_001);
    expect(d.redactDiagnostic(credential)).toBe(credential);
    d.rememberSecret(credential);
    expect(d.redactDiagnostic(credential)).toBe("[redacted]");
  });
  it("bounds remembered credentials under repeated synthetic key rotation", async () => {
    vi.resetModules();
    const d = await import("./diagnostics");
    const first = "synthetic-retirement-first-839";
    d.rememberSecret(first);
    for (let i = 0; i < d.DIAGNOSTIC_SECRET_LIMIT; i++)
      d.rememberSecret(`synthetic-rotation-value-${i}-last`);
    expect(d.redactDiagnostic(first)).toBe(first);
    expect(
      d.redactDiagnostic(
        `synthetic-rotation-value-${d.DIAGNOSTIC_SECRET_LIMIT - 1}-last`,
      ),
    ).toBe("[redacted]");
  });
  it("leaves records written by a newer version exactly as they are (installer review ST-07)", async () => {
    const { project, root } = await currentProject("diagnostic-newer");
    const io = await import("../storage/fsUtils");
    const file = path.join(root, "jobs", "job_newer123.json");
    await io.writeJsonAtomic(file, {
      ...legacyJob(project.id),
      id: "job_newer123",
      diagnosticsVersion: 3,
      fieldFromTheFuture: { keep: true },
    });
    const before = await fs.readFile(file, "utf8");
    expect(
      await (await import("./legacyDiagnostics")).cleanLegacyDiagnostics(),
    ).toEqual({ cleaned: 0, unreadable: 0 });
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });
});
