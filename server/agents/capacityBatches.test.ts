import { expect, it } from "vitest";
import { capacityBatches } from "./capacityBatches";
import { CapacityError } from "../llm/capacity";
import { ProviderError } from "../llm/errors";
const signal = () => new AbortController().signal;
it("keeps small semantic work in one call", async () => {
  const seen: unknown[] = [];
  expect(
    await capacityBatches(
      [1, 2],
      async (items) => {
        seen.push(items);
        return items.join(",");
      },
      signal(),
      () => {},
    ),
  ).toEqual(["1,2"]);
  expect(seen).toHaveLength(1);
});
it("partitions only at semantic boundaries and covers every unit in order", async () => {
  const done: number[] = [];
  const results = await capacityBatches(
    [1, 2, 3, 4, 5],
    async (items) => {
      if (items.length > 2) throw new CapacityError("input", "size");
      done.push(...items);
      return [...items];
    },
    signal(),
    () => {},
  );
  expect(done).toEqual([1, 2, 3, 4, 5]);
  expect(results.flat()).toEqual(done);
});
it.each(["auth", "quota", "timeout", "format_unsupported"] as const)(
  "does not turn %s into more partition calls",
  async (failure) => {
    let calls = 0;
    await expect(
      capacityBatches(
        [1, 2, 3],
        async () => {
          calls++;
          throw new ProviderError("fixture", { failure });
        },
        signal(),
        () => {},
      ),
    ).rejects.toThrow("fixture");
    expect(calls).toBe(1);
  },
);
it("stops when a single semantic unit still does not fit", async () => {
  let calls = 0;
  await expect(
    capacityBatches(
      [1, 2],
      async () => {
        calls++;
        throw new CapacityError("input", "size");
      },
      signal(),
      () => {},
    ),
  ).rejects.toThrow("size");
  expect(calls).toBe(2);
});
it("cancels before the next batch without publishing a partial batch result", async () => {
  const c = new AbortController();
  let calls = 0;
  await expect(
    capacityBatches(
      [1, 2],
      async (items) => {
        calls++;
        if (items.length > 1) throw new CapacityError("input", "size");
        c.abort();
        return items;
      },
      c.signal,
      () => {},
    ),
  ).rejects.toThrow(/cancel/i);
  expect(calls).toBe(2);
});
