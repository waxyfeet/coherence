import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { expect, it } from "vitest";
import { BrandMark } from "./BrandMark";

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

it.each([16, 24, 32, 48, 54, 256])(
  "uses approved SVGs with square dimensions and a single accessible logo at %ipx",
  (size) => {
    const html = renderToStaticMarkup(<BrandMark size={size} />);
    const suffix = size <= 48 ? `-${size}` : "";
    expect(html).toContain(`src="/brand/scanline-dark${suffix}.svg"`);
    expect(html).toContain(`src="/brand/scanline-light${suffix}.svg"`);
    expect(html).toContain(`width="${size}" height="${size}"`);
    expect(html).toContain(
      'role="img" aria-label="Coherence — Scanline 1B logo"',
    );
    expect(html.match(/alt=""/g)).toHaveLength(2);
    expect(html).not.toContain("<svg");
  },
);
it("retains every approved final export byte-for-byte and rejects active/external SVG content", async () => {
  const manifest = JSON.parse(read("src/brandAssets.json")) as {
    files: { file: string; sha256: string; bytes: number }[];
  };
  expect(manifest.files).toHaveLength(22);
  for (const asset of manifest.files) {
    const bytes = fs.readFileSync(path.join(root, "public", asset.file));
    expect(bytes.length, asset.file).toBe(asset.bytes);
    expect(createHash("sha256").update(bytes).digest("hex"), asset.file).toBe(
      asset.sha256,
    );
    if (asset.file.endsWith(".svg"))
      expect(bytes.toString()).not.toMatch(
        /<script\b|<foreignObject\b|<!DOCTYPE|\son\w+\s*=|(?:href|src)\s*=/i,
      );
    const pngSize = /-(\d+)\.png$/.exec(asset.file)?.[1];
    if (pngSize) {
      const metadata = await sharp(bytes).metadata();
      expect(metadata.width).toBe(Number(pngSize));
      expect(metadata.height).toBe(Number(pngSize));
    }
    if (asset.file.endsWith(".ico")) {
      expect(bytes.readUInt16LE(0)).toBe(0);
      expect(bytes.readUInt16LE(2)).toBe(1);
      expect(bytes.readUInt16LE(4)).toBeGreaterThan(1);
    }
  }
  expect(fs.readFileSync(path.join(root, "public/favicon.svg"))).toEqual(
    fs.readFileSync(path.join(root, "public/brand/scanline-dark-16.svg")),
  );
});
it("serves a Coherence title and explicit original SVG/PNG/ICO favicon paths with a light variant", () => {
  const html = read("index.html");
  expect(html).toContain("<title>Coherence — Design workspace</title>");
  expect(html).not.toContain("ScreenScribe");
  expect(html).toContain('media="(prefers-color-scheme: light)"');
  for (const href of [...html.matchAll(/<link\b[^>]*href="([^"]+)"/g)].map(
    (m) => m[1],
  ))
    expect(fs.existsSync(path.join(root, "public", href))).toBe(true);
  const css = read("src/brand.css");
  expect(css).toContain('data-theme="light"');
  expect(css).toContain('data-theme="cute"');
  expect(css).toContain("object-fit: contain");
  expect(css).not.toMatch(/filter\s*:|transform\s*:|padding\s*:/);
});
