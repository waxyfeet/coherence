/**
 * Surgical update of the `external:` block in a use case file's YAML front matter. Used after an export
 * when the BA's file differs from what the model would render: only the export links change, every other
 * byte of the file (including YAML formatting and comments) is kept.
 */
import { isMap, parseDocument, stringify } from "yaml";
import type { ExternalLink } from "@shared/types";

const FRONT_MATTER =
  /^(﻿?)---[ \t]*(\r?\n)([\s\S]*?)(\r?\n)---[ \t]*(?=\r?\n|$)/;

/** Key order as documented in the format (system, key, url, revision, exportedAt). */
function plainLinks(external: ExternalLink[]) {
  return external.map((l) => ({
    system: l.system,
    key: l.key,
    url: l.url,
    revision: l.revision,
    exportedAt: l.exportedAt,
  }));
}

/**
 * Returns the file with its front matter `external` list replaced (removed when empty), or undefined
 * when the file has no parseable YAML front matter.
 */
export function patchFrontMatterExternal(
  markdown: string,
  external: ExternalLink[],
): string | undefined {
  const match = FRONT_MATTER.exec(markdown);
  if (!match) return undefined;
  const [whole, bom, eol, yamlText] = match;
  const original = parseDocument(yamlText);
  if (original.errors.length || !isMap(original.contents)) return undefined;

  const expected = JSON.stringify(plainLinks(external));
  const lines = yamlText.split(/\r?\n/);
  const start = lines.findIndex((l) => /^external[ \t]*:/.test(l));
  let end = start;
  if (start !== -1) {
    end = start + 1;
    // The block runs until the next top-level key (indented lines, sequence items and blanks belong to it).
    while (
      end < lines.length &&
      (lines[end].trim() === "" ||
        /^[\s-]/.test(lines[end]) ||
        /^#/.test(lines[end]))
    )
      end++;
    // Trailing blank/comment lines belong to whatever follows.
    while (
      end - 1 > start &&
      (lines[end - 1].trim() === "" || /^#/.test(lines[end - 1]))
    )
      end--;
  }
  const block = external.length
    ? stringify({ external: plainLinks(external) }, { lineWidth: 0 })
        .replace(/\n+$/, "")
        .split("\n")
    : [];
  const nextLines =
    start === -1
      ? [...lines, ...block]
      : [...lines.slice(0, start), ...block, ...lines.slice(end)];
  let nextYaml = nextLines.join("\n");

  // Verify the surgical edit; fall back to a full YAML rewrite if it did not produce what we want.
  const check = parseDocument(nextYaml);
  const got = check.errors.length
    ? undefined
    : (check.toJS() as { external?: unknown } | null);
  const ok =
    got !== undefined &&
    got !== null &&
    JSON.stringify(got.external ?? []) === expected &&
    JSON.stringify({ ...(got as object), external: undefined }) ===
      JSON.stringify({ ...(original.toJS() as object), external: undefined });
  if (!ok) {
    if (external.length) original.set("external", plainLinks(external));
    else original.delete("external");
    nextYaml = original.toString({ lineWidth: 0 }).replace(/\n+$/, "");
  }
  if (eol === "\r\n") nextYaml = nextYaml.replace(/\r?\n/g, "\r\n");
  return `${bom}---${eol}${nextYaml}${match[4]}---${markdown.slice(whole.length)}`;
}
