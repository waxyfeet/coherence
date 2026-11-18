/**
 * OWNER: formats builder.
 * YAML front matter helpers shared by the format parser and the spec store (stale-file detection,
 * front-matter-only rewrites). Tolerant of BOM, CRLF and blank lines before the opening fence.
 */
import {
  Document,
  isMap,
  isScalar,
  parse as parseYaml,
  parseDocument,
  type YAMLMap,
} from "yaml";
import { normaliseNewlines } from "./markdown";

export interface FrontMatterSplit {
  /** False when the document does not start with a `---` block. */
  found: boolean;
  /** Raw YAML between the fences (LF line endings). */
  yaml: string;
  /** Everything after the closing fence (LF line endings). Whole document when !found. */
  body: string;
  /** Set when an opening fence exists but no closing fence was found. */
  unterminated: boolean;
}

const OPEN = /^---[ \t]*$/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/;

export function splitFrontMatter(markdown: string): FrontMatterSplit {
  const lines = normaliseNewlines(markdown).split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || !OPEN.test(lines[i])) {
    return {
      found: false,
      yaml: "",
      body: lines.join("\n"),
      unterminated: false,
    };
  }
  for (let j = i + 1; j < lines.length; j++) {
    if (CLOSE.test(lines[j])) {
      return {
        found: true,
        yaml: lines.slice(i + 1, j).join("\n"),
        body: lines.slice(j + 1).join("\n"),
        unterminated: false,
      };
    }
  }
  return { found: false, yaml: "", body: lines.join("\n"), unterminated: true };
}

export interface FrontMatterData {
  data: Record<string, unknown> | null;
  /** BA-readable problem, when the block is missing or not valid YAML. */
  error?: string;
  body: string;
}

export function readFrontMatter(markdown: string): FrontMatterData {
  const split = splitFrontMatter(markdown);
  if (split.unterminated) {
    return {
      data: null,
      body: split.body,
      error:
        'The front matter block is not closed — add a line with only "---" after it.',
    };
  }
  if (!split.found) {
    return {
      data: null,
      body: split.body,
      error:
        'The file has no front matter (the block between "---" lines at the very top).',
    };
  }
  try {
    const value: unknown = parseYaml(split.yaml, {
      prettyErrors: true,
      uniqueKeys: false,
    });
    if (value === null || value === undefined)
      return { data: {}, body: split.body };
    if (typeof value !== "object" || Array.isArray(value)) {
      return {
        data: null,
        body: split.body,
        error: 'The front matter must be a list of "key: value" lines.',
      };
    }
    return { data: value as Record<string, unknown>, body: split.body };
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return {
      data: null,
      body: split.body,
      error: `The front matter is not valid YAML: ${msg}`,
    };
  }
}

/**
 * Replace (or insert) the front matter block of `markdown` with `block` (a full `---…---` block),
 * leaving the body byte-for-byte untouched (including its line endings).
 */
export function replaceFrontMatter(markdown: string, block: string): string {
  const raw = markdown.replace(/^﻿/, "");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const fm = block.replace(/\n$/, "").replace(/\r?\n/g, eol);
  const m =
    /^(?:[ \t]*\r?\n)*---[ \t]*\r?\n([\s\S]*?)(?:^|\r?\n)(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(
      raw,
    );
  if (m && m.index === 0) {
    return `${fm}${eol}${raw.slice(m[0].length)}`;
  }
  return `${fm}${eol}${eol}${raw}`;
}

/**
 * replaceFrontMatter for a file the BA may have extended: keys of the existing block that the format does not
 * own (priority, owner, labels… — never read by the parser) are kept with their comments, after the rendered
 * keys. `owned` lists every key the format writes or reads (also the ones it only writes sometimes, such as
 * staleReason); keys present in `block` always count as owned. Without foreign keys, or when the existing
 * block is not a valid YAML map, this is replaceFrontMatter.
 */
export function mergeFrontMatter(
  markdown: string,
  block: string,
  owned: Iterable<string>,
): string {
  return replaceFrontMatter(markdown, withForeignKeys(block, markdown, owned));
}

/**
 * A freshly rendered document (`rendered`, front matter included) that keeps the foreign front-matter keys of
 * the file it replaces (`previous`) — see mergeFrontMatter.
 */
export function carryFrontMatter(
  previous: string,
  rendered: string,
  owned: Iterable<string>,
): string {
  const split = splitFrontMatter(rendered);
  if (!split.found) return rendered;
  const block = `---\n${split.yaml}\n---`;
  const merged = withForeignKeys(block, previous, owned);
  return merged === block ? rendered : replaceFrontMatter(rendered, merged);
}

/** `block` (a full `---…---` block) with the foreign keys of `source`'s front matter appended. */
function withForeignKeys(
  block: string,
  source: string,
  owned: Iterable<string>,
): string {
  const rendered = splitFrontMatter(block);
  if (!rendered.found) return block;
  const ownedKeys = new Set([...owned, ...topLevelKeys(rendered.yaml)]);
  const extra = foreignFrontMatter(source, ownedKeys);
  if (!extra) return block;
  return `---\n${rendered.yaml.replace(/\n+$/, "")}\n${extra}---`;
}

function topLevelKeys(yaml: string): string[] {
  try {
    const doc = parseDocument(yaml, { uniqueKeys: false });
    if (!isMap(doc.contents)) return [];
    return doc.contents.items.flatMap((pair) =>
      isScalar(pair.key) ? [String(pair.key.value)] : [],
    );
  } catch {
    return [];
  }
}

/** The keys of a document's front matter that are not `owned`, as YAML ending in a newline ('' when none). */
function foreignFrontMatter(markdown: string, owned: Set<string>): string {
  const split = splitFrontMatter(markdown);
  if (!split.found || !split.yaml.trim()) return "";
  try {
    const doc = parseDocument(split.yaml, { uniqueKeys: false });
    if (doc.errors.length || !isMap(doc.contents)) return "";
    const items = doc.contents.items.filter(
      (pair) => !(isScalar(pair.key) && owned.has(String(pair.key.value))),
    );
    if (!items.length) return "";
    const out = new Document({});
    (out.contents as YAMLMap).items = items;
    out.comment = doc.comment ?? doc.contents.comment ?? null;
    const yaml = out.toString({ lineWidth: 0, flowCollectionPadding: false });
    return yaml.trim() === "{}" ? "" : yaml;
  } catch {
    return ""; // e.g. an alias to an anchor in a replaced key — fall back to the rendered block
  }
}
