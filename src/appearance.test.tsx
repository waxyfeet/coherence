import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountAppearance, prefersReducedMotion } from "./appearance";

let light: EventTarget & { matches: boolean };
let reduced: EventTarget & { matches: boolean };
let dataset: Record<string, string>;
let cleanup: (() => void) | undefined;
beforeEach(() => {
  light = Object.assign(new EventTarget(), { matches: false });
  reduced = Object.assign(new EventTarget(), { matches: false });
  dataset = { theme: "dark", density: "compact", motion: "reduced" };
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), {
      documentElement: { dataset },
      visibilityState: "visible",
    }),
  );
  vi.stubGlobal("window", {
    matchMedia: (query: string) =>
      query.includes("color-scheme") ? light : reduced,
  });
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
});

it.each([
  ["compact", true],
  ["compact", false],
  ["comfortable", true],
  ["comfortable", false],
] as const)(
  "ignores legacy %s/%s without mutating the saved preferences",
  (density, reduceMotion) => {
    const saved = Object.freeze({ theme: "dark", density, reduceMotion });
    cleanup = mountAppearance(saved, true, true);
    expect(dataset).toEqual({
      theme: "dark",
      density: "comfortable",
      motion: "full",
    });
    reduced.matches = true;
    reduced.dispatchEvent(new Event("change"));
    expect(dataset.motion).toBe("reduced");
    reduced.matches = false;
    reduced.dispatchEvent(new Event("change"));
    expect(dataset.motion).toBe("full");
    expect(saved).toEqual({ theme: "dark", density, reduceMotion });
  },
);

it.each(["dark", "light"])(
  "keeps the explicit %s theme despite system changes",
  (theme) => {
    cleanup = mountAppearance(
      { theme, density: "compact", reduceMotion: true },
      true,
      true,
    );
    light.matches = true;
    light.dispatchEvent(new Event("change"));
    expect(dataset.theme).toBe(theme);
  },
);

it("follows System theme changes and restores the saved theme after a discarded preview", () => {
  cleanup = mountAppearance(
    { theme: "system", density: "compact", reduceMotion: true },
    true,
    true,
  );
  expect(dataset.theme).toBe("dark");
  light.matches = true;
  light.dispatchEvent(new Event("change"));
  expect(dataset.theme).toBe("light");
  cleanup();
  cleanup = mountAppearance(
    { theme: "dark", density: "compact", reduceMotion: true },
    true,
    true,
  );
  expect(dataset.theme).toBe("dark");
});

it("detaches old listeners so an obsolete preview cannot override a later one", () => {
  const old = mountAppearance(
    { theme: "system", density: "comfortable", reduceMotion: false },
    true,
    true,
  );
  old();
  dataset.theme = "later-preview";
  dataset.motion = "later-motion";
  light.matches = reduced.matches = true;
  light.dispatchEvent(new Event("change"));
  reduced.dispatchEvent(new Event("change"));
  expect(dataset.theme).toBe("later-preview");
  expect(dataset.motion).toBe("later-motion");
});

it.each([true, false])(
  "preserves the explicit prototype's simulated controls (%s)",
  (reduceMotion) => {
    cleanup = mountAppearance(
      { theme: "system", density: "compact", reduceMotion },
      false,
      false,
    );
    expect(dataset.density).toBe("compact");
    expect(dataset.motion).toBe(reduceMotion ? "reduced" : "full");
  },
);

it("suppresses programmatic smooth scrolling for OS preference or the prototype override", () => {
  dataset.motion = "full";
  expect(prefersReducedMotion()).toBe(false);
  reduced.matches = true;
  expect(prefersReducedMotion()).toBe(true);
  reduced.matches = false;
  dataset.motion = "reduced";
  expect(prefersReducedMotion()).toBe(true);
});
