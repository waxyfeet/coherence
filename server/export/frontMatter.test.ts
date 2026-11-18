import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { ExternalLink } from "@shared/types";
import { patchFrontMatterExternal } from "./frontMatter";

const jira: ExternalLink = {
  system: "jira",
  key: "ABC-12",
  url: "https://acme.atlassian.net/browse/ABC-12",
  revision: 2,
  exportedAt: "2026-10-14T11:00:00.000Z",
};
const gh: ExternalLink = {
  system: "github",
  key: "#42",
  url: "https://github.com/acme/portal/issues/42",
  revision: 2,
  exportedAt: "2026-10-14T11:00:00.000Z",
};

const FILE = [
  "---",
  "id: UC-003",
  "title: Sign in",
  "screenIds: [scr_ab12cd]",
  "status: edited            # generated | edited | stale | approved",
  "revision: 2",
  "---",
  "",
  "# UC-003 · Sign in",
  "",
  "BA edited body.",
  "",
].join("\n");

function frontMatterOf(md: string) {
  return parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(md)![1]) as Record<
    string,
    unknown
  >;
}

describe("patchFrontMatterExternal", () => {
  it("appends an external block and leaves everything else byte-for-byte", () => {
    const out = patchFrontMatterExternal(FILE, [jira])!;
    expect(out).toContain(
      "screenIds: [scr_ab12cd]\nstatus: edited            # generated | edited | stale | approved\nrevision: 2\nexternal:\n",
    );
    expect(out.endsWith("---\n\n# UC-003 · Sign in\n\nBA edited body.\n")).toBe(
      true,
    );
    expect(frontMatterOf(out).external).toEqual([jira]);
  });

  it("replaces an existing block and keeps following keys", () => {
    const withBlock = FILE.replace(
      "revision: 2\n",
      "revision: 2\nexternal:                     # only after export\n  - system: jira\n    key: ABC-1\n    url: old\n    revision: 1\n    exportedAt: x\nupdated: 2026-10-14T10:00:00.000Z\n",
    );
    const out = patchFrontMatterExternal(withBlock, [jira, gh])!;
    const fm = frontMatterOf(out);
    expect(fm.external).toEqual([jira, gh]);
    expect(fm.updated).toBe("2026-10-14T10:00:00.000Z");
    expect(out).toContain('key: "#42"');
    expect(out).not.toContain("ABC-1\n");
  });

  it("keeps CRLF line endings", () => {
    const crlf = FILE.replace(/\n/g, "\r\n");
    const out = patchFrontMatterExternal(crlf, [jira])!;
    expect(out.includes("\n") && !/[^\r]\n/.test(out)).toBe(true);
    expect(frontMatterOf(out).external).toEqual([jira]);
  });

  it("returns undefined without front matter or with broken YAML", () => {
    expect(
      patchFrontMatterExternal("# no front matter", [jira]),
    ).toBeUndefined();
    expect(
      patchFrontMatterExternal("---\nid: [unclosed\n---\nx", [jira]),
    ).toBeUndefined();
  });
});
