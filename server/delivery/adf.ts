/**
 * Markdown → Atlassian Document Format (Jira Cloud REST v3 rich-text fields).
 * Built from the marked lexer so structure is never guessed from strings. Raw HTML becomes plain text, only
 * http(s)/mailto links survive, local images become a text placeholder, and gherkin blocks render as lines with
 * bold GIVEN/WHEN/AND/THEN keywords — the same reading experience as the HTML and wiki converters.
 */
import { Lexer, type Token, type Tokens } from "marked";
import {
  imagePlaceholder,
  isAbsoluteUrl,
  splitGherkinLine,
} from "../export/markdown";

export interface AdfMark {
  type: "strong" | "em" | "code" | "strike" | "link";
  attrs?: { href: string };
}
export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
}
export interface AdfDoc {
  version: 1;
  type: "doc";
  content: AdfNode[];
}

const GHERKIN = new Set(["gherkin", "feature", "cucumber", "bdd"]);

const ENTITY: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};
const decode = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITY[m] ?? m);

function text(value: string, marks: AdfMark[] = []): AdfNode | undefined {
  if (!value) return undefined;
  return marks.length
    ? { type: "text", text: value, marks }
    : { type: "text", text: value };
}

function withMark(marks: AdfMark[], mark: AdfMark): AdfMark[] {
  // ADF forbids combining "code" with other marks.
  if (mark.type === "code") return [mark];
  if (marks.some((m) => m.type === "code")) return marks;
  return marks.some((m) => m.type === mark.type) ? marks : [...marks, mark];
}

function inline(tokens: Token[] | undefined, marks: AdfMark[] = []): AdfNode[] {
  const out: AdfNode[] = [];
  const push = (n: AdfNode | undefined) => {
    if (n) out.push(n);
  };
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length) out.push(...inline(tt.tokens, marks));
        else push(text(decode(tt.text), marks));
        break;
      }
      case "escape":
        push(text(decode((t as Tokens.Escape).text), marks));
        break;
      case "strong":
        out.push(
          ...inline(
            (t as Tokens.Strong).tokens,
            withMark(marks, { type: "strong" }),
          ),
        );
        break;
      case "em":
        out.push(
          ...inline((t as Tokens.Em).tokens, withMark(marks, { type: "em" })),
        );
        break;
      case "del":
        out.push(
          ...inline(
            (t as Tokens.Del).tokens,
            withMark(marks, { type: "strike" }),
          ),
        );
        break;
      case "codespan":
        push(
          text(
            decode((t as Tokens.Codespan).text),
            withMark(marks, { type: "code" }),
          ),
        );
        break;
      case "br":
        out.push({ type: "hardBreak" });
        break;
      case "link": {
        const l = t as Tokens.Link;
        out.push(
          ...inline(
            l.tokens,
            isAbsoluteUrl(l.href)
              ? withMark(marks, {
                  type: "link",
                  attrs: { href: l.href.trim() },
                })
              : marks,
          ),
        );
        break;
      }
      case "image": {
        const img = t as Tokens.Image;
        push(text(imagePlaceholder(img.text), withMark(marks, { type: "em" })));
        break;
      }
      case "html":
        // Raw HTML is shown as text, never interpreted.
        if (!/^\s*<!--[\s\S]*?-->\s*$/.test((t as Tokens.HTML).text))
          push(text((t as Tokens.HTML).text, marks));
        break;
      default:
        if ("text" in t && typeof t.text === "string")
          push(text(decode(t.text), marks));
    }
  }
  return out;
}

function paragraph(content: AdfNode[]): AdfNode {
  return content.length
    ? { type: "paragraph", content }
    : { type: "paragraph" };
}

function gherkin(code: string): AdfNode[] {
  const lines = code
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const content: AdfNode[] = [];
  lines.forEach((line, i) => {
    if (i) content.push({ type: "hardBreak" });
    const { keyword, rest } = splitGherkinLine(line);
    if (keyword) {
      content.push({
        type: "text",
        text: keyword,
        marks: [{ type: "strong" }],
      });
      if (rest) content.push({ type: "text", text: ` ${rest}` });
    } else content.push({ type: "text", text: line });
  });
  return content.length ? [paragraph(content)] : [];
}

function listItem(item: Tokens.ListItem): AdfNode {
  const content: AdfNode[] = [];
  for (const t of item.tokens ?? []) {
    if (t.type === "text") {
      const tt = t as Tokens.Text;
      content.push(paragraph(inline(tt.tokens?.length ? tt.tokens : [tt])));
    } else content.push(...block([t]));
  }
  if (item.task)
    content.unshift(
      paragraph([{ type: "text", text: item.checked ? "☑" : "☐" }]),
    );
  return {
    type: "listItem",
    content: content.length ? content : [paragraph([])],
  };
}

function block(tokens: Token[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "space":
        break;
      case "heading": {
        const h = t as Tokens.Heading;
        out.push({
          type: "heading",
          attrs: { level: Math.min(6, Math.max(1, h.depth)) },
          content: inline(h.tokens),
        });
        break;
      }
      case "paragraph":
        out.push(paragraph(inline((t as Tokens.Paragraph).tokens)));
        break;
      case "text": {
        const tt = t as Tokens.Text;
        out.push(paragraph(inline(tt.tokens?.length ? tt.tokens : [tt])));
        break;
      }
      case "list": {
        const l = t as Tokens.List;
        out.push({
          type: l.ordered ? "orderedList" : "bulletList",
          ...(l.ordered && typeof l.start === "number" && l.start !== 1
            ? { attrs: { order: l.start } }
            : {}),
          content: l.items.map(listItem),
        });
        break;
      }
      case "code": {
        const c = t as Tokens.Code;
        const lang = (c.lang ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "";
        if (GHERKIN.has(lang)) out.push(...gherkin(c.text));
        else
          out.push({
            type: "codeBlock",
            ...(lang ? { attrs: { language: lang } } : {}),
            content: c.text ? [{ type: "text", text: c.text }] : [],
          });
        break;
      }
      case "blockquote":
        out.push({
          type: "blockquote",
          content: block((t as Tokens.Blockquote).tokens),
        });
        break;
      case "hr":
        out.push({ type: "rule" });
        break;
      case "table": {
        // Tables become one paragraph per row; layout matters less than keeping every cell.
        const tb = t as Tokens.Table;
        const row = (cells: Tokens.TableCell[]) => {
          const content: AdfNode[] = [];
          cells.forEach((cell, i) => {
            if (i) content.push({ type: "text", text: " | " });
            content.push(...inline(cell.tokens));
          });
          return paragraph(content);
        };
        out.push(row(tb.header));
        for (const r of tb.rows) out.push(row(r));
        break;
      }
      case "html": {
        const raw = (t as Tokens.HTML).text;
        if (!/^\s*<!--[\s\S]*?-->\s*$/.test(raw))
          out.push(paragraph([{ type: "text", text: raw.trim() }]));
        break;
      }
      default:
        if ("text" in t && typeof t.text === "string" && t.text.trim())
          out.push(paragraph([{ type: "text", text: t.text }]));
    }
  }
  return out;
}

export function markdownToAdf(markdown: string): AdfDoc {
  const tokens = new Lexer({ gfm: true }).lex(markdown.replace(/\r\n/g, "\n"));
  const content = block(tokens);
  return {
    version: 1,
    type: "doc",
    content: content.length ? content : [paragraph([])],
  };
}

/** All text in an ADF document, for length checks and preservation checks. */
export function adfText(node: AdfNode | AdfDoc): string {
  if ("text" in node && typeof node.text === "string") return node.text;
  const parts = (node.content ?? []).map(adfText);
  const isBlock =
    node.type !== "paragraph" &&
    node.type !== "heading" &&
    node.type !== "text";
  return parts.join(isBlock ? "\n" : "");
}
