import type { SettingsData } from "./data";
import {
  applyOdysseusTokens,
  isOdysseusTheme,
  mountThemeEffect,
} from "./themes/odysseus";

/** Legacy values round-trip unchanged; only the design preview still uses them. */
export function mountAppearance(
  settings: Pick<
    SettingsData,
    "theme" | "density" | "reduceMotion" | "backgroundEffects"
  >,
  live: boolean,
  sessionAuthorized: boolean,
) {
  const light = window.matchMedia("(prefers-color-scheme: light)");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let clearTokens = () => {};
  let stopEffect = () => {};
  let previousTheme = "";
  let previousEffect = "";
  const update = () => {
    const root = document.documentElement;
    root.dataset.theme =
      settings.theme === "system"
        ? light.matches
          ? "light"
          : "dark"
        : settings.theme;
    root.dataset.density = live ? "comfortable" : settings.density;
    root.dataset.motion =
      reduced.matches || (!live && settings.reduceMotion) ? "reduced" : "full";
    const theme = root.dataset.theme;
    if (theme !== previousTheme) {
      stopEffect();
      clearTokens();
      clearTokens =
        live && isOdysseusTheme(theme) ? applyOdysseusTokens(theme) : () => {};
      previousTheme = theme;
      previousEffect = "";
    }
    const enabled =
      live &&
      sessionAuthorized &&
      isOdysseusTheme(theme) &&
      settings.backgroundEffects !== false &&
      document.visibilityState !== "hidden";
    const effectKey = `${theme}:${enabled}:${root.dataset.motion}`;
    if (effectKey !== previousEffect) {
      stopEffect();
      stopEffect =
        enabled && isOdysseusTheme(theme)
          ? mountThemeEffect(theme, !reduced.matches)
          : () => {};
      previousEffect = effectKey;
    }
  };
  update();
  light.addEventListener("change", update);
  reduced.addEventListener("change", update);
  document.addEventListener("visibilitychange", update);
  return () => {
    light.removeEventListener("change", update);
    reduced.removeEventListener("change", update);
    document.removeEventListener("visibilitychange", update);
    stopEffect();
    clearTokens();
  };
}

/** Shared by programmatic scrolling, which CSS alone cannot reliably suppress. */
export function prefersReducedMotion() {
  return (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.documentElement.dataset.motion === "reduced"
  );
}
