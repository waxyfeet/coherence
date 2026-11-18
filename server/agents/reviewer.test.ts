import { describe, expect, it } from "vitest";
import type { BddScenario, BusinessRule, UseCase } from "@shared/types";
import { getFormat } from "../formats/registry";
import {
  deterministicReview,
  distinctRuleCount,
  mockReview,
  numberFindings,
  selfRepair,
  vagueRuleFindings,
  type DraftFinding,
} from "./reviewer";
import { ReviewerOutputSchema } from "./schemas";
import { recordingContext } from "./testContext";
import {
  analysis,
  mockConnection,
  model,
  project,
  screen,
  useCase,
} from "./testFixtures";

const login = analysis("scr_login", "login", [
  { key: "email", type: "email_input", region: "form" },
  { key: "sign_in", region: "form" },
  { key: "logo", type: "logo", region: "brand" },
]);

function rule(
  id: string,
  elementId: string | undefined,
  rules = ["Mandatory."],
  element = elementId ?? "General",
): BusinessRule {
  return {
    id,
    elementId,
    element,
    elementType: elementId ? "button" : "general",
    description: "",
    rules,
  };
}

function happy(given: string[], then: string[]): BddScenario {
  return {
    id: "SC-01",
    title: "Happy",
    type: "happy",
    given,
    when: ["the user acts"],
    then,
    elementIds: [],
  };
}

const signIn = useCase("UC-001", {
  elementIds: ["login.email", "login.sign_in", "login.logo"],
  preconditions: ["The user has opened the application"],
  postconditions: ["The user is signed in"],
  businessRules: [
    rule("BR-01", "login.email"),
    rule("BR-02", "login.sign_in"),
    rule("BR-03", "login.logo"),
  ],
  scenarios: [
    happy(["the user has opened the application"], ["the user is signed in"]),
  ],
});
const dashboard = useCase("UC-002", {
  dependsOn: ["UC-001"],
  preconditions: ["The user is signed in"],
  postconditions: ["The Dashboard is displayed"],
  scenarios: [happy(["the user is signed in"], ["the Dashboard is displayed"])],
});

describe("deterministicReview", () => {
  it("is clean for a covered, governed, chained model", () => {
    expect(deterministicReview(model([login], [signIn, dashboard]))).toEqual(
      [],
    );
  });

  it("reports uncovered elements (error) and elements without a governing rule (warning)", () => {
    const partial: UseCase = {
      ...signIn,
      elementIds: ["login.email", "login.sign_in", "login.gone"],
      businessRules: [rule("BR-01", "login.email")],
    };
    const findings = deterministicReview(model([login], [partial, dashboard]));
    const coverage = findings.filter((f) => f.category === "coverage");
    expect(coverage.map((f) => f.severity)).toEqual([
      "error",
      "warning",
      "warning",
    ]);
    expect(coverage[0].message).toContain("login.logo");
    expect(coverage[1].message).toContain("login.sign_in");
    expect(coverage[2].message).toContain("login.gone");
  });

  it("reports broken chains: no predecessor postcondition, unknown dependency, happy path not chained", () => {
    const broken: UseCase = {
      ...dashboard,
      dependsOn: ["UC-001", "UC-009"],
      preconditions: ["The Dashboard screen is open"],
      scenarios: [happy(["something else"], ["nothing"])],
    };
    const findings = deterministicReview(
      model([login], [signIn, broken]),
    ).filter((f) => f.category === "chain");
    expect(findings.map((f) => f.severity)).toEqual([
      "error",
      "error",
      "warning",
      "warning",
    ]);
    expect(findings[0].message).toContain("UC-009");
    expect(findings[1].message).toContain('"The user is signed in"');
    expect(findings[1].useCaseIds).toEqual(["UC-002", "UC-001"]);
  });

  it("reports a missing happy path and an entry point without preconditions", () => {
    const noHappy: UseCase = {
      ...dashboard,
      scenarios: [{ ...happy([], []), type: "negative" }],
    };
    const entry: UseCase = { ...useCase("UC-003"), preconditions: [] };
    const findings = deterministicReview(
      model([login], [signIn, noHappy, entry]),
    );
    expect(
      findings.some(
        (f) => f.severity === "error" && f.message.includes("no happy path"),
      ),
    ).toBe(true);
    expect(
      findings.some(
        (f) =>
          f.severity === "warning" &&
          f.message.includes("UC-003 has no preconditions"),
      ),
    ).toBe(true);
  });

  it("warns about use cases that are too big, counting repeated shell elements once", () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      rule(`BR-${i + 1}`, `login.e${i}`, ["x"], `Element ${i}`),
    );
    const tooBig: UseCase = { ...dashboard, businessRules: many };
    const repeated: UseCase = {
      ...dashboard,
      id: "UC-003",
      businessRules: Array.from({ length: 15 }, (_, i) =>
        rule(`BR-${i + 1}`, `s${i % 3}.logo`, ["x"], "Logo"),
      ),
    };
    expect(distinctRuleCount(repeated)).toBe(1);
    const findings = deterministicReview(
      model([], [signIn, tooBig, repeated]),
    ).filter((f) => f.category === "size");
    expect(findings).toHaveLength(1);
    expect(findings[0].useCaseIds).toEqual(["UC-002"]);
    const scenarios = Array.from({ length: 11 }, (_, i) => ({
      ...happy(["the user is signed in"], ["the Dashboard is displayed"]),
      id: `SC-${i}`,
    }));
    expect(
      deterministicReview(
        model([], [signIn, { ...dashboard, scenarios }]),
      ).some((f) => f.category === "size"),
    ).toBe(true);
  });

  it("notes the same element governed differently in two use cases", () => {
    const other: UseCase = {
      ...dashboard,
      elementIds: ["login.email"],
      businessRules: [rule("BR-01", "login.email", ["Optional."])],
    };
    const findings = deterministicReview(
      model([login], [signIn, other]),
    ).filter((f) => f.category === "consistency");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "info",
      useCaseIds: ["UC-001", "UC-002"],
    });
  });
});

describe("selfRepair", () => {
  const p = project([screen("scr_login", "Login", 0)]);
  const m = model([login], [signIn, dashboard]);
  const contradiction: DraftFinding = {
    severity: "error",
    category: "consistency",
    useCaseIds: ["UC-001", "UC-002"],
    resolved: false,
    message:
      'UC-001 BR-02 limits "PO number" to 30 characters, UC-002 BR-04 to 20.',
    suggestion: "Use one limit.",
  };

  it("leaves agent findings open after a rewrite: nothing proves the rewrite fixed them", async () => {
    const ctx = recordingContext();
    // UC-002 is locked (approved by the BA), so only UC-001 can be rewritten.
    const result = await selfRepair({
      ctx,
      project: p,
      model: m,
      connection: mockConnection(),
      format: getFormat("use-case-bdd"),
      includeImages: false,
      deterministic: [],
      agent: [contradiction],
      lockedIds: new Set(["UC-002"]),
    });
    expect(result.rewritten).toEqual(["UC-001"]);
    const after = result.findings.find(
      (f) => f.message === contradiction.message,
    )!;
    expect(after.resolved).toBe(false);
    expect(after.severity).toBe("error");
    expect(after.suggestion).toMatch(/rewrote UC-001 .*verify/);
    expect(
      numberFindings(result.findings).filter(
        (f) => !f.resolved && f.severity === "error",
      ),
    ).toHaveLength(1);
  });
});

describe("findings", () => {
  it("numbers findings RV-01… with open errors first", () => {
    const numbered = numberFindings([
      {
        severity: "info",
        category: "other",
        useCaseIds: [],
        message: "c",
        resolved: false,
      },
      {
        severity: "error",
        category: "chain",
        useCaseIds: [],
        message: "a",
        resolved: true,
      },
      {
        severity: "warning",
        category: "size",
        useCaseIds: [],
        message: "b",
        resolved: false,
      },
      {
        severity: "error",
        category: "chain",
        useCaseIds: [],
        message: "d",
        resolved: false,
      },
    ]);
    expect(numbered.map((f) => `${f.id} ${f.message}`)).toEqual([
      "RV-01 d",
      "RV-02 b",
      "RV-03 c",
      "RV-04 a",
    ]);
  });

  it("flags untestable wording but not concrete rules", () => {
    const vague: UseCase = {
      ...signIn,
      businessRules: [
        rule("BR-01", "login.email", ["Must be valid."]),
        rule("BR-02", "login.sign_in", [
          "Disabled until all mandatory fields are valid.",
        ]),
      ],
    };
    const concrete: UseCase = {
      ...dashboard,
      businessRules: [
        rule("BR-01", "x", ["Must be valid (max 254 characters)."]),
      ],
    };
    const findings = vagueRuleFindings([vague, concrete]);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("UC-001 BR-01");
    expect(
      ReviewerOutputSchema.safeParse(
        mockReview([vague, { ...dashboard, openQuestions: ["Who approves?"] }]),
      ).success,
    ).toBe(true);
  });
});
