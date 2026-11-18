/**
 * Publishing a delivery plan to Jira through the real HTTP app against a stateful fake Jira (never a live service):
 * Cloud (REST v3, ADF, Parent field) and Data Center (REST v2, wiki markup, Epic Link). Proves the request order,
 * that the preview is what is sent, project scoping, that a repeat sends nothing, that lost records are recovered
 * by durable key, that updates keep the team's edits and labels, and that an issue edited after planning is not
 * overwritten.
 */
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DeliveryPlanView } from "@shared/api";
import {
  DEFAULT_GENERATION_OPTIONS,
  type Job,
  type SolutionModel,
} from "@shared/types";
import { recordingContext } from "../agents/testContext";
import { authenticatedTestApp } from "../security/authTestUtils";
import { removeDir, useTempDataDir } from "../storage/testUtils";
import type { RecordedCall } from "../export/testUtils";
import { FakeJira } from "./fakeJira";
import { jiraSettings, SECRETS } from "./testFixtures";

let dir: string;
let server: http.Server;
let base: string;
let release: () => Promise<void>;
let authenticated: Awaited<ReturnType<typeof authenticatedTestApp>>;
let jobs: typeof import("../jobs/jobManager");
let store: typeof import("../storage/projectStore");
let settingsStore: typeof import("../storage/settingsStore");
let cfg: typeof import("../config");
let fake: FakeJira;

async function demoProject(): Promise<string> {
  const project = await (await import("../storage/demo")).createDemoProject();
  await (
    await import("../agents/pipeline")
  ).runGeneration(recordingContext(project.id), project.id, {
    ...DEFAULT_GENERATION_OPTIONS,
    visionConnectionId: project.llm.visionConnectionId,
    textConnectionId: project.llm.textConnectionId,
  });
  return project.id;
}

beforeAll(async () => {
  dir = await useTempDataDir("delivery-publish-jira");
  vi.resetModules();
  store = await import("../storage/projectStore");
  jobs = await import("../jobs/jobManager");
  cfg = await import("../config");
  settingsStore = await import("../storage/settingsStore");
  const { httpDefaults } = await import("../export/http");
  httpDefaults.baseDelayMs = 0;
  release = await (
    await import("../storage/instanceLock")
  ).acquireInstanceLock();
  await store.ensureDataDirs();
  authenticated = await authenticatedTestApp();
  server = http.createServer(authenticated.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  authenticated.authenticate(base);
  const realFetch = globalThis.fetch;
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
      const call: RecordedCall = {
        method: (init?.method ?? "GET").toUpperCase(),
        url,
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      const r = fake.handle(call);
      const status = r.status ?? 200;
      const headers = new Headers(r.headers ?? {});
      if (r.json !== undefined) headers.set("content-type", "application/json");
      return new Response(
        status === 204
          ? null
          : r.json !== undefined
            ? JSON.stringify(r.json)
            : "",
        { status, headers },
      );
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

async function job(pid: string, route: string, body?: unknown) {
  const started = await api<{ jobId: string }>(
    "POST",
    `/api/projects/${pid}/delivery/${route}`,
    body,
  );
  expect(started.status).toBe(202);
  return (await jobs.waitForJob(started.body.jobId)) as Job;
}

const view = async (pid: string) =>
  (
    await api<DeliveryPlanView>(
      "GET",
      `/api/projects/${pid}/delivery/plans/jira`,
    )
  ).body;

/** Plans, answering the required Business Unit picklist (no suggestion exists for it). */
async function plan(pid: string, refresh = false) {
  const done = await job(pid, "plans", {
    target: "jira",
    includeUnapproved: true,
    useAi: false,
    refreshDestination: refresh,
  });
  expect(done.status).toBe("succeeded");
  const v = await view(pid);
  const unit = v.plan.decisions.find(
    (d) => d.fieldId === "customfield_10060" && !d.resolution,
  );
  if (!unit) return v;
  return (
    await api<DeliveryPlanView>(
      "POST",
      `/api/projects/${pid}/delivery/plans/jira/decisions`,
      { decisionId: unit.id, value: "value:Retail" },
    )
  ).body;
}

const publish = (pid: string, v: DeliveryPlanView) =>
  job(pid, "plans/jira/publish", {
    revision: v.plan.revision,
    fingerprint: v.fingerprint,
  });

const creates = () =>
  fake.writes().filter((c) => c.method === "POST" && /\/issue$/.test(c.url));

async function editUseCase(
  pid: string,
  change: (uc: SolutionModel["useCases"][number]) => void,
) {
  const model = (await store.loadModel(pid)) as SolutionModel;
  change(model.useCases[0]);
  model.useCases[0].revision += 1;
  await store.saveModel(pid, model);
  await (
    await import("../specs/specStore")
  ).writeSpecs(await store.getProject(pid), model, {
    preserveEdited: false,
    embedScreenImages: model.options.embedScreenImages,
  });
}

describe("publishing to Jira Cloud", () => {
  let pid: string;

  beforeAll(async () => {
    fake = new FakeJira({ cloud: true });
    // Another project on the same site, with an issue that looks like Coherence's: never touched.
    fake.seed({
      project: "OTH",
      issuetype: "10001",
      fields: { summary: "Not ours", labels: ["coherence"], description: "x" },
    });
    await settingsStore.setIntegration({ system: "jira", ...jiraSettings() });
  });

  it(
    "creates Epics, then stories under them (ADF, labels, parent), then Blocks links; the preview is what is sent; a repeat sends nothing",
    { timeout: 120_000 },
    async () => {
      pid = await demoProject();
      const first = await plan(pid);
      expect(first.publishing).toMatchObject({ enabled: true, needsCheck: 0 });
      expect(first.publishing.blockedReason).toBeUndefined();
      const epics = first.plan.items.filter((i) => i.role === "group");
      const stories = first.plan.items.filter((i) => i.role !== "group");
      const story = stories.find((s) => s.parentItemId)!;
      const preview = (
        await api<{ body: unknown }>(
          "GET",
          `/api/projects/${pid}/delivery/plans/jira/items/${encodeURIComponent(story.id)}/preview`,
        )
      ).body.body;

      const done = await publish(pid, first);
      expect(done.status).toBe("succeeded");
      expect(done.result).toMatchObject({
        status: "completed",
        counts: { created: first.plan.items.length, refused: 0 },
      });
      // Epics first, then the stories, all in the configured project and on the v3 API.
      const sent = creates();
      expect(
        sent.every(
          (c) => c.url === "https://acme.atlassian.net/rest/api/3/issue",
        ),
      ).toBe(true);
      expect(
        sent.map(
          (c) =>
            (c.body as { fields: { issuetype: { id: string } } }).fields
              .issuetype.id,
        ),
      ).toEqual([...epics.map(() => "10000"), ...stories.map(() => "10001")]);
      for (const c of sent)
        expect(
          (c.body as { fields: { project: unknown } }).fields.project,
        ).toEqual({ key: "POR" });

      // The preview is exactly what was sent, with the Epic's key filled in.
      const after = await view(pid);
      const epicKey = after.publishing.lastRun!.items.find(
        (i) => i.itemId === story.parentItemId,
      )!.key!;
      const storyKey = after.publishing.lastRun!.items.find(
        (i) => i.itemId === story.id,
      )!.key!;
      const sentStory = sent.find((c) =>
        JSON.stringify(c.body).includes(story.durableKey),
      )!;
      expect(JSON.stringify(sentStory.body)).toBe(
        JSON.stringify(preview).replaceAll(
          `{{${story.parentItemId}}}`,
          epicKey,
        ),
      );
      const issue = fake.issues.get(storyKey)!;
      expect(issue.fields.parent).toEqual({ key: epicKey });
      expect(typeof issue.fields.description).toBe("object"); // ADF
      expect(issue.fields.labels).toEqual(
        expect.arrayContaining([
          "coherence",
          story.sources.useCaseIds[0].toLowerCase(),
        ]),
      );
      expect(issue.fields.customfield_10060).toEqual({ value: "Retail" });

      // Dependencies: the prerequisite blocks the dependent.
      const dependencies = first.plan.relationships.filter(
        (r) => r.kind === "dependency" && r.status === "planned",
      );
      expect(dependencies.length).toBeGreaterThan(0);
      const linkCalls = fake
        .writes()
        .filter((c) => c.url.endsWith("/issueLink"));
      expect(linkCalls).toHaveLength(dependencies.length);
      for (const c of linkCalls)
        expect((c.body as { type: { name: string } }).type.name).toBe("Blocks");

      // Searches were scoped to the project; the other project's issue was never touched.
      const searches = fake.calls.filter((c) => c.url.includes("/search/jql"));
      expect(searches.length).toBeGreaterThan(0);
      for (const s of searches)
        expect(new URL(s.url).searchParams.get("jql")).toMatch(
          /^project = "POR" AND/,
        );
      expect(fake.issues.get("OTH-1")!.updated).toBe(
        Date.parse("2026-11-03T10:00:01.000Z"),
      );
      expect(fake.calls.some((c) => c.method === "DELETE")).toBe(false);

      expect(after.plan.items.every((i) => i.operation === "keep")).toBe(true);
      expect(after.publishing.blockedReason).toMatch(/already in Jira/);
      const model = (await store.loadModel(pid)) as SolutionModel;
      expect(
        model.useCases.every((u) =>
          u.external.some((l) => l.system === "jira"),
        ),
      ).toBe(true);
      const recordDir = path.join(
        cfg.paths.projectDir(pid),
        "delivery",
        "published",
      );
      for (const file of await fs.readdir(recordDir)) {
        const text = await fs.readFile(path.join(recordDir, file), "utf8");
        for (const s of SECRETS) expect(text).not.toContain(s);
      }

      const before = fake.writes().length;
      const again = await publish(pid, after);
      expect(again.status).toBe("failed");
      expect(again.error).toMatch(/already in Jira/);
      expect(fake.writes()).toHaveLength(before);
    },
  );

  it(
    "updates only what changed in Coherence, keeps the team's summary and labels, and never overwrites an issue edited after planning",
    { timeout: 120_000 },
    async () => {
      const ucId = (await store.loadModel(pid))!.useCases[0].id;
      const itemId = `uc:${ucId}`;
      const key = (await view(pid)).plan.items.find((i) => i.id === itemId)!
        .existing!.key;
      const issue = () => fake.issues.get(key)!;
      fake.edit(key, {
        summary: "Team's own summary",
        labels: [...(issue().fields.labels as string[]), "team-label"],
      });
      await editUseCase(pid, (uc) => {
        uc.scope = `${uc.scope} Now also covers locked accounts.`;
      });
      const changed = await plan(pid);
      const planned = changed.plan.items.find((i) => i.id === itemId)!;
      expect(planned.operation).toBe("update");
      const action = (id: string) =>
        planned.fields.find((f) => f.fieldId === id)?.updateAction;
      expect(action("description")).toBe("send");
      expect(action("summary")).toBe("keep-destination");
      expect(action("labels")).toBe("unchanged");
      expect(changed.publishing.scope.send).toEqual([itemId]);

      const done = await publish(pid, changed);
      expect(done.result).toMatchObject({
        status: "completed",
        counts: { updated: 1 },
      });
      const put = fake
        .writes()
        .filter((c) => c.method === "PUT")
        .at(-1)!;
      expect(Object.keys((put.body as { fields: object }).fields)).toEqual([
        "description",
      ]);
      expect(issue().fields.summary).toBe("Team's own summary");
      expect(issue().fields.labels).toContain("team-label");
      expect(JSON.stringify(issue().fields.description)).toContain(
        "Now also covers locked accounts.",
      );

      // Changed again, and someone edits the issue in Jira after the plan was made.
      await editUseCase(pid, (uc) => {
        uc.scope = `${uc.scope} And expired passwords.`;
      });
      const again = await plan(pid);
      fake.edit(key, { summary: "Edited during review" });
      const puts = fake.writes().filter((c) => c.method === "PUT").length;
      const refused = await publish(pid, again);
      expect(refused.result).toMatchObject({
        counts: { refused: 1, updated: 0 },
      });
      expect(fake.writes().filter((c) => c.method === "PUT")).toHaveLength(
        puts,
      );
      expect(
        (await view(pid)).publishing.lastRun!.items.find(
          (i) => i.itemId === itemId,
        )?.message,
      ).toMatch(/edited in Jira after this plan was made/);
    },
  );

  it(
    "finds its own issues by durable key when the local records are lost, and creates nothing",
    { timeout: 120_000 },
    async () => {
      const other = await demoProject();
      await publish(other, await plan(other));
      await fs.rm(
        path.join(cfg.paths.projectDir(other), "delivery", "published"),
        {
          recursive: true,
          force: true,
        },
      );
      const model = (await store.loadModel(other)) as SolutionModel;
      for (const uc of model.useCases) uc.external = [];
      await store.saveModel(other, model);
      await (
        await import("../specs/specStore")
      ).writeSpecs(await store.getProject(other), model, {
        preserveEdited: false,
        embedScreenImages: model.options.embedScreenImages,
      });
      const lost = await plan(other);
      expect(lost.plan.items.every((i) => i.operation === "create")).toBe(true);
      const before = creates().length;
      const done = await publish(other, lost);
      expect(done.result).toMatchObject({
        counts: { created: 0, reused: lost.plan.items.length },
      });
      expect(creates()).toHaveLength(before);
    },
  );

  it(
    "stops when Jira rejects the credentials, with nothing created after it",
    { timeout: 120_000 },
    async () => {
      const other = await demoProject();
      const v = await plan(other);
      fake.faults.push({
        when: (c) => c.method === "POST" && /\/issue$/.test(c.url),
        status: 401,
        json: { errorMessages: ["Unauthorized"] },
      });
      const before = creates().length;
      const done = await publish(other, v);
      expect(done.result).toMatchObject({
        status: "stopped",
        counts: { created: 0, refused: 1 },
      });
      expect(creates()).toHaveLength(before + 1); // the refused one only
      expect((await view(other)).publishing.lastRun!.message).toMatch(
        /rejected the credentials/,
      );
    },
  );
});

describe("publishing to Jira Data Center", () => {
  beforeAll(async () => {
    fake = new FakeJira({ cloud: false });
    await settingsStore.setIntegration({
      system: "jira",
      ...jiraSettings({ deployment: "server", email: "" }),
    });
  });

  it(
    "uses REST v2 with wiki markup, the Epic Link and Epic Name fields",
    { timeout: 120_000 },
    async () => {
      const pid = await demoProject();
      const v = await plan(pid, true);
      expect(v.plan.destination.textFormat).toBe("jira-wiki");
      const done = await publish(pid, v);
      expect(done.result).toMatchObject({
        status: "completed",
        counts: { created: v.plan.items.length },
      });
      const sent = creates();
      expect(
        sent.every(
          (c) => c.url === "https://acme.atlassian.net/rest/api/2/issue",
        ),
      ).toBe(true);
      const epics = [...fake.issues.values()].filter(
        (i) => i.issuetype === "10000",
      );
      const stories = [...fake.issues.values()].filter(
        (i) => i.issuetype === "10001",
      );
      expect(epics.length).toBeGreaterThan(0);
      for (const e of epics)
        expect(typeof e.fields.customfield_10101).toBe("string");
      for (const s of stories) {
        expect(epics.map((e) => e.key)).toContain(s.fields.customfield_10100);
        expect(typeof s.fields.description).toBe("string");
      }
      expect(fake.calls.some((c) => c.url.includes("/rest/api/3/"))).toBe(
        false,
      );
    },
  );
});
