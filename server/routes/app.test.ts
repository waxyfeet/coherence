import { authenticatedTestApp } from "../security/authTestUtils";
let authenticated: Awaited<ReturnType<typeof authenticatedTestApp>>;
/**
 * HTTP smoke test: the real Express app on an ephemeral port, exercised with fetch / http.request.
 * Only routes backed by server-core modules are exercised here; the spec-file, graph, impact and CSV routes
 * are covered by specRoutes.test.ts (generation itself is exercised by the agents' own tests).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobStarted, ProjectDetail } from "@shared/api";
import type {
  Job,
  JobEvent,
  Project,
  ProjectSummary,
  PublicSettings,
  Screen,
} from "@shared/types";
import { makePng, removeDir, useTempDataDir } from "../storage/testUtils";

type Jobs = typeof import("../jobs/jobManager");

let dataDir: string;
let server: http.Server;
let base: string;
let port: number;
let jobs: Jobs;

const H = { "X-ScreenScribe": "1" };

async function api<T>(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = H,
): Promise<{ status: number; body: T; headers: Headers }> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
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

/** http.request lets us send an arbitrary Host header (fetch does not). */
function rawGet(
  pathname: string,
  host: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "GET",
        headers: {
          Host: host,
          Authorization: authenticated.authorization(
            `http://127.0.0.1:${port}`,
          ),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A request as a cross-site form would send it: any method/path/headers, raw body. */
function rawRequest(
  method: string,
  pathname: string,
  headers: Record<string, string>,
  body = "",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: { Host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Reads an SSE stream until the server closes it. */
function readEvents(
  pathname: string,
): Promise<{ status: number; contentType?: string; events: JobEvent[] }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "GET",
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: authenticated.authorization(
            `http://127.0.0.1:${port}`,
          ),
        },
      },
      (res) => {
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (buffer += chunk));
        res.on("end", () => {
          const events = buffer
            .split("\n\n")
            .map((block) =>
              block
                .split("\n")
                .filter((l) => l.startsWith("data: "))
                .map((l) => l.slice(6))
                .join("\n"),
            )
            .filter(Boolean)
            .map((data) => JSON.parse(data) as JobEvent);
          resolve({
            status: res.statusCode ?? 0,
            contentType: res.headers["content-type"],
            events,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  dataDir = await useTempDataDir("http");
  for (const k of [
    "SCREENSCRIBE_V2_ANTHROPIC_API_KEY",
    "SCREENSCRIBE_V2_OPENAI_API_KEY",
    "SCREENSCRIBE_V2_GEMINI_API_KEY",
  ])
    delete process.env[k];
  vi.resetModules();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { createApp } = await import("../app");
  const store = await import("../storage/projectStore");
  jobs = await import("../jobs/jobManager");
  await store.ensureDataDirs();
  authenticated = await authenticatedTestApp();
  server = http.createServer(authenticated.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  authenticated.authenticate(base);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  vi.restoreAllMocks();
  await removeDir(dataDir);
});

describe("HTTP API smoke test", () => {
  it("serves health", async () => {
    const res = await api<{ ok: boolean; version: string; dataDir: string }>(
      "GET",
      "/api/health",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, version: expect.any(String) });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("enforces the Host and CSRF guards", async () => {
    expect((await rawGet("/api/health", "evil.example:80")).status).toBe(403);
    expect((await rawGet("/api/health", `127.0.0.1:${port}`)).status).toBe(200);
    expect((await rawGet("/api/health", `localhost:${port}`)).status).toBe(403);
    const noHeader = await api<{ code: string }>(
      "POST",
      "/api/projects",
      { name: "x", description: "" },
      {},
    );
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.code).toBe("CSRF");
  });

  it("does not let a cross-site form reach the API by changing the case of /api", async () => {
    const before = (await api<ProjectSummary[]>("GET", "/api/projects")).body
      .length;
    const evil = {
      Origin: "https://evil.example",
      "Content-Type": "text/plain",
    };
    // The API router itself still matches /api/PROJECTS, so the guard must not depend on the path at all.
    for (const pathname of [
      "/API/projects/demo",
      "/Api/projects/demo",
      "/aPi/projects/demo",
      "/api/PROJECTS/demo",
    ]) {
      const res = await rawRequest("POST", pathname, evil, "x=1");
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ code: "CSRF" });
    }
    // Even with the header, a foreign Origin is refused, and /API is not an alias of /api any more.
    expect(
      (
        await rawRequest("POST", "/API/projects/demo", {
          ...evil,
          "X-ScreenScribe": "1",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await rawRequest("POST", "/API/projects/demo", {
          "X-ScreenScribe": "1",
        })
      ).status,
    ).toBe(404);
    expect(
      (await api<ProjectSummary[]>("GET", "/api/projects")).body,
    ).toHaveLength(before);
  });

  it("returns JSON errors for unknown API routes, bad JSON and validation failures", async () => {
    const unknown = await api<{ code: string }>("GET", "/api/nope");
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("NOT_FOUND");

    const badJson = await authenticated.fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: "{oops",
    });
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { error: string }).error).toMatch(
      /not valid JSON/,
    );

    const invalid = await api<{ error: string; code: string }>(
      "POST",
      "/api/projects",
      { description: "no name" },
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("VALIDATION");
    expect(invalid.body.error).toMatch(/name/);
  });

  it("serves masked settings with the default offline connection", async () => {
    const res = await api<PublicSettings>("GET", "/api/settings");
    expect(res.status).toBe(200);
    expect(res.body.connections).toHaveLength(1);
    expect(res.body.connections[0]).toMatchObject({
      provider: "mock",
      hasApiKey: false,
    });
    expect(res.body.defaultConnectionId).toBe(res.body.connections[0].id);
    expect(res.body.dataDir).toBeTruthy();

    const created = await api<PublicSettings["connections"][number]>(
      "POST",
      "/api/settings/connections",
      {
        name: "Claude",
        provider: "anthropic",
        model: "claude-opus-5-5",
        apiKey: "sk-ant-http-test-WXYZ",
      },
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      hasApiKey: true,
      apiKeyHint: "…WXYZ",
    });
    expect(JSON.stringify(created.body)).not.toContain("sk-ant-http-test");

    const def = await api<PublicSettings>(
      "PUT",
      "/api/settings/default-connection",
      { connectionId: created.body.id },
    );
    expect(def.body.defaultConnectionId).toBe(created.body.id);

    const integration = await api<PublicSettings>(
      "PUT",
      "/api/settings/integrations/github",
      {
        owner: "acme",
        repo: "specs",
        token: "ghp_secret_1234",
        labels: ["spec"],
        apiBaseUrl: "",
        useMilestonesForFeatures: true,
      },
    );
    expect(integration.status).toBe(200);
    expect(integration.body.integrations.github).toMatchObject({
      token: "",
      hasSecret: true,
      owner: "acme",
    });
    expect(
      (await api("PUT", "/api/settings/integrations/trello", {})).status,
    ).toBe(400);

    const figma = await api<PublicSettings>("PUT", "/api/settings/figma", {
      token: "figd_abcdefgh",
    });
    expect(figma.body.figma).toEqual({ hasToken: true, tokenHint: "…efgh" });
    const figmaTestMissing = await api<{ ok: boolean }>(
      "DELETE",
      "/api/settings/figma",
    );
    expect(figmaTestMissing.status).toBe(200);

    const del = await api<{ ok: boolean }>(
      "DELETE",
      `/api/settings/connections/${created.body.id}`,
    );
    expect(del.body).toEqual({ ok: true });
    expect(
      (await api("DELETE", `/api/settings/connections/${created.body.id}`))
        .status,
    ).toBe(404);
  });

  it("runs the project & screen lifecycle", async () => {
    const created = await api<Project>("POST", "/api/projects", {
      name: "Smoke Test Project",
      description: "Testing the API.",
    });
    expect(created.status).toBe(201);
    const pid = created.body.id;
    expect(pid).toMatch(/^smoke-test-project-[a-z0-9-]{10}$/);

    // Upload two screens (multipart, field "files").
    const form = new FormData();
    form.append(
      "files",
      new Blob([new Uint8Array(await makePng(64, 48))], { type: "image/png" }),
      "Login screen.png",
    );
    form.append(
      "files",
      new Blob([new Uint8Array(await makePng(32, 80))], { type: "image/png" }),
      "Dashboard.png",
    );
    const uploaded = await api<Screen[]>(
      "POST",
      `/api/projects/${pid}/screens`,
      form,
    );
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.map((s) => [s.name, s.width, s.height])).toEqual([
      ["Login screen", 64, 48],
      ["Dashboard", 32, 80],
    ]);
    const [login, dash] = uploaded.body;

    // A non-image is rejected by magic bytes even if it claims to be a PNG.
    const bad = new FormData();
    bad.append(
      "files",
      new Blob(["definitely text"], { type: "image/png" }),
      "fake.png",
    );
    const rejected = await api<{ error: string }>(
      "POST",
      `/api/projects/${pid}/screens`,
      bad,
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/fake\.png/);

    const list = await api<ProjectSummary[]>("GET", "/api/projects");
    expect(list.body.find((p) => p.id === pid)).toMatchObject({
      screenCount: 2,
      useCaseCount: 0,
      thumbnailScreenId: login.id,
    });

    const patched = await api<Project>("PATCH", `/api/projects/${pid}`, {
      name: "Renamed project",
      additionalContext: "Roles: admin",
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      id: pid,
      name: "Renamed project",
      additionalContext: "Roles: admin",
    });
    expect(
      (await api("PATCH", `/api/projects/${pid}`, { outputDir: "relative" }))
        .status,
    ).toBe(400);
    expect(
      (
        await api("PATCH", `/api/projects/${pid}`, {
          llm: { visionConnectionId: "conn_missing" },
        })
      ).status,
    ).toBe(400);

    const screenPatch = await api<Screen>(
      "PATCH",
      `/api/projects/${pid}/screens/${login.id}`,
      { name: "Sign in", notes: "SSO later" },
    );
    expect(screenPatch.body).toMatchObject({
      name: "Sign in",
      notes: "SSO later",
    });

    const reordered = await api<Screen[]>(
      "PUT",
      `/api/projects/${pid}/screens-order`,
      { screenIds: [dash.id, login.id] },
    );
    expect(reordered.status).toBe(200);
    expect(reordered.body.map((s) => s.id)).toEqual([dash.id, login.id]);
    expect(
      (
        await api("PUT", `/api/projects/${pid}/screens-order`, {
          screenIds: [dash.id],
        })
      ).status,
    ).toBe(400);

    // Replace an image → version 2; both versions are served.
    const replace = new FormData();
    replace.append(
      "file",
      new Blob([new Uint8Array(await makePng(100, 50))], { type: "image/png" }),
      "Login v2.png",
    );
    const replaced = await api<Screen>(
      "PUT",
      `/api/projects/${pid}/screens/${login.id}/image`,
      replace,
    );
    expect(replaced.body).toMatchObject({ version: 2, width: 100, height: 50 });
    const current = await authenticated.fetch(
      `${base}/api/projects/${pid}/screens/${login.id}/image`,
    );
    expect(current.status).toBe(200);
    expect(current.headers.get("content-type")).toBe("image/png");
    expect(current.headers.get("cache-control")).toBe("no-store");
    const v1 = await authenticated.fetch(
      `${base}/api/projects/${pid}/screens/${login.id}/image?version=1`,
    );
    expect(v1.status).toBe(200);
    expect(v1.headers.get("cache-control")).toBe("no-store");
    expect((await v1.arrayBuffer()).byteLength).toBe(login.sizeBytes);
    expect(
      (
        await authenticated.fetch(
          `${base}/api/projects/${pid}/screens/${login.id}/image?version=9`,
        )
      ).status,
    ).toBe(404);

    const detail = await api<ProjectDetail>("GET", `/api/projects/${pid}`);
    expect(detail.body).toMatchObject({
      id: pid,
      hasModel: false,
      useCaseCount: 0,
      staleCount: 0,
      changedScreenIds: [],
    });
    expect(detail.body.activeJobId).toBeUndefined();

    expect((await api("GET", `/api/projects/${pid}/model`)).status).toBe(404);
    expect((await api("GET", `/api/projects/${pid}/graph`)).body).toEqual({
      nodes: [],
      edges: [],
    });
    expect(
      (
        await api("POST", `/api/projects/${pid}/impact/preview`, {
          targetKind: "free",
          description: "Change all buttons",
        })
      ).status,
    ).toBe(400);
    expect((await api("GET", `/api/projects/${pid}/impact`)).body).toEqual([]);
    expect((await api("GET", `/api/projects/${pid}/jobs`)).body).toEqual([]);

    const delScreen = await api<{ ok: boolean }>(
      "DELETE",
      `/api/projects/${pid}/screens/${dash.id}`,
    );
    expect(delScreen.body).toEqual({ ok: true });
    expect(
      (
        await api<ProjectDetail>("GET", `/api/projects/${pid}`)
      ).body.screens.map((s) => s.id),
    ).toEqual([login.id]);

    expect((await api("DELETE", `/api/projects/${pid}`)).status).toBe(400);
    const latest = await api<Project>("GET", `/api/projects/${pid}`);
    const deleted = await api<{ ok: boolean }>(
      "POST",
      `/api/projects/${pid}/trash`,
      { confirmation: pid, expectedUpdatedAt: latest.body.updatedAt },
    );
    expect(deleted.body).toEqual({ ok: true });
    expect((await api("GET", `/api/projects/${pid}`)).status).toBe(409);
  });

  it("creates the demo project", async () => {
    const res = await api<Project>("POST", "/api/projects/demo", {});
    expect(res.status).toBe(201);
    expect(res.body.screens).toHaveLength(4);
    const img = await authenticated.fetch(
      `${base}/api/projects/${res.body.id}/screens/${res.body.screens[0].id}/image`,
    );
    expect(img.status).toBe(200);
  });

  it("streams job events over SSE and supports cancel", async () => {
    const project = await api<Project>("POST", "/api/projects", {
      name: "SSE project",
      description: "",
    });
    const pid = project.body.id;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = await jobs.startJob("export", pid, async (ctx) => {
      ctx.setStages(["Exporting"]);
      ctx.stage("Exporting", 1);
      await gate;
      ctx.tick("UC-001");
      return { exported: 1 };
    });
    const streamPromise = readEvents(`/api/jobs/${job.id}/events`);
    await new Promise((r) => setTimeout(r, 50));
    const detail = await api<ProjectDetail>("GET", `/api/projects/${pid}`);
    expect(detail.body.activeJobId).toBe(job.id);
    release();
    const stream = await streamPromise;
    expect(stream.status).toBe(200);
    expect(stream.contentType).toMatch(/text\/event-stream/);
    expect(stream.events[0].type).toBe("snapshot");
    const last = stream.events.at(-1)!;
    expect(last).toMatchObject({
      type: "status",
      status: "succeeded",
      result: { exported: 1 },
    });
    expect(stream.events.some((e) => e.type === "progress")).toBe(true);

    // Finished job: GET + a snapshot-only stream; listed for the project.
    const fetched = await api<Job>("GET", `/api/jobs/${job.id}`);
    expect(fetched.body.status).toBe("succeeded");
    const replay = await readEvents(`/api/jobs/${job.id}/events`);
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]).toMatchObject({
      type: "snapshot",
      job: { status: "succeeded" },
    });
    expect(
      (await api<Job[]>("GET", `/api/projects/${pid}/jobs`)).body.map(
        (j) => j.id,
      ),
    ).toContain(job.id);

    // Cancel a running job through the API.
    const running = await jobs.startJob(
      "export",
      pid,
      (ctx) =>
        new Promise((_, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
        }),
    );
    const runningStream = readEvents(`/api/jobs/${running.id}/events`);
    await new Promise((r) => setTimeout(r, 20));
    expect(
      (await api<{ ok: boolean }>("POST", `/api/jobs/${running.id}/cancel`, {}))
        .body,
    ).toEqual({ ok: true });
    const cancelledEvents = (await runningStream).events;
    expect(cancelledEvents.at(-1)).toMatchObject({
      type: "status",
      status: "cancelled",
    });
    expect((await api("GET", "/api/jobs/job_unknown123")).status).toBe(404);
    expect(
      (await api("POST", "/api/jobs/job_unknown123/cancel", {})).status,
    ).toBe(404);
  });

  it('serves the web UI or the "not built" page for deep links', async () => {
    const res = await authenticated.fetch(
      `${base}/projects/some-project/specs`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    // S08: every page carries a script policy limited to this origin, without inline or eval scripts.
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src[^;]*(unsafe-inline|unsafe-eval)/);
    expect(
      (await authenticated.fetch(`${base}/assets/missing-file.js`)).status,
    ).toBe(404);
  });
});

describe("recovery extras over HTTP", () => {
  it("lists history, restores from trash and explains a missing output folder", async () => {
    const project = await api<Project>("POST", "/api/projects", {
      name: "Extras project",
      description: "",
    });
    const pid = project.body.id;
    expect((await api("GET", `/api/projects/${pid}/history`)).body).toEqual([]);
    const reveal = await api<{ error: string }>(
      "POST",
      `/api/projects/${pid}/reveal-output`,
      {},
    );
    expect(reveal.status).toBe(400);
    expect(reveal.body.error).toMatch(/generate specs first/);
    expect(
      (
        await api(
          "POST",
          `/api/projects/${pid}/history/model-2000-01-01T00-00-00-000Z.json/restore`,
          {},
        )
      ).status,
    ).toBe(404);

    await api("POST", `/api/projects/${pid}/trash`, {
      confirmation: pid,
      expectedUpdatedAt: project.body.updatedAt,
    });
    const trash = await api<{ id: string; projectId: string }[]>(
      "GET",
      "/api/trash",
    );
    const entry = trash.body.find((t) => t.projectId === pid)!;
    const restored = await api<Project>(
      "POST",
      `/api/trash/${entry.id}/restore`,
      {},
    );
    expect(restored.status).toBe(200);
    expect(restored.body.id).toBe(pid);
    expect((await api("GET", `/api/projects/${pid}`)).status).toBe(200);
  });
});

describe("job conflict over HTTP", () => {
  it("returns 409 when a job is already running for the project", async () => {
    const project = await api<Project>("POST", "/api/projects", {
      name: "Conflict project",
      description: "",
    });
    const pid = project.body.id;
    const form = new FormData();
    form.append(
      "files",
      new Blob([new Uint8Array(await makePng())], { type: "image/png" }),
      "a.png",
    );
    await api("POST", `/api/projects/${pid}/screens`, form);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = await jobs.startJob("export", pid, async () => gate);
    const res = await api<
      JobStarted & { code: string; details: { activeJobId: string } }
    >("POST", `/api/projects/${pid}/generate`, { granularity: "fine" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFLICT");
    expect(res.body.details.activeJobId).toBe(job.id);
    // Screen changes are allowed while an export runs, but sync/rerender are blocked.
    expect(
      (await api("POST", `/api/projects/${pid}/rerender`, {})).status,
    ).toBe(409);
    release();
    await jobs.waitForJob(job.id);
  });
});

describe("abandoning a stopped run", () => {
  it("discards the steps it kept, and waits for a running job (owner test note 7)", async () => {
    const project = await api<Project>("POST", "/api/projects", {
      name: "Abandon project",
      description: "",
    });
    const pid = project.body.id;
    const state = await import("../agents/runState");
    const key = state.stageKey("journey");
    const isNote = (v: unknown): v is { note: string } =>
      !!v && typeof (v as { note?: unknown }).note === "string";
    await state.writeStage(pid, "journey", key, { note: "kept" });
    expect(await state.readStage(pid, "journey", key, isNote)).toEqual({
      note: "kept",
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = await jobs.startJob("export", pid, async () => gate);
    expect(
      (await api("POST", `/api/projects/${pid}/generate/abandon`, {})).status,
    ).toBe(409);
    release();
    await jobs.waitForJob(job.id);
    expect(
      (await api("POST", `/api/projects/${pid}/generate/abandon`, {})).status,
    ).toBe(200);
    expect(await state.readStage(pid, "journey", key, isNote)).toBeUndefined();
  });
});

describe("starting a run without a key", () => {
  it("stops before any work when a provider that always needs a key has none (owner test note 3)", async () => {
    const project = await api<Project>("POST", "/api/projects", {
      name: "Keyless project",
      description: "",
    });
    const pid = project.body.id;
    const form = new FormData();
    form.append(
      "files",
      new Blob([new Uint8Array(await makePng())], { type: "image/png" }),
      "a.png",
    );
    await api("POST", `/api/projects/${pid}/screens`, form);
    const keyless = await api<PublicSettings["connections"][number]>(
      "POST",
      "/api/settings/connections",
      {
        name: "Keyless Claude",
        provider: "anthropic",
        model: "claude-opus-5-5",
      },
    );
    expect(keyless.body.hasApiKey).toBe(false);
    const before = (await jobs.listJobs(pid)).length;
    const res = await api<{ error: string }>(
      "POST",
      `/api/projects/${pid}/generate`,
      {
        visionConnectionId: keyless.body.id,
        textConnectionId: keyless.body.id,
        visionModelId: "claude-opus-5-5",
        textModelId: "claude-opus-5-5",
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "No API key is saved for Keyless Claude. Add it in Settings → AI connections, then start again.",
    );
    expect(await jobs.listJobs(pid)).toHaveLength(before);
  });
});

describe("stored secrets over HTTP", () => {
  it("never sends a stored key or token to a URL supplied by the request", async () => {
    const received: {
      method?: string;
      url?: string;
      headers: http.IncomingHttpHeaders;
    }[] = [];
    const capture = http.createServer((req, res) => {
      received.push({ method: req.method, url: req.url, headers: req.headers });
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [],
          has_more: false,
          first_id: null,
          last_id: null,
        }),
      );
    });
    await new Promise<void>((resolve) =>
      capture.listen(0, "127.0.0.1", resolve),
    );
    const captureUrl = `http://127.0.0.1:${(capture.address() as AddressInfo).port}`;
    try {
      const conn = await api<{ id: string }>(
        "POST",
        "/api/settings/connections",
        {
          name: "Secret Claude",
          provider: "anthropic",
          model: "claude-opus-5-5",
          apiKey: "sk-ant-VERIFY-SECRET-999",
        },
      );
      expect(conn.status).toBe(201);
      const connectionId = conn.body.id;

      const tested = await api<{ error: string }>(
        "POST",
        "/api/settings/connections/test",
        {
          connectionId,
          connection: {
            name: "x",
            provider: "anthropic",
            model: "m",
            baseUrl: captureUrl,
          },
        },
      );
      expect(tested.status).toBe(400);
      expect(tested.body.error).toMatch(/Re-enter the API key/);

      const listed = await api<{ error: string }>(
        "POST",
        "/api/settings/connections/models",
        { connectionId, provider: "anthropic", baseUrl: captureUrl },
      );
      expect(listed.status).toBe(400);

      expect(
        (
          await api("PUT", `/api/settings/connections/${connectionId}`, {
            name: "x",
            provider: "anthropic",
            model: "m",
            baseUrl: captureUrl,
          })
        ).status,
      ).toBe(400);

      await api("PUT", "/api/settings/integrations/github", {
        owner: "o",
        repo: "r",
        token: "ghp_VERIFY_SECRET_GH",
        labels: [],
        apiBaseUrl: "",
        useMilestonesForFeatures: true,
      });
      const gh = await api<{ error: string }>(
        "POST",
        "/api/settings/integrations/github/test",
        {
          owner: "o",
          repo: "r",
          labels: [],
          apiBaseUrl: captureUrl,
          useMilestonesForFeatures: true,
        },
      );
      expect(gh.status).toBe(400);
      expect(gh.body.error).toMatch(/Re-enter the GitHub token/);
      expect(received).toEqual([]);

      // The key still goes where it was saved: a connection saved for the capture URL lists models there.
      const gateway = await api<{ id: string }>(
        "POST",
        "/api/settings/connections",
        {
          name: "Gateway",
          provider: "anthropic",
          model: "claude-opus-5-5",
          baseUrl: captureUrl,
          apiKey: "sk-ant-GATEWAY-KEY-123",
        },
      );
      const models = await api<{ models: unknown[] }>(
        "POST",
        "/api/settings/connections/models",
        { connectionId: gateway.body.id, provider: "anthropic" },
      );
      expect(models.status).toBe(200);
      expect(received.length).toBeGreaterThan(0);
      expect(
        received.every(
          (r) => r.headers["x-api-key"] === "sk-ant-GATEWAY-KEY-123",
        ),
      ).toBe(true);
    } finally {
      capture.closeAllConnections();
      await new Promise((resolve) => capture.close(resolve));
    }
  });
});
