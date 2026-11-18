import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobEvent } from "@shared/types";
import { removeDir, useTempDataDir } from "../storage/testUtils";

type Jobs = typeof import("./jobManager");
type Store = typeof import("../storage/projectStore");
type Errors = typeof import("../errors");
type Config = typeof import("../config");

let dataDir: string;
let jobs: Jobs;
let store: Store;
let errors: Errors;
let cfg: Config;

beforeAll(async () => {
  dataDir = await useTempDataDir("jobs");
  vi.resetModules();
  jobs = await import("./jobManager");
  store = await import("../storage/projectStore");
  errors = await import("../errors");
  cfg = await import("../config");
  await store.ensureDataDirs();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(async () => {
  vi.restoreAllMocks();
  await removeDir(dataDir);
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("jobManager", () => {
  it("runs a job, fans out events and records the result", async () => {
    const p = await store.createProject({
      name: "Job events",
      description: "",
    });
    const gate = deferred();
    const job = await jobs.startJob("export", p.id, async (ctx) => {
      ctx.setStages(["One", "Two"]);
      ctx.stage("One", 2);
      ctx.tick("a");
      ctx.tick("b");
      ctx.info("hello");
      ctx.addUsage({ inputTokens: 100, outputTokens: 10, costUsd: 0.5 });
      ctx.addUsage({ inputTokens: 50, outputTokens: 5 });
      ctx.addUsage({
        calls: 2,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.25,
      });
      await gate.promise;
      ctx.stage("Two");
      ctx.progress(3, 4, "nearly");
      return { done: true };
    });
    expect(job.status).toBe("queued");
    expect(job.id).toMatch(/^job_/);

    const events: JobEvent[] = [];
    const unsubscribe = jobs.subscribe(job.id, (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 10));
    const running = jobs.activeJobFor(p.id)!;
    expect(running.status).toBe("running");
    expect(running.progress).toMatchObject({
      stage: "One",
      stageIndex: 0,
      stageCount: 2,
      current: 2,
      total: 2,
      label: "b",
    });
    // One response has unknown pricing; the aggregate must not present a partial estimate as the total.
    expect(running.usage).toEqual({
      calls: 4,
      inputTokens: 151,
      outputTokens: 16,
    });

    gate.resolve();
    const finished = await jobs.waitForJob(job.id);
    unsubscribe();
    expect(finished.status).toBe("succeeded");
    expect(finished.result).toEqual({ done: true });
    expect(finished.progress).toMatchObject({
      stage: "Two",
      stageIndex: 1,
      current: 3,
      total: 4,
      label: "nearly",
    });
    expect(finished.startedAt && finished.finishedAt).toBeTruthy();
    expect(
      finished.logs.some((l) => l.message === "hello" && l.stage === "One"),
    ).toBe(true);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("status");
    expect(types).toContain("progress");
    expect(types).toContain("log");
    expect(types).toContain("usage");
    const last = events.at(-1)!;
    expect(last).toMatchObject({
      type: "status",
      status: "succeeded",
      result: { done: true },
    });
    expect(jobs.activeJobFor(p.id)).toBeUndefined();

    // Persisted for history after a restart.
    const file = path.join(cfg.paths.jobsDir(p.id), `${job.id}.json`);
    expect(JSON.parse(await fs.readFile(file, "utf8")).status).toBe(
      "succeeded",
    );
  });

  it("allows only one active job per project", async () => {
    const p = await store.createProject({
      name: "Job conflict",
      description: "",
    });
    const gate = deferred();
    const first = await jobs.startJob(
      "generate",
      p.id,
      async () => gate.promise,
    );
    await expect(jobs.startJob("export", p.id, async () => 1)).rejects.toThrow(
      errors.ConflictError,
    );
    try {
      await jobs.startJob("impact-analysis", p.id, async () => 1);
    } catch (err) {
      expect((err as InstanceType<Errors["ConflictError"]>).status).toBe(409);
      expect((err as Error).message).toMatch(
        /Generating use cases is still running/,
      );
    }
    // Other projects are unaffected.
    const other = await store.createProject({
      name: "Job other",
      description: "",
    });
    const otherJob = await jobs.startJob("export", other.id, async () => "ok");
    expect((await jobs.waitForJob(otherJob.id)).status).toBe("succeeded");
    gate.resolve();
    await jobs.waitForJob(first.id);
    const again = await jobs.startJob("export", p.id, async () => "second");
    expect((await jobs.waitForJob(again.id)).result).toBe("second");
  });

  it("marks failures with a readable message", async () => {
    const p = await store.createProject({
      name: "Job failure",
      description: "",
    });
    const job = await jobs.startJob("export", p.id, async () => {
      throw new errors.IntegrationError(
        "Jira said: project ACME does not exist",
      );
    });
    const finished = await jobs.waitForJob(job.id);
    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("Jira said: project ACME does not exist");
    expect(finished.logs.at(-1)).toMatchObject({ level: "error" });
  });

  it("records a plain-words failure that names the connection and model, on disk too", async () => {
    const p = await store.createProject({
      name: "Job failure kind",
      description: "",
    });
    const { ProviderError } = await import("../llm/errors");
    const { withOrigin } = await import("../llm/origin");
    const job = await jobs.startJob("generate", p.id, async () => {
      throw withOrigin(
        new ProviderError(
          "The OpenAI-compatible server rate limit reached (429): upstream detail",
          {
            failure: "rate_limit",
            retryable: true,
            status: 429,
            retryAfterMs: 3 * 60 * 60 * 1000,
          },
        ),
        {
          id: "conn_or",
          name: "OpenRouter",
          provider: "openai-compatible",
          model: "vendor/model:free",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-test-key",
          concurrency: 1,
          requestTimeoutSec: 0,
          structuredOutput: "auto",
          vision: "auto",
          refusalFallback: false,
          createdAt: "",
          updatedAt: "",
        },
      );
    });
    const finished = await jobs.waitForJob(job.id);
    expect(finished.status).toBe("failed");
    expect(finished.failure).toMatchObject({
      kind: "rate-limited",
      action: "wait",
      connectionId: "conn_or",
      connectionName: "OpenRouter",
      model: "vendor/model:free",
    });
    expect(finished.failure!.message).toMatch(/^OpenRouter's rate limit/);
    expect(finished.failure!.message).not.toContain("upstream detail");
    expect(Date.parse(finished.failure!.resetAt!)).toBeGreaterThan(
      Date.now() + 2 * 60 * 60 * 1000,
    );
    // The technical line stays for the activity log and older readers.
    expect(finished.error).toContain("(429)");
    const file = path.join(cfg.paths.jobsDir(p.id), `${job.id}.json`);
    expect(JSON.parse(await fs.readFile(file, "utf8")).failure).toEqual(
      finished.failure,
    );
  });

  it("sends live progress of AI requests to listeners, throttled and never saved (tester build WP6)", async () => {
    const p = await store.createProject({
      name: "Live progress",
      description: "",
    });
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const seen: JobEvent[] = [];
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const job = await jobs.startJob("export", p.id, async (ctx) => {
      const call = ctx.live!.start("use-case-writer:UC-007", "vendor/model");
      call.stream({ thinking: true });
      await pause(jobs.LIVE_EVENT_MS + 150);
      call.stream({ text: 40 });
      call.stream({ text: 60 });
      await pause(jobs.LIVE_EVENT_MS + 150);
      call.end();
      await pause(jobs.LIVE_EVENT_MS + 150);
      await stopped;
    });
    const unsubscribe = jobs.subscribe(job.id, (e) => seen.push(e));
    await pause(3 * (jobs.LIVE_EVENT_MS + 150) + 100);
    const live = seen.filter(
      (e): e is Extract<JobEvent, { type: "live" }> => e.type === "live",
    );
    expect(live.map((e) => e.calls.map((c) => [c.phase, c.received]))).toEqual([
      [["thinking", 0]],
      [["writing", 100]],
      [],
    ]);
    expect(live[0].calls[0]).toMatchObject({
      purpose: "use-case-writer:UC-007",
      model: "vendor/model",
    });
    stop();
    await jobs.waitForJob(job.id);
    unsubscribe();
    const file = path.join(cfg.paths.jobsDir(p.id), `${job.id}.json`);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).not.toHaveProperty(
      "live",
    );
  });

  it("gives a cancelled job no failure", async () => {
    const p = await store.createProject({
      name: "Job cancelled kind",
      description: "",
    });
    const job = await jobs.startJob("export", p.id, async () => {
      throw new errors.CancelledError();
    });
    const finished = await jobs.waitForJob(job.id);
    expect(finished.status).toBe("cancelled");
    expect(finished.failure).toBeUndefined();
  });

  it("cancels via the abort signal (CancelledError and other abort-induced errors)", async () => {
    const p = await store.createProject({
      name: "Job cancel",
      description: "",
    });
    const job = await jobs.startJob(
      "generate",
      p.id,
      (ctx) =>
        new Promise((_, reject) => {
          ctx.signal.addEventListener("abort", () =>
            reject(new errors.CancelledError()),
          );
        }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(jobs.cancelJob(job.id)).toBe(true);
    const finished = await jobs.waitForJob(job.id);
    expect(finished.status).toBe("cancelled");
    expect(jobs.cancelJob(job.id)).toBe(false);

    const job2 = await jobs.startJob(
      "export",
      p.id,
      (ctx) =>
        new Promise((_, reject) => {
          ctx.signal.addEventListener("abort", () =>
            reject(new Error("The operation was aborted")),
          );
        }),
    );
    await new Promise((r) => setTimeout(r, 5));
    jobs.cancelJob(job2.id);
    expect((await jobs.waitForJob(job2.id)).status).toBe("cancelled");

    const job3 = await jobs.startJob("export", p.id, async (ctx) => {
      await new Promise((r) => setTimeout(r, 20));
      ctx.throwIfCancelled();
      return "not reached";
    });
    jobs.cancelJob(job3.id);
    expect((await jobs.waitForJob(job3.id)).status).toBe("cancelled");
  });

  it("restores the project status when a generation fails or is cancelled", async () => {
    const p = await store.createProject({
      name: "Job restore",
      description: "",
    });
    const job = await jobs.startJob("generate", p.id, async () => {
      // What the pipeline does first.
      await store.withProjectLock(p.id, async () => {
        const project = await store.getProject(p.id);
        project.status = "generating";
        await store.saveProject(project);
      });
      throw new Error("LLM unavailable");
    });
    expect((await jobs.waitForJob(job.id)).status).toBe("failed");
    expect((await store.getProject(p.id)).status).toBe("draft");

    // A project that was already specified goes back to 'specified'.
    await store.withProjectLock(p.id, async () => {
      const project = await store.getProject(p.id);
      project.status = "specified";
      await store.saveProject(project);
    });
    const job2 = await jobs.startJob("generate", p.id, async (ctx) => {
      await store.withProjectLock(p.id, async () => {
        const project = await store.getProject(p.id);
        project.status = "generating";
        await store.saveProject(project);
      });
      ctx.throwIfCancelled();
      await new Promise((r) => setTimeout(r, 30));
      ctx.throwIfCancelled();
    });
    await new Promise((r) => setTimeout(r, 10));
    jobs.cancelJob(job2.id);
    expect((await jobs.waitForJob(job2.id)).status).toBe("cancelled");
    expect((await store.getProject(p.id)).status).toBe("specified");
  });

  it("caps logs at 2000 entries, keeping the newest", async () => {
    const p = await store.createProject({ name: "Job logs", description: "" });
    const job = await jobs.startJob("export", p.id, async (ctx) => {
      for (let i = 0; i < 2100; i++) ctx.log("debug", `line ${i}`);
    });
    const finished = await jobs.waitForJob(job.id);
    expect(finished.logs).toHaveLength(jobs.MAX_LOG_ENTRIES);
    expect(finished.logs[0].message).toBe("line 100");
    expect(finished.logs.at(-1)!.message).toBe("line 2099");
    const persisted = JSON.parse(
      await fs.readFile(
        path.join(p.projectPath!, "jobs", job.id + ".json"),
        "utf8",
      ),
    );
    expect(persisted.logs).toEqual(finished.logs);
    expect(persisted.eventSequence).toBe(finished.eventSequence);
    expect(persisted.status).toBe("succeeded");
  });

  it("lists jobs newest first, merging memory and disk, and finds persisted jobs by id", async () => {
    const p = await store.createProject({ name: "Job list", description: "" });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const job = await jobs.startJob("export", p.id, async () => i);
      ids.push(job.id);
      await jobs.waitForJob(job.id);
      await new Promise((r) => setTimeout(r, 5));
    }
    const listed = await jobs.listJobs(p.id);
    expect(listed.map((j) => j.id)).toEqual([...ids].reverse());

    // Model a real restart: release physical ownership before reconstructing the registry.
    await (await import("../storage/projectRegistry")).releaseProjectLeases();
    await (
      await import("../storage/windowsStorageGuard")
    ).releaseFilesystemGuard();
    vi.resetModules();
    const restarted: Jobs = await import("./jobManager");
    jobs = restarted;
    store = await import("../storage/projectStore");
    await store.ensureDataDirs();
    const fromDisk = await restarted.listJobs(p.id);
    expect(fromDisk.map((j) => j.id)).toEqual([...ids].reverse());
    expect((await restarted.getJob(ids[0])).result).toBe(0);
    await expect(restarted.getJob("job_doesnotexist")).rejects.toMatchObject({
      status: 404,
    });
    await expect(restarted.getJob("../../settings")).rejects.toMatchObject({
      status: 404,
    });
    expect(restarted.getLiveJob(ids[0])).toBeUndefined();
  });

  it("cancelAllJobs stops running jobs", async () => {
    const p = await store.createProject({
      name: "Job shutdown",
      description: "",
    });
    const job = await jobs.startJob(
      "export",
      p.id,
      (ctx) =>
        new Promise((_, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
        }),
    );
    await new Promise((r) => setTimeout(r, 5));
    await jobs.cancelAllJobs(1000);
    expect((await jobs.getJob(job.id)).status).toBe("cancelled");
  });
});
