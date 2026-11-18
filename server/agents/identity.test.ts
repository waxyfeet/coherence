import { describe, expect, it } from "vitest";
import type { SolutionModel, UseCase } from "@shared/types";
import type { PlanResult } from "./planner";
import { stabilisePlan } from "./identity";
function uc(
  id: string,
  title: string,
  elements: string[],
  order: number,
): UseCase {
  return {
    id,
    title,
    elementIds: elements,
    order,
    dependsOn: [],
    internalId: id + "-uuid",
  } as unknown as UseCase;
}
describe("permanent V2 use-case identity", () => {
  it("keeps IDs across reordered plans and allocates beyond retired numbers", () => {
    const previous = {
      useCases: [
        uc("UC-003", "Submit order", ["form.submit"], 1),
        uc("UC-008", "Sign in", ["login.email"], 2),
      ],
      nextUseCaseNumber: 12,
    } as SolutionModel;
    const signIn = uc("UC-001", "Sign in", ["login.email"], 1);
    delete signIn.internalId;
    const submit = uc("UC-002", "Submit order", ["form.submit"], 2);
    delete submit.internalId;
    submit.dependsOn = ["UC-001"];
    const fresh = uc("UC-003", "Download receipt", ["receipt.download"], 3);
    delete fresh.internalId;
    const plan: PlanResult = {
      useCases: [signIn, submit, fresh],
      features: [
        {
          id: "F",
          name: "Feature",
          description: "",
          useCaseIds: ["UC-001", "UC-002", "UC-003"],
        },
      ],
      newIds: ["UC-001", "UC-002", "UC-003"],
      notes: [],
    };
    expect(stabilisePlan(plan, previous)).toBe(13);
    expect(plan.useCases.map((u) => u.id)).toEqual([
      "UC-008",
      "UC-003",
      "UC-012",
    ]);
    expect(submit.dependsOn).toEqual(["UC-008"]);
    expect(submit.internalId).toBe("UC-003-uuid");
    expect(fresh.internalId).not.toBe("UC-003-uuid");
    expect(plan.features[0].useCaseIds).toEqual(["UC-008", "UC-003", "UC-012"]);
  });
});
