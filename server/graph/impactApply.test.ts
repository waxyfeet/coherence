import { describe, expect, it } from "vitest";
import type { ImpactItem, ImpactReport, SolutionModel } from "@shared/types";
import {
  keepFlagAfterRewrite,
  markStale,
  nextFlaggingReport,
  regeneratedSince,
  restoreStatuses,
  statusAfterRewrite,
} from "./impactApply";
import { fixtureModel } from "./testFixtures";

const report: Pick<ImpactReport, "id" | "previousStatuses"> = {
  id: "IR-20261014-abc123",
  previousStatuses: {
    "UC-002": "approved",
    "UC-003": "generated",
    "UC-004": "edited",
  },
};

describe("statusAfterRewrite", () => {
  it("keeps BA-touched content protected after an AI rewrite", () => {
    // The use case the BA edited (md-edit source) is never marked stale.
    expect(statusAfterRewrite({ id: "UC-001", status: "edited" }, report)).toBe(
      "edited",
    );
    expect(
      statusAfterRewrite(
        { id: "UC-002", status: "stale", staleReason: report.id },
        report,
      ),
    ).toBe("edited");
    expect(
      statusAfterRewrite(
        { id: "UC-004", status: "stale", staleReason: report.id },
        report,
      ),
    ).toBe("edited");
    expect(
      statusAfterRewrite({ id: "UC-005", status: "approved" }, report),
    ).toBe("edited");
  });

  it("returns generated content to generated", () => {
    expect(
      statusAfterRewrite(
        { id: "UC-003", status: "stale", staleReason: report.id },
        report,
      ),
    ).toBe("generated");
    expect(
      statusAfterRewrite({ id: "UC-006", status: "generated" }, report),
    ).toBe("generated");
    // Flagged by another report and unknown to this one: nothing says the BA touched it.
    expect(
      statusAfterRewrite(
        { id: "UC-006", status: "stale", staleReason: "IR-20261013-zzzzzz" },
        report,
      ),
    ).toBe("generated");
  });

  it("keeps the protection when another report owns the stale flag", () => {
    const owner = {
      id: "IR-20261013-zzzzzz",
      previousStatuses: { "UC-006": "approved" as const },
    };
    const flagged = {
      id: "UC-006",
      status: "stale" as const,
      staleReason: owner.id,
    };
    expect(statusAfterRewrite(flagged, report, owner)).toBe("edited");
    // This report's own copy of the original status (recorded by markStale) is enough on its own.
    expect(
      statusAfterRewrite(
        { id: "UC-002", status: "stale", staleReason: owner.id },
        report,
      ),
    ).toBe("edited");
  });
});

/* ------------------------------------------------------------------ */
/* Overlapping impact reports                                          */
/* ------------------------------------------------------------------ */

const item = (
  useCaseId: string,
  severity: ImpactItem["severity"] = "high",
): ImpactItem => ({
  useCaseId,
  relation: "direct",
  severity,
  reason: "x",
  suggestedChanges: [],
  affectedSections: [],
  affectedRuleIds: [],
  affectedScenarioIds: [],
});

function openReport(
  id: string,
  createdAt: string,
  items: ImpactItem[],
): ImpactReport {
  return {
    id,
    projectId: "acme",
    createdAt,
    change: { targetKind: "free", description: "x", source: "manual" },
    deterministic: {
      seedNodeIds: [],
      directUseCaseIds: [],
      downstreamUseCaseIds: [],
      upstreamUseCaseIds: [],
      relatedUseCaseIds: [],
      affectedElementIds: [],
      affectedScreenIds: [],
      paths: [],
    },
    items,
    summary: "",
    risks: [],
    suggestedNewUseCases: [],
    status: "analysed",
    analysedBy: "mock/demo",
    previousStatuses: {},
  };
}

/** UC-002 approved; report A (button rename) and then report B (timeout change) both flag it high. */
function overlap(): { model: SolutionModel; a: ImpactReport; b: ImpactReport } {
  const model = fixtureModel();
  model.useCases.find((u) => u.id === "UC-002")!.status = "approved";
  const a = openReport("IR-20261014-aaaaaa", "2026-10-14T11:00:00.000Z", [
    item("UC-002"),
    item("UC-003", "medium"),
  ]);
  a.previousStatuses = markStale(
    model,
    a.items,
    a.id,
    new Set(),
    [],
  ).previousStatuses;
  const b = openReport("IR-20261014-bbbbbb", "2026-10-14T12:00:00.000Z", [
    item("UC-002"),
  ]);
  const marked = markStale(model, b.items, b.id, new Set(), [a]);
  b.previousStatuses = marked.previousStatuses;
  expect(marked.markedIds).toEqual([]); // UC-002 was already stale
  return { model, a, b };
}

const uc = (model: SolutionModel, id: string) =>
  model.useCases.find((u) => u.id === id)!;

describe("overlapping impact reports", () => {
  it("records the original status in the second report while the first keeps the flag", () => {
    const { model, a, b } = overlap();
    expect(a.previousStatuses).toEqual({
      "UC-002": "approved",
      "UC-003": "generated",
    });
    expect(b.previousStatuses).toEqual({ "UC-002": "approved" });
    expect(uc(model, "UC-002")).toMatchObject({
      status: "stale",
      staleReason: a.id,
    });
  });

  it("discarding the first report hands the flag to the report that still asks for a change", () => {
    const { model, a, b } = overlap();
    expect(restoreStatuses(model, a, new Set(), [b])).toEqual([
      "UC-002",
      "UC-003",
    ]);
    expect(uc(model, "UC-002")).toMatchObject({
      status: "stale",
      staleReason: b.id,
    });
    expect(uc(model, "UC-003").status).toBe("generated");

    a.status = "discarded";
    expect(restoreStatuses(model, b, new Set(), [a])).toEqual(["UC-002"]);
    expect(uc(model, "UC-002").status).toBe("approved");
    expect(uc(model, "UC-002").staleReason).toBeUndefined();
  });

  it("applying the second report keeps the BA protection and leaves the first report flagging the use case", () => {
    const { model, a, b } = overlap();
    const current = uc(model, "UC-002");
    const rewritten = { ...current, status: statusAfterRewrite(current, b, a) };
    expect(rewritten.status).toBe("edited");

    expect(keepFlagAfterRewrite(rewritten, [a])).toEqual([a]);
    expect(rewritten).toMatchObject({ status: "stale", staleReason: a.id });
    // Discarding A later restores the rewritten content's status, not the approval it never had.
    expect(a.previousStatuses["UC-002"]).toBe("edited");
    model.useCases[model.useCases.indexOf(current)] = rewritten;
    restoreStatuses(model, a, new Set(), []);
    expect(uc(model, "UC-002").status).toBe("edited");
  });

  it("clears the flag after a rewrite when no other open report asks for a change", () => {
    const { a } = overlap();
    const rewritten = {
      ...uc(fixtureModel(), "UC-002"),
      status: "edited" as const,
      staleReason: a.id,
    };
    a.status = "discarded";
    expect(keepFlagAfterRewrite(rewritten, [a])).toEqual([]);
    expect(rewritten.status).toBe("edited");
    expect(rewritten.staleReason).toBeUndefined();
  });

  it("only hands the flag to open reports that have not rewritten the use case yet, oldest first", () => {
    const { a, b } = overlap();
    const c = openReport("IR-20261014-cccccc", "2026-10-14T13:00:00.000Z", [
      item("UC-002"),
    ]);
    c.previousStatuses = { "UC-002": "approved" };
    expect(nextFlaggingReport([c, b], "UC-002")).toBe(b);
    b.appliedUseCaseIds = ["UC-002"];
    b.status = "partially-applied";
    expect(nextFlaggingReport([c, b], "UC-002")).toBe(c);
    c.status = "applied";
    expect(nextFlaggingReport([c, b, a], "UC-003")).toBe(a);
    expect(nextFlaggingReport([c, b], "UC-002")).toBeUndefined();
  });
});

describe("regeneratedSince", () => {
  it("compares the model the report was analysed against", () => {
    const model = { generatedAt: "2026-10-14T10:00:00.000Z" };
    expect(
      regeneratedSince(
        {
          createdAt: "2026-10-14T11:00:00.000Z",
          modelGeneratedAt: model.generatedAt,
        },
        model,
      ),
    ).toBe(false);
    expect(
      regeneratedSince(
        {
          createdAt: "2026-10-14T11:00:00.000Z",
          modelGeneratedAt: model.generatedAt,
        },
        { generatedAt: "2026-10-14T12:00:00.000Z" },
      ),
    ).toBe(true);
  });

  it("falls back to the creation time for reports that did not record it", () => {
    expect(
      regeneratedSince(
        { createdAt: "2026-10-14T11:00:00.000Z" },
        { generatedAt: "2026-10-14T10:00:00.000Z" },
      ),
    ).toBe(false);
    expect(
      regeneratedSince(
        { createdAt: "2026-10-14T11:00:00.000Z" },
        { generatedAt: "2026-10-14T12:00:00.000Z" },
      ),
    ).toBe(true);
  });
});
