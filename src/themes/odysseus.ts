import {
  ODYSSEUS_PALETTES,
  deriveSyntaxColors,
  computeAdvancedDefaults,
  type OdysseusTheme,
} from "./odysseus-colors.js";
import { mountOriginalEffect } from "./odysseus-renderers.js";

export { ODYSSEUS_PALETTES };
export const ODYSSEUS_REVISION = "8877273e195a90d51bc6a37f3a1b60dc3414c431";
/** Defaults copied from the pinned theme.js, not chosen ScreenScribe alternatives. */
export const ODYSSEUS_THEMES = [
  { id: "ocean", name: "Ocean", pattern: "starfield-depth", intensity: 1 },
  {
    id: "cyberpunk",
    name: "Cyberpunk",
    pattern: "synapse",
    intensity: 0.55,
    effectColor: "#62c4c7",
  },
  { id: "retrowave", name: "Retrowave", pattern: "embers", intensity: 1 },
  {
    id: "terminal",
    name: "Terminal",
    pattern: "ascii-fireflies",
    intensity: 0.8,
  },
  { id: "forest", name: "Forest", pattern: "petals", intensity: 1 },
  {
    id: "cute",
    name: "Cute",
    pattern: "sparkles",
    intensity: 1,
    effectColor: "#ff8cb8",
  },
] as const;
export function isOdysseusTheme(theme: string): theme is OdysseusTheme {
  return Object.hasOwn(ODYSSEUS_PALETTES, theme);
}
function luminance(hex: string) {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map((c) => parseInt(c, 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
/** Keep original palette tokens; map existing component roles onto those tokens. */
export function applyOdysseusTokens(theme: OdysseusTheme) {
  const root = document.documentElement;
  const p = ODYSSEUS_PALETTES[theme];
  // Original 00-tokens.css semantic colours, falling back to the original
  // foreground where a light surface makes those shared colours illegible.
  // This selects existing source colours; it never synthesizes a new palette.
  const readable = (color: string) =>
    [p.bg, p.panel].every(
      (bg) =>
        (Math.max(luminance(color), luminance(bg)) + 0.05) /
          (Math.min(luminance(color), luminance(bg)) + 0.05) >=
        4.5,
    )
      ? color
      : p.fg;
  const advanced = computeAdvancedDefaults(p);
  const syntax = deriveSyntaxColors(p);
  const tokens: Record<string, string> = {
    bg: p.bg,
    fg: p.fg,
    panel: p.panel,
    red: p.red,
    border: p.border,
    canvas: p.bg,
    surface: p.panel,
    "surface-2": p.panel,
    raised: p.panel,
    inset: p.panel,
    text: p.fg,
    muted: readable("#888888"),
    quiet: readable("#888888"),
    "border-soft": p.border,
    "border-strong": p.border,
    accent: p.red,
    "accent-hover": p.red,
    "accent-ink": p.bg,
    "accent-wash": `color-mix(in srgb, ${p.red} 12%, transparent)`,
    "accent-border": p.red,
    green: readable("#50fa7b"),
    amber: readable("#f0ad4e"),
    blue: readable("#00aaff"),
    "green-wash": `color-mix(in srgb, ${p.fg} 7%, transparent)`,
    "amber-wash": `color-mix(in srgb, ${p.fg} 7%, transparent)`,
    "blue-wash": `color-mix(in srgb, ${p.fg} 7%, transparent)`,
    "graph-edge": p.fg,
    mono: '"Fira Code", monospace',
    "hl-bg": syntax.bg,
    "hl-fg": syntax.fg,
    ...Object.fromEntries(
      Object.entries(syntax)
        .filter(([k]) => !["bg", "fg"].includes(k))
        .map(([k, v]) => [`hl-${k}`, v]),
    ),
    ...Object.fromEntries(
      Object.entries(advanced).map(([k, v]) => [
        k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()),
        v,
      ]),
    ),
  };
  const original = Object.fromEntries(
    Object.keys(tokens).map((k) => [k, root.style.getPropertyValue("--" + k)]),
  );
  for (const [key, value] of Object.entries(tokens))
    root.style.setProperty("--" + key, value);
  root.dataset.odysseusTheme = theme;
  return () => {
    for (const [key, value] of Object.entries(original)) {
      if (value) root.style.setProperty("--" + key, value);
      else root.style.removeProperty("--" + key);
    }
    delete root.dataset.odysseusTheme;
  };
}
export function mountThemeEffect(theme: OdysseusTheme, animated: boolean) {
  const definition = ODYSSEUS_THEMES.find((t) => t.id === theme)!;
  const layer = document.createElement("div");
  layer.id = "odysseus-background";
  layer.className = "bg-pattern-" + definition.pattern;
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;
  layer.dataset.pattern = definition.pattern;
  layer.dataset.motion = animated ? "running" : "static";
  const p = ODYSSEUS_PALETTES[theme];
  // Renderer reads these from documentElement, as in the original implementation.
  const root = document.documentElement;
  const effect = {
    "--bg-effect-intensity": String(definition.intensity),
    "--bg-effect-color":
      "effectColor" in definition ? definition.effectColor : p.fg,
    "--bg-effect-size": "1",
    "--bg-effect-speed": "1",
  };
  for (const [key, value] of Object.entries(effect))
    root.style.setProperty(key, value);
  document.body.prepend(layer);
  const stop = mountOriginalEffect(definition.pattern, layer, animated);
  return () => {
    stop();
    layer.remove();
    for (const key of Object.keys(effect)) root.style.removeProperty(key);
  };
}
