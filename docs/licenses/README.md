# Runtime licence provenance

Coherence uses independently installed dependencies. No Odysseus application source, styles, branding or media are included, apart from the six adapted themes, which are distributed with their copyright holders' written permission ([permission record](Odysseus-themes-permission.md)). The backend and domain modules and the Acme sample screenshots are adapted from the author's own earlier application, ScreenScribe.

`public/THIRD_PARTY_NOTICES.txt` reproduces runtime package notices from the installed tree, including transitive packages. The notice generator also writes an inventory of names, resolved versions and declared licences to `.cache/notices/dependency-licenses.json`. Development tools keep their own package notices in `node_modules`.

A review on 17 October 2026 confirmed that all 445 runtime entries installed at that time matched the inventory. The generator now also retains separate package `NOTICE` files; this adds `es-toolkit@1.52.0`'s Lodash/Underscore attribution that the earlier licence-only collection omitted.

One npm package, `react-remove-scroll-bar@2.3.8`, declares MIT but omits a licence file from its tarball. Its packaged README also says MIT. The retained `react-remove-scroll-bar-LICENSE.txt` was obtained on 15 October 2026 from the maintainer's [upstream LICENSE](https://github.com/theKashey/react-remove-scroll-bar/blob/master/LICENSE). This is the current upstream notice, not a claim that a licence file existed at the package's published gitHead. The notice generator explicitly supplies this file for that package.

Inter Variable is self-hosted from `@fontsource-variable/inter` under SIL OFL 1.1. The runtime notice bundle retains its full notice. Radix and React use MIT; Lucide's installed package includes ISC and attribution for applicable upstream icons. Exact notices, rather than this summary, govern reuse.

Home Hero 5a (21 October 2026) uses pinned Fontsource `5.3.0` packages for Geist, Geist Mono and Instrument Serif. Only normal Latin variable Geist/Geist Mono and Latin italic Instrument Serif are requested by the hero, from locally built font assets with `font-display: swap`. Full upstream copyright/OFL notices are retained unchanged in `Geist-OFL.txt`, `Geist-Mono-OFL.txt`, `Instrument-Serif-OFL.txt` and the generated runtime notice bundle; font binaries are unmodified. No Google Fonts connection, preview runtime or video is shipped. The actual runtime inventory is now 450 package entries, with no missing licence texts. The newly pinned `@axe-core/playwright`/`axe-core` accessibility tooling is development-only and is not a runtime dependency. The Home hero is adapted from the author's own design; no third-party assets are introduced by it.

The functional build now records 447 runtime package entries, including nested dependencies. The S03 follow-up added pinned MIT `undici@7.30.1` and `ipaddr.js@2.5.0`; the original `ipaddr.js@1.9.1` remains nested under its existing dependent. `data-uri-to-buffer@4.0.1` embeds its full MIT licence in its packaged README; the generator extracts that section. `busboy` and `streamsearch` declare licences in the older `licenses` array; `khroma` supplies an MIT licence file despite missing metadata. These are retained explicitly.

`standardwebhooks@1.1.1` declares MIT in package metadata but omits a licence file. Its upstream repository at published commit `b4d2c14fc5b4ccff3ff271e3b087dff812254c59` supplies an Apache-2.0 root licence and no JavaScript-specific licence. Both the metadata and the full upstream notice are retained; the difference is recorded rather than asserting that the two notices are identical. [Pinned upstream licence](https://github.com/standard-webhooks/standard-webhooks/blob/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/LICENSE).

Sharp's Windows libvips binary includes LGPL-3.0-or-later alongside Apache-2.0, and Mermaid's optional ELK layout dependency uses EPL-2.0. These are unmodified upstream dependencies with their installed notices retained. The Windows installer ships the LGPL-3.0 and GPL-3.0 texts beside them (`packaging/licenses/`). If you redistribute Coherence, keep these notices and the ability to replace those libraries.

To regenerate after dependency changes, from the project directory:

```powershell
New-Item -ItemType Directory -Force .cache/notices | Out-Null
npm ls --omit=dev --all --parseable | Set-Content -LiteralPath .cache/notices/runtime-packages.txt -Encoding utf8
node scripts/update-notices.mjs
```

## Odysseus theme source

Six themes and their effects are adapted from Odysseus, with its copyright holders' written permission ([permission record](Odysseus-themes-permission.md)). The selected source is pinned to `8877273e195a90d51bc6a37f3a1b60dc3414c431`; [mapping and technical differences](../ODYSSEUS_THEME_PORT.md), [file hashes](../odysseus-theme-source.json). Source module headers retain attribution and the revision. The full upstream AGPL text is retained in `public/notices/Odysseus-AGPL-3.0.txt`. Three original Fira Code WOFF2 files and their full OFL notice are bundled locally; they are not npm dependency additions. The source verifier checks their hashes.

This page records where things come from. It is not legal advice; the exact notices govern reuse.
