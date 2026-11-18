import { describe, expect, it } from "vitest";
import {
  assignScreenKeys,
  composeId,
  isShellRegion,
  screenKeyFor,
  toBounds,
  toScreenAnalysis,
} from "./ids";
import type { AnalysedElement, ScreenAnalysisOutput } from "./schemas";
import { analysis, screen } from "./testFixtures";

function el(
  key: string,
  regionKey: string,
  extra: Partial<AnalysedElement> = {},
): AnalysedElement {
  return {
    key,
    regionKey,
    type: "button",
    label: key,
    description: "",
    placeholder: "",
    defaultValue: "",
    helperText: "",
    options: [],
    required: "unknown",
    validation: [],
    states: [],
    behavior: "",
    navigatesToScreenId: "",
    navigatesToHint: "",
    dataBinding: "",
    inferred: [],
    bounds: { x: -1, y: -1, width: -1, height: -1 },
    ...extra,
  };
}

function raw(
  elements: AnalysedElement[],
  regions = [{ key: "form", name: "Sign-in form", purpose: "", layout: "" }],
): ScreenAnalysisOutput {
  return {
    title: "Login",
    purpose: "",
    screenType: "auth",
    personas: [],
    regions,
    elements,
    dataEntities: [],
    openQuestions: [],
  };
}

const login = screen("scr_login", "Login", 0);

describe("id composition", () => {
  it('composes "<screenKey>.<elementKey>" and de-duplicates keys with a suffix', () => {
    const { analysis: a, repairs } = toScreenAnalysis({
      raw: raw([
        el("Sign in", "form"),
        el("sign_in", "form"),
        el("", "form", { label: "Email address", type: "email_input" }),
      ]),
      screen: login,
      version: 1,
      screenKey: "login",
      validScreenIds: ["scr_login", "scr_dash"],
    });
    expect(a.elements.map((e) => e.id)).toEqual([
      "login.sign_in",
      "login.sign_in_2",
      "login.email_address",
    ]);
    expect(composeId("login", "email")).toBe("login.email");
    expect(repairs.some((r) => r.includes("sign_in_2"))).toBe(true);
    expect(a.regions[0].elementIds).toEqual(a.elements.map((e) => e.id));
  });

  it('puts elements with an unknown region into a fallback "main" region', () => {
    const { analysis: a } = toScreenAnalysis({
      raw: raw([el("ok", "form"), el("lost", "nowhere")]),
      screen: login,
      version: 1,
      screenKey: "login",
      validScreenIds: ["scr_login"],
    });
    const lost = a.elements.find((e) => e.key === "lost")!;
    expect(lost.regionId).toBe("login.main");
    expect(a.regions.map((r) => r.id)).toEqual(["login.form", "login.main"]);
  });

  it("validates navigation targets against real screen ids (names are rescued, unknown become hints)", () => {
    const { analysis: a } = toScreenAnalysis({
      raw: raw([
        el("a", "form", { navigatesToScreenId: "scr_dash" }),
        el("b", "form", { navigatesToScreenId: "Dashboard" }),
        el("c", "form", { navigatesToScreenId: "scr_nope" }),
        el("d", "form", { navigatesToScreenId: "scr_login" }),
      ]),
      screen: login,
      version: 1,
      screenKey: "login",
      validScreenIds: ["scr_login", "scr_dash"],
      screenIdByName: new Map([
        ["dashboard", "scr_dash"],
        ["login", "scr_login"],
      ]),
    });
    const [a1, b1, c1, d1] = a.elements;
    expect(a1.navigatesToScreenId).toBe("scr_dash");
    expect(b1.navigatesToScreenId).toBe("scr_dash");
    expect(c1.navigatesToScreenId).toBeUndefined();
    expect(c1.navigatesToHint).toBe("scr_nope");
    expect(d1.navigatesToScreenId).toBeUndefined();
  });

  it('turns "" / [] / -1 into absent fields and keeps facts', () => {
    const { analysis: a } = toScreenAnalysis({
      raw: raw([
        el("country", "form", {
          type: "dropdown",
          options: ["Australia", " New Zealand ", ""],
          required: "yes",
          defaultValue: "Australia",
          bounds: { x: 10, y: 95, width: 20, height: 10 },
        }),
      ]),
      screen: login,
      version: 1,
      screenKey: "login",
      validScreenIds: ["scr_login"],
    });
    const e = a.elements[0];
    expect(e.options).toEqual(["Australia", "New Zealand"]);
    expect(e.required).toBe(true);
    expect(e.placeholder).toBeUndefined();
    expect(e.bounds).toEqual({ x: 10, y: 95, width: 20, height: 5 });
  });

  it("converts bounds: -1 means unknown, values are clamped to the image", () => {
    expect(toBounds({ x: -1, y: -1, width: -1, height: -1 })).toBeUndefined();
    expect(toBounds({ x: 50, y: 50, width: 0, height: 10 })).toBeUndefined();
    expect(toBounds({ x: 90, y: 10, width: 30, height: 5 })).toEqual({
      x: 90,
      y: 10,
      width: 10,
      height: 5,
    });
  });

  it("keeps screen keys stable across generations and unique across screens", () => {
    const orders1 = screen("scr_o1", "Orders", 0);
    const orders2 = screen("scr_o2", "Orders", 1);
    const keys = assignScreenKeys([orders1, orders2], []);
    expect([...keys.values()]).toEqual(["orders", "orders-2"]);
    const renamed = { ...orders2, name: "Order list" };
    const again = assignScreenKeys(
      [orders1, renamed],
      [analysis("scr_o2", "orders-2", [])],
    );
    expect(again.get("scr_o2")).toBe("orders-2");
    expect(screenKeyFor(screen("scr_x", "Login", 2), ["login"])).toBe(
      "login-2",
    );
  });

  it("recognises the application shell but not page headers", () => {
    expect(isShellRegion({ key: "header", name: "Header" })).toBe(true);
    expect(isShellRegion({ key: "side_nav", name: "Side navigation" })).toBe(
      true,
    );
    expect(isShellRegion({ key: "footer", name: "Footer" })).toBe(true);
    expect(isShellRegion({ key: "page_header", name: "Page header" })).toBe(
      false,
    );
    expect(isShellRegion({ key: "table_header", name: "Table header" })).toBe(
      false,
    );
    expect(isShellRegion({ key: "orders_table", name: "Orders table" })).toBe(
      false,
    );
  });
});
