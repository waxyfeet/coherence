import { authenticatedTestApp } from "../security/authTestUtils";
let authenticated: Awaited<ReturnType<typeof authenticatedTestApp>>;
import http from "node:http";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { makePng, removeDir, useTempDataDir } from "../storage/testUtils";
import { recordingContext } from "../agents/testContext";
let dir: string, base: string, server: http.Server;
let store: typeof import("../storage/projectStore"),
  importer: typeof import("./figmaImport"),
  jobs: typeof import("../jobs/jobManager");
let png: Buffer;
let pendingDownload: () => void = () => {};
let slow = false,
  broken = false;
beforeAll(async () => {
  dir = await useTempDataDir("figma-job");
  vi.resetModules();
  store = await import("../storage/projectStore");
  importer = await import("./figmaImport");
  jobs = await import("../jobs/jobManager");
  await store.ensureDataDirs();
  png = await makePng(48, 48);
  await (
    await import("../storage/settingsStore")
  ).setFigmaToken("synthetic-fixture-token");
  authenticated = await authenticatedTestApp();
  server = http.createServer(authenticated.app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  authenticated.authenticate(base);
});
afterEach(() => {
  vi.unstubAllGlobals();
  slow = false;
  broken = false;
});
afterAll(async () => {
  await jobs.cancelAllJobs();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await removeDir(dir);
});
function fixtureFetch() {
  vi.stubGlobal(
    "fetch",
    async (raw: string | URL | Request, init: RequestInit = {}) => {
      const url = String(raw);
      if (url.includes("/nodes?"))
        return Response.json({
          nodes: { "1:1": { document: { id: "1:1", name: "Fixture frame" } } },
        });
      if (url.includes("/images/"))
        return Response.json({
          images: { "1:1": "https://s3-alpha-sig.figma.com/frame.png" },
        });
      if (url === "https://s3-alpha-sig.figma.com/frame.png") {
        expect(new Headers(init.headers).has("X-Figma-Token")).toBe(false);
        if (slow) {
          pendingDownload();
          return new Promise<Response>((_, reject) => {
            const signal = init.signal!;
            if (signal.aborted)
              reject(new DOMException("Aborted", "AbortError"));
            else
              signal.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
          });
        }
        return new Response(
          new Uint8Array(broken ? Buffer.from("bad-image") : png),
        );
      }
      throw new Error("Unexpected fixture request: " + url);
    },
  );
}
const request = {
  fileUrl: "FixtureKey123",
  frameIds: ["1:1"],
  scale: 1 as const,
};
async function post(url: string, body: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request(
      base + url,
      {
        method: "POST",
        headers: {
          Authorization: authenticated.authorization(base),
          "X-ScreenScribe": "1",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(text),
        },
      },
      (res) => {
        let output = "";
        res.on("data", (chunk) => (output += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: JSON.parse(output) }),
        );
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}
it("persists real PNG bytes only after all selected frames download", async () => {
  fixtureFetch();
  const project = await store.createProject({
    name: "Successful Figma fixture",
    description: "",
  });
  const ctx = recordingContext(project.id);
  const result = await importer.runFigmaImport(
    ctx,
    project.id,
    "synthetic-token",
    request,
  );
  expect(result.screenCount).toBe(1);
  const saved = await store.getProject(project.id);
  expect(saved.screens[0].name).toBe("Fixture frame");
  expect(saved.screens[0].width).toBe(48);
  expect(ctx.entered).toEqual([
    "Downloading Figma frames",
    "Saving screenshots",
  ]);
});
it("starts through HTTP as a durable job and cancellation aborts downloads without saving screenshots", async () => {
  fixtureFetch();
  slow = true;
  const project = await store.createProject({
    name: "Cancelled Figma fixture",
    description: "",
  });
  await store.addScreens(project.id, [
    { originalName: "existing.png", mimeType: "image/png", buffer: png },
  ]);
  const downloading = new Promise<void>((r) => (pendingDownload = r));
  const started = await post(
    `/api/projects/${project.id}/figma/import-job`,
    request,
  );
  expect(started.status).toBe(202);
  await downloading;
  const conflict = await post(`/api/projects/${project.id}/generate`, {});
  expect(conflict.status).toBe(409);
  await post(`/api/jobs/${started.body.jobId}/cancel`, {});
  await jobs.waitForJob(started.body.jobId);
  expect((await jobs.getJob(started.body.jobId)).status).toBe("cancelled");
  expect((await store.getProject(project.id)).screens).toHaveLength(1);
});
it("rejects invalid downloaded bytes before any screenshot is persisted", async () => {
  fixtureFetch();
  broken = true;
  const project = await store.createProject({
    name: "Broken Figma fixture",
    description: "",
  });
  await expect(
    importer.runFigmaImport(
      recordingContext(project.id),
      project.id,
      "synthetic-token",
      request,
    ),
  ).rejects.toThrow("PNG");
  expect((await store.getProject(project.id)).screens).toHaveLength(0);
});
