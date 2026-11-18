import { describe, expect, it } from "vitest";
import type { Project, SolutionModel, UseCase } from "@shared/types";
import { fixtureModel, fixtureProject } from "../../graph/testFixtures";
import { getFormat, hasFormat, listFormats } from "../registry";
import type { RenderContext } from "../types";
import { useCaseBddFormat } from "./index";
import { splitBinding } from "./reports";

const format = useCaseBddFormat;

function ctxFor(
  model: SolutionModel,
  project: Project = fixtureProject(),
  embedScreenImages = true,
): RenderContext {
  return { project, model, embedScreenImages };
}

/** render → parse → merge onto the model use case → render again. */
function roundTrip(
  uc: UseCase,
  ctx: RenderContext,
): {
  first: string;
  second: string;
  merged: UseCase;
  warnings: string[];
  errors: string[];
} {
  const first = format.renderUseCase(uc, ctx);
  const parsed = format.parseUseCase(first);
  const merged: UseCase = { ...uc, ...parsed.useCase };
  const second = format.renderUseCase(merged, ctx);
  return {
    first,
    second,
    merged,
    warnings: parsed.warnings,
    errors: parsed.errors,
  };
}

/** A use case full of characters that are significant in markdown, YAML, tables or Gherkin. */
function trickyUseCase(): UseCase {
  const base = fixtureModel().useCases[0];
  return {
    ...base,
    id: "UC-001",
    title: 'Sign in: "fast" | secure · with `code` & ünïcödé — 日本語 ✓',
    scope:
      '- starts like a bullet | has a pipe, "quotes" and `backticks`; spans\nseveral\nlines.',
    story: {
      asA: "registered user, admin",
      iWant: "sign in with my e-mail: fast",
      soThat: "I can work — securely (100%)",
    },
    preconditions: [
      "The user has opened the application",
      'A `feature flag` is "on" | enabled',
      "1. numbered-looking item",
    ],
    postconditions: ["The user is signed in", "Ünïcödé state: ✓"],
    businessRules: [
      {
        id: "BR-01",
        elementId: "login.email",
        element: 'Email | address "primary"',
        elementType: "email_input",
        description:
          "`login.email` looks like an id line but is the description.\n\n# Not a heading either",
        rules: [
          "Mandatory: yes",
          "Max 254 characters | no spaces",
          'Shows "Enter a valid email address" — inline',
          "- dash-led rule",
        ],
      },
      {
        id: "BR-02",
        elementId: "login.`odd`.id",
        element: "Name — first",
        elementType: "text_input",
        description: "",
        rules: [],
      },
      {
        id: "BR-03",
        element: "Screen-level rules",
        elementType: "general",
        description: "> quoted start\nwith a continuation line",
        rules: [
          "After 5 failed attempts the account is locked for 15 minutes.",
        ],
      },
      {
        id: "BR-04",
        element: "Whole page",
        elementType: "screen",
        description: "Applies to the screen.",
        rules: ["Session times out after 30 minutes."],
      },
    ],
    scenarios: [
      {
        id: "SC-01",
        title: 'Sign in (SSO): the "happy" path',
        type: "happy",
        given: [
          "the user has opened the application",
          "the user has an active account",
        ],
        when: [
          'the user enters "jane@acme.com" in "Email address"',
          'the user selects "Sign in" | twice',
        ],
        then: [
          "the user is signed in",
          "the Dashboard screen is displayed",
          "THEN-like text: ```fence``` stays inline",
        ],
        elementIds: ["login.email", "login.sign_in"],
      },
      {
        id: "SC-02",
        title: "",
        type: "edge",
        given: ["x"],
        when: ["y"],
        then: ["z"],
        elementIds: [],
      },
      {
        id: "SC-03",
        title: "Negative (with parentheses)",
        type: "negative",
        given: ["a"],
        when: ["b"],
        then: ["c"],
        elementIds: [],
      },
    ],
    assumptions: [],
    openQuestions: ["Is single sign-on required?", "Colon: inside | pipe"],
    notes:
      "Free text by the BA.\n\n- a list\n- with items\n\n```js\n## not a heading inside a fence\n```\n\n## Extra section\n\nKept verbatim.",
    status: "stale",
    staleReason: "IR-20261014-ab12cd",
    revision: 3,
    external: [
      {
        system: "jira",
        key: "ABC-12",
        url: "https://acme.atlassian.net/browse/ABC-12",
        revision: 2,
        exportedAt: "2026-10-14T11:00:00.000Z",
      },
    ],
  };
}

describe("format registry", () => {
  it("lists the default format and rejects unknown ids", () => {
    expect(listFormats().map((f) => f.id)).toEqual(["use-case-bdd"]);
    expect(listFormats()[0].isDefault).toBe(true);
    expect(getFormat("").info.id).toBe("use-case-bdd");
    expect(hasFormat("use-case-bdd")).toBe(true);
    expect(() => getFormat("nope")).toThrow(/Unknown output format "nope"/);
  });

  it("builds use case paths from id and slug", () => {
    const uc = fixtureModel().useCases[0];
    expect(format.useCasePath(uc)).toBe(`use-cases/UC-001-${uc.slug}.md`);
    expect(format.useCasePath({ ...uc, slug: "Bad Slug!" })).toBe(
      "use-cases/UC-001-bad-slug.md",
    );
  });
});

describe("renderUseCase", () => {
  it("renders the exact §5 layout", () => {
    const model = fixtureModel();
    const md = format.renderUseCase(model.useCases[2], ctxFor(model));
    expect(md.startsWith("---\nid: UC-003\n")).toBe(true);
    expect(md).toContain("format: use-case-bdd");
    expect(md).toContain("screenIds: [scr_dash, scr_orders]");
    expect(md).toContain("dependsOn: [UC-001]");
    expect(md).toContain("leadsTo: [UC-005]");
    expect(md).toMatch(/status: generated #/);
    expect(md).toContain("# UC-003 · Application shell & navigation");
    expect(md).toContain(
      "| Feature | Persona | Screens | Size | Depends on | Leads to |",
    );
    expect(md).toContain(
      "[Dashboard](../screens/dashboard.md), [Orders](../screens/orders.md)",
    );
    expect(md).toContain("![Dashboard](../screens/images/dashboard.png)");
    expect(md).toContain(
      "**As a** registered customer  \n**I want to** application shell & navigation  \n**So that** I get my work done",
    );
    expect(md).toContain(
      "### BR-01 · Main navigation — Navigation bar\n`dashboard.nav_bar`",
    );
    expect(md).toContain(
      "### SC-01 · Navigate between screens (happy path)\n\n```gherkin\nGIVEN The user is signed in\nWHEN",
    );
    expect(md).toContain("## Assumptions\n\n- None");
    expect(md).not.toContain("## Notes");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("repeats THEN on every then line and uses AND for further given/when lines", () => {
    const uc = trickyUseCase();
    const md = format.renderUseCase(uc, ctxFor(fixtureModel()));
    const block = md.split("```gherkin\n")[1].split("```\n")[0];
    expect(
      block
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split(" ")[0]),
    ).toEqual(["GIVEN", "AND", "WHEN", "AND", "THEN", "THEN", "THEN"]);
  });

  it("omits images when embedScreenImages is off and writes staleReason only for stale use cases", () => {
    const model = fixtureModel();
    const md = format.renderUseCase(
      model.useCases[0],
      ctxFor(model, fixtureProject(), false),
    );
    expect(md).not.toContain("![");
    expect(md).not.toContain("staleReason");
    const stale = format.renderUseCase(
      { ...model.useCases[0], status: "stale", staleReason: "IR-1" },
      ctxFor(model),
    );
    expect(stale).toContain("staleReason: IR-1");
  });
});

describe("refreshGeneratedParts", () => {
  it("updates front matter and summary links of a kept file, leaving every content line as the BA wrote it", () => {
    const model = fixtureModel();
    const ctx = ctxFor(model);
    const original = format.renderUseCase(model.useCases[2], ctx);
    const edited = original
      .replace(
        "## Assumptions\n\n- None",
        "## Assumptions\n\n- The BA wrote this by hand.",
      )
      .replace(/\n/g, "\r\n");
    // A later generation renumbered the dependent use case and the kept one is now 'edited'.
    const renumbered = model.useCases.map((u) =>
      u.id === "UC-005" ? { ...u, id: "UC-009", filePath: undefined } : u,
    );
    const next: SolutionModel = { ...model, useCases: renumbered };
    const kept = {
      ...next.useCases[2],
      status: "edited" as const,
      revision: 2,
    };
    const refreshed = format.refreshGeneratedParts!(edited, kept, ctxFor(next));

    expect(refreshed).toContain("leadsTo: [UC-009]");
    expect(refreshed).toContain("status: edited");
    expect(refreshed).toContain("revision: 2");
    expect(refreshed).toMatch(/\[UC-009\]\(UC-009-[a-z0-9-]+\.md\)/);
    expect(refreshed).not.toContain("UC-005");
    expect(refreshed).toContain("- The BA wrote this by hand.");
    expect(refreshed.includes("\r\n")).toBe(true);
    expect(
      refreshed
        .replace(/\r\n/g, "\n")
        .split("\n")
        .filter((l) => /\r/.test(l)),
    ).toEqual([]);
    // Everything from the scope line on is untouched.
    const tail = (s: string) => s.slice(s.indexOf("**Scope:**"));
    expect(tail(refreshed)).toBe(tail(edited));
  });

  it("keeps front-matter keys the BA added (with their comments) and drops owned keys the model no longer has", () => {
    const model = fixtureModel();
    const ctx = ctxFor(model);
    const stale = {
      ...model.useCases[2],
      status: "stale" as const,
      staleReason: "IR-1",
    };
    const original = format
      .renderUseCase(stale, ctx)
      .replace(
        "\nsize:",
        "\npriority: Must have # MoSCoW\nowner: Jane Cooper\nlabels: [mvp, security]\nsize:",
      );
    const refreshed = format.refreshGeneratedParts!(
      original,
      { ...model.useCases[2], status: "approved", revision: 4 },
      ctx,
    );
    const yaml = refreshed.split("\n---\n")[0];
    expect(yaml).toContain("status: approved");
    expect(yaml).toContain("revision: 4");
    expect(yaml).not.toContain("staleReason");
    expect(yaml).toContain(
      "\npriority: Must have # MoSCoW\nowner: Jane Cooper\nlabels: [mvp, security]",
    );
    expect(format.parseUseCase(refreshed).errors).toEqual([]);
    // Stable: refreshing again changes nothing.
    expect(
      format.refreshGeneratedParts!(
        refreshed,
        { ...model.useCases[2], status: "approved", revision: 4 },
        ctx,
      ),
    ).toBe(refreshed);
  });

  it("leaves a summary table the BA changed alone and only refreshes the front matter", () => {
    const model = fixtureModel();
    const ctx = ctxFor(model);
    const original = format.renderUseCase(model.useCases[2], ctx);
    const custom = original.replace(
      "| Feature | Persona |",
      "| Area | Persona |",
    );
    const refreshed = format.refreshGeneratedParts!(
      custom,
      { ...model.useCases[2], status: "approved" },
      ctx,
    );
    expect(refreshed).toContain("status: approved");
    expect(refreshed).toContain("| Area | Persona |");
    expect(refreshed.slice(refreshed.indexOf("# UC-003"))).toBe(
      custom.slice(custom.indexOf("# UC-003")),
    );
  });
});

describe("renderUseCase / parseUseCase round trip", () => {
  it("is stable for every fixture use case and recovers the content exactly", () => {
    const model = fixtureModel();
    const ctx = ctxFor(model);
    for (const uc of model.useCases) {
      const { first, second, merged, errors, warnings } = roundTrip(uc, ctx);
      expect(errors).toEqual([]);
      expect(warnings).toEqual([]);
      expect(second).toBe(first);
      for (const key of [
        "title",
        "scope",
        "story",
        "preconditions",
        "postconditions",
        "assumptions",
        "openQuestions",
        "dependsOn",
        "elementIds",
        "screenIds",
        "size",
        "status",
        "revision",
        "featureId",
        "personaId",
      ] as const) {
        expect(merged[key], `${uc.id}.${key}`).toEqual(uc[key]);
      }
      expect(merged.businessRules).toEqual(uc.businessRules);
      expect(
        merged.scenarios.map(({ elementIds: _e, ...rest }) => rest),
      ).toEqual(uc.scenarios.map(({ elementIds: _e, ...rest }) => rest));
    }
  });

  it("is idempotent for pipes, backticks, quotes, unicode, colons and empty sections", () => {
    const model = fixtureModel();
    const uc = trickyUseCase();
    model.useCases[0] = uc;
    const ctx = ctxFor(model);
    const { first, second, merged, errors } = roundTrip(uc, ctx);
    expect(errors).toEqual([]);
    expect(second).toBe(first);
    // A third pass must not drift either.
    const third = format.renderUseCase(
      { ...merged, ...format.parseUseCase(second).useCase },
      ctx,
    );
    expect(third).toBe(first);

    expect(merged.title).toBe(uc.title);
    expect(merged.scope).toBe(
      '- starts like a bullet | has a pipe, "quotes" and `backticks`; spans several lines.',
    );
    expect(merged.story).toEqual(uc.story);
    expect(merged.preconditions).toEqual(uc.preconditions);
    expect(merged.postconditions).toEqual(uc.postconditions);
    expect(merged.assumptions).toEqual([]);
    expect(merged.openQuestions).toEqual(uc.openQuestions);
    expect(merged.status).toBe("stale");
    expect(merged.staleReason).toBe("IR-20261014-ab12cd");
    expect(merged.external).toEqual(uc.external);

    const [br1, br2, br3, br4] = merged.businessRules;
    expect(br1).toEqual({ ...uc.businessRules[0] });
    expect(br2).toEqual({
      id: "BR-02",
      elementId: "login.`odd`.id",
      element: "Name — first",
      elementType: "text_input",
      description: "",
      rules: [],
    });
    // A quote with a lazy continuation line is reflowed into a one-line quote (a lazy line could be anything).
    expect(br3).toEqual({
      ...uc.businessRules[2],
      description: "> quoted start with a continuation line",
    });
    expect(br4.elementType).toBe("screen");
    expect(br4.elementId).toBeUndefined();

    expect(merged.scenarios.map((s) => [s.id, s.title, s.type])).toEqual([
      ["SC-01", 'Sign in (SSO): the "happy" path', "happy"],
      ["SC-02", "", "edge"],
      ["SC-03", "Negative (with parentheses)", "negative"],
    ]);
    expect(merged.scenarios[0].then).toEqual(uc.scenarios[0].then);
    expect(merged.notes).toBe(uc.notes);
  });

  it("is stable for a use case with every list empty", () => {
    const model = fixtureModel();
    const empty: UseCase = {
      ...model.useCases[1],
      title: "",
      scope: "",
      preconditions: [],
      postconditions: [],
      businessRules: [],
      scenarios: [],
      assumptions: [],
      openQuestions: [],
      notes: "",
      dependsOn: [],
      elementIds: [],
      screenIds: [],
    };
    model.useCases[1] = empty;
    const { first, second, merged, errors } = roundTrip(empty, ctxFor(model));
    expect(errors).toEqual([]);
    expect(second).toBe(first);
    expect(first).toContain("# UC-002\n");
    expect(first).toContain("## Business rules\n\n- None");
    expect(first).toContain("## BDD scenarios\n\n- None");
    expect(merged.businessRules).toEqual([]);
    expect(merged.scenarios).toEqual([]);
    expect(merged.notes).toBe("");
  });
});

describe("parseUseCase tolerance of BA hand edits", () => {
  const FRONT =
    "---\nid: UC-007\ntitle: Old title\nformat: use-case-bdd\nfeatureId: FEAT-01\npersonaId: persona-customer\nscreenIds: [scr_login]\nelements: [login.email]\ndependsOn: [uc-1]\nsize: m\nstatus: approved\nrevision: 2\n---\n";

  it("reads keyword variants, plain story labels, CRLF and a BOM", () => {
    const body = [
      "# UC-007 · Reset password",
      "",
      "Scope: the reset-password link.",
      "",
      "## User Story",
      "",
      "As a registered user",
      "I want to reset my password",
      "so that I can sign in again",
      "",
      "## preconditions",
      "",
      "* The Login screen is displayed",
      "",
      "## Post-conditions",
      "",
      "1. A reset link is sent",
      "",
      "## Business Rules",
      "",
      "### BR-1 · Forgot password? - Link",
      "Element: `login.forgot`",
      "",
      "Text link below the password field.",
      "",
      "- Opens the reset page",
      "  in a new tab",
      "",
      "## BDD Scenarios",
      "",
      "### SC-1: Request a link (Happy)",
      "",
      "```gherkin",
      "Scenario: Request a link",
      "Given the Login screen is displayed",
      'when the user selects "Forgot password?"',
      "then a reset link is sent",
      'and the confirmation "Check your inbox" is shown',
      "But no account details are revealed",
      "```",
      "",
      "## Assumptions",
      "",
      "- none",
      "",
      "## Open Questions",
      "",
      "- N/A",
      "",
      "## Risks",
      "",
      "Unknown section kept.",
    ].join("\r\n");
    const parsed = format.parseUseCase(
      `﻿${FRONT.replace(/\n/g, "\r\n")}${body}`,
    );
    expect(parsed.errors).toEqual([]);
    const uc = parsed.useCase;
    expect(uc.id).toBe("UC-007");
    expect(uc.title).toBe("Reset password");
    expect(uc.dependsOn).toEqual(["UC-001"]);
    expect(uc.size).toBe("M");
    expect(uc.status).toBe("approved");
    expect(uc.scope).toBe("the reset-password link.");
    expect(uc.story).toEqual({
      asA: "registered user",
      iWant: "reset my password",
      soThat: "I can sign in again",
    });
    expect(uc.preconditions).toEqual(["The Login screen is displayed"]);
    expect(uc.postconditions).toEqual(["A reset link is sent"]);
    expect(uc.businessRules).toEqual([
      {
        id: "BR-01",
        elementId: "login.forgot",
        element: "Forgot password?",
        elementType: "link",
        description: "Text link below the password field.",
        rules: ["Opens the reset page in a new tab"],
      },
    ]);
    expect(uc.scenarios).toEqual([
      {
        id: "SC-01",
        title: "Request a link",
        type: "happy",
        elementIds: [],
        given: ["the Login screen is displayed"],
        when: ['the user selects "Forgot password?"'],
        then: [
          "a reset link is sent",
          'the confirmation "Check your inbox" is shown',
          "no account details are revealed",
        ],
      },
    ]);
    expect(uc.assumptions).toEqual([]);
    expect(uc.openQuestions).toEqual([]);
    expect(uc.notes).toBe("## Risks\n\nUnknown section kept.");
  });

  it("accepts bold story labels without trailing spaces and a one-line story", () => {
    const md = (story: string) =>
      `${FRONT}# UC-007 · T\n\n## User story\n\n${story}\n`;
    expect(
      format.parseUseCase(
        md("**As a** buyer\n**I want to** pay\n**So that** I get my order"),
      ).useCase.story,
    ).toEqual({ asA: "buyer", iWant: "pay", soThat: "I get my order" });
    expect(
      format.parseUseCase(
        md(
          "As an admin, I want to export orders, so that finance can reconcile them.",
        ),
      ).useCase.story,
    ).toEqual({
      asA: "admin",
      iWant: "export orders",
      soThat: "finance can reconcile them.",
    });
  });

  it("numbers rules and scenarios without ids, de-duplicates ids and types untyped scenarios", () => {
    const md = `${FRONT}# UC-007 · T\n\n## Business rules\n\n### Email — Email input\n\n- Mandatory\n\n### BR-01 · Again — Button\n\n- x\n\n### BR-01 · Dup — Button\n\n- y\n\n## BDD scenarios\n\n### First\n\nGIVEN a\nWHEN b\nTHEN c\n\n### SC-02 · Second\n\n\`\`\`\nGIVEN a\nWHEN b\nTHEN c\n\`\`\`\n`;
    const parsed = format.parseUseCase(md);
    expect(parsed.errors).toEqual([]);
    expect(parsed.useCase.businessRules!.map((r) => r.id)).toEqual([
      "BR-01",
      "BR-02",
      "BR-03",
    ]);
    expect(parsed.useCase.businessRules![0].elementType).toBe("email_input");
    expect(parsed.useCase.scenarios!.map((s) => [s.id, s.type])).toEqual([
      ["SC-01", "happy"],
      ["SC-02", "alternate"],
    ]);
    expect(parsed.warnings.some((w) => w.includes("had no BR id"))).toBe(true);
    expect(parsed.warnings.some((w) => w.includes("used twice"))).toBe(true);
    expect(parsed.warnings.some((w) => w.includes("has no type"))).toBe(true);
  });

  it("takes the id from the title when the front matter is missing, and fails on broken YAML", () => {
    const noFront = format.parseUseCase(
      "# UC-012 · Pay\n\n## User story\n\nAs a buyer\nI want to pay\nSo that I get it\n",
    );
    expect(noFront.errors).toEqual([]);
    expect(noFront.useCase.id).toBe("UC-012");
    expect(noFront.useCase.title).toBe("Pay");
    expect(noFront.warnings[0]).toMatch(/no front matter/);

    const broken = format.parseUseCase(
      "---\nid: UC-001\nscreenIds: [a, b\n---\n# UC-001 · X\n",
    );
    expect(broken.errors[0]).toMatch(/not valid YAML/);

    const unterminated = format.parseUseCase("---\nid: UC-001\n# UC-001 · X\n");
    expect(unterminated.errors[0]).toMatch(/not closed/);

    const noId = format.parseUseCase("---\ntitle: x\n---\n# Just a title\n");
    expect(noId.errors[0]).toMatch(/id is missing/);
  });

  it("keeps unknown sections and stray text instead of dropping them", () => {
    const md = `${FRONT}# UC-007 · T\n\n**Scope:** s\n\nA stray paragraph.\n\n## Business rules\n\nIntro text before rules.\n\n### BR-01 · A — Button\n\n- r\n\n## Notes\n\nMy notes.\n\n## Glossary\n\n- Term: meaning\n`;
    const parsed = format.parseUseCase(md);
    expect(parsed.useCase.scope).toBe("s");
    expect(parsed.useCase.notes).toBe(
      "My notes.\n\nA stray paragraph.\n\nIntro text before rules.\n\n## Glossary\n\n- Term: meaning",
    );
  });

  it('splits a gherkin block holding several "Scenario:" lines into separate scenarios', () => {
    const md =
      `${FRONT}# UC-007 · Sign in\n\n## BDD scenarios\n\n### SC-01 · Sign in (happy path)\n\n\`\`\`gherkin\n` +
      "Scenario: Successful sign-in\nGiven the Login screen is displayed\nWhen the user enters valid credentials\nThen the user is signed in\n\n" +
      "@SC-04 @negative\nScenario: Wrong password\nGiven the Login screen is displayed\nWhen the user enters a wrong password\nThen the error banner is shown\n\n" +
      "Scenario: Locked account\nGiven the account is locked\nWhen the user signs in\nThen the lockout message is shown\n```\n";
    const parsed = format.parseUseCase(md);
    expect(parsed.errors).toEqual([]);
    expect(parsed.useCase.scenarios).toEqual([
      {
        id: "SC-01",
        title: "Sign in",
        type: "happy",
        elementIds: [],
        given: ["the Login screen is displayed"],
        when: ["the user enters valid credentials"],
        then: ["the user is signed in"],
      },
      {
        id: "SC-04",
        title: "Wrong password",
        type: "negative",
        elementIds: [],
        given: ["the Login screen is displayed"],
        when: ["the user enters a wrong password"],
        then: ["the error banner is shown"],
      },
      {
        id: "SC-05",
        title: "Locked account",
        type: "alternate",
        elementIds: [],
        given: ["the account is locked"],
        when: ["the user signs in"],
        then: ["the lockout message is shown"],
      },
    ]);
    expect(
      parsed.warnings.some((w) =>
        w.includes("SC-01: its gherkin block held 3 scenarios"),
      ),
    ).toBe(true);
    expect(parsed.warnings.some((w) => w.startsWith("SC-05 has no type"))).toBe(
      true,
    );
  });

  it('reads gherkin pasted under "BDD scenarios" without headings, background steps included', () => {
    const md =
      `${FRONT}# UC-007 · Sign in\n\n## BDD scenarios\n\n\`\`\`gherkin\nFeature: Sign in\n\n  Background:\n    Given the Login screen is displayed\n\n` +
      "  @happy\n  Scenario: Successful sign-in\n    When the user enters valid credentials\n    Then the user is signed in\n\n" +
      "  @negative\n  Scenario: Wrong password\n    When the user enters a wrong password\n    Then the error banner is shown\n```\n";
    const parsed = format.parseUseCase(md);
    expect(
      parsed.useCase.scenarios!.map((s) => [
        s.id,
        s.title,
        s.type,
        s.given,
        s.when,
        s.then,
      ]),
    ).toEqual([
      [
        "SC-01",
        "Successful sign-in",
        "happy",
        ["the Login screen is displayed"],
        ["the user enters valid credentials"],
        ["the user is signed in"],
      ],
      [
        "SC-02",
        "Wrong password",
        "negative",
        ["the Login screen is displayed"],
        ["the user enters a wrong password"],
        ["the error banner is shown"],
      ],
    ]);
    expect(parsed.useCase.notes).toBe("");
    expect(
      parsed.warnings.some((w) => w.includes("was read as 2 scenarios")),
    ).toBe(true);
  });

  it("keeps tables, quotes and code blocks in a rule description through re-renders", () => {
    const model = fixtureModel();
    const ctx = ctxFor(model);
    const original = format.renderUseCase(model.useCases[0], ctx);
    const rule = "### BR-02 · Password";
    const at = original.indexOf(rule);
    const bulletsEnd = original.indexOf("\n\n###", at + rule.length);
    const blocksAdded = [
      "**Validation**",
      '| Case | Message |\n|---|---|\n| Empty | "Password is required" |',
      "> Design note: confirm with UX",
      "```regex\n^.{8,}$\n\n# not a heading\n```",
      "1.5 seconds after the last key press the strength meter updates.",
    ].join("\n\n");
    const edited = `${original.slice(0, bulletsEnd)}\n\n${blocksAdded}${original.slice(bulletsEnd)}`;

    const parsed = format.parseUseCase(edited);
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([
      "BR-02: text below the rule's bullets was moved above them (a rule has one description, then its bullets).",
    ]);
    const merged: UseCase = { ...model.useCases[0], ...parsed.useCase };
    const br2 = merged.businessRules.find((r) => r.id === "BR-02")!;
    expect(br2.description).toBe(
      `${model.useCases[0].businessRules[1].description}\n\n${blocksAdded}`,
    );
    expect(br2.rules).toEqual(model.useCases[0].businessRules[1].rules);

    const rendered = format.renderUseCase(merged, ctx);
    expect(rendered).toContain(blocksAdded);
    expect(rendered).not.toMatch(/\\\*\*Validation|\\\||\\>|\\```|\\1\.5/);
    const again = format.parseUseCase(rendered);
    expect(again.warnings).toEqual([]);
    expect(format.renderUseCase({ ...merged, ...again.useCase }, ctx)).toBe(
      rendered,
    );
  });

  it("escapes only paragraph starts markdown would misread, and reads older escapes", () => {
    const model = fixtureModel();
    const uc: UseCase = {
      ...model.useCases[0],
      businessRules: [
        {
          id: "BR-01",
          element: "Notes",
          elementType: "general",
          rules: ["x"],
          description: [
            "1. Looks like a numbered item",
            "- Looks like a bullet",
            "**Bold label**",
            "*italic start*",
            "+1 vote",
            "\\- keeps its backslash",
          ].join("\n\n"),
        },
      ],
    };
    const md = format.renderUseCase(uc, ctxFor(model));
    expect(md).toContain(
      "1\\. Looks like a numbered item\n\n\\- Looks like a bullet\n\n**Bold label**\n\n*italic start*\n\n+1 vote\n\n\\\\- keeps its backslash",
    );
    expect(format.parseUseCase(md).useCase.businessRules![0].description).toBe(
      uc.businessRules[0].description,
    );
    // Files written before "1\." used "\1." — still read as the plain text.
    expect(
      format
        .parseUseCase(md.replace("1\\. Looks", "\\1. Looks"))
        .useCase.businessRules![0].description.split("\n\n")[0],
    ).toBe("1. Looks like a numbered item");
  });

  it("moves a table under a list section to Notes instead of flattening it into one item", () => {
    const md = `${FRONT}# UC-007 · T\n\n## Assumptions\n\n- Wording inferred\n\n| Locale | Format |\n|---|---|\n| en-AU | DD/MM/YYYY |\n\n## Notes\n\nMy notes.\n`;
    const parsed = format.parseUseCase(md);
    expect(parsed.useCase.assumptions).toEqual(["Wording inferred"]);
    expect(parsed.useCase.notes).toBe(
      "My notes.\n\n| Locale | Format |\n|---|---|\n| en-AU | DD/MM/YYYY |",
    );
    expect(parsed.warnings).toContain(
      'A table, quote or code block under "Assumptions" was moved to Notes — that section is a list.',
    );
  });

  it("reads external links and ignores malformed ones with a warning", () => {
    const md =
      "---\nid: UC-002\nexternal:\n  - system: Azure DevOps\n    key: 4711\n    url: https://dev.azure.com/x/_workitems/edit/4711\n    revision: 3\n    exportedAt: 2026-10-14T11:00:00.000Z\n  - system: trello\n    key: X\n---\n# UC-002 · T\n";
    const parsed = format.parseUseCase(md);
    expect(parsed.useCase.external).toEqual([
      {
        system: "azdo",
        key: "4711",
        url: "https://dev.azure.com/x/_workitems/edit/4711",
        revision: 3,
        exportedAt: "2026-10-14T11:00:00.000Z",
      },
    ]);
    expect(
      parsed.warnings.some((w) =>
        w.includes('"external" entry needs a system'),
      ),
    ).toBe(true);
  });
});

describe("renderSupportFiles", () => {
  const model = fixtureModel();
  const files = format.renderSupportFiles(ctxFor(model));
  const byPath = new Map(files.map((f) => [f.path, f.content]));

  it("writes the index, reports, screen docs and one feature file per use case", () => {
    for (const p of [
      "README.md",
      "BUILD-PLAN.md",
      "QUESTIONS.md",
      "TRACEABILITY.md",
      "DATA-DICTIONARY.md",
      "REVIEW.md",
      "CHANGELOG.md",
      "screens/login.md",
      "screens/dashboard.md",
      "screens/orders.md",
    ]) {
      expect(byPath.has(p), p).toBe(true);
    }
    const features = files.filter((f) => f.path.startsWith("features/"));
    expect(features.map((f) => f.path)).toEqual(
      model.useCases.map(
        (uc) =>
          `features/${uc.filePath!.split("/").pop()!.replace(/\.md$/, "")}.feature`,
      ),
    );
    for (const f of files) {
      expect(f.path).not.toMatch(/^\/|\.\.|\\/);
      if (f.path.endsWith(".md"))
        expect(f.content).toContain("Generated by Coherence");
    }
  });

  it("produces mermaid diagrams with safe node ids", () => {
    const readme = byPath.get("README.md")!;
    const blocks = [...readme.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(
      (m) => m[1],
    );
    expect(blocks.length).toBe(2);
    expect(blocks[0].startsWith("flowchart LR")).toBe(true);
    expect(blocks[1].startsWith("flowchart TD")).toBe(true);
    const reserved = new Set([
      "end",
      "graph",
      "subgraph",
      "flowchart",
      "style",
      "class",
      "classDef",
      "click",
      "linkStyle",
    ]);
    for (const block of blocks) {
      for (const line of block
        .split("\n")
        .slice(1)
        .map((l) => l.trim())
        .filter(Boolean)) {
        if (line === "end" || line.startsWith("classDef ")) continue;
        if (line.startsWith("class ")) {
          const [, ids] = line.split(" ");
          for (const id of ids.split(","))
            expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
          continue;
        }
        const ids = [
          ...line
            .replace(/"[^"]*"/g, '""')
            .matchAll(
              /(?:^|\s|subgraph\s)([A-Za-z][A-Za-z0-9_]*)(?=\[|\s*-->|\s*$)/g,
            ),
        ].map((m) => m[1]);
        for (const id of ids) {
          if (id === "subgraph") continue;
          expect(reserved.has(id), `${id} in "${line}"`).toBe(false);
          expect(id).toMatch(/^(s|uc|f)_[A-Za-z0-9_]+$/);
        }
        // Labels are always quoted, so brackets/quotes in names cannot break the syntax.
        expect(line.replace(/"[^"]*"/g, "")).not.toMatch(/["`]/);
      }
    }
    expect(blocks[0]).toContain(
      `s_scr_login -->|"Click 'Sign in'"| s_scr_dash`,
    );
    expect(blocks[1]).toContain("uc_UC_001 --> uc_UC_003");
  });

  it("escapes mermaid-significant characters in screen and use case names", () => {
    const tricky = fixtureModel();
    tricky.useCases[0] = {
      ...tricky.useCases[0],
      title: 'end "quoted" <b>|#1|</b> `x`',
    };
    tricky.features[0] = {
      ...tricky.features[0],
      id: "end",
      name: "subgraph [x]",
    };
    tricky.useCases[0].featureId = "end";
    tricky.useCases[1].featureId = "end";
    const project = fixtureProject();
    project.screens[0] = {
      ...project.screens[0],
      name: 'Log "in" [main] --> #1',
    };
    const readme = format
      .renderSupportFiles(ctxFor(tricky, project))
      .find((f) => f.path === "README.md")!.content;
    for (const block of [...readme.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(
      (m) => m[1],
    )) {
      for (const line of block.split("\n")) {
        const outsideLabels = line
          .replace(/"[^"]*"/g, "")
          .replace(/-->(\|\|)?/g, " ");
        expect(outsideLabels, line).not.toMatch(/["<>`#|]/);
      }
    }
    expect(readme).toContain("subgraph f_end [");
  });

  it("writes Gherkin with proper-case keywords, tags and the story as description", () => {
    const uc = model.useCases[0];
    const feature = byPath.get(
      `features/${uc.filePath!.split("/").pop()!.replace(/\.md$/, "")}.feature`,
    )!;
    const lines = feature.split("\n");
    expect(lines).toContain("@UC-001 @FEAT-01 @size-M");
    expect(lines).toContain("Feature: UC-001 Sign in with email and password");
    expect(lines).toContain("  As a registered customer");
    expect(lines).toContain("  @SC-01 @happy");
    expect(lines).toContain("  Scenario: SC-01 Successful sign-in");
    for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
      expect(line).not.toMatch(/^(GIVEN|WHEN|THEN|AND|BUT)\b/);
    }
    const stepKeywords = lines
      .filter((l) => l.startsWith("    "))
      .map((l) => l.trim().split(" ")[0]);
    expect(new Set(stepKeywords)).toEqual(
      new Set(["Given", "When", "Then", "And"]),
    );
  });

  it("flags uncovered elements in the traceability matrix and lists open questions", () => {
    const trace = byPath.get("TRACEABILITY.md")!;
    expect(trace).toContain("login.logo");
    const questions = format
      .renderSupportFiles(
        ctxFor({
          ...model,
          useCases: model.useCases.map((uc, i) =>
            i === 0
              ? {
                  ...uc,
                  openQuestions: ["Is SSO required?"],
                  assumptions: ["Wording inferred"],
                }
              : uc,
          ),
        }),
      )
      .find((f) => f.path === "QUESTIONS.md")!.content;
    expect(questions).toContain("Is SSO required?");
    expect(questions).toContain("Wording inferred");
  });

  it("renders support files for an empty model without throwing", () => {
    const empty: SolutionModel = {
      ...fixtureModel(),
      screens: [],
      useCases: [],
      features: [],
      flows: [],
      personas: [],
    };
    const out = format.renderSupportFiles(ctxFor(empty));
    expect(out.find((f) => f.path === "README.md")!.content).toContain(
      "No use cases yet",
    );
    expect(out.some((f) => f.path.startsWith("features/"))).toBe(false);
  });
});

describe("data dictionary bindings", () => {
  const known = new Map([
    ["order", "Order"],
    ["order line", "Order line"],
    ["user account", "User account"],
    ["address", "Address"],
  ]);

  it("maps binding prefixes onto the entities the screens named", () => {
    expect(splitBinding("order.total", known)).toEqual({
      entity: "Order",
      field: "total",
    });
    expect(splitBinding("orderLine.quantity", known)).toEqual({
      entity: "Order line",
      field: "quantity",
    });
    expect(splitBinding("orders.count", known)).toEqual({
      entity: "Order",
      field: "count",
    });
    expect(splitBinding("user.email", known)).toEqual({
      entity: "User account",
      field: "email",
    });
    expect(splitBinding("address.city", known)).toEqual({
      entity: "Address",
      field: "city",
    });
    expect(splitBinding("currentUser.firstName", known)).toEqual({
      entity: "Current User",
      field: "firstName",
    });
  });

  it('treats "entity[]" as the list of that entity', () => {
    expect(splitBinding("order[]", known)).toEqual({
      entity: "Order",
      field: "(list)",
    });
    expect(splitBinding("invoices[]", known)).toEqual({
      entity: "Invoices",
      field: "(list)",
    });
    expect(splitBinding("order total", known)).toEqual({
      entity: "Order",
      field: "total",
    });
  });
});
