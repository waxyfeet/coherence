import { authenticatedTestApp } from "../security/authTestUtils";
let authenticated: Awaited<ReturnType<typeof authenticatedTestApp>>;
/**
 * HTTP test of the spec-file save route's guard against jobs that rewrite use case files when they finish.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobKind } from "@shared/types";
import { removeDir, useTempDataDir } from "../storage/testUtils";

type Jobs = typeof import("../jobs/jobManager");

let dataDir: string;
let server: http.Server;
let base: string;
let jobs: Jobs;
let projectId: string;

async function save(
  content: string,
): Promise<{ status: number; body: { code?: string; error?: string } }> {
  const res = await authenticated.fetch(
    `${base}/api/projects/${projectId}/files/content`,
    {
      method: "PUT",
      headers: { "X-ScreenScribe": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ path: "notes/meeting.md", content }),
    },
  );
  return {
    status: res.status,
    body: (await res.json()) as { code?: string; error?: string },
  };
}

beforeAll(async () => {
  dataDir = await useTempDataDir("file-routes");
  vi.resetModules();
  const { createApp } = await import("../app");
  const store = await import("../storage/projectStore");
  jobs = await import("../jobs/jobManager");
  await store.ensureDataDirs();
  authenticated = await authenticatedTestApp();
  server = http.createServer(authenticated.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  authenticated.authenticate(base);
  projectId = (
    await store.createProject({ name: "File routes", description: "" })
  ).id;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await removeDir(dataDir);
});

describe("PUT /files/content", () => {
  it.each<JobKind>(["revise", "impact-apply", "generate"])(
    "is refused while a %s job that rewrites use case files runs",
    async (kind) => {
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const job = await jobs.startJob(kind, projectId, () => gate);
      try {
        const refused = await save("# Meeting\n");
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatch(
          /in progress — wait for it to finish/,
        );
      } finally {
        finish();
        await jobs.waitForJob(job.id);
      }
      expect((await save("# Meeting\n")).status).toBe(200);
    },
  );
});
