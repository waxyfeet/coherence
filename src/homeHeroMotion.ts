/** Loop only while visible and motion is allowed. Static CSS always shows the full story. */
export function mountHeroMotion(
  element: HTMLElement,
  onPlaying: (playing: boolean) => void,
  options: { paused?: boolean; staticMode?: boolean },
) {
  onPlaying(false);
  const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const supported =
    typeof CSS !== "undefined" &&
    CSS.supports("clip-path", "inset(0)") &&
    typeof window.requestAnimationFrame === "function";
  if (options.paused || options.staticMode || !preference || !supported)
    return () => {};

  let disposed = false;
  let playing = false;
  let frame = 0;
  let intersecting = true;
  const visible = () => {
    const rect = element.getBoundingClientRect();
    return (
      document.visibilityState === "visible" &&
      intersecting &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth
    );
  };
  const allowed = () =>
    !preference.matches &&
    document.documentElement?.dataset.motion !== "reduced" &&
    visible();
  const update = () => {
    if (disposed) return;
    if (!allowed()) {
      window.cancelAnimationFrame(frame);
      frame = 0;
      playing = false;
      onPlaying(false);
    } else if (!playing && !frame) {
      // A deferred start keeps React StrictMode's setup/cleanup probe harmless.
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (disposed || !allowed()) return;
        playing = true;
        onPlaying(true);
      });
    }
  };
  preference.addEventListener("change", update);
  document.addEventListener("visibilitychange", update);
  const appPreferenceObserver =
    typeof MutationObserver === "function"
      ? new MutationObserver(update)
      : undefined;
  if (document.documentElement)
    appPreferenceObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-motion"],
    });
  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          const entry = entries.find((item) => item.target === element);
          if (entry) intersecting = entry.isIntersecting;
          update();
        })
      : undefined;
  observer?.observe(element);
  // Older engines without IntersectionObserver still suspend an offscreen hero.
  if (!observer) {
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
  }
  update();
  return () => {
    disposed = true;
    window.cancelAnimationFrame(frame);
    observer?.disconnect();
    appPreferenceObserver?.disconnect();
    preference.removeEventListener("change", update);
    document.removeEventListener("visibilitychange", update);
    if (!observer) {
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    }
  };
}
