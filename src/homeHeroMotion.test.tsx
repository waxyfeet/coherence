import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountHeroMotion } from "./homeHeroMotion";

let frame: (() => void) | undefined;
let preference: EventTarget & { matches: boolean };
let doc: EventTarget & {
  visibilityState: string;
  documentElement: { dataset: { motion: string } };
};
let appChanged: (() => void) | undefined;
let appDisconnect: ReturnType<typeof vi.fn>;
let intersection:
  | ((entries: { target: HTMLElement; isIntersecting: boolean }[]) => void)
  | undefined;
let disconnect: ReturnType<typeof vi.fn>;
let win: EventTarget;
let bounds = { top: 10, bottom: 360, left: 20, right: 800 };
const element = { getBoundingClientRect: () => bounds } as HTMLElement;
const runFrame = () => {
  const next = frame;
  frame = undefined;
  next?.();
};
beforeEach(() => {
  vi.useFakeTimers();
  frame = undefined;
  intersection = undefined;
  bounds = { top: 10, bottom: 360, left: 20, right: 800 };
  preference = Object.assign(new EventTarget(), { matches: false });
  doc = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    documentElement: { dataset: { motion: "full" } },
  });
  appDisconnect = vi.fn();
  appChanged = undefined;
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        appChanged = callback;
      }
      observe() {}
      disconnect = appDisconnect;
    },
  );
  disconnect = vi.fn();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("CSS", { supports: () => true });
  win = Object.assign(new EventTarget(), {
    innerHeight: 768,
    innerWidth: 1366,
    matchMedia: () => preference,
    requestAnimationFrame: (callback: () => void) => {
      frame = callback;
      return 1;
    },
    cancelAnimationFrame: () => {
      frame = undefined;
    },
  });
  // The previous completion flag and even denied session storage are irrelevant to looping.
  Object.defineProperty(win, "sessionStorage", {
    get() {
      throw Error("Storage must not be read");
    },
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof intersection) {
        intersection = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps playing beyond repeated eight-second cycles and loops again on subsequent Home mounts without session storage", () => {
  const onPlaying = vi.fn();
  const cleanup = mountHeroMotion(element, onPlaying, {});
  runFrame();
  expect(onPlaying).toHaveBeenLastCalledWith(true);
  vi.advanceTimersByTime(32000);
  expect(onPlaying).toHaveBeenLastCalledWith(true);
  expect(vi.getTimerCount()).toBe(0);
  cleanup();
  const next = vi.fn();
  mountHeroMotion(element, next, {})();
  expect(frame).toBeUndefined();
  const stop = mountHeroMotion(element, next, {});
  runFrame();
  expect(next).toHaveBeenLastCalledWith(true);
  stop();
});
it("StrictMode cleanup before the first frame cancels startup and releases observers", () => {
  const onPlaying = vi.fn();
  mountHeroMotion(element, onPlaying, {})();
  expect(frame).toBeUndefined();
  expect(onPlaying).not.toHaveBeenCalledWith(true);
  expect(disconnect).toHaveBeenCalledOnce();
  expect(appDisconnect).toHaveBeenCalledOnce();
});
it.each([{ paused: true }, { staticMode: true }])(
  "%o remains fully revealed without scheduling animation",
  (options) => {
    const onPlaying = vi.fn();
    mountHeroMotion(element, onPlaying, options)();
    expect(onPlaying.mock.calls).toEqual([[false]]);
    expect(frame).toBeUndefined();
  },
);
it("OS reduced motion stops and reveals the full story; motion can resume only after the preference is disabled", () => {
  const onPlaying = vi.fn(),
    cleanup = mountHeroMotion(element, onPlaying, {});
  runFrame();
  preference.matches = true;
  preference.dispatchEvent(new Event("change"));
  expect(onPlaying).toHaveBeenLastCalledWith(false);
  expect(frame).toBeUndefined();
  preference.matches = false;
  preference.dispatchEvent(new Event("change"));
  runFrame();
  expect(onPlaying).toHaveBeenLastCalledWith(true);
  cleanup();
});
it("initial OS reduced motion stays static, then starts when explicitly allowed", () => {
  preference.matches = true;
  const onPlaying = vi.fn(),
    cleanup = mountHeroMotion(element, onPlaying, {});
  expect(frame).toBeUndefined();
  expect(onPlaying).not.toHaveBeenCalledWith(true);
  preference.matches = false;
  preference.dispatchEvent(new Event("change"));
  runFrame();
  expect(onPlaying).toHaveBeenLastCalledWith(true);
  cleanup();
});
it.each(["background", "offscreen"])(
  "suspends in %s, resumes when visible and releases listeners on cleanup",
  (reason) => {
    const onPlaying = vi.fn(),
      cleanup = mountHeroMotion(element, onPlaying, {});
    runFrame();
    if (reason === "background") {
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
    } else intersection!([{ target: element, isIntersecting: false }]);
    expect(onPlaying).toHaveBeenLastCalledWith(false);
    if (reason === "background") {
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
    } else intersection!([{ target: element, isIntersecting: true }]);
    runFrame();
    expect(onPlaying).toHaveBeenLastCalledWith(true);
    cleanup();
    const count = onPlaying.mock.calls.length;
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    preference.dispatchEvent(new Event("change"));
    appChanged!();
    expect(onPlaying.mock.calls).toHaveLength(count);
    expect(frame).toBeUndefined();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(appDisconnect).toHaveBeenCalledOnce();
  },
);
it("unsupported animation stays fully revealed", () => {
  vi.stubGlobal("CSS", { supports: () => false });
  const onPlaying = vi.fn();
  mountHeroMotion(element, onPlaying, {})();
  expect(onPlaying).not.toHaveBeenCalledWith(true);
  expect(frame).toBeUndefined();
});
it("application Reduce motion is respected initially and on changes, without consuming any session", () => {
  doc.documentElement.dataset.motion = "reduced";
  const onPlaying = vi.fn(),
    cleanup = mountHeroMotion(element, onPlaying, {});
  expect(frame).toBeUndefined();
  doc.documentElement.dataset.motion = "full";
  appChanged!();
  runFrame();
  expect(onPlaying).toHaveBeenLastCalledWith(true);
  doc.documentElement.dataset.motion = "reduced";
  appChanged!();
  expect(onPlaying).toHaveBeenLastCalledWith(false);
  cleanup();
});
it("rechecks preferences before the first frame", () => {
  const onPlaying = vi.fn(),
    cleanup = mountHeroMotion(element, onPlaying, {});
  doc.documentElement.dataset.motion = "reduced";
  runFrame();
  expect(onPlaying).not.toHaveBeenCalledWith(true);
  cleanup();
});
it("starts a previously hidden hero when the document becomes visible", () => {
  doc.visibilityState = "hidden";
  const onPlaying = vi.fn(),
    cleanup = mountHeroMotion(element, onPlaying, {});
  expect(frame).toBeUndefined();
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  runFrame();
  expect(onPlaying).toHaveBeenLastCalledWith(true);
  cleanup();
});
it("fallback without IntersectionObserver suspends on scroll and resumes on resize", () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const onPlaying = vi.fn(),
    cleanup = mountHeroMotion(element, onPlaying, {});
  runFrame();
  bounds = { top: 900, bottom: 1250, left: 20, right: 800 };
  doc.dispatchEvent(new Event("scroll"));
  expect(onPlaying).toHaveBeenLastCalledWith(false);
  bounds = { top: 10, bottom: 360, left: 20, right: 800 };
  win.dispatchEvent(new Event("resize"));
  runFrame();
  expect(onPlaying).toHaveBeenLastCalledWith(true);
  cleanup();
  const count = onPlaying.mock.calls.length;
  win.dispatchEvent(new Event("resize"));
  doc.dispatchEvent(new Event("scroll"));
  expect(onPlaying.mock.calls).toHaveLength(count);
});
