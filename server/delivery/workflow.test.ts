/**
 * End-to-end delivery planning through the real HTTP app: offline-generated synthetic project → approved use cases →
 * plan job with mocked (read-only) Azure DevOps metadata → decisions → approval → payload preview.
 * Proves that no request other than GET reaches the tracker and that no export journal or tracker link is written.
 */
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DeliveryPayloadPreview, DeliveryPlanView } from "@shared/api";
import {
  DEFAULT_GENERATION_OPTIONS,
  type Job,
  type SolutionModel,
} from "@shared/types";
import { recordingContext } from "../agents/testContext";
import { authenticatedTestApp } from "../security/authTestUtils";
import { removeDir, useTempDataDir } from "../storage/testUtils";
import {
  adoCustomRequirementFields,
  azdoRoutes,
  azdoSettings,
  SECRETS,
} from "./testFixtures";

let dir: string;
let server: http.Server;
let base: string;
let pid: string;
let release: () => Promise<void>;
let authenticated: Awaited<ReturnType<typeof authenticatedTestApp>>;
let jobs: typeof import("../jobs/jobManager");
let store: typeof import("../storage/projectStore");
let cfg: typeof import("../config");
const trackerCalls: { method: string; url: string; body: unknown }[] = [];

beforeAll(async () => {
  dir = await useTempDataDir("delivery-workflow");
  vi.resetModules();
  store = await import("../storage/projectStore");
  jobs = await import("../jobs/jobManager");
  cfg = await import("../config");
  const { httpDefaults } = await import("../export/http");
  httpDefaults.baseDelayMs = 0;
  release = await (
    await import("../storage/instanceLock")
  ).acquireInstanceLock();
  await store.ensureDataDirs();
  const project = await (await import("../storage/demo")).createDemoProject();
  pid = project.id;
  await (
    await import("../agents/pipeline")
  ).runGeneration(recordingContext(pid), pid, {
    ...DEFAULT_GENERATION_OPTIONS,
    visionConnectionId: project.llm.visionConnectionId,
    textConnectionId: project.llm.textConnectionId,
  });
  await (
    await import("../storage/settingsStore")
  ).setIntegration({
    system: "azdo",
    ...azdoSettings({ workItemType: "Requirement" }),
  });

  authenticated = await authenticatedTestApp();
  server = http.createServer(authenticated.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  authenticated.authenticate(base);

  const realFetch = globalThis.fetch;
  const routes = azdoRoutes({
    requirementType: "Requirement",
    requirementFields: adoCustomRequirementFields(),
  });
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith(base)) return realFetch(input, init);
      const method = (init?.method ?? "GET").toUpperCase();
      trackerCalls.push({ method, url, body: init?.body });
      const route = routes.find(([re]) => re.test(`${method} ${url}`));
      if (!route)
        return new Response(JSON.stringify({ message: "unexpected" }), {
          status: 500,
        });
      const r = typeof route[1] === "function" ? route[1]({ url }) : route[1];
      return new Response(JSON.stringify(r.json ?? {}), {
        status: r.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await jobs.cancelAllJobs();
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await release?.();
  await removeDir(dir);
});

async function api<T>(method: string, url: string, body?: unknown) {
  const response = await authenticated.fetch(base + url, {
    method,
    headers: { "X-ScreenScribe": "1", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function plan(body: Record<string, unknown>) {
  const started = await api<{ jobId: string }>(
    "POST",
    `/api/projects/${pid}/delivery/plans`,
    { target: "azdo", ...body },
  );
  expect(started.status).toBe(202);
  const job = (await jobs.waitForJob(started.body.jobId)) as Job;
  if (job.status !== "succeeded")
    console.log(
      JSON.stringify(
        { status: job.status, error: job.error, logs: job.logs?.slice(-8) },
        null,
        1,
      ),
    );
  expect(job.status).toBe("succeeded");
  return job;
}

describe("delivery planning workflow", () => {
  it(
    "plans, asks only what it must, saves answers and approves without any tracker write",
    { timeout: 120_000 },
    async () => {
      const model = (await store.loadModel(pid)) as SolutionModel;
      const ids = model.useCases.map((u) => u.id);
      // Nothing approved yet: the plan lists every use case but includes none.
      await plan({ useAi: true });
      let view = (
        await api<DeliveryPlanView>(
          "GET",
          `/api/projects/${pid}/delivery/plans/azdo`,
        )
      ).body;
      // Publishing is available for Azure DevOps, but nothing is planned yet, so there is nothing to send.
      expect(view.publishing).toMatchObject({ enabled: true });
      expect(view.publishing.scope.send).toEqual([]);
      expect(view.plan.sources.length).toBe(ids.length);
      expect(view.plan.sources.every((s) => !s.included)).toBe(true);
      expect(view.plan.items).toEqual([]);

      for (const id of ids)
        expect(
          (
            await api("PATCH", `/api/projects/${pid}/use-cases/${id}/status`, {
              status: "approved",
            })
          ).status,
        ).toBe(200);
      const before = trackerCalls.length;
      const job = await plan({ useAi: true });
      expect(trackerCalls.length).toBe(before); // cached destination structure, no new requests
      expect(job.result).toMatchObject({
        target: "azdo",
        readiness: "needs-decisions",
      });
      view = (
        await api<DeliveryPlanView>(
          "GET",
          `/api/projects/${pid}/delivery/plans/azdo`,
        )
      ).body;
      expect(view.stale).toEqual([]);
      expect(
        view.plan.items.filter((i) => i.role === "requirement"),
      ).toHaveLength(ids.length);
      expect(view.plan.ai.outcome).toBe("not-needed");
      const open = view.plan.decisions
        .filter((d) => d.blocking && !d.resolution)
        .map((d) => d.id)
        .sort();
      // Value Statement is assumed from its name; Business Unit has nothing to go on.
      expect(open).toEqual(["field:Requirement:Custom.BusinessUnit"]);
      expect(
        view.plan.decisions.find(
          (d) => d.id === "field:Requirement:Custom.ValueStatement",
        )?.resolution,
      ).toMatchObject({ value: "evidence:story.soThat", assumed: true });

      expect(
        (
          await api(
            "POST",
            `/api/projects/${pid}/delivery/plans/azdo/decisions`,
            {
              decisionId: "field:Requirement:Custom.BusinessUnit",
              value: "value:Invented",
            },
          )
        ).status,
      ).toBe(400);
      await api("POST", `/api/projects/${pid}/delivery/plans/azdo/decisions`, {
        decisionId: "field:Requirement:Custom.BusinessUnit",
        value: "value:Retail",
        saveAsRule: true,
      });
      const answered = await api<DeliveryPlanView>(
        "POST",
        `/api/projects/${pid}/delivery/plans/azdo/decisions`,
        {
          decisionId: "field:Requirement:Custom.ValueStatement",
          value: "evidence:story.soThat",
          saveAsRule: true,
        },
      );
      expect(answered.status).toBe(200);
      expect(answered.body.plan.readiness).toBe("ready");

      const approved = await api<DeliveryPlanView>(
        "POST",
        `/api/projects/${pid}/delivery/plans/azdo/approve`,
      );
      expect(approved.status).toBe(200);
      expect(approved.body.plan.approval).toBeDefined();

      const item = approved.body.plan.items.find(
        (i) => i.role === "requirement",
      )!;
      const preview = await api<DeliveryPayloadPreview>(
        "GET",
        `/api/projects/${pid}/delivery/plans/azdo/items/${encodeURIComponent(item.id)}/preview`,
      );
      expect(preview.status).toBe(200);
      expect(preview.body.request).toBe(
        "POST /_apis/wit/workitems/$Requirement",
      );

      // A later plan reuses the saved answers without asking again.
      const again = await plan({ useAi: true });
      expect(again.result).toMatchObject({ readiness: "ready" });

      // "Change" reopens a remembered answer: the rule is forgotten, so neither this plan nor the next re-applies it.
      const reopened = await api<DeliveryPlanView>(
        "POST",
        `/api/projects/${pid}/delivery/plans/azdo/decisions`,
        { decisionId: "field:Requirement:Custom.BusinessUnit", value: null },
      );
      expect(
        reopened.body.plan.decisions.find(
          (d) => d.id === "field:Requirement:Custom.BusinessUnit",
        )?.resolution,
      ).toBeUndefined();
      expect((await plan({ useAi: false })).result).toMatchObject({
        readiness: "needs-decisions",
      });

      // Proof: only reads reached the tracker, nothing was journalled or linked, and no secret is in project files.
      expect(trackerCalls.length).toBeGreaterThan(0);
      expect(
        trackerCalls.every((c) => c.method === "GET" && c.body === undefined),
      ).toBe(true);
      const projectDir = cfg.paths.projectDir(pid);
      await expect(
        fs.stat(path.join(projectDir, "export-journal")),
      ).rejects.toThrow();
      expect(
        ((await store.loadModel(pid)) as SolutionModel).useCases.every(
          (u) => u.external.length === 0,
        ),
      ).toBe(true);
      const planText = await fs.readFile(
        path.join(projectDir, "delivery", "plans", "azdo.json"),
        "utf8",
      );
      for (const s of SECRETS) expect(planText).not.toContain(s);
      const profiles = await fs.readdir(
        path.join(cfg.config.dataDir, "delivery", "profiles"),
      );
      expect(profiles).toHaveLength(1);

      // The live write lock is unchanged.
      const live = await api<{ error: string }>(
        "POST",
        `/api/projects/${pid}/export`,
        {
          target: "azdo",
          useCaseIds: ids,
          dryRun: false,
          createFeatureParents: true,
          linkDependencies: true,
          updateExisting: true,
          includeStoryPoints: false,
        },
      );
      expect(live.status).toBe(400);
    },
  );

  it("reports a stale plan after a reviewed use case changes", async () => {
    const model = (await store.loadModel(pid)) as SolutionModel;
    const first = model.useCases[0].id;
    await api("PATCH", `/api/projects/${pid}/use-cases/${first}/status`, {
      status: "edited",
    });
    const view = (
      await api<DeliveryPlanView>(
        "GET",
        `/api/projects/${pid}/delivery/plans/azdo`,
      )
    ).body;
    expect(view.stale.some((r) => r.includes(first))).toBe(true);
    const refused = await api<{ error: string }>(
      "POST",
      `/api/projects/${pid}/delivery/plans/azdo/approve`,
    );
    expect(refused.status).toBe(409);
  });
});
