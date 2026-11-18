# Odysseus theme port

Six of Coherence's themes (Ocean, Cyberpunk, Retrowave, Terminal, Forest and Cute) and their background effects are
adapted from [Odysseus](https://github.com/odysseus-dev/odysseus). This page records the source, how each part was
adapted and how to check it.

## Pinned source and exact mapping

Upstream: [Odysseus](https://github.com/odysseus-dev/odysseus/tree/8877273e195a90d51bc6a37f3a1b60dc3414c431), exact default-branch revision **`8877273e195a90d51bc6a37f3a1b60dc3414c431`**. [Source files and SHA-256 manifest](odysseus-theme-source.json). The themes are distributed with the copyright holders' written permission ([record](licenses/Odysseus-themes-permission.md)). Full upstream AGPL text and Fira Code OFL notice are retained in `public/notices/`.

The source `static/js/theme.js` defines five core colours per preset and derives its syntax/advanced component tokens. The default font for these six presets is Fira Code; none has an independent font override. Its three original WOFF2 files are bundled unchanged under `public/fonts/odysseus/`, with no runtime font CDN.

| Theme | Source bg / foreground / panel / border / accent (`red`) | Original default effect | Source defaults preserved |
|---|---|---|---|
| Ocean | `#0b1a2c` / `#64d2ff` / `#091422` / `#1e5074` / `#4facfe` | Depth starfield | Foreground effect colour, intensity/size/speed 1 |
| Cyberpunk | `#10121a` / `#9bdde0` / `#171a26` / `#514b78` / `#d45aa8` | Synapse grid/pulses | Effect `#62c4c7`, intensity 0.55, size/speed 1 |
| Retrowave | `#1a1a2e` / `#e94560` / `#16213e` / `#533483` / `#e94560` | Rising embers | Foreground effect colour, intensity/size/speed 1 |
| Terminal | `#0b1110` / `#b8e6c1` / `#080d0c` / `#28553a` / `#6bd38b` | ASCII fireflies | Foreground effect colour, intensity 0.8, size/speed 1 |
| Forest | `#1b2a1b` / `#a8d5a2` / `#142414` / `#3d6b3d` / `#7cb871` | Falling petals | Foreground effect colour, intensity/size/speed 1 |
| Cute | `#fff4f7` / `#63394d` / `#fffafd` / `#edc7d5` / `#d65f88` | Sparkles | Effect `#ff8cb8`, intensity/size/speed 1 |

Upstream currently labels the `ocean` ID “starfield” in its selector. Coherence keeps the explicitly requested **Ocean** label, with the exact `ocean` implementation. No additional presets or invented effects are included. Original default frosted-glass state is off for all six; no extra glass effect is added.

| Original implementation | Coherence adaptation |
|---|---|
| `static/js/theme.js`: `THEMES`, syntax and advanced defaults | `src/themes/odysseus-colors.js`; all selected core values and colour derivations preserved |
| Same file: six `_init*` renderers and size/speed helpers | `src/themes/odysseus-renderers.js`; original visual functions retained, wrapped in an instance-local lifecycle adapter |
| `static/js/color/hex.js` | Exact parser retained in both port modules |
| `static/css/01-agent-chat.css`: pattern/ASCII layer rules | `src/themes/odysseus.css`; body selectors retargeted to a single decorative host; original grid, glyph styling and opacity preserved |
| `static/css/00-tokens.css`: Fira Code font declarations | Same three faces and weights, local paths only |
| Theme/advanced role tokens | `src/themes/odysseus.ts` maps Coherence's surfaces/inputs to original bg/panel, text to original foreground, borders and accents to original tokens; CSS swatches use the same five colours |
| Existing application components | Original Coherence layouts/controls remain. Selected labels use source foreground. Secondary/semantic roles use the original shared grey/green/amber/blue tokens from `00-tokens.css` where readable, otherwise source foreground; typed labels/icons remain. No new palette is generated |

`node scripts/verify-odysseus-source.mjs` fetches only pinned public files if absent, verifies manifest hashes, compares all selected visual/colour functions after formatting normalization, checks the six palettes and verifies fonts/notices byte-for-byte. It does not run the upstream application or contact its APIs. No source synchronization, custom-theme editor or upstream account/storage code is incorporated.

## Known limits

- **Contrast:** two themes keep their original colours although they fall short of 4.5:1 for small text. Retrowave's
  foreground on its panel is 4.15:1, and Cute's filled accent button is about 3.34:1.
- **Reduced motion:** with reduced motion set in Windows, each theme shows a static version of its original scene.
- **No canvas:** where canvas isn't available, the theme's colours apply without the background effect.
