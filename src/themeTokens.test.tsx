import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyOdysseusTokens, ODYSSEUS_PALETTES } from "./themes/odysseus";
let values: Map<string, string>, dataset: Record<string, string>;
let cleanup: (() => void) | undefined;
beforeEach(() => {
  values = new Map();
  dataset = {};
  vi.stubGlobal("document", {
    documentElement: {
      dataset,
      style: {
        getPropertyValue: (key: string) => values.get(key) ?? "",
        setProperty: (key: string, value: string) => values.set(key, value),
        removeProperty: (key: string) => values.delete(key),
      },
    },
  });
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
});
it.each(Object.keys(ODYSSEUS_PALETTES) as (keyof typeof ODYSSEUS_PALETTES)[])(
  "keeps the exact %s palette in the application role mapping",
  (theme) => {
    cleanup = applyOdysseusTokens(theme);
    const source = ODYSSEUS_PALETTES[theme];
    for (const key of ["bg", "fg", "panel", "border", "red"] as const)
      expect(values.get("--" + key)).toBe(source[key]);
    expect(values.get("--canvas")).toBe(source.bg);
    expect(values.get("--surface")).toBe(source.panel);
    expect(values.get("--text")).toBe(source.fg);
    expect(values.get("--accent")).toBe(source.red);
    expect(dataset.odysseusTheme).toBe(theme);
  },
);
it("uses existing source foreground for light semantic text instead of inventing colours", () => {
  cleanup = applyOdysseusTokens("cute");
  expect(values.get("--green")).toBe(ODYSSEUS_PALETTES.cute.fg);
  expect(values.get("--muted")).toBe(ODYSSEUS_PALETTES.cute.fg);
  cleanup();
  cleanup = applyOdysseusTokens("ocean");
  expect(values.get("--green")).toBe("#50fa7b");
  expect(values.get("--muted")).toBe("#888888");
});
it("discard restores prior inline values and leaves unrelated properties untouched", () => {
  values.set("--canvas", "#112233");
  values.set("--sentinel", "retained");
  const stop = applyOdysseusTokens("forest");
  stop();
  expect(values).toEqual(
    new Map([
      ["--canvas", "#112233"],
      ["--sentinel", "retained"],
    ]),
  );
  expect(dataset.odysseusTheme).toBeUndefined();
});
