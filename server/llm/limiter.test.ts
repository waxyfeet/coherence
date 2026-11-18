import { describe, expect, it } from "vitest";
import type { LLMConnection } from "@shared/types";
import { Limiter, limiterFor } from "./limiter";

function connection(
  id: string,
  updatedAt: string,
  concurrency: number,
): LLMConnection {
  return {
    id,
    name: "Test",
    provider: "ollama",
    model: "qwen2.5vl:7b",
    concurrency,
    requestTimeoutSec: 60,
    structuredOutput: "auto",
    vision: "auto",
    refusalFallback: false,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt,
  };
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe("limiterFor", () => {
  it("keeps one limit per connection even when two saved versions are in use at once", async () => {
    // A job still running on v1 while a newer job uses v2 of the same connection.
    const v1 = connection("conn_versions", "2026-10-15T10:00:00.000Z", 1);
    const v2 = connection("conn_versions", "2026-10-15T11:00:00.000Z", 1);
    let inFlight = 0;
    let maxInFlight = 0;
    const call = (conn: LLMConnection) =>
      limiterFor(conn).run(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick();
        inFlight -= 1;
      });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => call(i % 2 ? v2 : v1)),
    );
    expect(maxInFlight).toBe(1);
  });

  it("applies the newest saved concurrency and ignores older snapshots", () => {
    const limiter = limiterFor(
      connection("conn_newest", "2026-10-15T10:00:00.000Z", 1),
    );
    expect(
      limiterFor(connection("conn_newest", "2026-10-15T11:00:00.000Z", 3)),
    ).toBe(limiter);
    expect(limiter.concurrency).toBe(3);
    limiterFor(connection("conn_newest", "2026-10-15T10:00:00.000Z", 1));
    expect(limiter.concurrency).toBe(3);
  });
});

describe("Limiter.setConcurrency", () => {
  it("starts waiters when the limit is raised and holds them back when it is lowered", async () => {
    const limiter = new Limiter(1);
    const releases: (() => void)[] = [];
    const started: number[] = [];
    const runs = Array.from({ length: 4 }, (_, i) =>
      limiter.run(
        () =>
          new Promise<void>((resolve) => {
            started.push(i);
            releases.push(resolve);
          }),
      ),
    );
    await tick();
    expect(started).toEqual([0]);

    limiter.setConcurrency(3);
    await tick();
    expect(started).toEqual([0, 1, 2]);

    limiter.setConcurrency(1);
    releases[0]();
    releases[1]();
    await tick();
    // Still one running (call 2) at the new limit of 1: call 3 waits.
    expect(started).toEqual([0, 1, 2]);
    expect(limiter.running).toBe(1);
    releases[2]();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    releases[3]();
    await Promise.all(runs);
    expect(limiter.running).toBe(0);
  });
});
