import { authenticatedTestApp } from "../security/authTestUtils";
let authenticated: Awaited<ReturnType<typeof authenticatedTestApp>>;
import fs from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { makeJpeg, makePng, removeDir, useTempDataDir } from "./testUtils";
import { fixtureModel } from "../graph/testFixtures";
let dataDir: string, origin: string, server: Server;
let store: typeof import("./projectStore"),
  lifecycle: typeof import("./projectLifecycle"),
  areas: typeof import("./areaStore"),
  jobs: typeof import("../jobs/jobManager"),
  cfg: typeof import("../config");
beforeAll(async () => {
  dataDir = await useTempDataDir("project-lifecycle");
  vi.resetModules();
  store = await import("./projectStore");
  lifecycle = await import("./projectLifecycle");
  areas = await import("./areaStore");
  jobs = await import("../jobs/jobManager");
  cfg = await import("../config");
  await store.ensureDataDirs();
  const { createApp } = await import("../app");
  authenticated = await authenticatedTestApp();
  server = authenticated.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  authenticated.authenticate(origin);
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await removeDir(dataDir);
});
async function request(url: string, method = "GET", body?: unknown) {
  const res = await authenticated.fetch(origin + "/api" + url, {
    method,
    headers: { "X-ScreenScribe": "1", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function seeded(name: string) {
  const area = await areas.saveArea(name + " area");
  let project = await store.createProject({
    name,
    description: "Full brief",
    additionalContext: "Exact business context\nSecond line",
    areaId: area.id,
  });
  await store.addScreens(project.id, [
    {
      originalName: "login.png",
      mimeType: "image/png",
      buffer: await makePng(),
    },
  ]);
  project = await store.getProject(project.id);
  await store.updateScreen(project.id, project.screens[0].id, {
    name: "Sign in",
    notes: "Exact input note",
  });
  await store.replaceScreenImage(project.id, project.screens[0].id, {
    originalName: "revised.jpg",
    mimeType: "image/jpeg",
    buffer: await makeJpeg(),
  });
  project = await store.getProject(project.id);
  project.status = "specified";
  project.lastGeneratedAt = new Date().toISOString();
  project.screens[0].analysedVersion = 2;
  project.llm = {
    visionConnectionId: "saved-vision",
    textConnectionId: "saved-writer",
  };
  await store.saveProject(project);
  const model = fixtureModel();
  model.projectId = project.id;
  await store.saveModel(project.id, model);
  return { project, area };
}

it("duplicates all user metadata and all image versions, with fresh IDs/output and no analysis or export history", async () => {
  const { project: source } = await seeded("Original for copy");
  const sourceFile = await fs.readFile(
    cfg.paths.projectFile(source.id),
    "utf8",
  );
  const copy = await lifecycle.duplicateProject(source.id);
  expect(copy).toMatchObject({
    name: source.name + " (copy)",
    description: source.description,
    additionalContext: source.additionalContext,
    formatId: source.formatId,
    llm: source.llm,
    areaId: source.areaId,
    status: "draft",
  });
  expect(copy.id).not.toBe(source.id);
  expect(copy.outputDir).toBe(cfg.paths.defaultSpecsDir(copy.id));
  expect(copy.lastGeneratedAt).toBeUndefined();
  expect(copy.generationPreferences).toEqual(fixtureModel().options);
  expect(copy.outputHistory).toBeUndefined();
  expect(copy.screens[0]).toMatchObject({
    name: "Sign in",
    notes: "Exact input note",
    version: 2,
    order: 0,
    mimeType: "image/jpeg",
    originalFileName: "revised.jpg",
  });
  expect(copy.screens[0].id).not.toBe(source.screens[0].id);
  expect(copy.screens[0].analysedVersion).toBeUndefined();
  for (const version of [1, 2])
    expect(
      await fs.readFile(
        store.screenImagePath(copy.id, copy.screens[0], version),
      ),
    ).toEqual(
      await fs.readFile(
        store.screenImagePath(source.id, source.screens[0], version),
      ),
    );
  expect((await fs.readdir(cfg.paths.projectDir(copy.id))).sort()).toEqual([
    "jobs",
    "project.json",
    "screens",
  ]);
  expect(await store.loadModel(copy.id)).toBeNull();
  expect(await jobs.listJobs(copy.id)).toEqual([]);
  expect(await fs.readFile(cfg.paths.projectFile(source.id), "utf8")).toBe(
    sourceFile,
  );
  const again = await lifecycle.duplicateProject(source.id);
  expect(again.id).not.toBe(copy.id);
  await store.updateScreen(copy.id, copy.screens[0].id, { notes: "Copy only" });
  expect((await store.getProject(source.id)).screens[0].notes).toBe(
    "Exact input note",
  );
});

it("rolls back an incomplete copy without publishing a half-copied project or modifying the source", async () => {
  const { project } = await seeded("Copy rollback");
  const before = (await store.listProjects()).map((p) => p.id).sort();
  const io = await import("./fsUtils"),
    write = io.writeFileAtomic;
  const copy = vi
    .spyOn(io, "writeFileAtomic")
    .mockImplementation(async (file, bytes, mode) => {
      if (file.includes("screens") && !file.startsWith(project.projectPath!))
        throw Error("Synthetic disk failure");
      return write(file, bytes, mode);
    });
  try {
    await expect(lifecycle.duplicateProject(project.id)).rejects.toThrow(
      "Synthetic disk failure",
    );
  } finally {
    copy.mockRestore();
  }
  expect((await store.listProjects()).map((p) => p.id).sort()).toEqual(before);
  expect((await store.getProject(project.id)).screens).toHaveLength(1);
});

it("requires the reviewed Trash workflow before permanent deletion", async () => {
  const p = await store.createProject({
    name: "Confirmation",
    description: "Keep me",
  });
  const preview = (await request(`/projects/${p.id}/deletion-preview`))
    .body as { updatedAt: string };
  expect(preview).toMatchObject({
    projectId: p.id,
    updatedAt: expect.any(String),
  });
  expect(
    (await request(`/projects/${p.id}/permanent-delete`, "POST", {})).status,
  ).toBe(400);
  expect(
    (
      await request(`/projects/${p.id}/permanent-delete`, "POST", {
        confirmation: "wrong",
        expectedUpdatedAt: preview.updatedAt,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(`/projects/${p.id}/permanent-delete`, "POST", {
        confirmation: p.id,
        expectedUpdatedAt: "old",
      })
    ).status,
  ).toBe(400);
  expect((await store.getProject(p.id)).description).toBe("Keep me");
});

it("refuses project junctions and attempts to redirect requirements", async () => {
  const p = await store.createProject({
    name: "Junction deletion",
    description: "",
  });
  const target = path.join(dataDir, "link-target");
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "keep.txt"), "Keep");
  const link = path.join(cfg.paths.projectDir(p.id), "linked");
  await fs.symlink(
    target,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(lifecycle.previewProjectDeletion(p.id)).rejects.toThrow(
    /symbolic links|junctions/,
  );
  await fs.unlink(link);
  await expect(
    store.updateProject(p.id, { outputDir: dataDir }),
  ).rejects.toMatchObject({ status: 400 });
  expect((await lifecycle.previewProjectDeletion(p.id)).paths).toEqual([
    cfg.paths.projectDir(p.id),
  ]);
  expect(await fs.readFile(path.join(target, "keep.txt"), "utf8")).toBe("Keep");
});

it("blocks running jobs and prevents a new job racing maintenance", async () => {
  const p = await store.createProject({
    name: "Busy operations",
    description: "",
  });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const active = await jobs.startJob("generate", p.id, async () => gate);
  await expect(lifecycle.duplicateProject(p.id)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    lifecycle.moveProjectToTrash(p.id, p.id, p.updatedAt),
  ).rejects.toMatchObject({ status: 409 });
  finish();
  await jobs.waitForJob(active.id);
  await jobs.withProjectMaintenance(p.id, async () => {
    await expect(jobs.startJob("export", p.id, async () => 1)).rejects.toThrow(
      /being copied or deleted/,
    );
  });
});

it("creates, renames and removes areas without deleting projects or generated content", async () => {
  const { project, area } = await seeded("Area grouping");
  expect((await request("/areas", "POST", { name: "  " })).status).toBe(400);
  expect(
    (await request("/areas", "POST", { name: area.name.toUpperCase() })).status,
  ).toBe(409);
  expect(
    (await request(`/areas/${area.id}`, "PATCH", { name: "Renamed group" }))
      .status,
  ).toBe(200);
  expect(
    (
      await request(`/projects/${project.id}`, "PATCH", {
        areaId: "nonexistent",
      })
    ).status,
  ).toBe(404);
  const model = await fs.readFile(cfg.paths.modelFile(project.id), "utf8");
  expect((await request(`/areas/${area.id}`, "DELETE")).status).toBe(200);
  expect((await store.getProject(project.id)).areaId).toBeUndefined();
  expect(await fs.readFile(cfg.paths.modelFile(project.id), "utf8")).toBe(
    model,
  );
  expect((await store.getProject(project.id)).screens).toHaveLength(1);
  expect((await store.getProject(project.id)).status).toBe("specified");
});

it("restores trash into Unassigned if its area was removed", async () => {
  const area = await areas.saveArea("Trashed group");
  const p = await store.createProject({
    name: "Trashed area project",
    description: "",
    areaId: area.id,
  });
  await store.deleteProject(p.id);
  await areas.removeArea(area.id);
  const recovery = await import("./recovery");
  const trash = (await recovery.listTrash()).find((t) => t.projectId === p.id)!;
  expect((await recovery.restoreFromTrash(trash.id)).areaId).toBeUndefined();
});

it("refuses removing an area with active work and leaves memberships intact", async () => {
  const area = await areas.saveArea("Busy group");
  const p = await store.createProject({
    name: "Busy area member",
    description: "",
    areaId: area.id,
  });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const job = await jobs.startJob("generate", p.id, async () => gate);
  try {
    expect((await request(`/areas/${area.id}`, "DELETE")).status).toBe(409);
    expect((await store.getProject(p.id)).areaId).toBe(area.id);
  } finally {
    finish();
    await jobs.waitForJob(job.id);
  }
});

it("explicitly saving or clearing project model choices supersedes remembered run choices without changing results", async () => {
  const { project } = await seeded("Explicit model default");
  const before = await fs.readFile(cfg.paths.modelFile(project.id), "utf8");
  project.generationPreferences = {
    ...fixtureModel().options,
    visionConnectionId: "last-run",
    textConnectionId: "last-run",
  };
  await store.saveProject(project);
  let saved = await store.updateProject(project.id, {
    llm: {
      visionConnectionId: "chosen-default",
      textConnectionId: "chosen-default",
    },
  });
  expect(saved.generationPreferences?.visionConnectionId).toBe(
    "chosen-default",
  );
  expect(saved.generationPreferences?.textConnectionId).toBe("chosen-default");
  saved = await store.updateProject(project.id, {
    llm: { visionConnectionId: null },
  });
  expect(saved.generationPreferences?.visionConnectionId).toBeUndefined();
  expect(saved.generationPreferences?.textConnectionId).toBe("chosen-default");
  expect(await fs.readFile(cfg.paths.modelFile(project.id), "utf8")).toBe(
    before,
  );
});
