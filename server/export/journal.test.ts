import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { removeDir, useTempDataDir } from "../storage/testUtils";
let dir: string, pid: string;
let journal: typeof import("./journal");
beforeAll(async () => {
  dir = await useTempDataDir("export-journal");
  vi.resetModules();
  const store = await import("../storage/projectStore");
  await store.ensureDataDirs();
  pid = (
    await store.createProject({ name: "Journal fixture", description: "" })
  ).id;
  journal = await import("./journal");
});
afterAll(async () => {
  await removeDir(dir);
});
it("persists successful remote references and exposes them for recovery", async () => {
  const first = await journal.createExportJournal(pid, "job_first", "github", {
    repo: "fixture",
  });
  expect(first).toBeDefined();
  const result = await first!.operation("item:UC-001", "item", async () => ({
    action: "created",
    ref: { key: "#7", url: "https://tracker.invalid/fixture/issues/7" },
  }));
  expect((await journal.listExportJournals(pid))[0].operations[0].state).toBe(
    "complete",
  );
  const second = await journal.createExportJournal(
    pid,
    "job_second",
    "github",
    { repo: "fixture" },
  );
  expect(await second!.completed("item:UC-001")).toEqual(result);
});
it("blocks uncertain repeated creates before invoking the remote callback", async () => {
  const first = await journal.createExportJournal(pid, "job_third", "github", {
    repo: "uncertain-fixture",
  });
  await expect(
    first!.operation("item:UC-002", "item", async () => {
      throw new Error("Connection lost after request");
    }),
  ).rejects.toThrow("Connection lost");
  const second = await journal.createExportJournal(
    pid,
    "job_fourth",
    "github",
    { repo: "uncertain-fixture" },
  );
  let calls = 0;
  await expect(
    second!.operation("item:UC-002", "item", async () => {
      calls++;
      return {};
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(calls).toBe(0);
  const records = await journal.listExportJournals(pid);
  expect(
    records.some((r) => r.operations.some((o) => o.state === "uncertain")),
  ).toBe(true);
});
it("records a proven refusal without blocking a retry, and lets a check settle an unknown outcome", async () => {
  const identity = { repo: "settle-fixture" };
  const first = await journal.createExportJournal(
    pid,
    "job_fifth",
    "azdo",
    identity,
  );
  await expect(
    first!.operation(
      "item:UC-003",
      "item",
      async () => {
        throw new Error("HTTP 400: rule error");
      },
      () => true,
    ),
  ).rejects.toThrow("rule error");
  // Refused: nothing was carried out, so trying again is allowed.
  const retry = await journal.createExportJournal(
    pid,
    "job_sixth",
    "azdo",
    identity,
  );
  await expect(
    retry!.operation("item:UC-003", "item", async () => {
      throw new Error("socket hang up");
    }),
  ).rejects.toThrow("socket hang up");
  // Unknown: blocked until a check settles it.
  const blocked = await journal.createExportJournal(
    pid,
    "job_seventh",
    "azdo",
    identity,
  );
  await expect(
    blocked!.operation("item:UC-003", "item", async () => ({})),
  ).rejects.toMatchObject({ status: 409 });
  await journal.settleOperation(pid, retry!.record.id, "item:UC-003", {
    resolution: "adopted",
    result: { key: "4711" },
  });
  const settled = (await journal.listExportJournals(pid))
    .find((j) => j.id === retry!.record.id)!
    .operations.find((o) => o.key === "item:UC-003")!;
  expect(settled).toMatchObject({
    state: "complete",
    resolution: "adopted",
    result: { key: "4711" },
  });
  expect(await blocked!.operation("item:UC-003", "item", async () => 1)).toBe(
    1,
  );
});
