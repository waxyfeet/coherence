/** Actual tracker clients against an isolated loopback fixture; never a Jira/AzDO/GitHub service. */
import http from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  DEFAULT_GENERATION_OPTIONS,
  type ExternalSystem,
  type SolutionModel,
} from "@shared/types";
import { recordingContext } from "../agents/testContext";
import { removeDir, useTempDataDir } from "../storage/testUtils";
let dir: string,
  base: string,
  server: http.Server,
  model: SolutionModel,
  pid: string;
let settings: typeof import("../storage/settingsStore"),
  exporter: typeof import("./exporter"),
  store: typeof import("../storage/projectStore");
let sequence = 0;
const calls: { method: string; url: string; body: any }[] = [];
const issues = new Map<number, any>();
beforeAll(async () => {
  dir = await useTempDataDir("tracker-transports");
  vi.resetModules();
  server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    const url = req.url!,
      method = req.method!;
    calls.push({ method, url, body });
    res.setHeader("Content-Type", "application/json");
    if (url.startsWith("/repos/fixture/repo/issues")) {
      const id = Number(/\/issues\/(\d+)/.exec(url)?.[1]) || ++sequence;
      const item = {
        ...issues.get(id),
        ...body,
        number: id,
        html_url: `${base}/fixture/repo/issues/${id}`,
        labels: body?.labels ?? issues.get(id)?.labels ?? [],
      };
      issues.set(id, item);
      res.end(JSON.stringify(item));
    } else if (url.startsWith("/rest/api/2/issueLink")) {
      res.end("{}");
    } else if (url.startsWith("/rest/api/2/issue")) {
      const key = /\/issue\/([^?]+)/.exec(url)?.[1] ?? `ABC-${++sequence}`;
      res.end(JSON.stringify({ key, fields: { issuelinks: [] } }));
    } else if (url.includes("/_apis/wit/workitems")) {
      const id = Number(/\/workitems\/(\d+)/.exec(url)?.[1]) || ++sequence;
      res.end(
        JSON.stringify({
          id,
          fields: {},
          relations: [],
          _links: {
            html: { href: `${base}/org/Portal/_workitems/edit/${id}` },
          },
        }),
      );
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Unexpected fixture route" }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  store = await import("../storage/projectStore");
  settings = await import("../storage/settingsStore");
  exporter = await import("./exporter");
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
  model = (await store.loadModel(pid))!;
}, 120_000);
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await removeDir(dir);
});
it.each(["jira", "azdo", "github"] as ExternalSystem[])(
  "creates, links, persists and updates through the real %s client on loopback",
  async (target) => {
    await settings.setIntegration(
      target === "jira"
        ? {
            system: "jira",
            baseUrl: base,
            deployment: "cloud",
            projectKey: "ABC",
            email: "fixture@example.invalid",
            apiToken: "synthetic-token",
            issueType: "Story",
            epicIssueType: "Epic",
            labels: [],
            linkType: "Blocks",
          }
        : target === "azdo"
          ? {
              system: "azdo",
              orgUrl: base + "/org",
              project: "Portal",
              pat: "synthetic-token",
              workItemType: "User Story",
              parentWorkItemType: "Feature",
              tags: [],
            }
          : {
              system: "github",
              apiBaseUrl: base,
              owner: "fixture",
              repo: "repo",
              token: "synthetic-token",
              labels: [],
              useMilestonesForFeatures: false,
            },
    );
    const dependent = model.useCases.find((u) => u.dependsOn.length > 0)!;
    const selected = [dependent.dependsOn[0], dependent.id];
    const request = {
      target,
      useCaseIds: selected,
      dryRun: false,
      createFeatureParents: false,
      linkDependencies: true,
      updateExisting: true,
      includeStoryPoints: false,
    };
    const before = calls.length;
    const created = await exporter.runExport(
      { ...recordingContext(pid), jobId: "job_create_" + target },
      pid,
      request,
    );
    expect(created.items.map((i) => i.action)).toEqual(["created", "created"]);
    expect(created.links.some((l) => l.ok)).toBe(true);
    const fresh = (await store.loadModel(pid))!;
    for (const id of selected) {
      const link = fresh.useCases
        .find((u) => u.id === id)!
        .external.find((e) => e.system === target);
      expect(link?.url).toContain(base.replace("http://", ""));
    }
    const updated = await exporter.runExport(
      { ...recordingContext(pid), jobId: "job_update_" + target },
      pid,
      request,
    );
    expect(updated.items.map((i) => i.action)).toEqual(["updated", "updated"]);
    const own = calls.slice(before);
    expect(own.some((c) => c.method === "POST" || c.method === "PATCH")).toBe(
      true,
    );
    expect(own.every((c) => !c.url.includes("https://"))).toBe(true);
    const journals = await (await import("./journal")).listExportJournals(pid);
    expect(
      journals
        .filter((j) => j.target === target)
        .every((j) => j.operations.every((o) => o.state === "complete")),
    ).toBe(true);
    const count = calls.length;
    const dry = await exporter.runExport(recordingContext(pid), pid, {
      ...request,
      dryRun: true,
    });
    expect(dry.items.every((i) => i.action === "would-update")).toBe(true);
    expect(calls).toHaveLength(count);
  },
);
