import { describe, expect, it } from "vitest";
import type {
  ChangeRequest,
  DeterministicImpact,
  GraphEdgeKind,
  ScreenDiff,
} from "@shared/types";
import { BadRequestError } from "../errors";
import { buildGraph, matchFreeText, traceImpact } from "./graph";
import { indexModel } from "./modelIndex";
import { fixtureModel } from "./testFixtures";

const change = (
  c: Partial<ChangeRequest> & Pick<ChangeRequest, "targetKind">,
): ChangeRequest => ({
  description: "Something changes",
  source: "manual",
  ...c,
});

function buckets(t: DeterministicImpact) {
  return {
    direct: t.directUseCaseIds,
    downstream: t.downstreamUseCaseIds,
    upstream: t.upstreamUseCaseIds,
    related: t.relatedUseCaseIds,
  };
}

function pathOf(t: DeterministicImpact, id: string) {
  return t.paths.find((p) => p.useCaseId === id)?.path;
}

describe("buildGraph", () => {
  const model = fixtureModel();
  const graph = buildGraph(model);
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  it("creates a node for every feature, persona, use case, rule, scenario, screen, region and element", () => {
    const count = (kind: string) =>
      graph.nodes.filter((n) => n.kind === kind).length;
    expect(count("feature")).toBe(3);
    expect(count("persona")).toBe(2);
    expect(count("usecase")).toBe(6);
    expect(count("rule")).toBe(15);
    expect(count("scenario")).toBe(9);
    expect(count("screen")).toBe(3);
    expect(count("region")).toBe(7);
    expect(count("element")).toBe(16);
    expect(graph.nodes).toHaveLength(61);
    expect(nodeIds.size).toBe(graph.nodes.length); // unique ids
  });

  it("creates every edge kind with the expected counts and no dangling edges", () => {
    const count = (kind: GraphEdgeKind) =>
      graph.edges.filter((e) => e.kind === kind).length;
    expect(count("groups")).toBe(6);
    expect(count("performed_by")).toBe(6);
    expect(count("appears_on")).toBe(7);
    expect(count("covers")).toBe(14);
    expect(count("depends_on")).toBe(4);
    expect(count("contains")).toBe(15 + 9 + 7 + 16);
    expect(count("governs")).toBe(15);
    expect(count("exercises")).toBe(14);
    expect(count("navigates_to")).toBe(4);
    for (const e of graph.edges) {
      expect(nodeIds.has(e.from), `${e.id} from`).toBe(true);
      expect(nodeIds.has(e.to), `${e.id} to`).toBe(true);
      expect(e.id).toBe(`e-${e.kind}-${e.from}-${e.to}`);
    }
    expect(new Set(graph.edges.map((e) => e.id)).size).toBe(graph.edges.length);
  });

  it("uses readable labels and display metadata", () => {
    const uc = graph.nodes.find((n) => n.id === "UC-001")!;
    expect(uc.label).toBe("UC-001 · Sign in with email and password");
    expect(uc.meta).toMatchObject({
      status: "generated",
      size: "M",
      ruleCount: 4,
      scenarioCount: 3,
      feature: "Authentication",
      leadsTo: ["UC-003", "UC-004"],
    });
    const email = graph.nodes.find((n) => n.id === "login.email")!;
    expect(email.label).toBe("Email address (email input)");
    expect(email.meta).toMatchObject({
      type: "email_input",
      screen: "Login",
      region: "Sign-in form",
      covered: true,
      useCaseIds: ["UC-001", "UC-002"],
    });
    const logo = graph.nodes.find((n) => n.id === "login.logo")!;
    expect(logo.label).toBe("Logo (logo)"); // unlabeled → humanised key
    expect(logo.meta?.covered).toBe(false);
    expect(graph.nodes.find((n) => n.id === "UC-001/BR-02")!.label).toBe(
      "BR-02 · Password",
    );
    expect(
      graph.nodes.find((n) => n.id === "UC-005/SC-02")!.meta,
    ).toMatchObject({ type: "alternate", useCaseId: "UC-005" });
  });

  it("keeps element ids and suffixes a region whose id clashes with an element id", () => {
    expect(nodeIds.has("orders.table")).toBe(true);
    expect(graph.nodes.find((n) => n.id === "orders.table")!.kind).toBe(
      "element",
    );
    expect(graph.nodes.find((n) => n.id === "orders.table#region")!.kind).toBe(
      "region",
    );
    expect(
      graph.edges.some(
        (e) =>
          e.kind === "contains" &&
          e.from === "orders.table#region" &&
          e.to === "orders.table",
      ),
    ).toBe(true);
  });

  it("links flows and navigation elements to screens", () => {
    expect(
      graph.edges.find((e) => e.id === "e-navigates_to-scr_login-scr_dash")
        ?.label,
    ).toBe("Click 'Sign in'");
    expect(
      graph.edges.some((e) => e.id === "e-navigates_to-login.sign_in-scr_dash"),
    ).toBe(true);
  });

  it("drops references to things that do not exist", () => {
    const m = fixtureModel();
    m.useCases[0].elementIds.push("login.ghost");
    m.useCases[0].dependsOn.push("UC-404");
    m.flows.push({
      id: "flow-9",
      fromScreenId: "scr_login",
      toScreenId: "scr_gone",
      trigger: "x",
    });
    const g = buildGraph(m);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
    expect(
      g.edges.some(
        (e) =>
          e.to === "login.ghost" || e.to === "UC-404" || e.to === "scr_gone",
      ),
    ).toBe(false);
  });

  it("returns an empty graph for an empty model", () => {
    const m = fixtureModel();
    Object.assign(m, {
      screens: [],
      useCases: [],
      features: [],
      personas: [],
      flows: [],
    });
    expect(buildGraph(m)).toEqual({ nodes: [], edges: [] });
  });
});

describe("traceImpact", () => {
  it("traces a feature to its member use cases and refuses an unknown feature", () => {
    const m = fixtureModel(),
      feature = m.features[0];
    const result = traceImpact(
      m,
      change({ targetKind: "feature", targetId: feature.id }),
    );
    expect(result.directUseCaseIds).toEqual(
      m.useCases.filter((u) => u.featureId === feature.id).map((u) => u.id),
    );
    expect(() =>
      traceImpact(m, change({ targetKind: "feature", targetId: "missing" })),
    ).toThrow("not");
  });
  const model = fixtureModel();

  it("element: covering use cases are direct, dependents downstream, sharers related", () => {
    const t = traceImpact(
      model,
      change({ targetKind: "element", targetId: "login.password" }),
    );
    expect(buckets(t)).toEqual({
      direct: ["UC-001"],
      downstream: ["UC-003", "UC-004", "UC-005", "UC-006"],
      upstream: [],
      related: ["UC-002"],
    });
    expect(t.seedNodeIds).toEqual(["login.password"]);
    expect(t.affectedElementIds).toEqual(["login.password"]);
    expect(t.affectedScreenIds).toEqual(["scr_login"]);
    expect(pathOf(t, "UC-001")).toEqual(["login.password", "UC-001"]);
    expect(pathOf(t, "UC-006")).toEqual([
      "login.password",
      "UC-001",
      "UC-003",
      "UC-005",
      "UC-006",
    ]);
    expect(pathOf(t, "UC-002")).toEqual([
      "login.password",
      "UC-001",
      "login.email",
      "UC-002",
    ]);
  });

  it("element covered only through a rule still makes that use case direct", () => {
    const t = traceImpact(
      model,
      change({ targetKind: "element", targetId: "login.email" }),
    );
    expect(t.directUseCaseIds).toEqual(["UC-001", "UC-002"]);
  });

  it("precedence: a use case is listed once, in the strongest bucket", () => {
    const t = traceImpact(
      model,
      change({ targetKind: "element", targetId: "orders.status" }),
    );
    // UC-003 shares the Orders screen (related) but is also a dependency (upstream) → upstream wins.
    expect(buckets(t)).toEqual({
      direct: ["UC-005"],
      downstream: ["UC-006"],
      upstream: ["UC-003"],
      related: [],
    });
    const all = [
      ...t.directUseCaseIds,
      ...t.downstreamUseCaseIds,
      ...t.upstreamUseCaseIds,
      ...t.relatedUseCaseIds,
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(t.paths.map((p) => p.useCaseId)).toEqual([
      "UC-005",
      "UC-006",
      "UC-003",
    ]);
    expect(pathOf(t, "UC-003")).toEqual(["orders.status", "UC-005", "UC-003"]);
  });

  it("screen: every use case appearing on it is direct", () => {
    const t = traceImpact(
      model,
      change({ targetKind: "screen", targetId: "scr_dash" }),
    );
    expect(buckets(t)).toEqual({
      direct: ["UC-003", "UC-004"],
      downstream: ["UC-005", "UC-006"],
      upstream: ["UC-001"],
      related: [],
    });
    expect(pathOf(t, "UC-004")).toEqual(["scr_dash", "UC-004"]);
    // screen keys are accepted too
    expect(
      traceImpact(
        model,
        change({ targetKind: "screen", targetId: "dashboard" }),
      ).directUseCaseIds,
    ).toEqual(["UC-003", "UC-004"]);
  });

  it("screen with a diff: only use cases touching what changed are direct", () => {
    const before = model.screens[0];
    const diff: ScreenDiff = {
      screenId: "scr_login",
      fromVersion: 1,
      toVersion: 2,
      added: [
        {
          ...before.elements[0],
          id: "login.google",
          key: "google",
          type: "button",
          label: "Sign in with Google",
          regionId: "login.form",
        },
      ],
      removed: [before.elements.find((e) => e.id === "login.remember_me")!],
      modified: [],
      summary: "Login changed",
    };
    const t = traceImpact(
      model,
      change({
        targetKind: "screen",
        targetId: "scr_login",
        source: "screen-replace",
        screenDiff: diff,
      }),
    );
    expect(t.directUseCaseIds).toEqual(["UC-001"]); // removed remember_me + owner of the form region
    expect(t.relatedUseCaseIds).toEqual(["UC-002"]);
    expect(t.seedNodeIds).toEqual(["scr_login", "login.remember_me"]);
    expect(t.affectedElementIds).toEqual(["login.remember_me"]);
    expect(pathOf(t, "UC-001")).toEqual(["login.remember_me", "UC-001"]);

    const empty = traceImpact(
      model,
      change({
        targetKind: "screen",
        targetId: "scr_login",
        source: "screen-replace",
        screenDiff: { ...diff, added: [], removed: [] },
      }),
    );
    expect(buckets(empty)).toEqual({
      direct: [],
      downstream: [],
      upstream: [],
      related: ["UC-001", "UC-002"],
    });
  });

  it("region: use cases listing the region or covering its elements", () => {
    const t = traceImpact(
      model,
      change({ targetKind: "region", targetId: "login.form" }),
    );
    expect(t.directUseCaseIds).toEqual(["UC-001", "UC-002"]);
    expect(t.affectedElementIds).toEqual([
      "login.email",
      "login.password",
      "login.remember_me",
      "login.sign_in",
      "login.forgot",
    ]);
    const clash = traceImpact(
      model,
      change({ targetKind: "region", targetId: "orders.table" }),
    );
    expect(clash.seedNodeIds).toEqual(["orders.table#region"]);
    expect(buckets(clash)).toEqual({
      direct: ["UC-005", "UC-006"],
      downstream: [],
      upstream: ["UC-003"],
      related: [],
    });
  });

  it("usecase: the use case is direct; sharers of its screens are related", () => {
    const t = traceImpact(
      model,
      change({ targetKind: "usecase", targetId: "UC-003" }),
    );
    expect(buckets(t)).toEqual({
      direct: ["UC-003"],
      downstream: ["UC-005", "UC-006"],
      upstream: ["UC-001"],
      related: ["UC-004"],
    });
    expect(pathOf(t, "UC-001")).toEqual(["UC-003", "UC-001"]);
    expect(
      traceImpact(model, change({ targetKind: "usecase", targetId: "uc-3" }))
        .directUseCaseIds,
    ).toEqual(["UC-003"]);
  });

  it("rule and scenario: namespaced ids, tolerant of id formatting", () => {
    const r = traceImpact(
      model,
      change({ targetKind: "rule", targetId: "UC-001/BR-2" }),
    );
    expect(r.seedNodeIds).toEqual(["UC-001/BR-02"]);
    expect(r.directUseCaseIds).toEqual(["UC-001"]);
    expect(r.affectedElementIds).toEqual(["login.password"]);
    expect(pathOf(r, "UC-001")).toEqual(["UC-001/BR-02", "UC-001"]);

    const s = traceImpact(
      model,
      change({ targetKind: "scenario", targetId: "UC-005/SC-02" }),
    );
    expect(s.seedNodeIds).toEqual(["UC-005/SC-02"]);
    expect(buckets(s)).toEqual({
      direct: ["UC-005"],
      downstream: ["UC-006"],
      upstream: ["UC-003"],
      related: [],
    });
    expect(s.affectedElementIds).toEqual(["orders.status"]);
  });

  it("persona: use cases performed by the persona", () => {
    const t = traceImpact(
      model,
      change({ targetKind: "persona", targetId: "persona-ops" }),
    );
    expect(buckets(t)).toEqual({
      direct: ["UC-005", "UC-006"],
      downstream: [],
      upstream: ["UC-003"],
      related: [],
    });
    expect(pathOf(t, "UC-005")).toEqual(["persona-ops", "UC-005"]);
  });

  it("free text: keyword match over labels, titles and rule text, ignoring stop words", () => {
    const t = traceImpact(
      model,
      change({
        targetKind: "free",
        description: "The password must be at least 12 characters",
      }),
    );
    expect(t.directUseCaseIds).toContain("UC-001");
    expect(t.seedNodeIds).toContain("login.password");
    expect(t.seedNodeIds).toContain("UC-001/BR-02");
    expect(t.affectedElementIds).toContain("login.password");
    expect(t.downstreamUseCaseIds).toEqual([
      "UC-003",
      "UC-004",
      "UC-005",
      "UC-006",
    ]);

    const exportCsv = traceImpact(
      model,
      change({
        targetKind: "free",
        description: "Export should also offer EXCEL besides csv",
      }),
    );
    expect(exportCsv.directUseCaseIds).toEqual(["UC-006"]);

    const explicit = traceImpact(
      model,
      change({ targetKind: "free", description: "See UC-4 and orders.status" }),
    );
    expect(explicit.directUseCaseIds).toEqual(["UC-004", "UC-005"]);

    const nothing = traceImpact(
      model,
      change({ targetKind: "free", description: "Add a dark mode theme" }),
    );
    expect(buckets(nothing)).toEqual({
      direct: [],
      downstream: [],
      upstream: [],
      related: [],
    });
    expect(nothing.seedNodeIds).toEqual([]);
  });

  it("free-text matching is case-insensitive and stem-tolerant", () => {
    const ix = indexModel(model);
    expect(matchFreeText(ix, "SEARCH ORDERS by date").elementIds).toContain(
      "orders.search",
    );
    expect(matchFreeText(ix, "statuses filter").elementIds).toContain(
      "orders.status",
    );
  });

  it("md-edit: the edited use case is direct and its dependents downstream", () => {
    const t = traceImpact(
      model,
      change({
        targetKind: "usecase",
        targetId: "UC-001",
        source: "md-edit",
        useCaseDiff: {
          useCaseId: "UC-001",
          changedSections: ["postconditions"],
          summary: "Postconditions changed",
          details: [],
        },
      }),
    );
    expect(buckets(t)).toEqual({
      direct: ["UC-001"],
      downstream: ["UC-003", "UC-004", "UC-005", "UC-006"],
      upstream: [],
      related: ["UC-002"],
    });
    expect(t.affectedElementIds).toEqual([]); // only the chain changed
    const rules = traceImpact(
      model,
      change({
        targetKind: "free",
        source: "md-edit",
        useCaseDiff: {
          useCaseId: "UC-005",
          changedSections: ["rules"],
          summary: "BR-02 options",
          details: [],
        },
      }),
    );
    expect(rules.directUseCaseIds).toEqual(["UC-005"]);
    expect(rules.affectedElementIds).toEqual([
      "orders.search",
      "orders.status",
      "orders.table",
    ]);
  });

  it("rejects targets that are not in the model with a readable error", () => {
    expect(() =>
      traceImpact(
        model,
        change({ targetKind: "element", targetId: "login.nope" }),
      ),
    ).toThrow(BadRequestError);
    expect(() =>
      traceImpact(model, change({ targetKind: "rule", targetId: "BR-02" })),
    ).toThrow(/UC-003\/BR-02/);
    expect(() => traceImpact(model, change({ targetKind: "usecase" }))).toThrow(
      /Choose the use case/,
    );
  });

  it("is deterministic", () => {
    const c = change({ targetKind: "screen", targetId: "scr_orders" });
    expect(traceImpact(model, c)).toEqual(traceImpact(fixtureModel(), c));
  });
});
