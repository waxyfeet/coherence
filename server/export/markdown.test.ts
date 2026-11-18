import { describe, expect, it } from "vitest";
import {
  escapeWikiText,
  gherkinToJiraWiki,
  markdownToHtml,
  markdownToJiraWiki,
  removeLeadingH1,
  rewriteRelativeReferences,
  stripFrontMatter,
} from "./markdown";

const RICH = [
  "# Title",
  "",
  "## Section",
  "",
  "Plain **bold** and _italic_ with `login.email` and ~~gone~~.",
  "A [link](https://example.com/a?b=1) and a [relative link](UC-001-open.md).",
  "",
  "- one",
  "  - nested",
  "- two",
  "",
  "1. first",
  "2. second",
  "",
  "| Field | Rule |",
  "|---|---|",
  "| Email | Mandatory |",
  "",
  "> Quoted **text**",
  "",
  "```js",
  "const a = { b: 1 };",
  "```",
  "",
  "```gherkin",
  "GIVEN the Login screen is displayed",
  'when the user selects "Sign in"',
  "And the form is valid",
  "THEN the user is signed in",
  "```",
  "",
  "---",
  "",
  "![Login](../screens/images/login.png)",
].join("\n");

describe("markdownToJiraWiki", () => {
  const wiki = markdownToJiraWiki(RICH);

  it("converts headings", () => {
    expect(wiki).toContain("h1. Title");
    expect(wiki).toContain("h2. Section");
  });

  it("converts inline formatting, code and links", () => {
    expect(wiki).toContain(
      "Plain *bold* and _italic_ with {{login.email}} and -gone-.",
    );
    expect(wiki).toContain("[link|https://example.com/a?b=1]");
    // Relative links point into the local spec folder: text only.
    expect(wiki).toContain("and a relative link.");
    expect(wiki).not.toContain("UC-001-open.md");
  });

  it("converts nested and ordered lists", () => {
    expect(wiki).toContain("* one\n** nested\n* two");
    expect(wiki).toContain("# first\n# second");
  });

  it("keeps a task-list checkbox on the same line as its text", () => {
    expect(
      markdownToJiraWiki("- [ ] Confirm lockout duration\n- [x] Done item"),
    ).toBe("* ☐ Confirm lockout duration\n* ☑ Done item");
    expect(markdownToJiraWiki("- [ ] Loose one\n\n- [x] Loose two")).toBe(
      "* ☐ Loose one\n* ☑ Loose two",
    );
  });

  it("converts tables", () => {
    expect(wiki).toContain("||Field||Rule||\n|Email|Mandatory|");
  });

  it("converts quotes, code, rules and images", () => {
    expect(wiki).toContain("{quote}\nQuoted *text*\n{quote}");
    expect(wiki).toContain("{code:js}\nconst a = { b: 1 };\n{code}");
    expect(wiki).toContain("\n----\n");
    expect(wiki).toContain("_(screen image: Login — see spec repo)_");
  });

  it("renders gherkin as bold upper-case keyword lines", () => {
    expect(wiki).toContain(
      [
        "*GIVEN* the Login screen is displayed",
        '*WHEN* the user selects "Sign in"',
        "*AND* the form is valid",
        "*THEN* the user is signed in",
      ].join("\n"),
    );
  });

  it("escapes wiki special characters in text", () => {
    const out = markdownToJiraWiki("Use {name} or [x] or a|b and (x) icons");
    expect(out).toBe("Use \\{name\\} or \\[x\\] or a\\|b and \\(x) icons");
  });

  it("keeps ordinary punctuation readable", () => {
    expect(escapeWikiText("C++ and sign_in_button and e-mail and 2 * 3")).toBe(
      "C++ and sign_in_button and e-mail and 2 * 3",
    );
    expect(escapeWikiText("a *b c and -5 degrees")).toBe(
      "a \\*b c and \\-5 degrees",
    );
  });

  it("uses the brace form for mid-word effects and keeps hard breaks", () => {
    expect(markdownToJiraWiki("**As a** user  \n**I want to** go")).toBe(
      "*As a* user\n*I want to* go",
    );
    expect(markdownToJiraWiki("pre**fix**post")).toBe("pre{*}fix{*}post");
  });

  it("escapes raw HTML as text and drops comments", () => {
    expect(markdownToJiraWiki("<!-- hidden -->\n\nText <b>x</b>")).toBe(
      "Text <b>x</b>",
    );
  });

  it("escapes paragraph line starts that look like wiki blocks", () => {
    expect(markdownToJiraWiki("h1. not a heading")).toBe("h1\\. not a heading");
  });
});

describe("gherkinToJiraWiki", () => {
  it("handles feature/scenario lines and comments", () => {
    expect(gherkinToJiraWiki("Scenario: Sign in\n# note\nGiven x")).toBe(
      "*Scenario:* Sign in\n_note_\n*GIVEN* x",
    );
  });
});

describe("markdownToHtml", () => {
  const html = markdownToHtml(RICH);

  it("renders standard markdown", () => {
    expect(html).toContain("<h2>Section</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>login.email</code>");
    expect(html).toContain("<table>");
    expect(html).toContain('<a href="https://example.com/a?b=1">link</a>');
  });

  it("turns relative links into text and relative images into a placeholder", () => {
    expect(html).toContain("and a relative link.");
    expect(html).not.toContain("UC-001-open.md");
    expect(html).toContain("<em>(screen image: Login — see spec repo)</em>");
    expect(html).not.toContain("<img");
  });

  it("renders gherkin with bold keywords", () => {
    expect(html).toContain(
      "<strong>GIVEN</strong> the Login screen is displayed<br>",
    );
    expect(html).toContain(
      "<strong>WHEN</strong> the user selects &quot;Sign in&quot;",
    );
    expect(html).toContain("<strong>THEN</strong> the user is signed in");
  });

  it("escapes raw HTML and unsafe links", () => {
    const out = markdownToHtml(
      'Hi <script>alert(1)</script> [x](javascript:alert(1))\n\n<div onclick="x">raw</div>',
    );
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain('href="javascript');
    expect(out).toContain("&lt;div onclick=&quot;x&quot;&gt;raw&lt;/div&gt;");
  });
});

describe("spec body helpers", () => {
  it("strips front matter and the leading H1", () => {
    const md = "---\nid: UC-001\n---\n\n# UC-001 · Title\n\nBody";
    expect(removeLeadingH1(stripFrontMatter(md))).toBe("Body");
  });

  it("rewrites relative references outside code fences only", () => {
    const md =
      "See [Login](../screens/login.md) and [docs](https://x.y)\n![Login](../screens/images/login.png)\n```\n[keep](a.md)\n```";
    expect(rewriteRelativeReferences(md)).toBe(
      "See Login and [docs](https://x.y)\n_(screen image: Login — see spec repo)_\n```\n[keep](a.md)\n```",
    );
  });
});
