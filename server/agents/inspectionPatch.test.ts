import { expect, it } from "vitest";
import { mergeInspection } from "./screenAnalyst";
import { mockInspection, mockScreenAnalysis } from "./mock/screenMock";
import { project, screen } from "./testFixtures";
import { InspectorOutputSchema } from "./schemas";
const first = () =>
  mockScreenAnalysis(
    project([screen("s", "Login", 0)]),
    screen("s", "Login", 0),
  );
it("an empty correction preserves every exact label, key, region, fact and reading order without rewriting the inventory", () => {
  const original = first(),
    patch = mockInspection(original);
  expect(InspectorOutputSchema.safeParse(patch).success).toBe(true);
  expect(patch.elements).toEqual([]);
  expect(patch.regions).toEqual([]);
  expect(JSON.stringify(patch).length).toBeLessThan(
    JSON.stringify(original).length,
  );
  expect(mergeInspection(original, patch).output).toEqual(original);
});
it("upserts corrections and additions while keeping all untouched entries and stable keys", () => {
  const original = first(),
    before = structuredClone(original);
  const changed = {
    ...original.elements[0],
    label: "Exact CASE & punctuation?!",
  };
  const extraRegion = { ...original.regions[0], key: "new_region" };
  const extra = {
    ...original.elements[0],
    key: "new_action",
    regionKey: "new_region",
    label: "Apply NOW",
  };
  const result = mergeInspection(original, {
    ...mockInspection(original),
    regions: [extraRegion],
    elements: [changed, extra],
    corrections: ["Synthetic correction"],
  }).output;
  expect(result.elements).toEqual([
    changed,
    ...original.elements.slice(1),
    extra,
  ]);
  expect(result.regions).toEqual([...original.regions, extraRegion]);
  expect(original).toEqual(before);
});
it("accepts an older complete inventory as a compatible patch", () => {
  const original = first();
  expect(
    mergeInspection(
      original,
      InspectorOutputSchema.parse({ ...original, corrections: [] }),
    ).output,
  ).toEqual(original);
});
it("rejects ambiguous corrections and dangling region references rather than damaging the first reading", () => {
  const original = first(),
    before = structuredClone(original),
    patch = mockInspection(original);
  expect(() =>
    mergeInspection(original, {
      ...patch,
      elements: [original.elements[0], original.elements[0]],
    }),
  ).toThrow(/ambiguous/);
  expect(() =>
    mergeInspection(original, {
      ...patch,
      elements: [{ ...original.elements[0], regionKey: "missing" }],
    }),
  ).toThrow(/unavailable region/);
  expect(original).toEqual(before);
});
it("applies compact coordinate and exact-label corrections without resending descriptions, options or rules", () => {
  const original = first(),
    before = structuredClone(original),
    target = original.elements[0];
  const patch = {
    ...mockInspection(original),
    boundsCorrections: [
      { key: target.key, bounds: { x: 2, y: 3, width: 20, height: 10 } },
    ],
    labelCorrections: [
      { key: target.key, label: "Exact text: Save & continue" },
    ],
  };
  const result = mergeInspection(original, patch).output;
  expect(result.elements[0]).toEqual({
    ...target,
    bounds: patch.boundsCorrections[0].bounds,
    label: patch.labelCorrections[0].label,
  });
  expect(result.elements.slice(1)).toEqual(original.elements.slice(1));
  expect(original).toEqual(before);
  const compact = JSON.stringify(patch.boundsCorrections);
  expect(compact.length).toBeLessThan(JSON.stringify(target).length);
});
it("rejects missing keys, duplicate or conflicting compact changes and out-of-image geometry", () => {
  const original = first(),
    empty = mockInspection(original),
    key = original.elements[0].key;
  const good = { key, bounds: { x: 1, y: 2, width: 10, height: 20 } };
  for (const patch of [
    { ...empty, boundsCorrections: [{ ...good, key: "missing" }] },
    { ...empty, boundsCorrections: [good, good] },
    { ...empty, elements: [original.elements[0]], boundsCorrections: [good] },
    {
      ...empty,
      boundsCorrections: [
        { key, bounds: { x: 99, y: 0, width: 10, height: 20 } },
      ],
    },
  ])
    expect(() => mergeInspection(original, patch)).toThrow(/inspection/);
});
