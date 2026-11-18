import { describe, expect, it } from "vitest";
import type { ChangeRequest } from "@shared/types";
import { traceImpact } from "./graph";
import { mockImpactAnalysis, relevantByKeywords } from "./impactMock";
import { fixtureModel } from "./testFixtures";
import { keywordTokens } from "./text";

function analyse(change: ChangeRequest) {
  const model = fixtureModel();
  return mockImpactAnalysis({
    model,
    change,
    trace: traceImpact(model, change),
  });
}

describe("offline Impact Analyst — a change to a whole use case", () => {
  it("targets only the rules the description is about and quotes them", () => {
    const out = analyse({
      targetKind: "usecase",
      targetId: "UC-004",
      source: "manual",
      description:
        "Show revenue for the last 90 days instead of the last 12 months, with a period selector",
    });
    const item = out.items.find((i) => i.useCaseId === "UC-004")!;
    expect(item.severity).toBe("high");
    expect(item.affectedRuleIds).toEqual(["BR-02"]);
    const rules = item.suggestedChanges.filter((s) => s.startsWith("BR-"));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain(
      "BR-02 (Revenue): currently “Shows revenue for the last 12 months”",
    );
    expect(item.suggestedChanges.join("\n")).not.toMatch(
      /BR-01|update to reflect/,
    );
  });

  it('turns "from X to Y" into a concrete edit of the matching rule line and skips unrelated use cases', () => {
    const out = analyse({
      targetKind: "usecase",
      targetId: "UC-001",
      source: "manual",
      description: "Password minimum length from 8 to 12",
    });
    const item = out.items.find((i) => i.useCaseId === "UC-001")!;
    expect(item.affectedRuleIds).toEqual(["BR-02"]);
    expect(item.suggestedChanges).toContain(
      "BR-02 (Password): currently “Minimum 8 characters” — change “8” to “12” (“Minimum 12 characters”)",
    );
    expect(item.affectedScenarioIds).toContain("SC-03"); // "Password too short"
    expect(item.affectedScenarioIds).not.toContain("SC-02"); // the email scenario
    // UC-002 only shares the email field, which the change is not about.
    expect(out.items.find((i) => i.useCaseId === "UC-002")).toBeUndefined();
  });

  it("falls back to one general suggestion when no rule matches the description", () => {
    const out = analyse({
      targetKind: "usecase",
      targetId: "UC-004",
      source: "manual",
      description: "Tidy up the wording",
    });
    const item = out.items.find((i) => i.useCaseId === "UC-004")!;
    expect(item.affectedRuleIds).toEqual([]);
    expect(item.suggestedChanges.filter((s) => s.startsWith("BR-"))).toEqual(
      [],
    );
    expect(item.suggestedChanges[0]).toMatch(/^Business rules: /);
  });

  it("still lists every rule of a single changed element", () => {
    const out = analyse({
      targetKind: "element",
      targetId: "login.password",
      source: "manual",
      description: "Password minimum length becomes 12 characters",
    });
    const item = out.items.find((i) => i.useCaseId === "UC-001")!;
    expect(item.affectedRuleIds).toEqual(["BR-02"]);
    expect(item.suggestedChanges[0]).toBe(
      "BR-02 (Password): currently “Minimum 8 characters” — rewrite it for the change “Password minimum length becomes 12 characters”",
    );
  });
});

describe("relevantByKeywords", () => {
  const texts = [
    "Shows the number of open orders",
    "Shows revenue for the last 12 months",
    "Revenue chart colours",
  ];
  it("keeps the items close to the best keyword match, best first, capped", () => {
    const query = (q: string) => new Set(keywordTokens(q));
    expect(
      relevantByKeywords(
        texts,
        (t) => t,
        query("revenue chart for the last months"),
        3,
      ),
    ).toEqual([texts[1], texts[2]]);
    expect(
      relevantByKeywords(
        texts,
        (t) => t,
        query("revenue chart for the last months"),
        1,
      ),
    ).toEqual([texts[1]]);
    // A weak partial match (only the shared word "revenue") is dropped next to a strong one.
    expect(
      relevantByKeywords(
        texts,
        (t) => t,
        query("revenue of the last months"),
        3,
      ),
    ).toEqual([texts[1]]);
  });

  it("does not match on numbers alone", () => {
    expect(
      relevantByKeywords(texts, (t) => t, new Set(keywordTokens("12")), 3),
    ).toEqual([]);
  });
});
