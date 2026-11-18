import { describe, expect, it } from "vitest";
import type { Job } from "@shared/types";
import { JOB_DIAGNOSTICS_VERSION, safeJobDiagnostics } from "./jobDiagnostics";

const job = (extra: Record<string, unknown>): Job =>
  ({
    diagnosticsVersion: JOB_DIAGNOSTICS_VERSION,
    id: "job_test",
    kind: "generate",
    projectId: "p",
    status: "failed",
    progress: { stage: "", stageIndex: 0, stageCount: 0, current: 0, total: 0 },
    logs: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    createdAt: "2026-11-03T00:00:00.000Z",
    ...extra,
  }) as Job;

const failure = {
  kind: "rate-limited",
  action: "wait",
  message: "OpenRouter's rate limit for m was reached.",
  connectionId: "conn_a",
  connectionName: "OpenRouter",
  model: "m",
  resetAt: "2026-11-03T10:00:00.000Z",
};

describe("job failure diagnostics", () => {
  it("keeps a failure this build knows, and is stable when applied twice", () => {
    const once = safeJobDiagnostics(job({ failure }));
    expect(once.failure).toEqual(failure);
    expect(safeJobDiagnostics(once)).toEqual(once);
  });

  it.each([
    ["an unknown kind", { ...failure, kind: "mystery" }],
    ["an unknown action", { ...failure, action: "panic" }],
    ["no message", { ...failure, message: " " }],
    ["not an object", "rate-limited"],
  ])("drops a failure with %s", (_label, value) => {
    expect(safeJobDiagnostics(job({ failure: value })).failure).toBeUndefined();
  });

  it("drops extra fields and an unreadable reset time", () => {
    const result = safeJobDiagnostics(
      job({ failure: { ...failure, resetAt: "soon", raw: "provider body" } }),
    ).failure!;
    expect(result).not.toHaveProperty("raw");
    expect(result).not.toHaveProperty("resetAt");
  });

  it("drops a failure from a record written before failures existed", () => {
    expect(
      safeJobDiagnostics(job({ diagnosticsVersion: 1, failure })).failure,
    ).toBeUndefined();
  });
});
