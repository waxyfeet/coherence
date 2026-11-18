import { describe, expect, it } from "vitest";
import type { ScreenAnalysis, UIElement } from "@shared/types";
import { diffScreenAnalyses, diffScreenAnalysesWith } from "./screenDiff";
import { fixtureModel } from "./testFixtures";
import { labelSimilarity, levenshtein, levenshteinRatio } from "./text";

const model = fixtureModel();
const login = (): ScreenAnalysis => structuredClone(model.screens[0]);
const orders = (): ScreenAnalysis => structuredClone(model.screens[2]);

/** Re-key an analysis the way a fresh Screen Analyst run would (different screen key, own ids). */
function reKeyed(
  a: ScreenAnalysis,
  screenKey: string,
  version = 2,
): ScreenAnalysis {
  const swap = (id: string) =>
    `${screenKey}.${id.split(".").slice(1).join(".")}`;
  return {
    ...a,
    screenKey,
    screenVersion: version,
    regions: a.regions.map((r) => ({
      ...r,
      id: swap(r.id),
      elementIds: r.elementIds.map(swap),
    })),
    elements: a.elements.map((e) => ({
      ...e,
      id: swap(e.id),
      regionId: swap(e.regionId),
    })),
  };
}

function find(a: ScreenAnalysis, key: string): UIElement {
  return a.elements.find((e) => e.key === key)!;
}

describe("text similarity helpers", () => {
  it("computes edit distance and ratios", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshteinRatio("Sign in", "Sign-in")).toBe(1);
    expect(labelSimilarity("Email address", "Address (email)")).toBe(1);
    expect(labelSimilarity("Sign in now", "Sign in")).toBeGreaterThanOrEqual(
      0.6,
    );
    expect(labelSimilarity("Export CSV", "Search orders")).toBeLessThan(0.6);
  });
});

describe("diffScreenAnalyses", () => {
  it("reports no changes for an identical re-analysis and keeps every id", () => {
    const before = login();
    const { diff, remapped } = diffScreenAnalyses(
      before,
      reKeyed(before, "sign_in_page"),
    );
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.fromVersion).toBe(1);
    expect(diff.toVersion).toBe(2);
    expect(diff.summary).toMatch(
      /^No functional changes detected on Login \(version 1 → 2\)/,
    );
    expect(remapped.screenKey).toBe("login");
    expect(remapped.elements.map((e) => e.id)).toEqual(
      before.elements.map((e) => e.id),
    );
    expect(remapped.regions.map((r) => r.id)).toEqual(
      before.regions.map((r) => r.id),
    );
    expect(remapped.screenVersion).toBe(2);
  });

  it("matches by key, then (type, label), then fuzzy label within the region; remaps onto old ids", () => {
    const before = login();
    const after = reKeyed(before, "signin");
    // 1. same key, new label → modified (label)
    find(after, "password").label = "Your password";
    // 2. new key, same type + label → matched by (type, label)
    Object.assign(find(after, "email"), {
      key: "email_address",
      id: "signin.email_address",
    });
    after.regions[0].elementIds = after.regions[0].elementIds.map((id) =>
      id === "signin.email" ? "signin.email_address" : id,
    );
    // 3. new key and slightly different label, same region → fuzzy match
    Object.assign(find(after, "sign_in"), {
      key: "submit",
      id: "signin.submit",
      label: "Sign in now",
    });
    after.regions[0].elementIds = after.regions[0].elementIds.map((id) =>
      id === "signin.sign_in" ? "signin.submit" : id,
    );
    // removed
    after.elements = after.elements.filter((e) => e.key !== "remember_me");
    after.regions[0].elementIds = after.regions[0].elementIds.filter(
      (id) => id !== "signin.remember_me",
    );
    // added, in a brand-new region
    after.regions.push({
      id: "signin.social",
      key: "social",
      screenId: before.screenId,
      name: "Social sign-in",
      purpose: "",
      layout: "row",
      elementIds: ["signin.google"],
    });
    after.elements.push({
      id: "signin.google",
      key: "google",
      screenId: before.screenId,
      regionId: "signin.social",
      type: "button",
      label: "Sign in with Google",
      description: "Google button",
      inferred: [],
    });

    const { diff, remapped } = diffScreenAnalyses(before, after);
    expect(diff.removed.map((e) => e.id)).toEqual(["login.remember_me"]);
    expect(diff.added.map((e) => [e.id, e.key, e.regionId])).toEqual([
      ["login.google", "google", "login.social"],
    ]);
    const modified = new Map(
      diff.modified.map((m) => [m.before.id, m.changes]),
    );
    expect([...modified.keys()].sort()).toEqual([
      "login.password",
      "login.sign_in",
    ]);
    expect(modified.get("login.password")).toEqual([
      "label: 'Password' → 'Your password'",
    ]);
    expect(modified.get("login.sign_in")).toEqual([
      "label: 'Sign in' → 'Sign in now'",
    ]);

    // remapped analysis keeps old ids/keys for matched elements and regions
    expect(remapped.screenKey).toBe("login");
    expect(remapped.elements.map((e) => e.id)).toEqual([
      "login.email",
      "login.password",
      "login.sign_in",
      "login.forgot",
      "login.logo",
      "login.heading",
      "login.google",
    ]);
    expect(find(remapped, "email").id).toBe("login.email");
    expect(remapped.regions.map((r) => r.id)).toEqual([
      "login.form",
      "login.brand",
      "login.social",
    ]);
    expect(remapped.regions[0].elementIds).toEqual([
      "login.email",
      "login.password",
      "login.sign_in",
      "login.forgot",
    ]);
    expect(
      remapped.elements.every((e) =>
        remapped.regions.some((r) => r.id === e.regionId),
      ),
    ).toBe(true);

    expect(diff.summary).toContain(
      "1 element added (“Sign in with Google” button)",
    );
    expect(diff.summary).toContain("1 removed (“Remember me” checkbox)");
    expect(diff.summary).toContain("2 modified");
    expect(diff.summary).toContain("New region “Social sign-in”");
  });

  it("describes field-level changes: type, options, validation, required, placeholder, behaviour, navigation, position", () => {
    const before = orders();
    before.elements.find((e) => e.key === "export")!.navigatesToScreenId =
      "scr_dash";
    const after = reKeyed(before, "orders");
    Object.assign(find(after, "status"), {
      options: ["All", "Open", "Shipped", "Returned"],
      required: true,
      validation: ["Must pick one"],
      type: "combobox",
    });
    Object.assign(find(after, "search"), {
      placeholder: "Search by anything",
      behavior: "Filters the table as you type",
    });
    Object.assign(find(after, "export"), {
      navigatesToScreenId: "scr_login",
      regionId: "orders.filters",
    });

    const { diff } = diffScreenAnalysesWith(before, after, {
      screenName: (id) => ({ scr_dash: "Dashboard", scr_login: "Login" })[id],
    });
    const changes = new Map(diff.modified.map((m) => [m.before.id, m.changes]));
    expect(changes.get("orders.status")).toEqual([
      "type: dropdown → combobox",
      "options: added 'Returned'",
      "options: removed 'Cancelled'",
      "validation: added 'Must pick one'",
      "required: no → yes",
    ]);
    expect(changes.get("orders.search")).toEqual([
      "placeholder: 'Order number or customer' → 'Search by anything'",
      "behaviour: (none) → 'Filters the table as you type'",
    ]);
    expect(changes.get("orders.export")).toEqual([
      "moved from region 'Orders table' to 'Filters'",
      "navigates to: Dashboard → Login",
    ]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("ignores re-worded prose and re-ordered validation wording when the meaning is the same", () => {
    const before = login();
    find(before, "sign_in").behavior =
      "Submits the credentials and opens the dashboard";
    const after = reKeyed(before, "login");
    find(after, "sign_in").behavior =
      "Opens the dashboard and submits the credentials.";
    find(after, "email").validation = [
      "valid email address",
      "Max 254 characters.",
    ];
    expect(diffScreenAnalyses(before, after).diff.modified).toEqual([]);
  });

  it("flags option re-ordering", () => {
    const before = orders();
    const after = reKeyed(before, "orders");
    find(after, "status").options = ["Open", "All", "Shipped", "Cancelled"];
    expect(diffScreenAnalyses(before, after).diff.modified[0].changes).toEqual([
      "options: reordered",
    ]);
  });

  it("matches regions by name when their key changed and gives new elements unique ids", () => {
    const before = orders();
    const after = reKeyed(before, "orders");
    after.regions[1] = {
      ...after.regions[1],
      id: "orders.filter_bar",
      key: "filter_bar",
    };
    for (const e of after.elements)
      if (e.regionId === "orders.filters") e.regionId = "orders.filter_bar";
    // a duplicate key from the analyst: the second "search" is new and must not reuse an existing id
    after.elements.push({
      ...find(after, "search"),
      id: "orders.search#2",
      label: "Search customers",
      type: "text_input",
    });
    after.regions[1].elementIds.push("orders.search#2");

    const { diff, remapped } = diffScreenAnalyses(before, after);
    expect(remapped.regions[1].id).toBe("orders.filters");
    expect(diff.added.map((e) => e.id)).toEqual(["orders.search_2"]);
    expect(diff.added[0].regionId).toBe("orders.filters");
    expect(remapped.regions[1].elementIds).toContain("orders.search_2");
    expect(new Set(remapped.elements.map((e) => e.id)).size).toBe(
      remapped.elements.length,
    );
  });

  it("does not fuzzy-match across regions", () => {
    const before = login();
    const after = reKeyed(before, "login");
    // "Welcome back" heading moves to the form region with a new key and a similar label → not fuzzy-matched
    Object.assign(find(after, "heading"), {
      key: "title",
      id: "login.title",
      label: "Welcome back!!",
      type: "text",
    });
    after.regions[1].elementIds = ["login.logo"];
    find(after, "title").regionId = "login.form";
    after.regions[0].elementIds.push("login.title");
    const { diff } = diffScreenAnalyses(before, after);
    expect(diff.removed.map((e) => e.id)).toEqual(["login.heading"]);
    expect(diff.added.map((e) => e.id)).toEqual(["login.title"]);
  });
});
