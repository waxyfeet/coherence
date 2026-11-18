export type Page =
  | "overview"
  | "screens"
  | "analysis"
  | "use-cases"
  | "graph"
  | "changes"
  | "export";
export type Provider =
  | "anthropic"
  | "openai"
  | "azure"
  | "gemini"
  | "ollama"
  | "lmstudio"
  | "compatible"
  | "mock";
export interface Connection {
  id: string;
  name: string;
  provider: Provider;
  model: string;
  /** Live provider accounts manage identities; model is retained for the explicit prototype/test draft only. */
  modelIds?: string[];
  visibleModelIds?: string[];
  manualModelIds?: string[];
  catalogue?: import("../shared/modelCatalogue").ModelCatalogue;
  capabilities?: import("../shared/modelCapabilities").CapabilityInventory;
  /** Unsaved manual-entry buffer; never included in provider API/storage payloads. */
  pendingModelId?: string;
  endpoint: string;
  apiKey: string;
  keyPresent: boolean;
  maxTokens: number;
  timeout: number;
  concurrency: number;
  effort: string;
  vision: string;
  structured: string;
  temperature: number;
  azureVersion: string;
}
export interface SettingsData {
  analysisDefaults?: import("../shared/types").AnalysisModelDefaults;
  connections: Connection[];
  defaultId: string;
  visionId: string;
  textId: string;
  thoroughness: string;
  granularity: string;
  preserveEdits: boolean;
  embedImages: boolean;
  reuseAnalysis: boolean;
  theme: string;
  density: string;
  reduceMotion: boolean;
  backgroundEffects?: boolean;
  integrations: Record<string, Record<string, string>>;
}
export const providers: Record<
  Provider,
  {
    label: string;
    letter: string;
    kind: string;
    endpoint: string;
    models: { value: string; label: string; detail?: string }[];
  }
> = {
  mock: {
    label: "Offline demo",
    letter: "D",
    kind: "Offline fixture",
    endpoint: "http://127.0.0.1",
    models: [
      {
        value: "demo",
        label: "Deterministic demo",
        detail: "No AI or network requests",
      },
    ],
  },
  anthropic: {
    label: "Anthropic",
    letter: "A",
    kind: "Cloud API",
    endpoint: "https://api.anthropic.com",
    models: [
      {
        value: "claude-opus-5-5",
        label: "Claude Opus",
        detail: "Sample vision + reasoning model",
      },
      {
        value: "claude-sonnet-4-5",
        label: "Claude Sonnet",
        detail: "Sample balanced model",
      },
    ],
  },
  openai: {
    label: "OpenAI",
    letter: "O",
    kind: "Cloud API",
    endpoint: "https://api.openai.com/v1",
    models: [
      { value: "gpt-5.2", label: "GPT-5.2", detail: "Sample model ID" },
      { value: "gpt-4.1", label: "GPT-4.1", detail: "Sample vision model" },
    ],
  },
  azure: {
    label: "Azure OpenAI",
    letter: "Az",
    kind: "Cloud API",
    endpoint: "https://your-resource.openai.azure.com",
    models: [
      {
        value: "my-deployment",
        label: "my-deployment",
        detail: "Your deployment name",
      },
    ],
  },
  gemini: {
    label: "Google Gemini",
    letter: "G",
    kind: "Cloud API",
    endpoint: "https://generativelanguage.googleapis.com",
    models: [
      {
        value: "gemini-2.5-pro",
        label: "Gemini Pro",
        detail: "Sample model ID",
      },
      {
        value: "gemini-2.5-flash",
        label: "Gemini Flash",
        detail: "Sample fast model",
      },
    ],
  },
  ollama: {
    label: "Ollama",
    letter: "Ol",
    kind: "Local model",
    endpoint: "http://localhost:11434",
    models: [
      {
        value: "qwen3-vl:8b-instruct",
        label: "Qwen3 VL · 8B",
        detail: "Sample local vision model",
      },
      {
        value: "llama3.3:latest",
        label: "Llama 3.3",
        detail: "Sample local text model",
      },
    ],
  },
  compatible: {
    label: "OpenAI-compatible",
    letter: "↗",
    kind: "Custom endpoint",
    endpoint: "http://localhost:1234/v1",
    models: [
      {
        value: "local-model",
        label: "local-model",
        detail: "LM Studio, vLLM or a hosted API",
      },
    ],
  },
  lmstudio: {
    label: "LM Studio",
    letter: "LM",
    kind: "Local model",
    endpoint: "http://127.0.0.1:1234/v1",
    models: [
      {
        value: "local-model",
        label: "Local model",
        detail: "Sample ID in visual prototype only",
      },
    ],
  },
};
export const tuningDefaults = {
  // Zero represents Automatic in the UI; API payloads omit the optional hard cap.
  maxTokens: 0,
  // Zero represents Automatic: the API omits it and the server applies the provider's default (owner test note 4).
  timeout: 0,
  concurrency: 2,
  effort: "high",
  vision: "auto",
  structured: "auto",
  temperature: 0.7,
  azureVersion: "2025-04-01-preview",
};
export function newConnection(
  provider: Provider = "anthropic",
  id = `connection-${Date.now()}`,
): Connection {
  return {
    id,
    name: `${providers[provider].label} connection`,
    provider,
    model: providers[provider].models[0].value,
    endpoint: providers[provider].endpoint,
    apiKey: "",
    keyPresent: false,
    ...tuningDefaults,
  };
}
export const initialSettings: SettingsData = {
  connections: [
    {
      ...newConnection("anthropic", "cloud"),
      name: "Claude · visual analysis",
      keyPresent: true,
      maxTokens: 32000,
    },
    {
      ...newConnection("ollama", "local"),
      name: "Ollama · local writing",
      concurrency: 1,
      timeout: 300,
    },
  ],
  defaultId: "cloud",
  visionId: "cloud",
  textId: "local",
  thoroughness: "thorough",
  granularity: "balanced",
  preserveEdits: true,
  embedImages: true,
  reuseAnalysis: true,
  theme: "dark",
  density: "comfortable",
  reduceMotion: false,
  integrations: {
    jira: {
      deployment: "cloud",
      url: "https://northstar-demo.atlassian.net",
      email: "analyst@example.test",
      project: "NORTH",
      issueType: "Story",
      parentType: "Epic",
      linkType: "Blocks",
      labels: "screenscribe, northstar",
      pointsField: "customfield_10016",
      token: "",
    },
    azdo: {
      url: "https://dev.azure.com/northstar-demo",
      project: "Customer portal",
      issueType: "User Story",
      parentType: "Feature",
      area: "Customer portal\\Orders",
      iteration: "",
      labels: "ScreenScribe",
      token: "",
    },
    github: {
      owner: "northstar-demo",
      repo: "customer-portal",
      url: "https://api.github.com",
      labels: "requirements, screenscribe",
      milestones: "yes",
      token: "",
    },
    figma: { url: "https://www.figma.com/design/sample/Northstar", token: "" },
  },
};
export interface ScreenItem {
  id: string;
  title: string;
  kind: "login" | "orders" | "create" | "detail";
  fileName: string;
  version: number;
  notes: string;
  width: number;
  height: number;
  url?: string;
}
export const initialScreens: ScreenItem[] = [
  {
    id: "login",
    title: "Sign in",
    kind: "login",
    fileName: "01-sign-in.png",
    version: 1,
    notes:
      "Customers sign in with their work email. Include the invalid password state.",
    width: 1440,
    height: 960,
  },
  {
    id: "orders",
    title: "Order overview",
    kind: "orders",
    fileName: "02-order-overview.png",
    version: 1,
    notes:
      "Only show orders belonging to the signed-in customer. Status options: All statuses, Draft, In progress, Shipped, Delivered.",
    width: 1440,
    height: 960,
  },
  {
    id: "create",
    title: "Create an order",
    kind: "create",
    fileName: "03-create-order.png",
    version: 2,
    notes:
      "Delivery address and at least one line item are mandatory. Orders over $5,000 require approval.",
    width: 1440,
    height: 960,
  },
  {
    id: "detail",
    title: "Order details",
    kind: "detail",
    fileName: "04-order-details.png",
    version: 1,
    notes: "A customer can cancel a draft order. Shipped orders are read-only.",
    width: 1440,
    height: 960,
  },
];
export interface UseCase {
  id: string;
  title: string;
  feature: string;
  screenId: string;
  size: string;
  status: "generated" | "approved" | "edited" | "stale";
  story: string;
  goal: string;
  benefit: string;
  pre: string;
  post: string;
  rules: { label: string; detail: string }[];
}
export const initialUseCases: UseCase[] = [
  {
    id: "UC-001",
    title: "Sign in to your account",
    feature: "Account & access",
    screenId: "login",
    size: "M",
    status: "approved",
    story: "registered customer",
    goal: "sign in using my work email and password",
    benefit: "I can securely access my orders",
    pre: "The user has opened the application",
    post: "The customer is signed in",
    rules: [
      {
        label: "Work email",
        detail:
          "Mandatory email address. Trim leading and trailing spaces. Show an inline message for an invalid address.",
      },
      {
        label: "Password",
        detail:
          "Mandatory. Mask the value by default. The visibility control must not change the entered value.",
      },
      {
        label: "Sign in",
        detail:
          "Submit once. Show a loading state while credentials are verified. On success, display the order overview.",
      },
    ],
  },
  {
    id: "UC-002",
    title: "Navigate the customer workspace",
    feature: "Account & access",
    screenId: "orders",
    size: "S",
    status: "approved",
    story: "signed-in customer",
    goal: "navigate between my orders and account",
    benefit: "I can find the tools I need",
    pre: "The customer is signed in",
    post: "The customer workspace navigation is displayed",
    rules: [
      {
        label: "Main navigation",
        detail:
          "Show Overview, Orders, Customers and Reports. Indicate the active page with text and a selected state.",
      },
      {
        label: "Account menu",
        detail: "Show account details and a Sign out action.",
      },
    ],
  },
  {
    id: "UC-003",
    title: "Browse and filter orders",
    feature: "Order management",
    screenId: "orders",
    size: "M",
    status: "generated",
    story: "signed-in customer",
    goal: "browse, search and filter my orders",
    benefit: "I can quickly find an order and check its progress",
    pre: "The customer workspace navigation is displayed",
    post: "The filtered order list is displayed",
    rules: [
      {
        label: "Search orders",
        detail:
          "Filter by order number or customer name. Search is case-insensitive. An empty search shows all matching orders.",
      },
      {
        label: "All statuses",
        detail:
          "Options: All statuses, Draft, In progress, Shipped, Delivered. Default to All statuses. Combine the selected status with the current search.",
      },
      {
        label: "Orders table",
        detail:
          "Show Order, Customer, Date, Status and Total. Only display the current customer’s orders. Selecting a row opens its details.",
      },
      {
        label: "New order",
        detail:
          "Open Create an order. Keep navigation available. Display an informative empty state when no orders match.",
      },
    ],
  },
  {
    id: "UC-004",
    title: "Enter order and delivery details",
    feature: "Order management",
    screenId: "create",
    size: "M",
    status: "stale",
    story: "signed-in customer",
    goal: "enter the customer and delivery details for a new order",
    benefit: "my order can be delivered to the right address",
    pre: "The customer workspace navigation is displayed",
    post: "Valid delivery details are entered",
    rules: [
      {
        label: "Customer",
        detail:
          "Mandatory selection. Show only customer accounts the user can access.",
      },
      {
        label: "Delivery address",
        detail:
          "Mandatory street, city, postcode and country. Retain entered values when validation fails.",
      },
      {
        label: "Purchase order number",
        detail: "Optional text with a maximum of 50 characters.",
      },
    ],
  },
  {
    id: "UC-005",
    title: "Add products to an order",
    feature: "Order management",
    screenId: "create",
    size: "M",
    status: "generated",
    story: "signed-in customer",
    goal: "add products and quantities to my order",
    benefit: "I can request exactly what I need",
    pre: "Valid delivery details are entered",
    post: "The order contains at least one valid line item",
    rules: [
      {
        label: "Product",
        detail: "Select an available product and display its unit price.",
      },
      {
        label: "Quantity",
        detail:
          "Mandatory whole number from 1 to 999. Recalculate the line total when it changes.",
      },
      {
        label: "Remove item",
        detail:
          "Remove the selected line item and update the subtotal. An order must contain at least one item before submission.",
      },
    ],
  },
  {
    id: "UC-006",
    title: "Review order details",
    feature: "Order management",
    screenId: "detail",
    size: "S",
    status: "generated",
    story: "signed-in customer",
    goal: "review an order’s items and delivery information",
    benefit: "I can confirm the details and track its status",
    pre: "The filtered order list is displayed",
    post: "The selected order details are displayed",
    rules: [
      {
        label: "Order summary",
        detail:
          "Show order number, status, date, customer and delivery address.",
      },
      {
        label: "Line items",
        detail: "Show product, quantity, unit price and total for every item.",
      },
    ],
  },
  {
    id: "UC-007",
    title: "Review and submit an order",
    feature: "Order management",
    screenId: "create",
    size: "M",
    status: "stale",
    story: "signed-in customer",
    goal: "review the total and submit my order",
    benefit: "the fulfilment team can process it",
    pre: "The order contains at least one valid line item",
    post: "The order has been submitted",
    rules: [
      {
        label: "Order total",
        detail:
          "Display subtotal, delivery and tax as currency with two decimal places.",
      },
      {
        label: "Submit order",
        detail:
          "Enable only when delivery details and every line item are valid. Prevent duplicate submission and display a confirmation.",
      },
    ],
  },
  {
    id: "UC-008",
    title: "Track an order’s progress",
    feature: "Order management",
    screenId: "detail",
    size: "S",
    status: "generated",
    story: "signed-in customer",
    goal: "track the fulfilment status of my order",
    benefit: "I know when to expect delivery",
    pre: "The selected order details are displayed",
    post: "The current order progress is displayed",
    rules: [
      {
        label: "Status timeline",
        detail:
          "Show the current fulfilment stage and available timestamps. Shipped orders cannot be edited.",
      },
      {
        label: "Tracking link",
        detail:
          "When tracking is available, open the carrier’s tracking page in a new tab.",
      },
    ],
  },
];
export function useCaseMarkdown(uc: UseCase): string {
  return `# ${uc.id} · ${uc.title}\n\n## User story\n\n**As a** ${uc.story}\n**I want to** ${uc.goal}\n**So that** ${uc.benefit}\n\n## Preconditions\n\n- ${uc.pre}\n\n## Business rules\n\n${uc.rules.map((r, i) => `### BR-${String(i + 1).padStart(2, "0")} · ${r.label}\n\n${r.detail}`).join("\n\n")}\n\n## BDD scenarios\n\n### SC-01 · Successful ${uc.title.toLowerCase()}\n\n\`\`\`gherkin\nGIVEN ${uc.pre}\nWHEN the customer completes the required action\nTHEN ${uc.post}\nTHEN the current state is clearly visible\n\`\`\`\n\n### SC-02 · No matching results\n\n\`\`\`gherkin\nGIVEN ${uc.pre}\nWHEN no matching information is available\nTHEN an informative empty state is displayed\nTHEN the customer can change their selection\n\`\`\`\n\n## Open questions\n\n- Confirm business rules with the product owner before implementation.\n\n> Synthetic example · not generated by an AI model.\n`;
}
export const stages = [
  "Prepare screenshots",
  "Read screens",
  "Map journeys",
  "Plan use cases",
  "Write use cases",
  "Review coverage",
  "Prepare documents",
];
export const stageNotes = [
  "Checking the four bundled sample screens.",
  "Loading the hand-authored element inventory.",
  "Connecting the sample customer journey.",
  "Grouping the example into eight use cases.",
  "Loading the sample stories, rules and BDD scenarios.",
  "Checking the example’s predefined relationships.",
  "Making the sample documents available in this session.",
];
