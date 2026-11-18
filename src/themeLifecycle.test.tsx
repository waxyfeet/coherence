// Appearance policy lifecycle, independent of the original visual algorithms.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountAppearance } from "./appearance";
import { applyOdysseusTokens, mountThemeEffect } from "./themes/odysseus";
vi.mock("./themes/odysseus", async (original) => ({
  ...(await original<typeof import("./themes/odysseus")>()),
  applyOdysseusTokens: vi.fn(() => vi.fn()),
  mountThemeEffect: vi.fn(() => vi.fn()),
}));
let light: EventTarget & { matches: boolean },
  reduced: EventTarget & { matches: boolean };
let doc: EventTarget & {
  visibilityState: string;
  documentElement: { dataset: Record<string, string> };
};
let stop: (() => void) | undefined;
const saved = (theme: string, backgroundEffects?: boolean) =>
  Object.freeze({
    theme,
    backgroundEffects,
    density: "compact",
    reduceMotion: true,
  });
beforeEach(() => {
  vi.clearAllMocks();
  light = Object.assign(new EventTarget(), { matches: false });
  reduced = Object.assign(new EventTarget(), { matches: false });
  doc = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    documentElement: { dataset: {} },
  });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", {
    matchMedia: (q: string) => (q.includes("color-scheme") ? light : reduced),
  });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
});

it.each(["ocean", "cyberpunk", "retrowave", "terminal", "forest", "cute"])(
  "previews %s without changing saved compatibility fields",
  (theme) => {
    const input = saved(theme);
    stop = mountAppearance(input, true, true);
    expect(doc.documentElement.dataset).toEqual({
      theme,
      density: "comfortable",
      motion: "full",
    });
    expect(applyOdysseusTokens).toHaveBeenCalledWith(theme);
    expect(mountThemeEffect).toHaveBeenCalledExactlyOnceWith(theme, true);
    expect(input).toEqual(saved(theme));
  },
);
it("effects Off preserves theme and OS motion without starting a renderer", () => {
  stop = mountAppearance(saved("ocean", false), true, true);
  expect(doc.documentElement.dataset.theme).toBe("ocean");
  expect(applyOdysseusTokens).toHaveBeenCalledWith("ocean");
  expect(mountThemeEffect).not.toHaveBeenCalled();
  reduced.matches = true;
  reduced.dispatchEvent(new Event("change"));
  expect(doc.documentElement.dataset.motion).toBe("reduced");
  expect(mountThemeEffect).not.toHaveBeenCalled();
});
it("OS changes dispose the moving renderer before building a static original scene", () => {
  stop = mountAppearance(saved("cute"), true, true);
  const dispose = vi.mocked(mountThemeEffect).mock.results[0].value;
  reduced.matches = true;
  reduced.dispatchEvent(new Event("change"));
  expect(dispose).toHaveBeenCalledOnce();
  expect(mountThemeEffect).toHaveBeenLastCalledWith("cute", false);
  reduced.dispatchEvent(new Event("change"));
  expect(mountThemeEffect).toHaveBeenCalledTimes(2);
});
it("hidden documents release resources and resume only once when visible", () => {
  stop = mountAppearance(saved("terminal"), true, true);
  const dispose = vi.mocked(mountThemeEffect).mock.results[0].value;
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(dispose).toHaveBeenCalledOnce();
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(mountThemeEffect).toHaveBeenCalledTimes(1);
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(mountThemeEffect).toHaveBeenCalledTimes(2);
});
it("unmount releases tokens/renderer and detaches media and visibility observers", () => {
  const cleanup = mountAppearance(saved("forest"), true, true);
  const dispose = vi.mocked(mountThemeEffect).mock.results[0].value;
  const clear = vi.mocked(applyOdysseusTokens).mock.results[0].value;
  cleanup();
  expect(dispose).toHaveBeenCalledOnce();
  expect(clear).toHaveBeenCalledOnce();
  reduced.matches = true;
  reduced.dispatchEvent(new Event("change"));
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(mountThemeEffect).toHaveBeenCalledTimes(1);
});
it("Graphite, Porcelain, System and explicit prototype do not acquire theme effects", () => {
  for (const theme of ["dark", "light", "system"]) {
    const cleanup = mountAppearance(saved(theme), true, true);
    cleanup();
  }
  const cleanup = mountAppearance(saved("dark"), false, false);
  cleanup();
  expect(applyOdysseusTokens).not.toHaveBeenCalled();
  expect(mountThemeEffect).not.toHaveBeenCalled();
});

it.each(["ocean", "cyberpunk", "retrowave", "terminal", "forest", "cute"])(
  "%s retains its palette but cannot render while session recovery is required",
  (theme) => {
    stop = mountAppearance(saved(theme), true, false);
    reduced.matches = true;
    reduced.dispatchEvent(new Event("change"));
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(applyOdysseusTokens).toHaveBeenCalledWith(theme);
    expect(mountThemeEffect).not.toHaveBeenCalled();
    expect(doc.documentElement.dataset.theme).toBe(theme);
  },
);

it.each([
  [true, false, "visible", true],
  [true, true, "visible", true],
  [false, false, "visible", false],
  [true, false, "hidden", false],
] as const)(
  "recovery respects effects=%s, reduced=%s, visibility=%s",
  (effects, reduce, visibility, renders) => {
    reduced.matches = reduce;
    doc.visibilityState = visibility;
    for (let pass = 0; pass < 4; pass++) {
      // The Settings effect changes authorization without unmounting its owner.
      const active = mountAppearance(saved("ocean", effects), true, true);
      expect(mountThemeEffect).toHaveBeenCalledTimes(renders ? pass + 1 : 0);
      if (renders)
        expect(mountThemeEffect).toHaveBeenLastCalledWith("ocean", !reduce);
      active();
      if (renders)
        expect(
          vi.mocked(mountThemeEffect).mock.results[pass].value,
        ).toHaveBeenCalledOnce();
      const recovering = mountAppearance(saved("ocean", effects), true, false);
      light.dispatchEvent(new Event("change"));
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(mountThemeEffect).toHaveBeenCalledTimes(renders ? pass + 1 : 0);
      recovering();
    }
  },
);
