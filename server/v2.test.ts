import { authenticatedTestApp } from "./security/authTestUtils";
let authenticated: Awaited<ReturnType<typeof authenticatedTestApp>>;
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GENERATION_OPTIONS,
  type SolutionModel,
  type UseCase,
} from "@shared/types";
import { recordingContext } from "./agents/testContext";
import { removeDir, useTempDataDir } from "./storage/testUtils";
let dir: string;
let profileClaim: import("./storage/instanceLock").InstanceLock;
let pid: string;
let model: SolutionModel;
let server: http.Server;
let base: string;
let store: typeof import("./storage/projectStore"),
  settings: typeof import("./storage/settingsStore"),
  specs: typeof import("./specs/specStore"),
  proposals: typeof import("./specs/revisionProposals"),
  jobs: typeof import("./jobs/jobManager"),
  cfg: typeof import("./config");
beforeAll(async () => {
  dir = await useTempDataDir("v2");
  vi.resetModules();
  store = await import("./storage/projectStore");
  settings = await import("./storage/settingsStore");
  specs = await import("./specs/specStore");
  proposals = await import("./specs/revisionProposals");
  jobs = await import("./jobs/jobManager");
  cfg = await import("./config");
  profileClaim = await (
    await import("./storage/instanceLock")
  ).acquireInstanceLock();
  await store.ensureDataDirs();
  const p = await (await import("./storage/demo")).createDemoProject();
  pid = p.id;
  await (
    await import("./agents/pipeline")
  ).runGeneration(recordingContext(pid), pid, {
    ...DEFAULT_GENERATION_OPTIONS,
    visionConnectionId: p.llm.visionConnectionId,
    textConnectionId: p.llm.textConnectionId,
  });
  model = (await store.loadModel(pid))!;
  authenticated = await authenticatedTestApp();
  server = http.createServer(authenticated.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  authenticated.authenticate(base);
}, 120_000); // Real full generation now uses mandatory native guarded project IO.
afterAll(async () => {
  await jobs.cancelAllJobs();
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await profileClaim?.();
  await removeDir(dir);
});
async function request(url: string, body: unknown) {
  const response = await authenticated.fetch(base + url, {
    method: "POST",
    headers: { "X-ScreenScribe": "1", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as { error?: string },
  };
}
describe("V2 isolation and protected configuration", () => {
  it("refuses lexical and junction escapes from V2", async () => {
    const { assertV2Path, V2_ROOT } = await import("./storage/boundary");
    expect(() =>
      assertV2Path(path.resolve(V2_ROOT, "../screenscribe - reference")),
    ).toThrow(/not an enrolled/);
    expect(assertV2Path(path.join(dir, "safe.md"))).toContain(dir);
    if (process.platform === "win32") {
      const link = path.join(dir, "escape-junction");
      await fs.symlink("C:/Windows", link, "junction");
      try {
        expect(() => assertV2Path(path.join(link, "test.txt"))).toThrow(
          "symbolic",
        );
      } finally {
        await fs.unlink(link);
      }
    }
  });
  it("does not inherit a conventional provider environment key", async () => {
    const saved = process.env.OPENAI_API_KEY;
    const v2 = process.env.SCREENSCRIBE_V2_OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "synthetic-conventional-key";
    delete process.env.SCREENSCRIBE_V2_OPENAI_API_KEY;
    try {
      const connection = await settings.resolveConnectionInput({
        provider: "openai",
        name: "Test",
        model: "contract-fixture",
      });
      expect(
        (await import("./llm/providers/common")).resolveApiKey(connection),
      ).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
      if (v2 !== undefined) process.env.SCREENSCRIBE_V2_OPENAI_API_KEY = v2;
    }
  });
  it("resolves every cloud provider through V2-only environment names, including Azure", async () => {
    const { PROVIDER_PRESETS } = await import("@shared/providers");
    const { resolveApiKey } = await import("./llm/providers/common");
    for (const preset of Object.values(PROVIDER_PRESETS)) {
      if (!preset.apiKeyEnvVar) continue;
      expect(preset.apiKeyEnvVar).toMatch(/^SCREENSCRIBE_V2_/);
      const name = preset.apiKeyEnvVar;
      const original = process.env[name];
      const conventional = name.slice("SCREENSCRIBE_V2_".length);
      const oldConventional = process.env[conventional];
      try {
        process.env[conventional] = "synthetic-conventional-do-not-use";
        delete process.env[name];
        const c = await settings.resolveConnectionInput({
          provider: preset.kind,
          name: "Environment fixture",
          model: "fixture-deployment",
          baseUrl:
            preset.kind === "azure-openai"
              ? "https://fixture.openai.azure.com"
              : preset.defaultBaseUrl,
        });
        expect(resolveApiKey(c)).toBeUndefined();
        process.env[name] = "synthetic-v2-env-do-not-send";
        if (preset.kind === "azure-openai") {
          expect(resolveApiKey(c)).toBeUndefined();
          vi.stubEnv("SCREENSCRIBE_V2_AZURE_OPENAI_ENDPOINT", c.baseUrl!);
        }
        expect(resolveApiKey(c)).toBe("synthetic-v2-env-do-not-send");
      } finally {
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
        if (oldConventional === undefined) delete process.env[conventional];
        else process.env[conventional] = oldConventional;
      }
    }
  });
  it.skipIf(process.platform !== "win32")(
    "protects secrets, round-trips and rejects damaged DPAPI ciphertext",
    async () => {
      const { protectSettings, unprotectSettings } =
        await import("./storage/protectedSecrets");
      const input = {
        connections: [{ apiKey: "synthetic-secret-do-not-send" }],
        integrations: { github: { token: "synthetic-token" } },
      };
      const protectedValue = await protectSettings(input);
      const serialized = JSON.stringify(protectedValue);
      expect(serialized).not.toContain("synthetic-secret");
      expect(serialized).not.toContain("synthetic-token");
      expect(await unprotectSettings(protectedValue)).toEqual(input);
      protectedValue._protectedSecrets!.ciphertext = "AAAA";
      await expect(unprotectSettings(protectedValue)).rejects.toThrow("unlock");
    },
  );
  it("saves a configuration transaction once and rejects stale or invalid drafts without partial writes", async () => {
    const current = await settings.getPublicSettings();
    const row = current.connections[0];
    const input = {
      baseRevision: current.revision ?? 0,
      connections: [
        {
          id: row.id,
          provider: "mock" as const,
          model: "demo",
          name: "Atomic demo",
        },
      ],
      defaultConnectionId: row.id,
      integrations: [],
      preferences: { theme: "dark" },
    };
    const saved = await settings.replaceWorkspaceSettings(input);
    expect(saved.connections[0].name).toBe("Atomic demo");
    const onDisk = await fs.readFile(cfg.paths.settingsFile(), "utf8");
    await expect(
      settings.replaceWorkspaceSettings(input),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      settings.replaceWorkspaceSettings({
        ...input,
        baseRevision: saved.revision!,
        connections: [
          {
            ...input.connections[0],
            name: "Must not persist",
            baseUrl: "file:///bad",
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await fs.readFile(cfg.paths.settingsFile(), "utf8")).toBe(onDisk);
  });
  it("binds a demo project to the offline provider even when another default exists", async () => {
    const real = await settings.createConnection({
      provider: "openai",
      model: "no-request-fixture",
      name: "Uncalled cloud",
    });
    await settings.setDefaultConnection(real.id);
    const demo = await (await import("./storage/demo")).createDemoProject();
    expect(
      (await settings.getConnection(demo.llm.visionConnectionId!)).provider,
    ).toBe("mock");
    expect(demo.llm.textConnectionId).toBe(demo.llm.visionConnectionId);
  });
});
describe("V2 document and operation safety", () => {
  it("detects external edits even when modification time is preserved", async () => {
    const project = await store.getProject(pid);
    const uc = model.useCases[0];
    const file = await specs.readSpecFile(project, uc.filePath!);
    const absolute = path.join(project.outputDir, uc.filePath!);
    const stat = await fs.stat(absolute);
    await fs.writeFile(absolute, file.content + "\nExternal modification\n");
    await fs.utimes(absolute, stat.atime, stat.mtime);
    await expect(
      specs.saveSpecFile(project, {
        path: uc.filePath!,
        content: file.content + "\nOld editor\n",
        baseHash: file.contentHash,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await fs.readFile(absolute, "utf8")).toContain(
      "External modification",
    );
    await fs.writeFile(absolute, file.content);
  });
  it("proposes a revision without writing the spec, then applies only once", async () => {
    const project = await store.getProject(pid);
    const before = (await store.loadModel(pid))!.useCases[0];
    const file = await specs.readSpecFile(project, before.filePath!);
    const next = {
      ...before,
      scope: before.scope + " Reviewed proposal addition.",
    };
    const proposal = await proposals.createRevisionProposal(
      project,
      model,
      before,
      next,
      file.contentHash!,
    );
    expect((await specs.readSpecFile(project, before.filePath!)).content).toBe(
      file.content,
    );
    const reviewed = await proposals.reviewRevisionProposal(pid, proposal.id);
    await proposals.applyRevisionProposal(
      pid,
      proposal.id,
      reviewed.reviewToken,
    );
    expect(
      (await specs.readSpecFile(project, before.filePath!)).content,
    ).toContain("Reviewed proposal addition.");
    await expect(
      proposals.applyRevisionProposal(pid, proposal.id, reviewed.reviewToken),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("refuses an obsolete proposal after a later human edit", async () => {
    const project = await store.getProject(pid);
    const fresh = (await store.loadModel(pid))!;
    const before = fresh.useCases[0];
    const file = await specs.readSpecFile(project, before.filePath!);
    const proposal = await proposals.createRevisionProposal(
      project,
      fresh,
      before,
      { ...before, scope: "An obsolete proposal" },
      file.contentHash!,
    );
    const reviewed = await proposals.reviewRevisionProposal(pid, proposal.id);
    await specs.saveSpecFile(project, {
      path: before.filePath!,
      content: file.content + "\nA later human note.\n",
      baseHash: file.contentHash,
    });
    await expect(
      proposals.applyRevisionProposal(pid, proposal.id, reviewed.reviewToken),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await specs.readSpecFile(project, before.filePath!)).content,
    ).toContain("A later human note.");
  });
  it("persists a discarded proposal without changing its document and refuses later apply", async () => {
    const project = await store.getProject(pid);
    const fresh = (await store.loadModel(pid))!;
    const before = fresh.useCases[1];
    const file = await specs.readSpecFile(project, before.filePath!);
    const proposal = await proposals.createRevisionProposal(
      project,
      fresh,
      before,
      { ...before, scope: "Discarded revision must never be written" },
      file.contentHash!,
    );
    const reviewed = await proposals.reviewRevisionProposal(pid, proposal.id);
    await proposals.discardRevisionProposal(pid, proposal.id);
    expect((await proposals.getRevisionProposal(pid, proposal.id)).status).toBe(
      "discarded",
    );
    await expect(
      proposals.applyRevisionProposal(pid, proposal.id, reviewed.reviewToken),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await specs.readSpecFile(project, before.filePath!)).contentHash,
    ).toBe(file.contentHash);
  });
  it("requires fresh approval when the body of an approved document is edited", async () => {
    const project = await store.getProject(pid);
    const before = (await store.loadModel(pid))!.useCases[1];
    await specs.setUseCaseStatus(project, before.id, "approved");
    const file = await specs.readSpecFile(project, before.filePath!);
    await specs.saveSpecFile(project, {
      path: before.filePath!,
      baseHash: file.contentHash,
      content: file.content + "\nHuman wording added after approval.\n",
    });
    expect(
      (await store.loadModel(pid))!.useCases.find((u) => u.id === before.id)!
        .status,
    ).toBe("edited");
    expect(
      (await specs.readSpecFile(project, before.filePath!)).content,
    ).toContain("Human wording added after approval.");
  });
  it("persists a queued job before exposing its ID and marks interrupted jobs on restart", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started = await jobs.startJob("revise", pid, async () => {
      await gate;
      return { ok: true };
    });
    const queued = JSON.parse(
      await fs.readFile(
        path.join(cfg.paths.jobsDir(pid), started.id + ".json"),
        "utf8",
      ),
    );
    expect(queued.id).toBe(started.id);
    expect(["queued", "running"]).toContain(queued.status);
    release();
    await jobs.waitForJob(started.id);
    const fake = { ...queued, id: "job_interrupted123", status: "running" };
    await fs.writeFile(
      path.join(cfg.paths.jobsDir(pid), fake.id + ".json"),
      JSON.stringify(fake),
    );
    expect(
      await (await import("./jobs/recovery")).recoverInterruptedJobs(),
    ).toBe(1);
    const recovered = await jobs.getJob(fake.id);
    expect(recovered.status).toBe("failed");
    expect(recovered.error).toContain("explicitly retry");
  });
  it("blocks live tracker writes at the HTTP boundary before contacting a tracker", async () => {
    const result = await request(`/api/projects/${pid}/export`, {
      target: "github",
      useCaseIds: [model.useCases[0].id],
      dryRun: false,
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("locked");
  });
  it("refuses a second process claiming the same data root", async () => {
    const { acquireInstanceLock } = await import("./storage/instanceLock");
    await expect(acquireInstanceLock()).rejects.toThrow("Another V2 process");
  });
  it.each([
    "dark",
    "light",
    "system",
    "ocean",
    "cyberpunk",
    "retrowave",
    "terminal",
    "forest",
    "cute",
  ])(
    "round-trips the %s theme and optional background preference through the authenticated workspace API",
    async (theme) => {
      const current = await settings.getPublicSettings();
      const response = await authenticated.fetch(
        base + "/api/settings/workspace",
        {
          method: "PUT",
          headers: {
            "X-ScreenScribe": "1",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            baseRevision: current.revision ?? 0,
            connections: current.connections,
            defaultConnectionId: current.defaultConnectionId,
            integrations: [],
            preferences: {
              theme,
              backgroundEffects: false,
              density: "compact",
              reduceMotion: true,
              visionId: current.defaultConnectionId,
              textId: current.defaultConnectionId,
              thoroughness: "standard",
              granularity: "balanced",
              preserveEdits: true,
              embedImages: true,
              reuseAnalysis: true,
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      const saved = await settings.getPublicSettings();
      expect(saved.preferences).toMatchObject({
        theme,
        backgroundEffects: false,
        density: "compact",
        reduceMotion: true,
      });
      expect(saved.defaultConnectionId).toBe(current.defaultConnectionId);
      expect(saved.connections.map((c) => c.id)).toEqual(
        current.connections.map((c) => c.id),
      );
    },
  );
  it.each([
    { theme: "invented-theme", backgroundEffects: true },
    { theme: "ocean", backgroundEffects: "on" },
  ])(
    "rejects malformed appearance preferences atomically (%j)",
    async (appearance) => {
      const current = await settings.getPublicSettings();
      const before = await fs.readFile(cfg.paths.settingsFile(), "utf8");
      const response = await authenticated.fetch(
        base + "/api/settings/workspace",
        {
          method: "PUT",
          headers: {
            "X-ScreenScribe": "1",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            baseRevision: current.revision ?? 0,
            connections: current.connections,
            defaultConnectionId: current.defaultConnectionId,
            integrations: [],
            preferences: {
              ...appearance,
              density: "comfortable",
              reduceMotion: false,
              visionId: current.defaultConnectionId,
              textId: current.defaultConnectionId,
              thoroughness: "standard",
              granularity: "balanced",
              preserveEdits: true,
              embedImages: true,
              reuseAnalysis: true,
            },
          }),
        },
      );
      expect(response.status).toBe(400);
      expect(await fs.readFile(cfg.paths.settingsFile(), "utf8")).toBe(before);
    },
  );
  it("uses complete screen fingerprints for context and model changes", async () => {
    const { analysisFingerprint } = await import("./agents/runState");
    const screen = { version: 1, name: "Sign in", notes: "Required email" };
    const a = analysisFingerprint(screen, "reader-v1", "standard", "context A");
    expect(
      analysisFingerprint(
        { ...screen, notes: "Optional email" },
        "reader-v1",
        "standard",
        "context A",
      ),
    ).not.toBe(a);
    expect(
      analysisFingerprint(screen, "reader-v2", "standard", "context A"),
    ).not.toBe(a);
    expect(
      analysisFingerprint(screen, "reader-v1", "standard", "context B"),
    ).not.toBe(a);
  });
});
