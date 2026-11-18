/**
 * Publishing a delivery plan through the real HTTP app against a stateful fake Azure DevOps (never a live service):
 * offline-generated demo projects → plan → publish → repeat, refusals, unknown outcomes and "Check Azure DevOps",
 * lost local records. Proves the request order, the project scoping, that nothing is duplicated, and that nothing
 * is deleted or sent with bypassRules.
 */
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DeliveryPlanView } from "@shared/api";
import type { PublishItemResult } from "@shared/delivery";
import {
  DEFAULT_GENERATION_OPTIONS,
  type Job,
  type SolutionModel,
} from "@shared/types";
import { recordingContext } from "../agents/testContext";
import { authenticatedTestApp } from "../security/authTestUtils";
import { removeDir, useTempDataDir } from "../storage/testUtils";
import type { RecordedCall } from "../export/testUtils";
import { FakeAzdo } from "./fakeAzdo";
import { azdoSettings, SECRETS } from "./testFixtures";

let dir: string;
let server: http.Server;
let base: string;
let release: () => Promise<void>;
let authenticated: Awaited<ReturnType<typeof authenticatedTestApp>>;
let jobs: typeof import("../jobs/jobManager");
let store: typeof import("../storage/projectStore");
let cfg: typeof import("../config");
let fake: FakeAzdo;

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
  dir = await useTempDataDir("delivery-publish");
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
  await (
    await import("../storage/settingsStore")
  ).setIntegration({ system: "azdo", ...azdoSettings() });

  authenticated = await authenticatedTestApp();
  server = http.createServer(authenticated.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  authenticated.authenticate(base);

  fake = new FakeAzdo();
  // Another project in the same organisation, with an item that looks like Coherence's: never touched.
  fake.seed({
    project: "Other",
    type: "User Story",
    fields: {
      "System.Title": "Someone else's story",
      "System.Tags": "Coherence",
      "System.Description": "not ours",
    },
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
      return new Response(
        r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? ""),
        { status: r.status ?? 200, headers },
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

async function plan(pid: string) {
  const done = await job(pid, "plans", {
    target: "azdo",
    includeUnapproved: true,
    useAi: false,
  });
  expect(done.status).toBe("succeeded");
  return view(pid);
}

async function view(pid: string) {
  return (
    await api<DeliveryPlanView>(
      "GET",
      `/api/projects/${pid}/delivery/plans/azdo`,
    )
  ).body;
}

function publish(pid: string, v: DeliveryPlanView) {
  return job(pid, "plans/azdo/publish", {
    revision: v.plan.revision,
    fingerprint: v.fingerprint,
  });
}

const creates = () =>
  fake
    .writes()
    .filter((c) => c.method === "POST" && !c.url.includes("validateOnly=true"));

const outcomes = (v: DeliveryPlanView) =>
  Object.fromEntries(
    (v.publishing.lastRun?.items ?? []).map((i) => [i.itemId, i.outcome]),
  ) as Record<string, PublishItemResult["outcome"]>;

describe("publishing a delivery plan to Azure DevOps", () => {
  let pid: string;

  it(
    "creates Features, then work items with their parent, then dependency links; a repeat sends nothing",
    { timeout: 120_000 },
    async () => {
      pid = await demoProject();
      const first = await plan(pid);
      expect(first.publishing).toMatchObject({ enabled: true, needsCheck: 0 });
      expect(first.publishing.blockedReason).toBeUndefined();
      const groups = first.plan.items.filter((i) => i.role === "group");
      const requirements = first.plan.items.filter((i) => i.role !== "group");
      expect(first.publishing.scope.send).toHaveLength(first.plan.items.length);

      const done = await publish(pid, first);
      expect(done.status).toBe("succeeded");
      expect(done.result).toMatchObject({
        status: "completed",
        counts: { created: first.plan.items.length, refused: 0, uncertain: 0 },
      });

      // Every create was checked without saving before the first real write.
      const writes = fake.writes();
      const firstCreate = writes.findIndex(
        (c) => c.method === "POST" && !c.url.includes("validateOnly=true"),
      );
      expect(
        writes.filter((c) => c.url.includes("validateOnly=true")),
      ).toHaveLength(first.plan.items.length);
      expect(
        writes.slice(firstCreate).some((c) => c.url.includes("validateOnly")),
      ).toBe(false);
      // Features first, then the work items, each carrying its parent link in the same request.
      const order = creates().map((c) =>
        decodeURIComponent(/\$([^?]+)/.exec(c.url)![1]),
      );
      expect(order).toEqual([
        ...groups.map(() => "Feature"),
        ...requirements.map(() => "User Story"),
      ]);
      const stories = [...fake.items.values()].filter(
        (i) => i.project === "Portal" && i.type === "User Story",
      );
      expect(stories).toHaveLength(requirements.length);
      for (const story of stories) {
        expect(story.relations[0]).toMatchObject({
          rel: "System.LinkTypes.Hierarchy-Reverse",
          attributes: { comment: "Feature group (Coherence)" },
        });
        expect(String(story.fields["System.Tags"])).toMatch(
          /^coherence-test; Coherence; UC-\d+$/,
        );
      }
      for (const item of first.plan.items)
        expect(
          [...fake.items.values()].some((w) =>
            String(w.fields["System.Description"]).includes(item.durableKey),
          ),
        ).toBe(true);
      const dependencies = first.plan.relationships.filter(
        (r) => r.kind === "dependency" && r.status === "planned",
      );
      expect(dependencies.length).toBeGreaterThan(0);
      expect(
        stories.flatMap((s) =>
          s.relations.filter(
            (r) => r.rel === "System.LinkTypes.Dependency-Reverse",
          ),
        ),
      ).toHaveLength(dependencies.length);

      // Only the configured project was searched; nothing was deleted or sent around the rules.
      const queries = fake.calls.filter((c) =>
        c.url.includes("/_apis/wit/wiql"),
      );
      expect(queries.length).toBeGreaterThan(0);
      for (const q of queries)
        expect(String((q.body as { query: string }).query)).toContain(
          "[System.TeamProject] = @project",
        );
      expect(fake.calls.some((c) => c.method === "DELETE")).toBe(false);
      expect(
        fake.calls.some((c) =>
          /bypassRules|suppressNotifications/i.test(c.url),
        ),
      ).toBe(false);
      expect(
        [...fake.items.values()].find((i) => i.project === "Other")!.rev,
      ).toBe(1);

      // Recorded: the plan now shows everything as already there; the use cases carry their links.
      const after = await view(pid);
      expect(after.plan.items.every((i) => i.operation === "keep")).toBe(true);
      expect(after.publishing.blockedReason).toMatch(/already in Azure DevOps/);
      expect(after.publishing.lastRun).toMatchObject({ status: "completed" });
      const model = (await store.loadModel(pid)) as SolutionModel;
      expect(
        model.useCases.every((u) =>
          u.external.some((l) => l.system === "azdo"),
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

      // Publishing again sends nothing.
      const before = fake.writes().length;
      const again = await publish(pid, after);
      expect(again.status).toBe("failed");
      expect(again.error).toMatch(/already in Azure DevOps/);
      expect(fake.writes()).toHaveLength(before);
    },
  );

  it("refuses a plan that changed since the BA looked at it", async () => {
    const v = await view(pid);
    const before = fake.calls.length;
    const done = await job(pid, "plans/azdo/publish", {
      revision: v.plan.revision,
      fingerprint: "0".repeat(32),
    });
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/plan changed/);
    expect(fake.calls).toHaveLength(before);
  });

  it(
    "finds its own work items by durable key when the local records are lost, and creates nothing",
    { timeout: 60_000 },
    async () => {
      await fs.rm(
        path.join(cfg.paths.projectDir(pid), "delivery", "published"),
        { recursive: true, force: true },
      );
      // The links are gone from the model and from the .md front matter too (for example a restored backup).
      const model = (await store.loadModel(pid)) as SolutionModel;
      for (const uc of model.useCases) uc.external = [];
      await store.saveModel(pid, model);
      await (
        await import("../specs/specStore")
      ).writeSpecs(await store.getProject(pid), model, {
        preserveEdited: false,
        embedScreenImages: model.options.embedScreenImages,
      });
      const lost = await plan(pid);
      expect(lost.plan.items.every((i) => i.operation === "create")).toBe(true);
      const before = creates().length;
      const done = await publish(pid, lost);
      expect(done.status).toBe("succeeded");
      expect(done.result).toMatchObject({
        counts: { created: 0, reused: lost.plan.items.length },
      });
      expect(creates()).toHaveLength(before);
      expect(
        (await view(pid)).plan.items.every((i) => i.operation === "keep"),
      ).toBe(true);
    },
  );

  it(
    "stops before sending anything when Azure DevOps rejects the credentials",
    { timeout: 60_000 },
    async () => {
      const other = await demoProject();
      const v = await plan(other);
      fake.faults.push({
        when: (c) => c.url.includes("validateOnly=true"),
        status: 401,
        json: { message: "TF400813: not authorized" },
      });
      const before = fake
        .writes()
        .filter((c) => !c.url.includes("validateOnly")).length;
      const done = await publish(other, v);
      expect(done.status).toBe("failed");
      expect(done.error).toMatch(/credentials|personal access token/i);
      expect(
        fake.writes().filter((c) => !c.url.includes("validateOnly")),
      ).toHaveLength(before);
    },
  );

  it("keeps the classic export's live writes locked, and refuses a publish request it can't read", async () => {
    const malformed = await api<{ error: string }>(
      "POST",
      `/api/projects/${pid}/delivery/plans/azdo/publish`,
      { revision: 1, fingerprint: "not-a-fingerprint" },
    );
    expect(malformed.status).toBe(400);
    const live = await api<{ error: string }>(
      "POST",
      `/api/projects/${pid}/export`,
      {
        target: "azdo",
        useCaseIds: ["UC-001"],
        dryRun: false,
        createFeatureParents: true,
        linkDependencies: true,
        updateExisting: true,
        includeStoryPoints: false,
      },
    );
    expect(live.status).toBe(400);
  });
});

describe("refusals and unknown outcomes", () => {
  it(
    "leaves refused items behind with Azure DevOps's reason and creates nothing for them",
    { timeout: 120_000 },
    async () => {
      const pid = await demoProject();
      const v = await plan(pid);
      fake.required["User Story"] = ["Custom.Approver"];
      const before = creates().length;
      const done = await publish(pid, v);
      delete fake.required["User Story"];
      expect(done.status).toBe("succeeded");
      // No story can be saved, so their Features aren't created on their own either.
      expect(creates()).toHaveLength(before);
      const after = await view(pid);
      const results = after.publishing.lastRun!.items;
      for (const r of results.filter((i) => i.itemId.startsWith("uc:")))
        expect(r).toMatchObject({
          outcome: "refused",
          message: expect.stringMatching(
            /TF401320: Rule Error for field Custom\.Approver/,
          ),
        });
      for (const r of results.filter((i) => i.itemId.startsWith("group:")))
        expect(r.outcome).toBe("not-sent");
      // Nothing was saved, so nothing waits for a check; publishing again creates everything.
      expect(after.publishing.needsCheck).toBe(0);
      const retry = await publish(pid, after);
      expect(retry.result).toMatchObject({
        counts: { created: v.plan.items.length },
      });
    },
  );

  it(
    "stops at a write whose outcome is unknown; Check adopts a saved item or clears an unsaved one, and nothing is created twice",
    { timeout: 120_000 },
    async () => {
      const pid = await demoProject();
      const v = await plan(pid);
      const stories = () =>
        creates().filter((c) => c.url.includes("$User%20Story"));
      const storiesBefore = stories().length;
      // The first story is saved but the answer is lost.
      fake.faults.push({
        when: (c) =>
          c.method === "POST" &&
          c.url.includes("$User%20Story") &&
          !c.url.includes("validateOnly"),
        status: 500,
        apply: true,
      });
      const first = await publish(pid, v);
      expect(first.status).toBe("succeeded");
      expect(first.result).toMatchObject({
        status: "stopped",
        counts: { uncertain: 1 },
      });
      expect(stories()).toHaveLength(storiesBefore + 1);
      let now = await view(pid);
      expect(now.publishing.needsCheck).toBe(1);
      expect(now.publishing.blockedReason).toMatch(/Check Azure DevOps/);
      const uncertain = now.publishing.lastRun!.items.find(
        (i) => i.outcome === "uncertain",
      )!;
      // A publish is refused until the check has run.
      const refused = await publish(pid, now);
      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(/unknown outcome/);

      const check = await job(pid, "plans/azdo/check");
      expect(check.status).toBe("succeeded");
      now = await view(pid);
      expect(now.publishing.needsCheck).toBe(0);
      expect(now.publishing.lastRun!.items).toContainEqual(
        expect.objectContaining({
          itemId: uncertain.itemId,
          outcome: "reused",
        }),
      );
      expect(
        now.plan.items.find((i) => i.id === uncertain.itemId)?.operation,
      ).toBe("keep");

      // The next story isn't saved at all (a 500 before anything happened).
      fake.faults.push({
        when: (c) =>
          c.method === "POST" &&
          c.url.includes("$User%20Story") &&
          !c.url.includes("validateOnly"),
        status: 500,
      });
      const second = await publish(pid, now);
      expect(second.result).toMatchObject({
        status: "stopped",
        counts: { uncertain: 1 },
      });
      await job(pid, "plans/azdo/check");
      now = await view(pid);
      expect(now.publishing.needsCheck).toBe(0);
      expect(now.publishing.lastRun!.items[0]).toMatchObject({
        outcome: "not-sent",
      });

      const last = await publish(pid, now);
      expect(last.result).toMatchObject({ status: "completed" });
      // One work item per use case: the adopted one was not created again.
      const requirements = v.plan.items.filter((i) => i.role !== "group");
      const portalStories = [...fake.items.values()].filter(
        (i) =>
          i.type === "User Story" &&
          requirements.some((r) =>
            String(i.fields["System.Description"]).includes(r.durableKey),
          ),
      );
      expect(portalStories).toHaveLength(requirements.length);
    },
  );
});

describe("updating published work items", () => {
  async function editUseCase(
    pid: string,
    change: (uc: SolutionModel["useCases"][number]) => void,
  ) {
    const model = (await store.loadModel(pid)) as SolutionModel;
    const uc = model.useCases[0];
    change(uc);
    uc.revision += 1;
    await store.saveModel(pid, model);
    await (
      await import("../specs/specStore")
    ).writeSpecs(await store.getProject(pid), model, {
      preserveEdited: false,
      embedScreenImages: model.options.embedScreenImages,
    });
    return uc.id;
  }

  it(
    "sends only what changed in Coherence, keeps the team's edits and tags, and never overwrites an edit made after planning",
    { timeout: 180_000 },
    async () => {
      const pid = await demoProject();
      await publish(pid, await plan(pid));
      const ucId = (await store.loadModel(pid))!.useCases[0].id;
      const itemId = `uc:${ucId}`;
      const key = (await view(pid)).plan.items.find((i) => i.id === itemId)!
        .existing!.key;
      const workItem = () => fake.items.get(Number(key))!;

      // The team retitles the work item and adds a tag; the BA widens the use case's scope in Coherence.
      fake.edit(Number(key), {
        "System.Title": "Team's own title",
        "System.Tags": `${String(workItem().fields["System.Tags"])}; team-tag`,
      });
      await editUseCase(pid, (uc) => {
        uc.scope = `${uc.scope} Now also covers locked accounts.`;
      });
      const changed = await plan(pid);
      const planned = changed.plan.items.find((i) => i.id === itemId)!;
      expect(planned.operation).toBe("update");
      expect(planned.existing?.remoteRev).toBe(workItem().rev);
      const action = (fieldId: string) =>
        planned.fields.find((f) => f.fieldId === fieldId)?.updateAction;
      expect(action("System.Description")).toBe("send");
      expect(action("System.Title")).toBe("keep-destination");
      expect(action("System.Tags")).toBe("unchanged");
      expect(changed.publishing.scope.send).toEqual([itemId]);

      const done = await publish(pid, changed);
      expect(done.result).toMatchObject({
        status: "completed",
        counts: { updated: 1, created: 0 },
      });
      const patch = fake.calls
        .filter(
          (c) =>
            c.method === "PATCH" &&
            c.url.includes(`/workitems/${key}?`) &&
            !c.url.includes("validateOnly"),
        )
        .at(-1)!;
      expect((patch.body as { op: string }[])[0]).toEqual({
        op: "test",
        path: "/rev",
        value: planned.existing!.remoteRev,
      });
      expect((patch.body as { path: string }[]).map((o) => o.path)).toEqual([
        "/rev",
        "/fields/System.Description",
      ]);
      expect(workItem().fields["System.Title"]).toBe("Team's own title");
      expect(String(workItem().fields["System.Tags"])).toContain("team-tag");
      expect(String(workItem().fields["System.Description"])).toContain(
        "Now also covers locked accounts.",
      );
      let now = await view(pid);
      expect(now.plan.items.find((i) => i.id === itemId)?.operation).toBe(
        "keep",
      );

      // Changed again in Coherence, and the team rewrites the description after the plan was made.
      await editUseCase(pid, (uc) => {
        uc.scope = `${uc.scope} And expired passwords.`;
      });
      const again = await plan(pid);
      fake.edit(Number(key), {
        "System.Description": "<p>Team rewrote it</p>",
      });
      const refused = await publish(pid, again);
      expect(refused.result).toMatchObject({
        counts: { refused: 1, updated: 0 },
      });
      expect(workItem().fields["System.Description"]).toBe(
        "<p>Team rewrote it</p>",
      );
      now = await view(pid);
      expect(
        now.publishing.lastRun!.items.find((i) => i.itemId === itemId)?.message,
      ).toMatch(/edited in Azure DevOps after this plan was made/);

      // Planning again sees both sides changed: a question, and nothing is sent until it is answered.
      const conflict = await plan(pid);
      const question = conflict.plan.decisions.find(
        (d) => d.id === `conflict:${itemId}:System.Description`,
      )!;
      expect(question.resolution).toBeUndefined();
      expect(conflict.publishing.scope.notSent.map((n) => n.itemId)).toContain(
        itemId,
      );
      const answered = (
        await api<DeliveryPlanView>(
          "POST",
          `/api/projects/${pid}/delivery/plans/azdo/decisions`,
          { decisionId: question.id, value: "replace" },
        )
      ).body;
      expect(answered.publishing.scope.send).toEqual([itemId]);
      const replaced = await publish(pid, answered);
      expect(replaced.result).toMatchObject({ counts: { updated: 1 } });
      expect(String(workItem().fields["System.Description"])).toContain(
        "And expired passwords.",
      );
    },
  );
});
