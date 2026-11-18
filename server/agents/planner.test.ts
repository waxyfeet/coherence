import { describe, expect, it } from "vitest";
import type { Persona } from "@shared/types";
import { chainHolds } from "./chain";
import {
  PlanBuilder,
  breakCycles,
  buildPlanContext,
  finalisePlan,
  topoSort,
  type OrderNode,
} from "./planner";
import type { PlannedUseCase } from "./schemas";
import { analysis, project, screen, useCase } from "./testFixtures";

const screens = [
  screen("scr_login", "Login", 0),
  screen("scr_dash", "Dashboard", 1),
  screen("scr_orders", "Orders", 2),
];
const proj = project(screens);
const analyses = [
  analysis("scr_login", "login", [
    { key: "email", type: "email_input", region: "form" },
    { key: "password", type: "password_input", region: "form" },
    { key: "sign_in", region: "form" },
    { key: "logo", type: "logo", region: "brand" },
  ]),
  analysis("scr_dash", "dashboard", [
    { key: "nav_orders", type: "link", region: "header" },
    { key: "kpi_open", type: "tile", region: "kpis" },
    { key: "kpi_late", type: "tile", region: "kpis" },
  ]),
  analysis("scr_orders", "orders", [
    { key: "nav_dash", type: "link", region: "header" },
    { key: "table", type: "table", region: "list" },
    { key: "search", type: "search_input", region: "filters" },
    { key: "status", type: "dropdown", region: "filters" },
  ]),
];
const personas: Persona[] = [
  { id: "persona-sales-rep", name: "Sales rep", description: "", goals: [] },
  {
    id: "persona-customer-admin",
    name: "Customer admin",
    description: "",
    goals: [],
  },
];

function planned(key: string, extra: Partial<PlannedUseCase>): PlannedUseCase {
  return {
    key,
    title: key.replace(/-/g, " "),
    featureKey: "core",
    personaName: "Sales rep",
    screenIds: [],
    regionIds: [],
    elementIds: [],
    dependsOn: [],
    size: "M",
    scope: "",
    preconditions: [],
    postconditions: [],
    ...extra,
  };
}

function builder(
  useCases: PlannedUseCase[],
  locked = [] as ReturnType<typeof useCase>[],
): PlanBuilder {
  const b = new PlanBuilder(buildPlanContext(proj, analyses, locked));
  b.addFeatures([
    { key: "access", name: "Access & navigation", description: "" },
    { key: "orders", name: "Order management", description: "" },
  ]);
  b.addUseCases(useCases);
  b.dropEmptyDrafts();
  return b;
}

const signIn = planned("sign-in", {
  title: "Sign in",
  featureKey: "access",
  elementIds: ["login.email", "login.password", "login.sign_in"],
  preconditions: ["The user has opened the application"],
  postconditions: [
    "The user is signed in",
    "The Dashboard screen is displayed",
  ],
});
const shell = planned("app-shell", {
  title: "Application shell & navigation",
  featureKey: "access",
  elementIds: ["dashboard.nav_orders", "orders.nav_dash"],
  dependsOn: ["sign-in"],
  preconditions: ["The user is signed in"],
  postconditions: ["The main navigation is displayed"],
});
const browse = planned("browse-orders", {
  title: "Browse orders",
  featureKey: "orders",
  elementIds: ["orders.table"],
  dependsOn: ["app-shell"],
  preconditions: ["The Orders screen is displayed"],
  postconditions: ["The order list is displayed"],
});
const filter = planned("filter-orders", {
  title: "Filter orders",
  featureKey: "orders",
  elementIds: ["orders.search", "orders.status", "orders.bogus"],
  dependsOn: ["browse-orders", "nonexistent"],
  preconditions: ["The order list is displayed"],
  postconditions: ["Only matching orders are listed"],
});
const kpis = planned("view-kpis", {
  title: "View KPIs",
  featureKey: "dashboards",
  elementIds: ["dashboard.kpi_open"],
  dependsOn: ["sign-in"],
  preconditions: ["The Dashboard screen is displayed"],
  postconditions: ["The KPIs are displayed"],
});

describe("PlanBuilder validation", () => {
  it("drops unknown element ids and unknown dependencies with notes", () => {
    const b = builder([signIn, shell, browse, filter]);
    const f = b.draft("filter-orders")!;
    expect(f.elementIds).toEqual(["orders.search", "orders.status"]);
    expect(f.dependsOn).toEqual(["browse-orders"]);
    expect(f.screenIds).toEqual(["scr_orders"]);
    expect(f.regionIds).toEqual(["orders.filters"]);
    expect(b.notes.some((n) => n.includes("orders.bogus"))).toBe(true);
    expect(b.notes.some((n) => n.includes("nonexistent"))).toBe(true);
  });

  it("creates features for unknown feature keys and removes use cases without elements", () => {
    const empty = planned("empty", { elementIds: ["nope.nothing"] });
    const dependent = planned("after-empty", {
      elementIds: ["dashboard.kpi_late"],
      dependsOn: ["empty"],
    });
    const b = builder([
      signIn,
      { ...empty, dependsOn: ["sign-in"] },
      dependent,
      kpis,
    ]);
    expect(b.draft("empty")).toBeUndefined();
    // The dependent inherits the removed use case's dependency, so its chain survives.
    expect(b.draft("after-empty")!.dependsOn).toEqual(["sign-in"]);
    expect(b.features.map((x) => x.key)).toContain("dashboards");
  });
});

describe("coverage", () => {
  it("lists uncovered elements and places them: by region first, else in a generated layout use case", () => {
    const b = builder([signIn, shell, browse, filter, kpis]);
    expect(b.uncovered().map((e) => e.id)).toEqual([
      "login.logo",
      "dashboard.kpi_late",
    ]);
    const { assigned, created } = b.applyCoverageFallback();
    expect(assigned).toBe(1);
    expect(b.draft("view-kpis")!.elementIds).toContain("dashboard.kpi_late");
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe("View Login layout and content");
    expect(created[0].elementIds).toEqual(["login.logo"]);
    expect(created[0].dependsOn).toEqual(["sign-in"]);
    expect(created[0].preconditions[0]).toBe("The user is signed in");
    expect(b.uncovered()).toEqual([]);
  });

  it("applies a coverage repair answer (assignments and new use cases)", () => {
    const b = builder([signIn, shell, browse, filter, kpis]);
    const placed = b.applyCoverageRepair({
      assignments: [
        { elementId: "dashboard.kpi_late", useCaseKey: "view-kpis" },
        { elementId: "login.email", useCaseKey: "nope" },
      ],
      newFeatures: [{ key: "brand", name: "Branding", description: "" }],
      newUseCases: [
        planned("brand", {
          featureKey: "brand",
          title: "View branding",
          elementIds: ["login.logo"],
          postconditions: ["Branding shown"],
        }),
      ],
    });
    expect(placed).toBe(2);
    expect(b.uncovered()).toEqual([]);
    expect(b.draft("brand")!.featureKey).toBe("brand");
  });
});

describe("graph ordering", () => {
  it("breaks cycles by dropping the edge from the latest-planned use case", () => {
    const nodes: OrderNode[] = [
      { key: "a", dependsOn: ["c"], planIndex: 0, screenRank: 0 },
      { key: "b", dependsOn: ["a"], planIndex: 1, screenRank: 0 },
      { key: "c", dependsOn: ["b"], planIndex: 2, screenRank: 0 },
    ];
    const notes = breakCycles(nodes);
    expect(notes).toHaveLength(1);
    expect(nodes.find((n) => n.key === "c")!.dependsOn).toEqual([]);
    expect(topoSort(nodes)).toEqual(["c", "a", "b"]);
  });

  it("sorts topologically, stable by screen order then plan order", () => {
    const nodes: OrderNode[] = [
      { key: "orders-view", dependsOn: ["shell"], planIndex: 0, screenRank: 2 },
      { key: "dash-view", dependsOn: ["sign-in"], planIndex: 1, screenRank: 1 },
      { key: "shell", dependsOn: ["sign-in"], planIndex: 2, screenRank: 1 },
      { key: "sign-in", dependsOn: [], planIndex: 3, screenRank: 0 },
      { key: "forgot", dependsOn: [], planIndex: 4, screenRank: 0 },
    ];
    expect(topoSort(nodes)).toEqual([
      "sign-in",
      "forgot",
      "dash-view",
      "shell",
      "orders-view",
    ]);
  });
});

describe("finalisePlan", () => {
  it("assigns ids in build order, features in first-appearance order and repairs the chain", () => {
    const b = builder([browse, filter, kpis, shell, signIn]);
    b.applyCoverageFallback();
    const result = finalisePlan({
      builder: b,
      personas,
      lockedFeatures: [],
      formatId: "use-case-bdd",
      now: "2026-10-14T00:00:00.000Z",
    });
    const titles = result.useCases.map((u) => `${u.id} ${u.title}`);
    expect(titles[0]).toBe("UC-001 Sign in");
    expect(result.useCases.map((u) => u.order)).toEqual(
      result.useCases.map((_, i) => i + 1),
    );
    expect(result.features.map((f) => `${f.id} ${f.name}`)).toEqual([
      "FEAT-01 Access & navigation",
      "FEAT-02 Dashboards",
      "FEAT-03 Order management",
    ]);
    for (const f of result.features)
      for (const id of f.useCaseIds)
        expect(result.useCases.find((u) => u.id === id)!.featureId).toBe(f.id);

    const byId = new Map(result.useCases.map((u) => [u.id, u]));
    for (const uc of result.useCases) {
      for (const dep of uc.dependsOn)
        expect(byId.get(dep)!.order).toBeLessThan(uc.order);
      if (uc.dependsOn.length)
        expect(
          chainHolds(
            uc,
            uc.dependsOn.map((d) => byId.get(d)!),
          ),
        ).toBe(true);
    }
    // "Browse orders" started from "The Orders screen is displayed": the shell's postcondition is prepended verbatim.
    const browseUc = result.useCases.find((u) => u.title === "Browse orders")!;
    expect(browseUc.preconditions).toEqual([
      "The main navigation is displayed",
      "The Orders screen is displayed",
    ]);
    expect(browseUc.slug).toBe("browse-orders");
    expect(browseUc.personaId).toBe("persona-sales-rep");
    expect(result.newIds).toHaveLength(result.useCases.length);
    expect(
      result.useCases.every(
        (u) => u.status === "generated" && u.revision === 1,
      ),
    ).toBe(true);
  });

  it("keeps locked use cases (ids, features) and numbers new ones after the highest locked id", () => {
    const locked = useCase("UC-004", {
      title: "Sign in (edited)",
      status: "edited",
      order: 1,
      featureId: "FEAT-03",
      screenIds: ["scr_login"],
      elementIds: ["login.email", "login.password", "login.sign_in"],
      postconditions: ["The user is signed in"],
      dependsOn: ["UC-001"],
    });
    const b = builder(
      [
        planned("logo", {
          title: "View branding",
          elementIds: ["login.logo", "login.email"],
          postconditions: ["Branding shown"],
        }),
        { ...shell, dependsOn: ["UC-004"] },
        browse,
      ],
      [locked],
    );
    // Locked elements are never re-planned.
    expect(b.draft("logo")!.elementIds).toEqual(["login.logo"]);
    const result = finalisePlan({
      builder: b,
      personas,
      formatId: "use-case-bdd",
      lockedFeatures: [
        {
          id: "FEAT-03",
          name: "Access & navigation",
          description: "Kept",
          useCaseIds: ["UC-004"],
        },
      ],
    });
    const kept = result.useCases.find((u) => u.id === "UC-004")!;
    expect(kept.title).toBe("Sign in (edited)");
    expect(kept.dependsOn).toEqual([]);
    expect(result.newIds.every((id) => Number(id.slice(3)) > 4)).toBe(true);
    const shellUc = result.useCases.find(
      (u) => u.title === "Application shell & navigation",
    )!;
    expect(shellUc.dependsOn).toEqual(["UC-004"]);
    expect(shellUc.preconditions[0]).toBe("The user is signed in");
    // The planned "access" feature has the same name as the kept feature, so it reuses FEAT-03.
    expect(shellUc.featureId).toBe("FEAT-03");
    expect(result.features.map((f) => f.id)).toContain("FEAT-01");
  });
});
