/**
 * Publishing a delivery plan to GitHub through the real HTTP app against a stateful fake GitHub (never a live
 * service): milestones, then issues with their milestone, labels, type and a "Depends on" line; the preview is what
 * is sent; a repeat sends nothing; updates keep the team's title and labels and never overwrite an issue edited
 * after planning; labels or a milestone GitHub silently left out are reported.
 */
import http from "node:http";
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
import { FakeGitHub } from "./fakeGitHub";
import { githubSettings } from "./testFixtures";

let dir: string;
let server: http.Server;
let base: string;
let release: () => Promise<void>;
let authenticated: Awaited<ReturnType<typeof authenticatedTestApp>>;
let jobs: typeof import("../jobs/jobManager");
let store: typeof import("../storage/projectStore");
let fake: FakeGitHub;

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
  dir = await useTempDataDir("delivery-publish-github");
  vi.resetModules();
  store = await import("../storage/projectStore");
  jobs = await import("../jobs/jobManager");
  const { httpDefaults } = await import("../export/http");
  httpDefaults.baseDelayMs = 0;
  (await import("./githubClient")).githubDefaults.writeSpacingMs = 0;
  release = await (
    await import("../storage/instanceLock")
  ).acquireInstanceLock();
  await store.ensureDataDirs();
  await (
    await import("../storage/settingsStore")
  ).setIntegration({ system: "github", ...githubSettings() });
  authenticated = await authenticatedTestApp();
  server = http.createServer(authenticated.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  authenticated.authenticate(base);
  fake = new FakeGitHub();
  fake.seed("acme/other", {
    title: "Not ours",
    body: "x",
    labels: ["coherence"],
  });
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
      const headers = new Headers(r.headers ?? {});
      if (r.json !== undefined) headers.set("content-type", "application/json");
      return new Response(r.json !== undefined ? JSON.stringify(r.json) : "", {
        status: r.status ?? 200,
        headers,
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
      `/api/projects/${pid}/delivery/plans/github`,
    )
  ).body;

async function plan(pid: string) {
  const done = await job(pid, "plans", {
    target: "github",
    includeUnapproved: true,
    useAi: false,
    refreshDestination: true,
  });
  expect(done.status).toBe("succeeded");
  return view(pid);
}

const publish = (pid: string, v: DeliveryPlanView) =>
  job(pid, "plans/github/publish", {
    revision: v.plan.revision,
    fingerprint: v.fingerprint,
  });

const issueCreates = () =>
  fake
    .writes()
    .filter(
      (c) =>
        c.method === "POST" && /\/repos\/acme\/portal\/issues$/.test(c.url),
    );

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

describe("publishing to GitHub", () => {
  let pid: string;

  it(
    "creates milestones, then issues with milestone, labels, type and a Depends on line; the preview is what is sent; a repeat sends nothing",
    { timeout: 120_000 },
    async () => {
      pid = await demoProject();
      const first = await plan(pid);
      expect(first.publishing).toMatchObject({ enabled: true, needsCheck: 0 });
      expect(first.publishing.blockedReason).toBeUndefined();
      const issues = first.plan.items.filter((i) => i.role !== "group");
      const dependent = issues.find((i) =>
        first.plan.relationships.some(
          (r) => r.fromItemId === i.id && r.kind === "dependency" && r.toItemId,
        ),
      )!;
      const preview = (
        await api<{ body: unknown }>(
          "GET",
          `/api/projects/${pid}/delivery/plans/github/items/${encodeURIComponent(dependent.id)}/preview`,
        )
      ).body.body;

      const done = await publish(pid, first);
      expect(done.status).toBe("succeeded");
      expect(done.result).toMatchObject({
        status: "completed",
        counts: { refused: 0, uncertain: 0 },
      });
      const after = await view(pid);
      const results = after.publishing.lastRun!.items;
      // Milestones before issues; every planned issue exists once, with its milestone and labels.
      const writes = fake.writes();
      const lastMilestone = writes
        .map((c) => c.url)
        .lastIndexOf("https://api.github.com/repos/acme/portal/milestones");
      const firstIssue = writes.findIndex((c) => /\/issues$/.test(c.url));
      expect(lastMilestone).toBeLessThan(firstIssue);
      expect(fake.portal()).toHaveLength(issues.length);
      for (const issue of fake.portal()) {
        expect(issue.milestone).not.toBeNull();
        expect(issue.labels).toContain("coherence");
        expect(issue.type).toBe("Feature");
      }
      // The dependent issue names its prerequisite's number; otherwise it is exactly the preview.
      const key = (id: string) => results.find((i) => i.itemId === id)!.key!;
      const sent = issueCreates().find((c) =>
        String((c.body as { body: string }).body).includes(
          dependent.durableKey,
        ),
      )!;
      let expected = JSON.stringify(preview);
      for (const r of first.plan.relationships.filter(
        (x) => x.fromItemId === dependent.id && x.toItemId,
      ))
        expected =
          r.kind === "parent"
            ? // The milestone placeholder becomes its number (a JSON number, not a string).
              expected.replaceAll(`"{{${r.toItemId}}}"`, key(r.toItemId!))
            : expected.replaceAll(`{{${r.toItemId}}}`, key(r.toItemId!));
      expect(JSON.stringify(sent.body)).toBe(expected);
      expect(String((sent.body as { body: string }).body)).toMatch(
        /^\*\*Depends on:\*\* #\d+ \(UC-\d+\)/,
      );
      // The organisation issue field mapped by assumption isn't sent, and the result says so.
      expect(results.find((i) => i.itemId === dependent.id)?.message).toMatch(
        /issue fields aren't sent yet/,
      );
      // The other repository's issue was never touched.
      expect(fake.issues.get("acme/other#1")!.updated).toBe(
        Date.parse("2026-11-03T10:00:01Z"),
      );

      expect(after.plan.items.every((i) => i.operation === "keep")).toBe(true);
      const before = fake.writes().length;
      const again = await publish(pid, after);
      expect(again.status).toBe("failed");
      expect(again.error).toMatch(/already in GitHub/);
      expect(fake.writes()).toHaveLength(before);
    },
  );

  it(
    "updates only what changed in Coherence, keeps the team's title and labels, and never overwrites an issue edited after planning",
    { timeout: 120_000 },
    async () => {
      const ucId = (await store.loadModel(pid))!.useCases[0].id;
      const itemId = `uc:${ucId}`;
      const key = (await view(pid)).plan.items.find((i) => i.id === itemId)!
        .existing!.key;
      const number = Number(key.slice(1));
      const issue = () => fake.issues.get(`acme/portal#${number}`)!;
      fake.edit(number, {
        title: "Team's own title",
        labels: [...issue().labels, "team-label"],
      });
      await editUseCase(pid, (uc) => {
        uc.scope = `${uc.scope} Now also covers locked accounts.`;
      });
      const changed = await plan(pid);
      const planned = changed.plan.items.find((i) => i.id === itemId)!;
      expect(planned.operation).toBe("update");
      const action = (id: string) =>
        planned.fields.find((f) => f.fieldId === id)?.updateAction;
      expect(action("body")).toBe("send");
      expect(action("title")).toBe("keep-destination");
      expect(action("labels")).toBe("unchanged");

      const done = await publish(pid, changed);
      expect(done.result).toMatchObject({ counts: { updated: 1 } });
      const patch = fake
        .writes()
        .filter((c) => c.method === "PATCH")
        .at(-1)!;
      expect(Object.keys(patch.body as object)).toEqual(["body"]);
      expect(issue().title).toBe("Team's own title");
      expect(issue().labels).toContain("team-label");
      expect(issue().body).toContain("Now also covers locked accounts.");

      await editUseCase(pid, (uc) => {
        uc.scope = `${uc.scope} And expired passwords.`;
      });
      const again = await plan(pid);
      fake.edit(number, { title: "Edited during review" });
      const patches = fake.writes().filter((c) => c.method === "PATCH").length;
      const refused = await publish(pid, again);
      expect(refused.result).toMatchObject({
        counts: { refused: 1, updated: 0 },
      });
      expect(fake.writes().filter((c) => c.method === "PATCH")).toHaveLength(
        patches,
      );
      expect(
        (await view(pid)).publishing.lastRun!.items.find(
          (i) => i.itemId === itemId,
        )?.message,
      ).toMatch(/edited on GitHub after this plan was made/);
    },
  );

  it(
    "reports labels and a milestone GitHub silently left out",
    { timeout: 120_000 },
    async () => {
      const other = await demoProject();
      const v = await plan(other);
      fake.dropLabelsAndMilestone = true;
      const done = await publish(other, v);
      fake.dropLabelsAndMilestone = false;
      expect(done.result).toMatchObject({ status: "completed" });
      const results = (await view(other)).publishing.lastRun!.items.filter(
        (i) => i.outcome === "created" && i.itemId.startsWith("uc:"),
      );
      expect(results.length).toBeGreaterThan(0);
      for (const r of results)
        expect(r.message).toMatch(
          /GitHub didn't apply labels .* and the milestone/,
        );
    },
  );
});
