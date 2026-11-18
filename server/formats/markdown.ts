/**
 * OWNER: formats builder.
 * Small, format-agnostic markdown / mermaid helpers shared by the renderers and parsers.
 * Everything here is pure and deterministic (render output must be stable for round-trip tests).
 */

/** Collapse all whitespace (incl. newlines) to single spaces and trim — for one-line markdown constructs. */
export function oneLine(text: string | undefined | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Normalise line endings (CRLF / CR → LF) and strip a UTF-8 BOM. */
export function normaliseNewlines(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/**
 * Free-text block (notes): LF line endings, no leading blank lines, no trailing whitespace.
 * Interior formatting is kept verbatim.
 */
export function normaliseBlock(text: string | undefined | null): string {
  return normaliseNewlines(text ?? "")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/\s+$/, "");
}

/** Escape a value for a GFM table cell: pipes escaped, line breaks become <br>. */
export function escapeCell(text: string | number | undefined | null): string {
  const s = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!s) return "";
  return s
    .replace(/\\\|/g, "|") // avoid double escaping already-escaped pipes
    .replace(/\|/g, "\\|")
    .replace(/\n+/g, "<br>");
}

/** Escape text used inside a markdown link label: [label](target). */
export function escapeLinkText(text: string): string {
  return oneLine(text).replace(/([[\]\\])/g, "\\$1");
}

/** Markdown link with a relative target. Spaces in targets are percent-encoded so GFM keeps the link intact. */
export function mdLink(label: string, target: string): string {
  return `[${escapeLinkText(label)}](${encodeLinkTarget(target)})`;
}

export function encodeLinkTarget(target: string): string {
  return target
    .replace(/ /g, "%20")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

/** Inline code span that survives backticks inside the value. */
export function inlineCode(text: string): string {
  const value = oneLine(text);
  const longest = Math.max(
    0,
    ...(value.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** Render a GFM table. Cells must already be escaped (use escapeCell) or be trusted markdown (links). */
export function table(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `|${headers.map(() => "---").join("|")}|`;
  const body = rows.map(
    (row) => `| ${row.map((c) => (c === "" ? " " : c)).join(" | ")} |`,
  );
  return [head, sep, ...body].join("\n");
}

/** "—" for empty values in tables and summaries. */
export function orDash(text: string | undefined | null): string {
  const s = (text ?? "").trim();
  return s ? s : "—";
}

/** Title Case for type words ("email_input" → "Email input"; only the first letter is capitalised). */
export function capitalise(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

export function plural(
  n: number,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

export function percent(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

/** Shorten to max characters with an ellipsis (whitespace collapsed first). */
export function truncate(text: string, max: number): string {
  const s = oneLine(text);
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Local calendar date (YYYY-MM-DD) of an ISO timestamp; "" when not parseable. The server runs on the BA's
 * machine, so local time is the BA's time — a spec written just after midnight must not show yesterday.
 */
export function isoDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    return /^(\d{4}-\d{2}-\d{2})/.exec(iso)?.[1] ?? "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "YYYY-MM-DD HH:MM (UTC+10:00)" in local time from an ISO timestamp. */
export function isoDateTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const offset = -d.getTimezoneOffset();
  const zone =
    offset === 0
      ? "UTC"
      : `UTC${offset > 0 ? "+" : "-"}${pad2(Math.floor(Math.abs(offset) / 60))}:${pad2(Math.abs(offset) % 60)}`;
  return `${isoDate(iso)} ${pad2(d.getHours())}:${pad2(d.getMinutes())} (${zone})`;
}

/* ------------------------------------------------------------------ */
/* Mermaid                                                             */
/* ------------------------------------------------------------------ */

/**
 * Mermaid-safe node id: letters, digits and underscores only, prefixed so reserved words
 * ("end", "graph", "subgraph"…) and leading digits can never break the diagram.
 */
export function mermaidId(prefix: string, raw: string): string {
  const body = raw.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${prefix}_${body || "x"}`;
}

/** Allocates unique mermaid ids for arbitrary domain ids (distinct raw ids may sanitise to the same string). */
export class MermaidIds {
  private readonly byRaw = new Map<string, string>();
  private readonly used = new Set<string>();

  constructor(private readonly prefix: string) {}

  get(raw: string): string {
    const existing = this.byRaw.get(raw);
    if (existing) return existing;
    const base = mermaidId(this.prefix, raw);
    let id = base;
    for (let n = 2; this.used.has(id); n++) id = `${base}_${n}`;
    this.used.add(id);
    this.byRaw.set(raw, id);
    return id;
  }
}

/**
 * Quoted mermaid label. Mermaid entity codes keep quotes, angle brackets, backticks and hashes
 * from being interpreted (HTML labels, markdown strings, entity starts).
 */
export function mermaidLabel(text: string, max = 60): string {
  const s = truncate(text, max)
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/`/g, "#96;")
    .replace(/\|/g, "#124;");
  return `"${s || " "}"`;
}

/* ------------------------------------------------------------------ */
/* Line scanning                                                       */
/* ------------------------------------------------------------------ */

export interface FenceState {
  char: "`" | "~";
  length: number;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Tracks fenced code blocks line by line. Returns the new state after `line`
 * (null = outside a fence). `inside` tells whether `line` itself belongs to a fence (incl. its markers).
 */
export function stepFence(
  state: FenceState | null,
  line: string,
): { state: FenceState | null; inside: boolean } {
  const m = FENCE_OPEN.exec(line);
  if (!state) {
    if (m) {
      const char = m[1][0] as "`" | "~";
      // A backtick fence's info string may not contain backticks (CommonMark).
      if (char === "`" && m[2].includes("`"))
        return { state: null, inside: false };
      return { state: { char, length: m[1].length }, inside: true };
    }
    return { state: null, inside: false };
  }
  if (
    m &&
    m[1][0] === state.char &&
    m[1].length >= state.length &&
    m[2].trim() === ""
  ) {
    return { state: null, inside: true };
  }
  return { state, inside: true };
}

/** Splits lines at headings of exactly `level` (#, ##, ###) outside fenced code blocks. */
export function splitAtHeadings(
  lines: string[],
  level: number,
): {
  before: string[];
  sections: { heading: string; rawHeading: string; lines: string[] }[];
} {
  const re = new RegExp(`^ {0,3}#{${level}}(?!#)(?:[ \\t]+(.*?))?[ \\t]*$`);
  const before: string[] = [];
  const sections: { heading: string; rawHeading: string; lines: string[] }[] =
    [];
  let fence: FenceState | null = null;
  for (const line of lines) {
    const wasOutside = fence === null;
    const step = stepFence(fence, line);
    fence = step.state;
    const m = wasOutside && !step.inside ? re.exec(line) : null;
    if (m) {
      sections.push({
        heading: (m[1] ?? "").trim(),
        rawHeading: line.trimEnd(),
        lines: [],
      });
    } else if (sections.length) {
      sections[sections.length - 1].lines.push(line);
    } else {
      before.push(line);
    }
  }
  return { before, sections };
}

/** Removes leading and trailing blank lines. */
export function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

/** Groups lines into paragraphs separated by blank lines. */
export function paragraphs(lines: string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length) out.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) out.push(current);
  return out;
}

/** '|' for a table row, '>' for a blockquote line, '' otherwise. */
function lineKind(line: string): "|" | ">" | "" {
  const m = /^ {0,3}([|>])/.exec(line);
  return m ? (m[1] as "|" | ">") : "";
}

/**
 * True for a block markdown construct that must be kept line by line rather than reflowed into one line: a
 * closed fenced code block, or a table / blockquote whose every line carries its marker (a lazy continuation
 * line could be anything — a heading, an element id — so such a block is reflowed like a paragraph).
 */
export function isVerbatimBlock(lines: string[]): boolean {
  if (!lines.length) return false;
  const kind = lineKind(lines[0]);
  if (kind) return lines.every((line) => lineKind(line) === kind);
  let fence: FenceState | null = stepFence(null, lines[0]).state;
  if (!fence) return false;
  for (const line of lines.slice(1))
    fence = fence ? stepFence(fence, line).state : fence;
  return fence === null;
}

/**
 * Like paragraphs(), but aware of block constructs: a fenced code block is one block even across blank lines,
 * and a fence, table or blockquote starting right under other text begins a block of its own (as in CommonMark,
 * where they interrupt a paragraph).
 */
export function blocks(lines: string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let fence: FenceState | null = null;
  const flush = () => {
    if (current.length) out.push(current);
    current = [];
  };
  for (const line of lines) {
    if (fence) {
      current.push(line);
      fence = stepFence(fence, line).state;
      if (!fence) flush();
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const opened = stepFence(null, line).state;
    const kind = lineKind(line);
    if (opened || (kind && current.length && lineKind(current[0]) !== kind))
      flush();
    current.push(line);
    fence = opened;
  }
  flush();
  return out;
}

const BULLET = /^(\s*)(?:[-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;

/** True when the line starts a list item ("- x", "* x", "+ x", "1. x", "1) x"). */
export function isBulletLine(line: string): boolean {
  const m = BULLET.exec(line);
  // A lone "-" / "*" with nothing after it is still an (empty) bullet; "---" (hr) is not.
  return !!m && !/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line);
}

/**
 * Parses a markdown bullet list tolerantly:
 * - accepts -, *, + and numbered markers;
 * - continuation lines (indented or lazy) are joined to the previous item with a space;
 * - nested items are folded into their parent ("Options: Admin; Editor");
 * - plain paragraphs without markers become items;
 * - a list that is only "None" / "N/A" / "—" means empty.
 */
export function parseBulletList(lines: string[]): string[] {
  interface Item {
    indent: number;
    text: string;
    children: string[];
  }
  const items: Item[] = [];
  let prevBlank = true;
  let fence: FenceState | null = null;
  for (const raw of lines) {
    const step = stepFence(fence, raw);
    const wasInFence = fence !== null || step.inside;
    fence = step.state;
    if (wasInFence) {
      // Code inside a list: keep its text on the current item so nothing is lost.
      const text = raw.trim();
      if (text && !/^(`{3,}|~{3,})/.test(text) && items.length)
        appendText(items[items.length - 1], text);
      prevBlank = false;
      continue;
    }
    if (raw.trim() === "") {
      prevBlank = true;
      continue;
    }
    const m = BULLET.exec(raw);
    if (m && isBulletLine(raw)) {
      const indent = m[1].replace(/\t/g, "    ").length;
      const text = stripCheckboxSpacing(m[2] ?? "");
      const parent = items[items.length - 1];
      if (parent && indent >= parent.indent + 2) {
        parent.children.push(oneLine(text));
      } else {
        items.push({ indent, text: oneLine(text), children: [] });
      }
    } else if (!prevBlank && items.length) {
      appendText(items[items.length - 1], raw.trim());
    } else if (/^\s{2,}\S/.test(raw) && items.length) {
      appendText(items[items.length - 1], raw.trim());
    } else {
      items.push({ indent: 0, text: oneLine(raw), children: [] });
    }
    prevBlank = false;
  }
  const out = items
    .map((item) => {
      const children = item.children.filter(Boolean);
      if (!children.length) return item.text;
      const joiner = item.text.endsWith(":") || !item.text ? " " : "; ";
      return oneLine(`${item.text}${joiner}${children.join("; ")}`);
    })
    .filter((s) => s !== "");
  if (out.length === 1 && isNoneMarker(out[0])) return [];
  return out;

  function appendText(item: Item, text: string): void {
    if (item.children.length)
      item.children[item.children.length - 1] = oneLine(
        `${item.children[item.children.length - 1]} ${text}`,
      );
    else item.text = oneLine(`${item.text} ${text}`);
  }
}

function stripCheckboxSpacing(text: string): string {
  return text.replace(/^\[([ xX])\]\s+/, "[$1] ");
}

/** "None", "None.", "N/A", "-", "—", "_None_" … */
export function isNoneMarker(text: string): boolean {
  return /^[_*]*\s*(none|n\/a|na|nil|-|—|–)\s*\.?\s*[_*]*$/i.test(text.trim());
}

/** Renders list items as "- item" lines; an empty list renders as "- None" (the parser reads it back as []). */
export function bulletList(items: string[]): string {
  const clean = items.map(oneLine).filter(Boolean);
  if (!clean.length) return "- None";
  return clean.map((item) => `- ${item}`).join("\n");
}
