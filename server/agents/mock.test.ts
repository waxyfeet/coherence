/**
 * The offline generators must always satisfy the agent schemas (generateStructured validates them) and be
 * deterministic, for the demo screens and for arbitrary screen names.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Project, ScreenAnalysis } from "@shared/types";
import { assignScreenKeys, indexRegions, toScreenAnalysis } from "./ids";
import { normaliseJourney } from "./journeyMapper";
import { contextRoles, primaryPersona } from "./mock/heuristics";
import { mockJourney } from "./mock/journeyMock";
import { optionsFromNotes, projectLocale } from "./mock/notes";
import { mockCoverageRepair, mockPlan } from "./mock/plannerMock";
import { SAMPLE_SCREENS } from "./mock/sampleScreens";
import { mockInspection, mockScreenAnalysis } from "./mock/screenMock";
import { mockWriteUseCase } from "./mock/writerMock";
import { PlanBuilder, buildPlanContext, finalisePlan } from "./planner";
import {
  CoverageRepairOutputSchema,
  InspectorOutputSchema,
  JourneyOutputSchema,
  PlanOutputSchema,
  ScreenAnalysisOutputSchema,
  WriterOutputSchema,
} from "./schemas";
import { project, screen } from "./testFixtures";
import { leadSentences } from "./text";
import { useCaseElements } from "./writer";

const DEMO_CONTEXT = [
  "Roles:",
  "- Sales rep — Acme employee who manages the orders of assigned customers.",
  "- Customer admin — staff member of a trade customer; places their own orders.",
  "",
  "Prices are in AUD excluding GST.",
].join("\n");

function analyse(p: Project): ScreenAnalysis[] {
  const keys = assignScreenKeys(p.screens, []);
  return p.screens.map((s) => {
    const raw = mockScreenAnalysis(p, s);
    expect(ScreenAnalysisOutputSchema.safeParse(raw).success).toBe(true);
    expect(InspectorOutputSchema.safeParse(mockInspection(raw)).success).toBe(
      true,
    );
    return toScreenAnalysis({
      raw,
      screen: s,
      version: 1,
      screenKey: keys.get(s.id)!,
      validScreenIds: p.screens.map((x) => x.id),
    }).analysis;
  });
}

function runOffline(p: Project) {
  const analyses = analyse(p);
  const journey = mockJourney(p, analyses);
  expect(JourneyOutputSchema.safeParse(journey).success).toBe(true);
  const { journey: normalised } = normaliseJourney(journey, p, analyses);
  const plan = mockPlan({
    project: p,
    analyses,
    personaNames: normalised.personas.map((x) => x.name),
    granularity: "balanced",
    locked: [],
  });
  expect(PlanOutputSchema.safeParse(plan).success).toBe(true);
  const builder = new PlanBuilder(buildPlanContext(p, analyses, []));
  builder.addFeatures(plan.features);
  builder.addUseCases(plan.useCases);
  builder.dropEmptyDrafts();
  const repair = mockCoverageRepair(
    builder.drafts,
    builder.uncovered(),
    buildPlanContext(p, analyses, []).elements,
  );
  expect(CoverageRepairOutputSchema.safeParse(repair).success).toBe(true);
  builder.applyCoverageRepair(repair);
  builder.applyCoverageFallback();
  const result = finalisePlan({
    builder,
    personas: normalised.personas,
    lockedFeatures: [],
    formatId: "use-case-bdd",
  });
  const regions = indexRegions(analyses);
  const written = result.useCases.map((uc) => {
    const out = mockWriteUseCase({
      useCase: uc,
      elements: useCaseElements(uc, { screens: analyses }),
      regionNameOf: (id) => regions.get(id)?.name ?? "",
      screens: p.screens,
      personaName: normalised.personas[0].name,
      granularity: "balanced",
      screenOpenQuestions: [],
    });
    expect(WriterOutputSchema.safeParse(out).success).toBe(true);
    return out;
  });
  return { analyses, journey: normalised, plan, result, written };
}

describe("offline generators", () => {
  it("produce schema-valid, deterministic output for the demo screens", () => {
    const p = project(
      [
        screen("s1", "Login", 0),
        screen("s2", "Dashboard", 1),
        screen("s3", "Orders", 2),
        screen("s4", "New order", 3),
      ],
      { additionalContext: DEMO_CONTEXT },
    );
    const first = runOffline(p);
    const second = runOffline(p);
    expect(JSON.stringify(second.plan)).toBe(JSON.stringify(first.plan));
    expect(JSON.stringify(second.written)).toBe(JSON.stringify(first.written));
    expect(first.result.useCases.length).toBeGreaterThanOrEqual(10);
    expect(first.result.features.length).toBeGreaterThanOrEqual(3);
    expect(first.journey.personas.map((x) => x.name)).toEqual([
      "Sales rep",
      "Customer admin",
    ]);
    // Sample amounts follow the project's currency and tax.
    const text = JSON.stringify(first.analyses);
    expect(text).not.toContain("€");
    expect(text).toContain("GST");
    for (const w of first.written)
      expect(w.scenarios.length).toBeGreaterThanOrEqual(3);
  });

  it("produce sensible output for arbitrary screen names", () => {
    const p = project(
      [
        screen("a", "Register", 0),
        screen("b", "Home", 1),
        screen("c", "Products", 2),
        screen("d", "Product details", 3),
        screen("e", "Checkout", 4),
        screen("f", "Account settings", 5),
        screen("g", "Quarterly widget thing", 6),
      ],
      { description: "Online shop for garden supplies." },
    );
    const { analyses, result } = runOffline(p);
    expect(analyses.every((a) => a.elements.length > 3)).toBe(true);
    const covered = new Set(result.useCases.flatMap((u) => u.elementIds));
    for (const a of analyses)
      for (const e of a.elements) expect(covered.has(e.id)).toBe(true);
    expect(result.useCases.some((u) => u.screenIds.includes("g"))).toBe(true);
  });

  it("reads option lists, defaults and locale from the BA notes and context", () => {
    expect(
      optionsFromNotes(
        '"Period" options: Today, This week, This month (default), This year — it drives the tiles.',
        "Period",
      ),
    ).toEqual({
      options: ["Today", "This week", "This month", "This year"],
      defaultValue: "This month",
    });
    expect(
      optionsFromNotes(
        "Country dropdown options, in this order: Australia (default), New Zealand.",
        "Country",
      ),
    ).toEqual({
      options: ["Australia", "New Zealand"],
      defaultValue: "Australia",
    });
    expect(
      optionsFromNotes("Rows per page: 10 (default), 25, 50.", "Rows per page")
        ?.options,
    ).toEqual(["10", "25", "50"]);
    expect(
      optionsFromNotes("The period is important.", "Period"),
    ).toBeUndefined();
    expect(
      projectLocale({ description: "", additionalContext: "Prices in AUD." }),
    ).toEqual({ symbol: "$", tax: "GST" });
    expect(
      projectLocale({ description: "A shop", additionalContext: "" }),
    ).toBeUndefined();

    const p = project([
      screen(
        "s1",
        "Dashboard",
        0,
        '"Period" options: Today, Yesterday (default).',
      ),
    ]);
    const raw = mockScreenAnalysis(p, p.screens[0]);
    const period = raw.elements.find((e) => e.label === "Period");
    expect(period?.options).toEqual(["Today", "Yesterday"]);
    expect(period?.defaultValue).toBe("Yesterday");
  });

  it("adds option controls the notes describe but the template lacks, to the form region", () => {
    const notes =
      "Then the Country dropdown options, in this order: Australia (default), New Zealand, United States. Notes are free text.";
    const p = project([screen("s1", "New order", 0, notes)]);
    const raw = mockScreenAnalysis(p, p.screens[0]);
    const country = raw.elements.filter((e) => e.label === "Country");
    expect(country).toHaveLength(1);
    expect(country[0]).toMatchObject({
      type: "dropdown",
      options: ["Australia", "New Zealand", "United States"],
      defaultValue: "Australia",
      bounds: { x: -1, y: -1, width: -1, height: -1 },
    });
    const inputsInRegion = raw.elements.filter(
      (e) => e.regionKey === country[0].regionKey && e.type !== "dropdown",
    );
    expect(inputsInRegion.length).toBeGreaterThan(1);
    expect(ScreenAnalysisOutputSchema.safeParse(raw).success).toBe(true);
    // Deterministic, and nothing is added twice when the template already has the control.
    expect(mockScreenAnalysis(p, p.screens[0])).toEqual(raw);
    const settings = project([
      screen(
        "s2",
        "Settings",
        0,
        "Language dropdown options: English (UK), Deutsch.",
      ),
    ]);
    expect(
      mockScreenAnalysis(settings, settings.screens[0]).elements.filter(
        (e) => e.label === "Language",
      ),
    ).toHaveLength(1);
  });

  it("takes personas from the roles the BA listed, else the most specific role named", () => {
    expect(
      contextRoles({ additionalContext: DEMO_CONTEXT }).map((r) => r.name),
    ).toEqual(["Sales rep", "Customer admin"]);
    expect(
      primaryPersona(
        project([], {
          additionalContext: "",
          description: "Customers order; sales reps approve.",
        }),
      ),
    ).toBe("Sales representative");
  });
});

describe("normaliseJourney", () => {
  it("keeps only flows between real screens and adds navigation the analyst recorded", () => {
    const p = project([screen("s1", "Login", 0), screen("s2", "Dashboard", 1)]);
    const analyses = analyse(p);
    const { journey, repairs } = normaliseJourney(
      {
        summary: "",
        personas: [
          { name: "Sales rep", description: "d", goals: ["g", "g"] },
          { name: "sales rep", description: "", goals: [] },
        ],
        flows: [
          {
            fromScreenId: "Login",
            toScreenId: "s2",
            trigger: "Sign in",
            elementId: "login.nope",
            condition: "",
          },
          {
            fromScreenId: "s1",
            toScreenId: "s9",
            trigger: "Elsewhere",
            elementId: "",
            condition: "",
          },
        ],
        dataEntities: [],
        journeyOrder: ["s2"],
      },
      p,
      analyses,
    );
    expect(journey.personas).toEqual([
      {
        id: "persona-sales-rep",
        name: "Sales rep",
        description: "d",
        goals: ["g"],
      },
    ]);
    expect(journey.flows[0]).toMatchObject({
      id: "flow-1",
      fromScreenId: "s1",
      toScreenId: "s2",
      trigger: "Sign in",
    });
    expect(journey.flows[0].elementId).toBeUndefined();
    expect(journey.flows.every((f) => f.toScreenId !== "s9")).toBe(true);
    expect(journey.journeyOrder).toEqual(["s2", "s1"]);
    expect(journey.summary).toContain("Acme Orders");
    expect(repairs.length).toBeGreaterThanOrEqual(2);
  });
});

describe("offline journey wording", () => {
  it("summarises and describes personas in whole sentences, never cut mid-word", () => {
    const first =
      "Acme Orders is the B2B order-management portal of Acme Wholesale, an Australian distributor of industrial hardware and fixings to trade customers such as retailers, manufacturers and pharmacies.";
    const p = project([screen("s1", "Login", 0), screen("s2", "Orders", 1)], {
      description: `${first} Sales reps use it to manage the orders of the customer accounts assigned to them every day.`,
      additionalContext: [
        "Roles:",
        `- Sales rep — ${"Acme employee who manages the orders of assigned customers. ".repeat(6).trim()}`,
        "- Customer admin — staff member of a trade customer.",
      ].join("\n"),
    });
    const journey = mockJourney(p, analyse(p));
    expect(
      journey.summary.startsWith(
        `${first} Sales reps and customer admins use 2 screens: Login and Orders.`,
      ),
    ).toBe(true);
    expect(journey.summary).not.toContain("…");
    const rep = journey.personas.find((x) => x.name === "Sales rep")!;
    expect(rep.description.length).toBeLessThanOrEqual(300);
    expect(rep.description).toMatch(/assigned customers\.$/);
  });

  it("cuts a single over-long sentence at a word with an ellipsis", () => {
    const cut = leadSentences(`${"lorem ipsum ".repeat(30)}end.`, 50);
    expect(cut.length).toBeLessThanOrEqual(50);
    expect(cut).toMatch(/(lorem|ipsum)…$/);
    expect(leadSentences("Short. Text.", 50)).toBe("Short. Text.");
  });
});

describe("sample screen fixtures (offline demo)", () => {
  const samples = path.resolve(__dirname, "../../samples/screens");
  const demo = (name: string, order: number, notes = "") =>
    screen(`scr_${order}`, name, order, notes);
  const p = project([
    demo("Login", 0),
    demo("Dashboard", 1),
    demo("Orders", 2),
    demo("New order", 3),
  ]);
  const sha = (file: string) =>
    createHash("sha256")
      .update(fs.readFileSync(path.join(samples, file)))
      .digest("hex");

  it("has a fixture for each bundled PNG, matching the image bytes (re-run scripts/sample-fixtures.mjs if this fails)", () => {
    for (const file of fs
      .readdirSync(samples)
      .filter((f) => f.endsWith(".png"))) {
      expect(
        SAMPLE_SCREENS.map((f) => f.sha256),
        file,
      ).toContain(sha(file));
    }
  });

  it("returns the real elements of a recognised sample, valid for the agent schema", () => {
    const order = mockScreenAnalysis(p, p.screens[3]!, sha("04-new-order.png"));
    expect(ScreenAnalysisOutputSchema.safeParse(order).success).toBe(true);
    const country = order.elements.find((e) => e.key === "country")!;
    expect(country.options).toEqual([
      "Australia",
      "New Zealand",
      "South Africa",
      "United Kingdom",
      "United States",
    ]);
    expect(
      order.elements.find((e) => e.key === "postcode")!.validation,
    ).toEqual(["Postcode is required"]);
    expect(order.elements.find((e) => e.key === "user_menu")!.label).toBe(
      "Jane Cooper",
    );
    // Navigation resolves to this project's own screens.
    expect(
      order.elements.find((e) => e.key === "nav_dashboard")!
        .navigatesToScreenId,
    ).toBe("scr_1");
    expect(
      order.elements.every(
        (e) =>
          e.bounds.x >= 0 &&
          e.bounds.x + e.bounds.width <= 100.5 &&
          e.bounds.y + e.bounds.height <= 100.5,
      ),
    ).toBe(true);
    expect(order.elements.map((e) => e.label)).not.toContain("Discount %");
  });

  it("keeps guessing from the name for any other image", () => {
    const other = mockScreenAnalysis(p, p.screens[0]!, "not-a-sample-hash");
    expect(other).toEqual(mockScreenAnalysis(p, p.screens[0]!));
  });
});
