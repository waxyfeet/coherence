import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  sampleContent,
  sampleModel,
  sampleProject,
  sampleUseCase,
} from "./testUtils";

vi.mock("../storage/projectStore", () => ({
  getProject: vi.fn(),
  loadModel: vi.fn(),
}));
vi.mock("../formats/registry", () => ({ getFormat: vi.fn() }));
vi.mock("../specs/specStore", () => ({
  resolveSpecPath: vi.fn(() => "/nonexistent/ScreenScribe-test/missing.md"),
}));

const { getProject, loadModel } = await import("../storage/projectStore");
const { getFormat } = await import("../formats/registry");
const { csvField, csvRow, exportCsv, useCaseCsvRow, CSV_COLUMNS } =
  await import("./csv");

/** Minimal RFC 4180 reader to check the output round-trips. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe("csv escaping", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a, b")).toBe('"a, b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line1\r\nline2")).toBe('"line1\nline2"');
    expect(csvField(undefined)).toBe("");
    expect(csvField(5)).toBe("5");
  });

  it("neutralises spreadsheet formulas", () => {
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-5")).toBe("'-5");
    expect(csvField("@cmd")).toBe("'@cmd");
  });

  it("neutralises formulas hidden behind a leading line break (S09)", () => {
    for (const lead of ["\n", "\r", "\r\n"])
      expect(csvField(`${lead}=1+1`)).toBe(`"'\n=1+1"`);
  });

  it("joins a row", () => {
    expect(csvRow(["a", "b,c", ""])).toBe('a,"b,c",');
  });

  it("renders a use case row with multi-line cells", () => {
    const content = sampleContent({
      external: [
        {
          system: "jira",
          key: "ABC-12",
          url: "u",
          revision: 1,
          exportedAt: "x",
        },
      ],
    });
    const [row] = parseCsv(`${useCaseCsvRow(content)}\r\n`);
    expect(row).toHaveLength(CSV_COLUMNS.length);
    const cell = (name: (typeof CSV_COLUMNS)[number]) =>
      row[CSV_COLUMNS.indexOf(name)];
    expect(cell("ID")).toBe("UC-003");
    expect(cell("Story Points")).toBe("5");
    expect(cell("User Story")).toBe(
      "As a registered user, I want to sign in with my email address and password, so that I can access my account securely",
    );
    expect(cell("Postconditions")).toBe(
      "• The user is signed in\n• The Dashboard screen is displayed",
    );
    expect(cell("Business Rules")).toContain(
      "BR-01 · Email address — Email input [login.email]\nSingle-line email input",
    );
    expect(cell("Acceptance Criteria (BDD)")).toContain(
      "SC-01 · Successful sign-in (happy path)\nGIVEN the Login screen is displayed\nAND the user has an active account\nWHEN",
    );
    expect(cell("Jira")).toBe("ABC-12");
    expect(cell("GitHub")).toBe("");
  });
});

describe("exportCsv", () => {
  const ucs = [
    sampleUseCase({
      id: "UC-001",
      title: "Open the app",
      dependsOn: [],
      order: 1,
    }),
    sampleUseCase({ order: 2 }),
  ];
  const format = {
    useCasePath: (uc: { id: string }) => `use-cases/${uc.id}.md`,
    parseUseCase: vi.fn(),
    renderUseCase: (uc: { id: string; title: string }) =>
      `---\nid: ${uc.id}\n---\n\n# ${uc.id} · ${uc.title}\n`,
  };

  beforeEach(() => {
    vi.mocked(getProject).mockResolvedValue(sampleProject());
    vi.mocked(loadModel).mockResolvedValue(sampleModel(ucs));
    vi.mocked(getFormat).mockReturnValue(format as never);
  });

  it("writes a BOM, a header and one row per use case in build order (model fallback)", async () => {
    const { fileName, csv } = await exportCsv("acme");
    expect(fileName).toMatch(/^acme-use-cases-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(
      csv.startsWith(
        "﻿ID,Title,Feature,Persona,Screens,Size,Story Points,Status,Depends On,User Story,",
      ),
    ).toBe(true);
    const rows = parseCsv(csv.slice(1));
    expect(rows.map((r) => r[0])).toEqual(["ID", "UC-001", "UC-003"]);
    expect(rows[2][2]).toBe("Authentication");
    expect(rows[2][4]).toBe("Login");
  });

  it("filters by id and rejects unknown ids", async () => {
    const { csv } = await exportCsv("acme", ["UC-003"]);
    expect(parseCsv(csv.slice(1)).map((r) => r[0])).toEqual(["ID", "UC-003"]);
    await expect(exportCsv("acme", ["UC-999"])).rejects.toThrow(
      "Unknown use case id(s): UC-999.",
    );
  });

  it("explains when nothing has been generated", async () => {
    vi.mocked(loadModel).mockResolvedValue(null);
    await expect(exportCsv("acme")).rejects.toThrow(/generate the specs/);
  });
});
