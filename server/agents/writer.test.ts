import { describe, expect, it } from "vitest";
import type { UIElement, UseCase } from "@shared/types";
import { indexElements } from "./ids";
import type { WriterOutput } from "./schemas";
import { analysis, model, screen, useCase } from "./testFixtures";
import {
  assignItemIds,
  compactRepeatedRules,
  finaliseWriterOutput,
  useCaseElements,
  useCaseToWriterOutput,
} from "./writer";

const screens = [
  screen("scr_login", "Login", 0),
  screen("scr_dash", "Dashboard", 1),
];
const login = analysis("scr_login", "login", [
  {
    key: "email",
    type: "email_input",
    label: "Email address",
    region: "form",
    extra: { required: true, validation: ["Must be a valid email address"] },
  },
  {
    key: "password",
    type: "password_input",
    label: "Password",
    region: "form",
    extra: { required: true },
  },
  {
    key: "remember_me",
    type: "checkbox",
    label: "Remember me",
    region: "form",
  },
  { key: "sign_in", type: "button", label: "Sign in", region: "form" },
  { key: "help", type: "link", label: "Help", region: "footer" },
]);
const dash = analysis("scr_dash", "dashboard", [
  { key: "menu", type: "menu", label: "Anna Berg", region: "header" },
]);
const all = indexElements([login, dash]);
const stub = useCase("UC-001", {
  title: "Sign in with email and password",
  screenIds: ["scr_login"],
  elementIds: [
    "login.email",
    "login.password",
    "login.remember_me",
    "login.sign_in",
  ],
  preconditions: ["The user has opened the application"],
  postconditions: [
    "The user is signed in",
    "The Dashboard screen is displayed",
  ],
});
const elements = useCaseElements(stub, model([login, dash], [stub]));

function output(extra: Partial<WriterOutput> = {}): WriterOutput {
  return {
    title: "Log in",
    scope: "Sign-in form.",
    story: {
      asA: "As a sales rep",
      iWant: "I want to sign in.",
      soThat: "so that I can work",
    },
    preconditions: [
      "The user has opened the application",
      "The user has an active account",
    ],
    postconditions: ["The user is signed in"],
    businessRules: [
      {
        id: "BR-07",
        elementId: "login.sign_in",
        element: "Sign in",
        elementType: "button",
        description: "Primary button.",
        rules: ["Submits the form."],
      },
      {
        id: "BR-01",
        elementId: "login.email",
        element: "Email address",
        elementType: "text_input",
        description: "Email field.",
        rules: ["Mandatory.", "- Max 254 characters."],
      },
      {
        id: "BR-02",
        elementId: "login.email",
        element: "Email address",
        elementType: "email_input",
        description: "",
        rules: ["Trimmed."],
      },
      {
        id: "BR-03",
        elementId: "login.help",
        element: "Help",
        elementType: "link",
        description: "Owned elsewhere.",
        rules: ["Opens help."],
      },
      {
        id: "BR-04",
        elementId: "",
        element: "Password",
        elementType: "password_input",
        description: "Password field.",
        rules: ["Masked."],
      },
      {
        id: "BR-05",
        elementId: "",
        element: "Screen-level rules",
        elementType: "general",
        description: "",
        rules: ["Locks after 5 failed attempts."],
      },
    ],
    scenarios: [
      {
        id: "SC-02",
        title: "Bad email",
        type: "negative",
        given: ["Given the Login screen is displayed"],
        when: ['When the user enters "x" in "Email address"'],
        then: ["Then the inline error is shown"],
        elementIds: ["login.email", "nope.nothing"],
      },
      {
        id: "SC-01",
        title: "Happy",
        type: "happy",
        given: ["the user has an active account"],
        when: ['the user selects "Sign in"'],
        then: ["When checked, the session is kept for 30 days"],
        elementIds: ["login.sign_in"],
      },
      {
        id: "SC-03",
        title: "Empty",
        type: "edge",
        given: [],
        when: [],
        then: [],
        elementIds: [],
      },
    ],
    assumptions: [
      "Message wording is inferred.",
      "message wording is inferred",
    ],
    openQuestions: [],
    ...extra,
  };
}

function finalise(out: WriterOutput, revising = false, uc = stub) {
  return finaliseWriterOutput({
    useCase: uc,
    output: out,
    elements,
    allElements: all,
    regionNameOf: () => "Sign-in form",
    screens,
    revising,
    now: "2026-10-14T12:00:00.000Z",
  });
}

describe("finaliseWriterOutput", () => {
  it("keeps the planned pre/postconditions verbatim and first, appending extra ones", () => {
    const { useCase: uc } = finalise(output());
    expect(uc.preconditions).toEqual([
      "The user has opened the application",
      "The user has an active account",
    ]);
    expect(uc.postconditions).toEqual([
      "The user is signed in",
      "The Dashboard screen is displayed",
    ]);
    expect(uc.title).toBe("Sign in with email and password");
    expect(uc.story).toEqual({
      asA: "sales rep",
      iWant: "sign in",
      soThat: "I can work",
    });
  });

  it("gives every element exactly one rule: merges duplicates, drops other use cases' elements, fills omissions", () => {
    const { useCase: uc, addedRulesFor, notes } = finalise(output());
    const byElement = uc.businessRules
      .filter((r) => r.elementId)
      .map((r) => r.elementId);
    expect(byElement).toEqual([
      "login.email",
      "login.password",
      "login.remember_me",
      "login.sign_in",
    ]);
    expect(uc.businessRules.map((r) => r.id)).toEqual([
      "BR-01",
      "BR-02",
      "BR-03",
      "BR-04",
      "BR-05",
    ]);
    const email = uc.businessRules[0];
    expect(email.elementType).toBe("email_input");
    expect(email.rules).toEqual([
      "Mandatory.",
      "Max 254 characters.",
      "Trimmed.",
    ]);
    // "Password" had no id but matched the element label.
    expect(uc.businessRules[1].rules).toEqual(["Masked."]);
    expect(addedRulesFor).toEqual(["login.remember_me"]);
    expect(uc.businessRules[4]).toMatchObject({
      elementType: "general",
      rules: ["Locks after 5 failed attempts."],
    });
    expect(uc.businessRules.some((r) => r.elementId === "login.help")).toBe(
      false,
    );
    expect(notes.some((n) => n.includes("login.help"))).toBe(true);
    expect(uc.assumptions).toEqual(["Message wording is inferred."]);
  });

  it("cleans steps, puts one happy path first and chains it to the pre/postconditions", () => {
    const { useCase: uc } = finalise(output());
    expect(uc.scenarios.map((s) => `${s.id} ${s.type}`)).toEqual([
      "SC-01 happy",
      "SC-02 negative",
    ]);
    const [happy, negative] = uc.scenarios;
    expect(happy.given).toEqual([
      "the user has opened the application",
      "the user has an active account",
    ]);
    // A THEN line that legitimately starts with "When" keeps it; postconditions come last, verbatim.
    expect(happy.then).toEqual([
      "When checked, the session is kept for 30 days",
      "the user is signed in",
      "the Dashboard screen is displayed",
    ]);
    expect(negative.given).toEqual(["the Login screen is displayed"]);
    expect(negative.when).toEqual(['the user enters "x" in "Email address"']);
    expect(negative.elementIds).toEqual(["login.email"]);
  });

  it("keeps existing rule and scenario ids when revising and numbers new items after them", () => {
    const current = finalise(output()).useCase;
    const revised = useCaseToWriterOutput(current);
    revised.businessRules = revised.businessRules.filter(
      (r) => r.id !== "BR-02",
    );
    revised.businessRules.push({
      id: "",
      elementId: "",
      element: "Session",
      elementType: "general",
      description: "",
      rules: ["Expires after 8 hours."],
    });
    revised.scenarios.push({
      id: "SC-01",
      title: "Dup id",
      type: "edge",
      given: [],
      when: ["x"],
      then: ["y"],
      elementIds: [],
    });
    const { useCase: uc } = finalise(revised, true, current);
    expect(uc.businessRules.map((r) => `${r.id} ${r.element}`)).toEqual([
      "BR-01 Email address",
      "BR-03 Remember me",
      "BR-04 Sign in",
      "BR-05 Screen-level rules",
      "BR-06 Session",
      "BR-07 Password",
    ]);
    expect(uc.scenarios.map((s) => s.id)).toEqual(["SC-01", "SC-02", "SC-03"]);
  });

  it("promotes an alternate (never a negative) when no happy path is marked, and warns", () => {
    const scenarios: WriterOutput["scenarios"] = [
      {
        id: "SC-01",
        title: "Email left empty",
        type: "negative",
        given: [],
        when: [
          'the user leaves "Email address" empty',
          'the user selects "Sign in"',
        ],
        then: ['the inline error "Email address is required" is shown'],
        elementIds: [],
      },
      {
        id: "SC-02",
        title: "Sign in",
        type: "alternate",
        given: [],
        when: ['the user selects "Sign in"'],
        then: ["the Dashboard is shown"],
        elementIds: [],
      },
    ];
    const { useCase: uc, warnings } = finalise(output({ scenarios }));
    expect(uc.scenarios.map((s) => `${s.title}:${s.type}`)).toEqual([
      "Sign in:happy",
      "Email left empty:negative",
    ]);
    const negative = uc.scenarios[1];
    expect(negative.then).toEqual([
      'the inline error "Email address is required" is shown',
    ]);
    expect(warnings.join(" ")).toMatch(/alternate scenario "Sign in"/);
  });

  it("adds a happy path instead of relabelling a negative or edge scenario", () => {
    const scenarios: WriterOutput["scenarios"] = [
      {
        id: "SC-01",
        title: "Email left empty",
        type: "negative",
        given: [],
        when: ['the user leaves "Email address" empty'],
        then: ["the inline error is shown"],
        elementIds: [],
      },
      {
        id: "SC-02",
        title: "Double click",
        type: "edge",
        given: [],
        when: ['the user selects "Sign in" twice'],
        then: ["one request is sent"],
        elementIds: [],
      },
    ];
    const fromInventory = {
      id: "SC-01",
      title: "Inventory happy path",
      type: "happy" as const,
      given: [],
      when: ["the user enters valid credentials"],
      then: [],
      elementIds: [],
    };
    const run = (fallback?: () => (typeof fromInventory)[]) =>
      finaliseWriterOutput({
        useCase: stub,
        output: output({ scenarios }),
        elements,
        allElements: all,
        regionNameOf: () => "Sign-in form",
        screens,
        revising: false,
        fallbackScenarios: fallback,
      });

    const withInventory = run(() => [fromInventory]);
    expect(
      withInventory.useCase.scenarios.map(
        (s) => `${s.id} ${s.title}:${s.type}`,
      ),
    ).toEqual([
      "SC-01 Inventory happy path:happy",
      "SC-02 Email left empty:negative",
      "SC-03 Double click:edge",
    ]);
    expect(withInventory.useCase.scenarios[0].then).toEqual([
      "the user is signed in",
      "the Dashboard screen is displayed",
    ]);
    expect(withInventory.useCase.scenarios[1].then).toEqual([
      "the inline error is shown",
    ]);
    expect(withInventory.warnings).toHaveLength(1);

    const synthesised = run().useCase.scenarios[0];
    expect(synthesised).toMatchObject({
      type: "happy",
      title: "Sign in with email and password",
    });
    expect(synthesised.then).toEqual([
      "the user is signed in",
      "the Dashboard screen is displayed",
    ]);
  });

  it("keeps repeated WHEN steps (multi-step and repeated actions)", () => {
    const scenarios: WriterOutput["scenarios"] = [
      {
        id: "SC-01",
        title: "Two-step sign in",
        type: "happy",
        given: [],
        elementIds: [],
        when: [
          'the user enters "a@b.co" in "Email address"',
          'the user selects "Next"',
          "the user enters the password",
          'And the user selects "Next"',
        ],
        then: ["the user is signed in"],
      },
      {
        id: "SC-02",
        title: "Lockout",
        type: "negative",
        given: [],
        elementIds: [],
        when: Array.from({ length: 5 }, () => [
          "the user enters an incorrect password",
          'the user selects "Sign in"',
        ]).flat(),
        then: [
          "the account is locked for 15 minutes",
          "the account is locked for 15 minutes",
        ],
      },
    ];
    const { useCase: uc } = finalise(output({ scenarios }));
    expect(uc.scenarios[0].when).toEqual([
      'the user enters "a@b.co" in "Email address"',
      'the user selects "Next"',
      "the user enters the password",
      'the user selects "Next"',
    ]);
    expect(uc.scenarios[1].when).toHaveLength(10);
    // THEN lines are outcomes: a repeated one says nothing new.
    expect(uc.scenarios[1].then).toEqual([
      "the account is locked for 15 minutes",
    ]);
  });

  it("returns a new object and leaves the input untouched", () => {
    const before = JSON.stringify(stub);
    const { useCase: uc } = finalise(output());
    expect(uc).not.toBe(stub);
    expect(JSON.stringify(stub)).toBe(before);
    expect(uc.id).toBe("UC-001");
    expect(uc.updatedAt).toBe("2026-10-14T12:00:00.000Z");
  });
});

describe("BR/SC references written by the model", () => {
  const shellScreens = [
    screen("scr_dash", "Dashboard", 0),
    screen("scr_orders", "Orders", 1),
  ];
  const dashboard = analysis("scr_dash", "dashboard", [
    { key: "logo", type: "logo", label: "Acme Orders", region: "header" },
    {
      key: "nav_dashboard",
      type: "link",
      label: "Dashboard",
      region: "header",
      extra: { behavior: "Opens the Dashboard screen." },
    },
    {
      key: "nav_orders",
      type: "link",
      label: "Orders",
      region: "header",
      extra: { behavior: "Opens the Orders screen." },
    },
  ]);
  const orders = analysis("scr_orders", "orders", [
    {
      key: "nav_dashboard",
      type: "link",
      label: "Dashboard",
      region: "header",
      extra: { behavior: "Opens the Dashboard screen." },
    },
    {
      key: "nav_orders",
      type: "link",
      label: "Orders",
      region: "header",
      extra: { behavior: "Opens the Orders screen." },
    },
  ]);
  const shell = useCase("UC-003", {
    title: "Application shell & navigation",
    screenIds: ["scr_dash", "scr_orders"],
    elementIds: [
      "dashboard.logo",
      "dashboard.nav_dashboard",
      "dashboard.nav_orders",
      "orders.nav_dashboard",
      "orders.nav_orders",
    ],
    preconditions: ["The user is signed in"],
    postconditions: ["The main navigation is displayed"],
  });
  const shellAll = indexElements([dashboard, orders]);
  const shellElements = useCaseElements(
    shell,
    model([dashboard, orders], [shell]),
  );

  function link(
    id: string,
    elementId: string,
    label: string,
    rules: string[],
    description = `"${label}" link.`,
  ): WriterOutput["businessRules"][number] {
    return {
      id,
      elementId,
      element: label,
      elementType: "link",
      description,
      rules,
    };
  }

  function finaliseShell(
    businessRules: WriterOutput["businessRules"],
    extra: Partial<WriterOutput> = {},
  ) {
    return finaliseWriterOutput({
      useCase: shell,
      output: output({
        preconditions: [],
        postconditions: [],
        businessRules,
        assumptions: [],
        openQuestions: [],
        scenarios: [
          {
            id: "SC-01",
            title: "Navigate",
            type: "happy",
            given: [],
            when: ['the user selects "Orders"'],
            then: ["the Orders screen is displayed"],
            elementIds: [],
          },
        ],
        ...extra,
      }),
      elements: shellElements,
      allElements: shellAll,
      regionNameOf: () => "Header",
      screens: shellScreens,
      revising: false,
    }).useCase;
  }

  const byElement = (uc: UseCase) =>
    Object.fromEntries(uc.businessRules.map((r) => [r.elementId, r]));

  it("follows the renumbering when an omitted element is added and the rules are re-sorted", () => {
    // The model left out the logo, so every final id moves up by one.
    const uc = finaliseShell(
      [
        link("BR-01", "dashboard.nav_dashboard", "Dashboard", [
          "Opens the Dashboard screen.",
        ]),
        link("BR-02", "dashboard.nav_orders", "Orders", [
          "Opens the Orders screen.",
        ]),
        link(
          "BR-03",
          "orders.nav_dashboard",
          "Dashboard",
          ["Identical to BR-01."],
          "Same link as BR-01, shown on the Orders screen.",
        ),
        link(
          "BR-04",
          "orders.nav_orders",
          "Orders",
          ["Identical to BR-02."],
          "Same link as BR-02, shown on the Orders screen.",
        ),
      ],
      { assumptions: ["BR-04 follows BR-02; UC-001 BR-02 is unrelated."] },
    );
    const rules = byElement(uc);
    expect(rules["dashboard.logo"].id).toBe("BR-01");
    expect(rules["dashboard.nav_dashboard"].id).toBe("BR-02");
    expect(rules["dashboard.nav_orders"].id).toBe("BR-03");
    expect(rules["orders.nav_dashboard"]).toMatchObject({
      id: "BR-04",
      description: "Same link as BR-02, shown on the Orders screen.",
      rules: ["Identical to BR-02."],
    });
    expect(rules["orders.nav_orders"]).toMatchObject({
      id: "BR-05",
      description: "Same link as BR-03, shown on the Orders screen.",
      rules: ["Identical to BR-03."],
    });
    // Another use case's rule keeps its number.
    expect(uc.assumptions).toEqual([
      "BR-05 follows BR-03; UC-001 BR-02 is unrelated.",
    ]);
  });

  it("re-points a pointer at a different element, or rebuilds the rule when nothing matches", () => {
    const uc = finaliseShell([
      link("BR-01", "dashboard.logo", "Acme Orders", [
        "Visual element; not interactive.",
      ]),
      link("BR-02", "dashboard.nav_dashboard", "Dashboard", [
        "Opens the Dashboard screen.",
      ]),
      link("BR-03", "dashboard.nav_orders", "Orders", [
        "Opens the Orders screen.",
      ]),
      // Both point at the wrong element (the Dashboard link, the logo).
      link("BR-04", "orders.nav_orders", "Orders", [
        "Identical to BR-02.",
        "Highlighted on the Orders screen.",
      ]),
      link("BR-05", "orders.nav_dashboard", "Dashboard", [
        "Identical to BR-01.",
      ]),
    ]);
    const rules = byElement(uc);
    expect(rules["orders.nav_orders"].rules).toEqual([
      "Identical to BR-03.",
      "Highlighted on the Orders screen.",
    ]);
    expect(rules["orders.nav_dashboard"].rules).toEqual([
      "Identical to BR-02.",
    ]);

    // No other "Dashboard" link is described: the rule is rebuilt, the model's extra bullets kept.
    const els = new Map(shellElements.map((e) => [e.id, e]));
    const out = compactRepeatedRules(
      [
        {
          id: "BR-01",
          elementId: "dashboard.logo",
          element: "Acme Orders",
          elementType: "logo",
          description: "Logo.",
          rules: ["Visual element; not interactive."],
        },
        {
          id: "BR-02",
          elementId: "dashboard.nav_dashboard",
          element: "Dashboard",
          elementType: "link",
          description: "Same link as BR-01.",
          rules: ["Identical to BR-01.", "Bold when active."],
        },
      ],
      els,
      (id) => id,
      (r, e) => ({
        ...r,
        description: `Rebuilt ${e.label}.`,
        rules: [e.behavior ?? ""],
      }),
    );
    expect(out[1]).toMatchObject({
      id: "BR-02",
      description: "Rebuilt Dashboard.",
      rules: ["Opens the Dashboard screen.", "Bold when active."],
    });
  });
});

describe("rule helpers", () => {
  it("assigns BR/SC ids", () => {
    expect(
      assignItemIds([{ id: "x" }, { id: "y" }], "BR", false).map((i) => i.id),
    ).toEqual(["BR-01", "BR-02"]);
    expect(
      assignItemIds(
        [{ id: "SC-3" }, { id: "sc_03" }, { id: "" }],
        "SC",
        true,
      ).map((i) => i.id),
    ).toEqual(["SC-03", "SC-04", "SC-05"]);
  });

  it("points identical shell elements on other screens at the first description", () => {
    const els = new Map<string, UIElement>([
      ["dashboard.menu", { ...dash.elements[0] }],
      [
        "orders.menu",
        { ...dash.elements[0], id: "orders.menu", screenId: "scr_orders" },
      ],
      ["dashboard.menu_2", { ...dash.elements[0], id: "dashboard.menu_2" }],
    ]);
    const rule = {
      element: "Anna Berg",
      elementType: "menu" as const,
      description: "User menu.",
      rules: ['Menu items: "Sign out".'],
    };
    const out = compactRepeatedRules(
      [
        { id: "BR-01", elementId: "dashboard.menu", ...rule },
        { id: "BR-02", elementId: "orders.menu", ...rule },
        { id: "BR-03", elementId: "dashboard.menu_2", ...rule },
      ],
      els,
      (id) => (id === "scr_orders" ? "Orders" : "Dashboard"),
    );
    expect(out[1]).toMatchObject({
      description: "Same menu as BR-01, shown on the Orders screen.",
      rules: ["Identical to BR-01."],
    });
    expect(out[2].rules).toEqual(rule.rules);
  });

  it("keeps existing pointers on revision instead of chaining them", () => {
    const els = new Map<string, UIElement>([
      ["dashboard.menu", { ...dash.elements[0] }],
      [
        "orders.menu",
        { ...dash.elements[0], id: "orders.menu", screenId: "scr_orders" },
      ],
      [
        "new.menu",
        { ...dash.elements[0], id: "new.menu", screenId: "scr_new" },
      ],
    ]);
    const rule = {
      element: "Anna Berg",
      elementType: "menu" as const,
      description: "User menu.",
      rules: ['Menu items: "Sign out".'],
    };
    const pointer = {
      element: "Anna Berg",
      elementType: "menu" as const,
      rules: ["Identical to BR-01."],
    };
    const out = compactRepeatedRules(
      [
        { id: "BR-01", elementId: "dashboard.menu", ...rule },
        {
          id: "BR-02",
          elementId: "orders.menu",
          ...pointer,
          description: "Same menu as BR-01, shown on the Orders screen.",
        },
        {
          id: "BR-03",
          elementId: "new.menu",
          ...pointer,
          description: "Same menu as BR-01, shown on the New order screen.",
        },
      ],
      els,
      (id) => id,
    );
    expect(out[1].rules).toEqual(["Identical to BR-01."]);
    expect(out[2]).toMatchObject({
      description: "Same menu as BR-01, shown on the New order screen.",
      rules: ["Identical to BR-01."],
    });
  });
});
