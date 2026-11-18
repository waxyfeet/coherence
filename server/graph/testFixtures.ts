/**
 * OWNER: graph builder.
 * A small but realistic SolutionModel used by the graph/impact unit tests (not used at runtime):
 * Login → Dashboard → Orders, six chained use cases, a shared shell use case, an uncovered element pair,
 * and a deliberate region/element id clash ("orders.table").
 *
 * Chain: UC-001 → UC-003 → UC-005 → UC-006, UC-001 → UC-004; UC-002 is an entry point.
 */
import type {
  BddScenario,
  BusinessRule,
  ElementType,
  Project,
  ScreenAnalysis,
  ScreenRegion,
  SolutionModel,
  UIElement,
  UseCase,
} from "@shared/types";
import { DEFAULT_GENERATION_OPTIONS } from "@shared/types";

const AT = "2026-10-14T10:00:00.000Z";

function el(
  screenId: string,
  screenKey: string,
  key: string,
  regionKey: string,
  type: ElementType,
  label: string,
  extra: Partial<UIElement> = {},
): UIElement {
  return {
    id: `${screenKey}.${key}`,
    key,
    screenId,
    regionId: `${screenKey}.${regionKey}`,
    type,
    label,
    description: `${label || key} ${type.replace(/_/g, " ")}`,
    inferred: [],
    ...extra,
  };
}

function region(
  screenId: string,
  screenKey: string,
  key: string,
  name: string,
  elementKeys: string[],
): ScreenRegion {
  return {
    id: `${screenKey}.${key}`,
    key,
    screenId,
    name,
    purpose: `${name} area`,
    layout: "stacked",
    elementIds: elementKeys.map((k) => `${screenKey}.${k}`),
  };
}

function screen(
  screenId: string,
  screenKey: string,
  title: string,
  regions: ScreenRegion[],
  elements: UIElement[],
): ScreenAnalysis {
  return {
    screenId,
    screenVersion: 1,
    screenKey,
    title,
    purpose: `${title} screen`,
    screenType:
      screenKey === "login"
        ? "auth"
        : screenKey === "dashboard"
          ? "dashboard"
          : "list",
    personas: ["Registered customer"],
    regions,
    elements,
    dataEntities: [],
    openQuestions: [],
    analysedAt: AT,
  };
}

function rule(
  id: string,
  elementId: string | undefined,
  element: string,
  elementType: BusinessRule["elementType"],
  rules: string[],
): BusinessRule {
  return {
    id,
    ...(elementId ? { elementId } : {}),
    element,
    elementType,
    description: `${element} ${elementType}`,
    rules,
  };
}

function scenario(
  id: string,
  title: string,
  type: BddScenario["type"],
  elementIds: string[],
  given: string[],
  then: string[],
): BddScenario {
  return {
    id,
    title,
    type,
    given,
    when: [`the user uses ${title.toLowerCase()}`],
    then,
    elementIds,
  };
}

function useCase(
  partial: Partial<UseCase> & Pick<UseCase, "id" | "title" | "order">,
): UseCase {
  return {
    slug: partial.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    formatId: "use-case-bdd",
    featureId: "FEAT-01",
    personaId: "persona-customer",
    screenIds: [],
    regionIds: [],
    elementIds: [],
    dependsOn: [],
    size: "M",
    scope: `${partial.title}.`,
    story: {
      asA: "registered customer",
      iWant: partial.title.toLowerCase(),
      soThat: "I get my work done",
    },
    preconditions: [],
    postconditions: [],
    businessRules: [],
    scenarios: [],
    assumptions: [],
    openQuestions: [],
    notes: "",
    status: "generated",
    revision: 1,
    updatedAt: AT,
    external: [],
    filePath: `use-cases/${partial.id}.md`,
    ...partial,
  };
}

export function fixtureModel(): SolutionModel {
  const L = "scr_login";
  const D = "scr_dash";
  const O = "scr_orders";

  const login = screen(
    L,
    "login",
    "Login",
    [
      region(L, "login", "form", "Sign-in form", [
        "email",
        "password",
        "remember_me",
        "sign_in",
        "forgot",
      ]),
      region(L, "login", "brand", "Branding", ["logo", "heading"]),
    ],
    [
      el(L, "login", "email", "form", "email_input", "Email address", {
        required: true,
        placeholder: "you@company.com",
        validation: ["Valid email address", "Max 254 characters"],
      }),
      el(L, "login", "password", "form", "password_input", "Password", {
        required: true,
        validation: ["Minimum 8 characters"],
      }),
      el(L, "login", "remember_me", "form", "checkbox", "Remember me", {
        defaultValue: "unchecked",
      }),
      el(L, "login", "sign_in", "form", "button", "Sign in", {
        navigatesToScreenId: D,
        behavior: "Submits the credentials and opens the dashboard",
      }),
      el(L, "login", "forgot", "form", "link", "Forgot password?", {
        navigatesToHint: "Reset password page",
      }),
      el(L, "login", "logo", "brand", "logo", ""),
      el(L, "login", "heading", "brand", "heading", "Welcome back"),
    ],
  );

  const dashboard = screen(
    D,
    "dashboard",
    "Dashboard",
    [
      region(D, "dashboard", "nav", "Navigation", ["nav_bar", "sign_out"]),
      region(D, "dashboard", "summary", "Summary", [
        "orders_card",
        "revenue_chart",
      ]),
    ],
    [
      el(
        D,
        "dashboard",
        "nav_bar",
        "nav",
        "navigation_bar",
        "Main navigation",
        {
          options: ["Dashboard", "Orders", "Settings"],
          navigatesToScreenId: O,
        },
      ),
      el(D, "dashboard", "sign_out", "nav", "button", "Sign out"),
      el(D, "dashboard", "orders_card", "summary", "card", "Open orders"),
      el(D, "dashboard", "revenue_chart", "summary", "chart", "Revenue"),
    ],
  );

  const orders = screen(
    O,
    "orders",
    "Orders",
    [
      region(O, "orders", "nav", "Navigation", ["nav_bar"]),
      region(O, "orders", "filters", "Filters", ["search", "status"]),
      region(O, "orders", "table", "Orders table", ["table", "export"]),
    ],
    [
      el(O, "orders", "nav_bar", "nav", "navigation_bar", "Main navigation", {
        options: ["Dashboard", "Orders", "Settings"],
      }),
      el(O, "orders", "search", "filters", "search_input", "Search orders", {
        placeholder: "Order number or customer",
      }),
      el(O, "orders", "status", "filters", "dropdown", "Status", {
        options: ["All", "Open", "Shipped", "Cancelled"],
        defaultValue: "All",
      }),
      el(O, "orders", "table", "table", "table", "Orders", {
        options: ["Order #", "Customer", "Total", "Status"],
      }),
      el(O, "orders", "export", "table", "button", "Export CSV"),
    ],
  );

  const useCases: UseCase[] = [
    useCase({
      id: "UC-001",
      title: "Sign in with email and password",
      order: 1,
      screenIds: [L],
      regionIds: ["login.form"],
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
      businessRules: [
        rule("BR-01", "login.email", "Email address", "email_input", [
          "Mandatory",
          "Must be a valid email address, max 254 characters",
        ]),
        rule("BR-02", "login.password", "Password", "password_input", [
          "Mandatory",
          "Minimum 8 characters",
        ]),
        rule("BR-03", "login.remember_me", "Remember me", "checkbox", [
          "Unchecked by default",
        ]),
        rule("BR-04", "login.sign_in", "Sign in", "button", [
          "Disabled until both fields are filled",
        ]),
      ],
      scenarios: [
        scenario(
          "SC-01",
          "Successful sign-in",
          "happy",
          ["login.email", "login.password", "login.sign_in"],
          ["The user has opened the application"],
          ["The user is signed in", "The Dashboard screen is displayed"],
        ),
        scenario(
          "SC-02",
          "Invalid email format",
          "negative",
          ["login.email", "login.sign_in"],
          ["The Login screen is displayed"],
          ["An inline error is shown"],
        ),
        scenario(
          "SC-03",
          "Password too short",
          "negative",
          ["login.password"],
          ["The Login screen is displayed"],
          ['"Use at least 8 characters" is shown'],
        ),
      ],
    }),
    useCase({
      id: "UC-002",
      title: "Reset forgotten password",
      order: 2,
      screenIds: [L],
      regionIds: ["login.form"],
      elementIds: ["login.forgot"],
      preconditions: ["The user has opened the application"],
      postconditions: ["A reset link is sent"],
      businessRules: [
        rule("BR-01", "login.forgot", "Forgot password?", "link", [
          "Opens the reset password page",
        ]),
        rule("BR-02", "login.email", "Email address", "email_input", [
          "Prefilled from the sign-in form",
        ]),
      ],
      scenarios: [
        scenario(
          "SC-01",
          "Request reset link",
          "happy",
          ["login.forgot", "login.email"],
          ["The user has opened the application"],
          ["A reset link is sent"],
        ),
      ],
    }),
    useCase({
      id: "UC-003",
      title: "Application shell & navigation",
      order: 3,
      featureId: "FEAT-02",
      screenIds: [D, O],
      regionIds: ["dashboard.nav", "orders.nav"],
      elementIds: ["dashboard.nav_bar", "dashboard.sign_out", "orders.nav_bar"],
      dependsOn: ["UC-001"],
      preconditions: ["The user is signed in"],
      postconditions: ["The navigation bar is displayed"],
      businessRules: [
        rule(
          "BR-01",
          "dashboard.nav_bar",
          "Main navigation",
          "navigation_bar",
          ["Options: Dashboard, Orders, Settings"],
        ),
        rule("BR-02", "dashboard.sign_out", "Sign out", "button", [
          "Signs the user out",
        ]),
        rule("BR-03", "orders.nav_bar", "Main navigation", "navigation_bar", [
          "Same as the dashboard navigation",
        ]),
      ],
      scenarios: [
        scenario(
          "SC-01",
          "Navigate between screens",
          "happy",
          ["dashboard.nav_bar"],
          ["The user is signed in"],
          ["The navigation bar is displayed"],
        ),
      ],
    }),
    useCase({
      id: "UC-004",
      title: "View dashboard summary",
      order: 4,
      featureId: "FEAT-03",
      screenIds: [D],
      regionIds: ["dashboard.summary"],
      elementIds: ["dashboard.orders_card", "dashboard.revenue_chart"],
      dependsOn: ["UC-001"],
      preconditions: ["The user is signed in"],
      postconditions: ["The dashboard summary is displayed"],
      businessRules: [
        rule("BR-01", "dashboard.orders_card", "Open orders", "card", [
          "Shows the number of open orders",
        ]),
        rule("BR-02", "dashboard.revenue_chart", "Revenue", "chart", [
          "Shows revenue for the last 12 months",
        ]),
      ],
      scenarios: [
        scenario(
          "SC-01",
          "See the summary",
          "happy",
          ["dashboard.orders_card"],
          ["The user is signed in"],
          ["The dashboard summary is displayed"],
        ),
      ],
    }),
    useCase({
      id: "UC-005",
      title: "View and filter orders",
      order: 5,
      featureId: "FEAT-03",
      personaId: "persona-ops",
      screenIds: [O],
      regionIds: ["orders.filters", "orders.table"],
      elementIds: ["orders.search", "orders.status", "orders.table"],
      dependsOn: ["UC-003"],
      preconditions: ["The navigation bar is displayed"],
      postconditions: ["The orders list is displayed"],
      businessRules: [
        rule("BR-01", "orders.search", "Search orders", "search_input", [
          "Searches by order number or customer",
        ]),
        rule("BR-02", "orders.status", "Status", "dropdown", [
          "Options: All, Open, Shipped, Cancelled",
          "Default: All",
        ]),
        rule("BR-03", "orders.table", "Orders", "table", [
          "Columns: Order #, Customer, Total, Status",
        ]),
      ],
      scenarios: [
        scenario(
          "SC-01",
          "Search orders",
          "happy",
          ["orders.search", "orders.table"],
          ["The navigation bar is displayed"],
          ["The orders list is displayed"],
        ),
        scenario(
          "SC-02",
          "Filter by status",
          "alternate",
          ["orders.status"],
          ["The orders list is displayed"],
          ["Only matching orders are listed"],
        ),
      ],
    }),
    useCase({
      id: "UC-006",
      title: "Export orders to CSV",
      order: 6,
      featureId: "FEAT-03",
      personaId: "persona-ops",
      screenIds: [O],
      regionIds: ["orders.table"],
      elementIds: ["orders.export"],
      dependsOn: ["UC-005"],
      preconditions: ["The orders list is displayed"],
      postconditions: ["A CSV file is downloaded"],
      businessRules: [
        rule("BR-01", "orders.export", "Export CSV", "button", [
          "Downloads the filtered orders as CSV",
        ]),
      ],
      scenarios: [
        scenario(
          "SC-01",
          "Export the list",
          "happy",
          ["orders.export"],
          ["The orders list is displayed"],
          ["A CSV file is downloaded"],
        ),
      ],
    }),
  ];

  return {
    schemaVersion: 1,
    projectId: "acme",
    formatId: "use-case-bdd",
    generatedAt: AT,
    updatedAt: AT,
    generator: { vision: "mock/mock", text: "mock/mock" },
    options: { ...DEFAULT_GENERATION_OPTIONS },
    summary: "Order management for Acme.",
    personas: [
      {
        id: "persona-customer",
        name: "Registered customer",
        description: "Signs in and views orders",
        goals: ["Track orders"],
      },
      {
        id: "persona-ops",
        name: "Operations manager",
        description: "Manages orders",
        goals: ["Ship orders on time"],
      },
    ],
    screens: [login, dashboard, orders],
    flows: [
      {
        id: "flow-1",
        fromScreenId: L,
        toScreenId: D,
        trigger: "Click 'Sign in'",
        elementId: "login.sign_in",
      },
      {
        id: "flow-2",
        fromScreenId: D,
        toScreenId: O,
        trigger: "Select 'Orders'",
        elementId: "dashboard.nav_bar",
      },
    ],
    features: [
      {
        id: "FEAT-01",
        name: "Authentication",
        description: "Sign in and recovery",
        useCaseIds: ["UC-001", "UC-002"],
      },
      {
        id: "FEAT-02",
        name: "Shell",
        description: "Navigation",
        useCaseIds: ["UC-003"],
      },
      {
        id: "FEAT-03",
        name: "Orders",
        description: "Dashboard and orders",
        useCaseIds: ["UC-004", "UC-005", "UC-006"],
      },
    ],
    useCases,
    review: [],
    changeLog: [],
  };
}

export function fixtureProject(): Project {
  const shot = (id: string, name: string, order: number) => ({
    id,
    name,
    notes: "",
    order,
    version: 1,
    fileName: `${id}/v1.png`,
    originalFileName: `${name}.png`,
    mimeType: "image/png",
    width: 1440,
    height: 900,
    sizeBytes: 1000,
    uploadedAt: AT,
    analysedVersion: 1,
  });
  return {
    id: "acme",
    name: "Acme Orders",
    description: "Customers sign in and manage their orders.",
    additionalContext: "",
    formatId: "use-case-bdd",
    outputDir: "/tmp/acme-specs",
    llm: {},
    screens: [
      shot("scr_login", "Login", 0),
      shot("scr_dash", "Dashboard", 1),
      shot("scr_orders", "Orders", 2),
    ],
    status: "specified",
    createdAt: AT,
    updatedAt: AT,
    lastGeneratedAt: AT,
  };
}
