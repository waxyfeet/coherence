import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { removeDir, useTempDataDir } from "../storage/testUtils";

// Captures the managed-mode control events instead of writing them to stdout.
const events = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock(import("../lifecycle/control"), async (importOriginal) => ({
  ...(await importOriginal()),
  emit: (event: string, data: Record<string, unknown> = {}) => {
    events.push({ event, ...data });
  },
}));

let dataDir: string;
beforeAll(async () => {
  dataDir = await useTempDataDir("jobs-event");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(async () => {
  vi.restoreAllMocks();
  await removeDir(dataDir);
});

it("tells the launcher each time the number of running jobs changes", async () => {
  const jobs = await import("./jobManager");
  const store = await import("../storage/projectStore");
  await store.ensureDataDirs();
  const first = await store.createProject({ name: "One", description: "" });
  const second = await store.createProject({ name: "Two", description: "" });
  const gates = [0, 1].map(() => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  });
  const a = await jobs.startJob("export", first.id, () => gates[0].promise);
  const b = await jobs.startJob("export", second.id, () => gates[1].promise);
  await vi.waitFor(() => expect(jobs.activeJobCount()).toBe(2));
  gates[0].resolve();
  await vi.waitFor(async () =>
    expect((await jobs.getJob(a.id)).status).toBe("succeeded"),
  );
  gates[1].resolve();
  await vi.waitFor(async () =>
    expect((await jobs.getJob(b.id)).status).toBe("succeeded"),
  );
  expect(events.filter((e) => e.event === "jobs")).toEqual([
    { event: "jobs", active: 1 },
    { event: "jobs", active: 2 },
    { event: "jobs", active: 1 },
    { event: "jobs", active: 0 },
  ]);
});
