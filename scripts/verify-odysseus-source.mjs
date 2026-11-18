/** Pin/compare the authorised source port. Public upstream reads only; no Odysseus service or owner data. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import { format } from "prettier";
import { ODYSSEUS_PALETTES } from "../src/themes/odysseus-colors.js";

export const revision = "8877273e195a90d51bc6a37f3a1b60dc3414c431";
export const files = [
  "static/js/theme.js",
  "static/js/color/hex.js",
  "static/css/00-tokens.css",
  "static/css/01-agent-chat.css",
  "static/css/17-research.css",
  "LICENSE",
  "licenses/FiraCode-OFL-1.1.txt",
  ...["Light", "Regular", "SemiBold"].map(
    (w) => `static/fonts/FiraCode-${w}.woff2`,
  ),
];
export const sourceRoot = path.resolve(".cache/batch03/upstream");
export async function ensureSource() {
  const hashes = {};
  for (const file of files) {
    const target = path.join(sourceRoot, file);
    let data;
    try {
      data = await readFile(target);
    } catch {
      const response = await fetch(
        `https://raw.githubusercontent.com/odysseus-dev/odysseus/${revision}/${file}`,
        { redirect: "error" },
      );
      assert(response.ok, "Pinned public source unavailable");
      data = Buffer.from(await response.arrayBuffer());
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
    }
    hashes[file] = createHash("sha256").update(data).digest("hex");
  }
  return hashes;
}
export function originalFunctions(source) {
  return new Map(
    [...source.matchAll(/^(?:export )?function (\w+)\(/gm)].map((m) => {
      const rest = source.slice(m.index),
        first = rest.split("\n")[0];
      return [
        m[1],
        (/}\s*$/.test(first) ? first : rest.match(/^[^]*?^}/m)[0]).replace(
          /^export /,
          "",
        ),
      ];
    }),
  );
}
export async function verifySource() {
  const hashes = await ensureSource();
  const manifest = JSON.parse(
    await readFile("docs/odysseus-theme-source.json", "utf8"),
  );
  assert.equal(manifest.revision, revision);
  assert.deepEqual(hashes, manifest.sha256);
  const original = await readFile(
    path.join(sourceRoot, "static/js/theme.js"),
    "utf8",
  );
  const functions = originalFunctions(original);
  const renderer = await readFile("src/themes/odysseus-renderers.js", "utf8");
  const colors = await readFile("src/themes/odysseus-colors.js", "utf8");
  const canonical = (value) => format(value, { parser: "babel" });
  const checked = [];
  for (const name of [
    "_initSynapse",
    "_initStarfieldDepth",
    "_initAsciiFireflies",
    "_initPetals",
    "_initSparkles",
    "_initEmbers",
    "_getEffectSize",
    "_getEffectSpeed",
  ]) {
    const adapted = renderer.match(
      new RegExp(`^  function ${name}\\([^]*?^  }`, "m"),
    )?.[0];
    assert(adapted, `Missing ported ${name}`);
    assert.equal(
      await canonical(adapted),
      await canonical(functions.get(name)),
      `Visual algorithm differs: ${name}`,
    );
    checked.push(name);
  }
  const portedColors = originalFunctions(colors);
  for (const name of [
    "hexToHSL",
    "hslToHex",
    "deriveSyntaxColors",
    "computeAdvancedDefaults",
  ]) {
    assert.equal(
      await canonical(portedColors.get(name)),
      await canonical(functions.get(name)),
      `Derived colour differs: ${name}`,
    );
    checked.push(name);
  }
  const hex = originalFunctions(
    await readFile(path.join(sourceRoot, "static/js/color/hex.js"), "utf8"),
  ).get("hexToRgb");
  assert.equal(
    await canonical(portedColors.get("hexToRgb")),
    await canonical(hex),
  );
  assert.equal(
    await canonical(renderer.match(/^  function hexToRgb\([^]*?^  }/m)[0]),
    await canonical(hex),
  );
  for (const [name, palette] of Object.entries(ODYSSEUS_PALETTES)) {
    const line = original.match(new RegExp(`^  ${name}:.*$`, "m"))[0];
    assert.deepEqual(
      palette,
      Object.fromEntries(
        [...line.matchAll(/(bg|fg|panel|border|red):'([^']+)'/g)].map((m) => [
          m[1],
          m[2],
        ]),
      ),
    );
  }
  for (const weight of ["Light", "Regular", "SemiBold"])
    assert.equal(
      createHash("sha256")
        .update(
          await readFile(`public/fonts/odysseus/FiraCode-${weight}.woff2`),
        )
        .digest("hex"),
      hashes[`static/fonts/FiraCode-${weight}.woff2`],
    );
  assert.equal(
    createHash("sha256")
      .update(await readFile("public/notices/Odysseus-AGPL-3.0.txt"))
      .digest("hex"),
    hashes.LICENSE,
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile("public/notices/Odysseus-FiraCode-OFL-1.1.txt"))
      .digest("hex"),
    hashes["licenses/FiraCode-OFL-1.1.txt"],
  );
  const result = {
    passed: true,
    revision,
    palettes: 6,
    unchangedVisualFunctions: [...checked, "hexToRgb (both modules)"],
    originalFontFiles: 3,
    originalNotices: 2,
  };
  await mkdir("artifacts/ux-batch-03", { recursive: true });
  await writeFile(
    "artifacts/ux-batch-03/source-verification.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
  return result;
}
if (
  process.argv[1]?.replaceAll("\\", "/").endsWith("verify-odysseus-source.mjs")
)
  await verifySource();
