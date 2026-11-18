/**
 * Markdown converters for the trackers:
 *  - markdownToJiraWiki: Jira wiki markup (REST v2 description field, Cloud and Server/DC).
 *  - markdownToHtml: HTML for Azure DevOps rich-text fields — raw HTML in the markdown is escaped, links
 *    are limited to http(s)/mailto, relative images become a text placeholder.
 *  - helpers to turn a spec .md body into a GitHub issue body (relative links/images do not resolve there).
 * Gherkin code blocks are rendered as lines with bold GIVEN/WHEN/AND/THEN keywords in both Jira and HTML,
 * which reads better in a tracker than a code block.
 */
import { Lexer, Marked, type Token, type Tokens } from "marked";

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const GHERKIN_LANGS = new Set(["gherkin", "feature", "cucumber", "bdd"]);
const STEP_KEYWORD = /^(given|when|then|and|but)\b[ \t]*(.*)$/i;
const BLOCK_KEYWORD =
  /^(feature|background|scenario outline|scenario template|scenario|example|examples|rule):[ \t]*(.*)$/i;

/** Text shown instead of an image that only exists in the local spec folder. */
export function imagePlaceholder(alt: string): string {
  return `(screen image: ${alt.trim() || "screen"} — see spec repo)`;
}

export function isAbsoluteUrl(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href.trim());
}

function isHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}

const ENTITY: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
};

/** marked marks some text as already HTML-escaped; Jira needs the plain characters. */
function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m) => ENTITY[m] ?? m);
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isHtmlComment(text: string): boolean {
  return /^\s*<!--[\s\S]*?-->\s*$/.test(text);
}

function isBrTag(text: string): boolean {
  return /^\s*<br\s*\/?>\s*$/i.test(text);
}

/** "GIVEN the user …" lines of a gherkin block, keyword split from the rest. */
export function splitGherkinLine(line: string): {
  keyword?: string;
  rest: string;
  block?: boolean;
} {
  const trimmed = line.trim();
  const step = STEP_KEYWORD.exec(trimmed);
  if (step) return { keyword: step[1].toUpperCase(), rest: step[2] };
  const block = BLOCK_KEYWORD.exec(trimmed);
  if (block)
    return {
      keyword: `${block[1][0].toUpperCase()}${block[1].slice(1).toLowerCase()}:`,
      rest: block[2],
      block: true,
    };
  return { rest: trimmed };
}

/* ------------------------------------------------------------------ */
/* Markdown → Jira wiki markup                                         */
/* ------------------------------------------------------------------ */

const JIRA_CODE_LANGS = new Set([
  "actionscript",
  "ada",
  "applescript",
  "bash",
  "c",
  "c#",
  "c++",
  "cpp",
  "css",
  "erlang",
  "go",
  "groovy",
  "haskell",
  "html",
  "java",
  "javascript",
  "js",
  "json",
  "lua",
  "nyan",
  "objc",
  "perl",
  "php",
  "python",
  "r",
  "rainbow",
  "ruby",
  "scala",
  "sh",
  "sql",
  "swift",
  "visualbasic",
  "xml",
  "yaml",
]);

// Jira turns these into icons: (x) (/) (i) (y) (n) (!) (?) (+) (-) (on) (off) (*) (*r) …
const JIRA_EMOTICON =
  /\((x|\/|i|y|n|!|\?|\+|-|on|off|\*[rgby]?|flag|flagoff)\)/gi;
const OPENER_CHARS = "*_+^~-";

/**
 * Escape plain text for Jira wiki. Brackets, braces and pipes always (links, macros, tables);
 * text-effect markers only where they could open an effect (keeps "C++" and "sign_in_button" readable).
 */
export function escapeWikiText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = i === 0 ? "" : text[i - 1];
    const next = text[i + 1] ?? "";
    if ("{}[]|".includes(ch)) {
      out += `\\${ch}`;
    } else if (
      OPENER_CHARS.includes(ch) &&
      (prev === "" || /[\s([{"']/.test(prev)) &&
      next !== "" &&
      !/\s/.test(next)
    ) {
      out += `\\${ch}`;
    } else if (ch === "?" && next === "?") {
      // ??citation??
      out += "\\?";
    } else if (
      ch === "!" &&
      next !== "" &&
      !/\s/.test(next) &&
      text.indexOf("!", i + 1) > i + 1
    ) {
      // !image.png!
      out += "\\!";
    } else {
      out += ch;
    }
  }
  return out.replace(JIRA_EMOTICON, (m) => `\\${m}`);
}

/** Text at the start of a line must not read as a list, heading, quote or rule. */
function escapeLineStarts(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (/^[*#-]+\s/.test(line)) return `\\${line}`;
      if (/^(h[1-6]|bq)\.\s/i.test(line)) return line.replace(".", "\\.");
      if (/^-{4,}\s*$/.test(line)) return `\\${line}`;
      return line;
    })
    .join("\n");
}

type InlinePart =
  | { kind: "text"; value: string }
  | { kind: "effect"; marker: string; inner: string };

function renderInlineWiki(tokens: Token[] | undefined): string {
  if (!tokens?.length) return "";
  const parts: InlinePart[] = [];
  for (const token of tokens) {
    const t = token as Token & Record<string, unknown>;
    switch (token.type) {
      case "text": {
        const tt = token as Tokens.Text;
        if (tt.tokens?.length)
          parts.push({ kind: "text", value: renderInlineWiki(tt.tokens) });
        else {
          const plain = tt.escaped ? decodeEntities(tt.text) : tt.text;
          // Soft line breaks are spaces in markdown; Jira would render them as breaks.
          parts.push({
            kind: "text",
            value: escapeWikiText(plain.replace(/\r?\n/g, " ")),
          });
        }
        break;
      }
      case "escape": {
        const ch = (token as Tokens.Escape).text;
        parts.push({
          kind: "text",
          value: /[{}[\]|*_+^~\-!?#(]/.test(ch) ? `\\${ch}` : ch,
        });
        break;
      }
      case "strong":
        parts.push({
          kind: "effect",
          marker: "*",
          inner: renderInlineWiki((token as Tokens.Strong).tokens),
        });
        break;
      case "em":
        parts.push({
          kind: "effect",
          marker: "_",
          inner: renderInlineWiki((token as Tokens.Em).tokens),
        });
        break;
      case "del":
        parts.push({
          kind: "effect",
          marker: "-",
          inner: renderInlineWiki((token as Tokens.Del).tokens),
        });
        break;
      case "codespan": {
        const code = decodeIfNeeded((token as Tokens.Codespan).text);
        if (code.trim())
          parts.push({ kind: "text", value: `{{${escapeMonospace(code)}}}` });
        break;
      }
      case "br":
        parts.push({ kind: "text", value: "\n" });
        break;
      case "link": {
        const link = token as Tokens.Link;
        const label =
          renderInlineWiki(link.tokens) || escapeWikiText(link.text);
        if (isAbsoluteUrl(link.href)) {
          const href = encodeWikiUrl(link.href.trim());
          parts.push({
            kind: "text",
            value:
              link.autolink || link.text === link.href
                ? `[${href}]`
                : `[${label}|${href}]`,
          });
        } else {
          // Relative links point into the local spec folder — meaningless in the tracker.
          parts.push({ kind: "text", value: label });
        }
        break;
      }
      case "image": {
        const img = token as Tokens.Image;
        if (isHttpUrl(img.href))
          parts.push({
            kind: "text",
            value: `!${encodeWikiUrl(img.href.trim())}!`,
          });
        else
          parts.push({
            kind: "effect",
            marker: "_",
            inner: escapeWikiText(imagePlaceholder(img.text)),
          });
        break;
      }
      case "html": {
        const html = (token as Tokens.HTML).text;
        if (isBrTag(html)) parts.push({ kind: "text", value: "\n" });
        else if (!isHtmlComment(html))
          parts.push({ kind: "text", value: escapeWikiText(html) });
        break;
      }
      case "checkbox":
        parts.push({
          kind: "text",
          value: (token as Tokens.Checkbox).checked ? "☑ " : "☐ ",
        });
        break;
      default:
        parts.push({
          kind: "text",
          value: escapeWikiText(String(t.text ?? t.raw ?? "")),
        });
    }
  }
  return joinInlineParts(parts);
}

/** Jira effects need non-word neighbours; mid-word effects use the {*}bold{*} form. */
function joinInlineParts(parts: InlinePart[]): string {
  const rendered: string[] = parts.map((p) =>
    p.kind === "text" ? p.value : "",
  );
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.kind !== "effect") continue;
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(p.inner);
    const [lead, core, trail] = match
      ? [match[1], match[2], match[3]]
      : ["", p.inner, ""];
    if (!core) {
      rendered[i] = p.inner;
      continue;
    }
    const before = rendered.slice(0, i).join("").slice(-1);
    const after = (
      parts[i + 1]?.kind === "text"
        ? (parts[i + 1] as { value: string }).value
        : ""
    ).slice(0, 1);
    const tight =
      (/[\p{L}\p{N}]/u.test(before) && !lead) ||
      (/[\p{L}\p{N}]/u.test(after) && !trail);
    const open = tight ? `{${p.marker}}` : p.marker;
    rendered[i] = `${lead}${open}${core}${open}${trail}`;
  }
  return rendered.join("");
}

function decodeIfNeeded(text: string): string {
  return /&(amp|lt|gt|quot|#39);/.test(text) ? decodeEntities(text) : text;
}

function escapeMonospace(code: string): string {
  return code.replace(/[{}[\]|*_+^~\-!]/g, (c) => `\\${c}`);
}

function encodeWikiUrl(url: string): string {
  return url
    .replace(/\|/g, "%7C")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D")
    .replace(/ /g, "%20");
}

/** List items and table cells cannot contain raw newlines in Jira — use its forced break. */
function singleLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " \\\\ ").trim();
}

export function gherkinToJiraWiki(code: string): string {
  return code
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const { keyword, rest } = splitGherkinLine(line);
      if (keyword)
        return `*${keyword}*${rest ? ` ${escapeWikiText(rest)}` : ""}`;
      if (line.startsWith("#"))
        return `_${escapeWikiText(line.replace(/^#\s*/, ""))}_`;
      return escapeLineStarts(escapeWikiText(line));
    })
    .join("\n");
}

function renderBlocksWiki(tokens: Token[]): string[] {
  const blocks: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "space":
      case "def":
        break;
      case "heading": {
        const h = token as Tokens.Heading;
        blocks.push(
          `h${Math.min(6, Math.max(1, h.depth))}. ${singleLine(renderInlineWiki(h.tokens))}`,
        );
        break;
      }
      case "paragraph":
        blocks.push(
          escapeLineStarts(
            renderInlineWiki((token as Tokens.Paragraph).tokens),
          ),
        );
        break;
      case "text": {
        const t = token as Tokens.Text;
        blocks.push(
          escapeLineStarts(
            t.tokens ? renderInlineWiki(t.tokens) : escapeWikiText(t.text),
          ),
        );
        break;
      }
      case "code": {
        const c = token as Tokens.Code;
        const lang = (c.lang ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "";
        if (GHERKIN_LANGS.has(lang)) {
          blocks.push(gherkinToJiraWiki(c.text));
        } else if (c.text.includes("{code") || c.text.includes("{noformat}")) {
          blocks.push(
            `{noformat}\n${c.text.replace(/\{noformat\}/g, "{ noformat}")}\n{noformat}`,
          );
        } else {
          blocks.push(
            `${JIRA_CODE_LANGS.has(lang) ? `{code:${lang}}` : "{code}"}\n${c.text}\n{code}`,
          );
        }
        break;
      }
      case "blockquote": {
        const inner = renderBlocksWiki(
          (token as Tokens.Blockquote).tokens,
        ).join("\n\n");
        blocks.push(`{quote}\n${inner}\n{quote}`);
        break;
      }
      case "list":
        blocks.push(renderListWiki(token as Tokens.List, "").join("\n"));
        break;
      case "table":
        blocks.push(renderTableWiki(token as Tokens.Table));
        break;
      case "hr":
        blocks.push("----");
        break;
      case "html": {
        const html = (token as Tokens.HTML).text;
        if (!isHtmlComment(html) && html.trim())
          blocks.push(escapeLineStarts(escapeWikiText(html.trim())));
        break;
      }
      default: {
        const raw = (token as { raw?: string }).raw ?? "";
        if (raw.trim())
          blocks.push(escapeLineStarts(escapeWikiText(raw.trim())));
      }
    }
  }
  return blocks.filter((b) => b.length > 0);
}

function renderListWiki(list: Tokens.List, prefix: string): string[] {
  const marker = `${prefix}${list.ordered ? "#" : "*"}`;
  const lines: string[] = [];
  for (const item of list.items) {
    const inline: string[] = [];
    const nested: string[] = [];
    const trailing: string[] = [];
    // A prefix, not an inline entry: inline entries are joined with a line break (Jira's " \\ ").
    let box = "";
    for (const child of item.tokens) {
      if (child.type === "list")
        nested.push(...renderListWiki(child as Tokens.List, marker));
      else if (child.type === "checkbox")
        box = (child as Tokens.Checkbox).checked ? "☑ " : "☐ ";
      else if (child.type === "text" || child.type === "paragraph") {
        const t = child as Tokens.Text | Tokens.Paragraph;
        inline.push(
          t.tokens ? renderInlineWiki(t.tokens) : escapeWikiText(t.text),
        );
      } else if (child.type !== "space") {
        // Code blocks/tables inside list items cannot nest in Jira; they follow the item.
        trailing.push(...renderBlocksWiki([child]));
      }
    }
    const content = `${box}${singleLine(inline.join("\n"))}`.trim();
    lines.push(`${marker} ${content || " "}`);
    lines.push(...nested);
    if (trailing.length) lines.push(...trailing);
  }
  return lines;
}

function renderTableWiki(table: Tokens.Table): string {
  const cell = (c: Tokens.TableCell) =>
    singleLine(renderInlineWiki(c.tokens)) || " ";
  const lines = [`||${table.header.map(cell).join("||")}||`];
  for (const row of table.rows) lines.push(`|${row.map(cell).join("|")}|`);
  return lines.join("\n");
}

/** Markdown (GFM) → Jira wiki markup. */
export function markdownToJiraWiki(markdown: string): string {
  const tokens = Lexer.lex(markdown.replace(/\r\n/g, "\n"), { gfm: true });
  return renderBlocksWiki(tokens).join("\n\n").trim();
}

/* ------------------------------------------------------------------ */
/* Markdown → HTML (Azure DevOps rich text)                            */
/* ------------------------------------------------------------------ */

export function gherkinToHtml(code: string): string {
  const lines = code
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const { keyword, rest } = splitGherkinLine(line);
      if (keyword)
        return `<strong>${escapeHtml(keyword)}</strong>${rest ? ` ${escapeHtml(rest)}` : ""}`;
      if (line.startsWith("#"))
        return `<em>${escapeHtml(line.replace(/^#\s*/, ""))}</em>`;
      return escapeHtml(line);
    });
  return lines.length ? `<p>${lines.join("<br>\n")}</p>\n` : "";
}

const htmlMarked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }) {
      if (isHtmlComment(text)) return "";
      if (isBrTag(text)) return "<br>";
      // Never pass the BA's raw HTML through to the tracker — show it as text.
      return escapeHtml(text);
    },
    code({ text, lang }) {
      const language = (lang ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "";
      if (GHERKIN_LANGS.has(language)) return gherkinToHtml(text);
      return `<pre><code>${escapeHtml(text)}</code></pre>\n`;
    },
    link({ href, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (!isAbsoluteUrl(href)) return inner;
      return `<a href="${escapeHtml(href.trim())}">${inner}</a>`;
    },
    image({ href, text }) {
      if (isHttpUrl(href))
        return `<img src="${escapeHtml(href.trim())}" alt="${escapeHtml(text)}">`;
      return `<em>${escapeHtml(imagePlaceholder(text))}</em>`;
    },
    checkbox({ checked }) {
      return checked ? "☑ " : "☐ ";
    },
  },
});

/** Markdown (GFM) → HTML with raw HTML escaped and only http(s)/mailto links. */
export function markdownToHtml(markdown: string): string {
  return (
    htmlMarked.parse(markdown.replace(/\r\n/g, "\n"), {
      async: false,
    }) as string
  ).trim();
}

/* ------------------------------------------------------------------ */
/* Spec .md → tracker-friendly markdown                                */
/* ------------------------------------------------------------------ */

const FRONT_MATTER = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export function stripFrontMatter(markdown: string): string {
  return markdown.replace(FRONT_MATTER, "").replace(/^\s*\n/, "");
}

/** Drops the first H1 ("# UC-003 · Title") — the tracker item title already says it. */
export function removeLeadingH1(markdown: string): string {
  return markdown.replace(/^\s*#[ \t]+[^\n]*\n?/, "").replace(/^\s*\n/, "");
}

/**
 * Relative images → "_(screen image: Login — see spec repo)_", relative links → their text.
 * Fenced code blocks are left untouched.
 */
export function rewriteRelativeReferences(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let fence: string | null = null;
  return lines
    .map((line) => {
      const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        if (!fence) fence = fenceMatch[1];
        else if (
          fenceMatch[1][0] === fence[0] &&
          fenceMatch[1].length >= fence.length
        )
          fence = null;
        return line;
      }
      if (fence) return line;
      return line
        .replace(
          /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
          (m, alt: string, href: string) =>
            isHttpUrl(href) ? m : `_${imagePlaceholder(alt)}_`,
        )
        .replace(
          /(^|[^!\\])\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
          (m, pre: string, text: string, href: string) =>
            isAbsoluteUrl(href) ? m : `${pre}${text}`,
        );
    })
    .join("\n");
}
