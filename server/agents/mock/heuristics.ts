/**
 * Heuristics for the offline 'mock' provider: it cannot see images, so it infers what a screen probably is
 * from its name (and the BA's notes / project description) and produces plausible, deterministic content.
 */
import type { ElementType, Project, Screen } from "@shared/types";
import { pluralize, singularize, titleCase } from "../text";

export type MockScreenKind =
  | "login"
  | "signup"
  | "forgot"
  | "dashboard"
  | "list"
  | "detail"
  | "form"
  | "settings"
  | "checkout"
  | "generic";

const KIND_PATTERNS: [MockScreenKind, RegExp][] = [
  [
    "forgot",
    /\b(forgot|reset|recover)\b.*\b(password|pass|pin)\b|\bpassword reset\b|\bforgot\b/i,
  ],
  [
    "signup",
    /\b(sign ?up|register|registration|create (an )?account|join|onboard(ing)?)\b/i,
  ],
  ["login", /\b(log ?in|sign ?in|signin|login|auth(entication)?|log on)\b/i],
  [
    "settings",
    /\b(settings?|preferences|profile|my account|account settings|configuration|admin)\b/i,
  ],
  ["checkout", /\b(checkout|check out|payment|pay|cart|basket|billing)\b/i],
  [
    "dashboard",
    /\b(dashboard|home|overview|landing|summary|analytics|insights|start|welcome)\b/i,
  ],
  [
    "form",
    /\b(new|create|add|edit|update|form|compose|request|wizard|step)\b/i,
  ],
  ["detail", /\b(details?|view|record|item page)\b|#\s*\d+/i],
  [
    "list",
    /\b(list|search|results|browse|catalog(ue)?|directory|inbox|queue|history|all)\b/i,
  ],
];

export function detectScreenKind(
  screen: Pick<Screen, "name" | "notes">,
): MockScreenKind {
  const name = screen.name.replace(/[_-]+/g, " ");
  for (const [kind, pattern] of KIND_PATTERNS)
    if (pattern.test(name)) return kind;
  // A plural noun ("Orders", "Customers") is almost always a list screen.
  const last = name.trim().split(/\s+/).pop() ?? "";
  if (/[a-z]{3,}s$/i.test(last) && !/(ss|us|is)$/i.test(last)) return "list";
  const notes = screen.notes ?? "";
  for (const [kind, pattern] of KIND_PATTERNS)
    if (pattern.test(notes)) return kind;
  return "generic";
}

export function isAuthKind(kind: MockScreenKind): boolean {
  return kind === "login" || kind === "signup" || kind === "forgot";
}

/* ── Entity profiles ─────────────────────────────────────────────────── */

export interface MockField {
  key: string;
  type: ElementType;
  label: string;
  placeholder?: string;
  helperText?: string;
  defaultValue?: string;
  options?: string[];
  required?: boolean;
  validation?: string[];
  behavior?: string;
  dataBinding?: string;
  inferred?: string[];
  states?: string[];
}

export interface MockFormSection {
  key: string;
  name: string;
  purpose: string;
  fields: MockField[];
}

export interface EntityProfile {
  id: string;
  singular: string;
  plural: string;
  /** Column header for the identifier, e.g. "Order #". */
  idLabel: string;
  /** Example identifier, e.g. "SO-10482". */
  sampleId: string;
  columns: string[];
  statuses: string[];
  kpis: string[];
  chartLabel: string;
  searchPlaceholder: string;
  rowActions: string[];
  sections: MockFormSection[];
  /** Persona most likely to work with this entity (used when the description names no role). */
  defaultPersona: string;
  submitLabel: string;
  submittedState: string;
}

const ORDER_PROFILE: EntityProfile = {
  id: "order",
  singular: "order",
  plural: "orders",
  idLabel: "Order #",
  sampleId: "SO-10482",
  columns: [
    "Order #",
    "Customer",
    "PO number",
    "Order date",
    "Status",
    "Total",
  ],
  statuses: [
    "Draft",
    "Submitted",
    "Awaiting approval",
    "Approved",
    "Shipped",
    "Delivered",
    "Cancelled",
  ],
  kpis: [
    "Open orders",
    "Awaiting approval",
    "Shipped this month",
    "Revenue (MTD)",
  ],
  chartLabel: "Orders per week",
  searchPlaceholder: "Search by order #, customer or PO number",
  rowActions: ["View details", "Edit", "Duplicate", "Cancel order"],
  defaultPersona: "Sales representative",
  submitLabel: "Submit order",
  submittedState: 'The order is submitted with status "Submitted"',
  sections: [
    {
      key: "order_details",
      name: "Order details",
      purpose: "Captures who the order is for and how it is delivered.",
      fields: [
        {
          key: "customer",
          type: "combobox",
          label: "Customer",
          placeholder: "Search customers…",
          required: true,
          validation: [
            "Mandatory — an existing, active customer account must be selected",
            "Typing at least 2 characters searches customers by name or account number",
          ],
          behavior:
            "Selecting a customer fills the delivery address and price list.",
          dataBinding: "order.customerId",
          inferred: ["options", "validation"],
        },
        {
          key: "po_number",
          type: "text_input",
          label: "PO number",
          placeholder: "e.g. PO-2026-0142",
          required: false,
          validation: [
            "Optional",
            'Max 30 characters; letters, digits, "-" and "/" only',
            'Must be unique per customer — inline error "This PO number is already used for this customer"',
          ],
          dataBinding: "order.poNumber",
          inferred: ["validation"],
        },
        {
          key: "delivery_date",
          type: "date_picker",
          label: "Requested delivery date",
          placeholder: "dd/mm/yyyy",
          required: true,
          validation: [
            "Mandatory",
            "Must be today or a later date",
            "Weekends and public holidays cannot be selected",
          ],
          dataBinding: "order.requestedDeliveryDate",
          inferred: ["validation"],
        },
        {
          key: "shipping_method",
          type: "dropdown",
          label: "Shipping method",
          defaultValue: "Standard (3–5 business days)",
          options: [
            "Standard (3–5 business days)",
            "Express (1–2 business days)",
            "Next business day",
            "Collect from warehouse",
          ],
          required: true,
          validation: ["Mandatory — one option must be selected"],
          behavior:
            "Changing the method recalculates the shipping cost in the order summary.",
          dataBinding: "order.shippingMethod",
        },
        {
          key: "delivery_address",
          type: "text",
          label: "Delivery address",
          helperText: "Default address of the selected customer",
          behavior:
            'Read-only; shows the selected customer\'s default delivery address, or "Select a customer first".',
          dataBinding: "customer.defaultDeliveryAddress",
          states: ["empty until a customer is selected"],
        },
      ],
    },
    {
      key: "order_lines",
      name: "Order lines",
      purpose: "Lists the products being ordered with quantities and prices.",
      fields: [
        {
          key: "lines_table",
          type: "table",
          label: "Order lines",
          options: [
            "Product",
            "SKU",
            "Quantity",
            "Unit price",
            "Discount %",
            "Line total",
          ],
          behavior:
            "One row per product; the line total updates as quantity or discount changes.",
          dataBinding: "order.lines",
          states: ['empty: "No products added yet"'],
        },
        {
          key: "product",
          type: "combobox",
          label: "Product",
          placeholder: "Search by product name or SKU",
          required: true,
          validation: [
            "Mandatory on every line",
            "Only active products on the customer's price list can be selected",
          ],
          dataBinding: "orderLine.productId",
          inferred: ["validation"],
        },
        {
          key: "quantity",
          type: "number_input",
          label: "Quantity",
          defaultValue: "1",
          required: true,
          validation: [
            "Mandatory",
            "Whole number from 1 to 9,999",
            'Inline error "Enter a quantity between 1 and 9,999"',
          ],
          dataBinding: "orderLine.quantity",
          inferred: ["validation"],
        },
        {
          key: "unit_price",
          type: "currency_input",
          label: "Unit price",
          states: ["read-only"],
          behavior:
            "Read-only; taken from the customer's price list in the order currency.",
          dataBinding: "orderLine.unitPrice",
        },
        {
          key: "discount",
          type: "number_input",
          label: "Discount %",
          defaultValue: "0",
          required: false,
          validation: [
            "Optional",
            "Number from 0 to 100 with up to 2 decimals",
            "Discounts above 15% require manager approval",
          ],
          dataBinding: "orderLine.discountPercent",
          inferred: ["validation"],
        },
        {
          key: "remove_line",
          type: "icon_button",
          label: "Remove line",
          behavior:
            'Removes the line after a confirmation "Remove this line?".',
          inferred: ["behavior"],
        },
        {
          key: "add_line",
          type: "button",
          label: "Add line",
          behavior:
            "Adds an empty order line at the bottom of the table and focuses its Product field.",
        },
      ],
    },
    {
      key: "order_summary",
      name: "Order summary and actions",
      purpose:
        "Shows the order totals and lets the user save or submit the order.",
      fields: [
        {
          key: "subtotal",
          type: "text",
          label: "Subtotal",
          behavior:
            'Sum of all line totals, formatted in the order currency (e.g. "€1,250.00").',
          dataBinding: "order.subtotal",
        },
        {
          key: "shipping_cost",
          type: "text",
          label: "Shipping",
          behavior: "Shipping cost for the selected shipping method.",
          dataBinding: "order.shippingCost",
        },
        {
          key: "order_total",
          type: "text",
          label: "Order total",
          behavior:
            "Subtotal plus shipping plus VAT; updates immediately when lines change.",
          dataBinding: "order.total",
        },
        {
          key: "notes",
          type: "textarea",
          label: "Notes for the warehouse",
          placeholder: "Delivery instructions, dock opening hours…",
          helperText: "0/500",
          required: false,
          validation: [
            "Optional",
            "Max 500 characters; the counter shows the characters used",
          ],
          dataBinding: "order.notes",
        },
        {
          key: "cancel",
          type: "button",
          label: "Cancel",
          behavior:
            'Asks "Discard this order?" when there are unsaved changes, then returns to the order list.',
        },
        {
          key: "save_draft",
          type: "button",
          label: "Save as draft",
          behavior:
            'Saves the order with status "Draft" without validating mandatory fields and shows "Draft saved".',
        },
        {
          key: "submit",
          type: "button",
          label: "Submit order",
          states: [
            "disabled until all mandatory fields are valid and at least one line exists",
            "loading while submitting",
          ],
          behavior:
            'Validates and submits the order; on success shows "Order SO-10482 submitted" and returns to the order list.',
        },
      ],
    },
  ],
};

function genericProfile(noun: string): EntityProfile {
  const singular = singularize(noun.toLowerCase()) || "item";
  const plural = pluralize(singular);
  const title = titleCase(singular);
  return {
    id: singular.replace(/\s+/g, "-"),
    singular,
    plural,
    idLabel: `${title} ID`,
    sampleId: `${singular.slice(0, 3).toUpperCase()}-1042`,
    columns: [`${title} ID`, "Name", "Owner", "Created", "Status"],
    statuses: ["Draft", "Active", "On hold", "Closed"],
    kpis: [
      `Active ${plural}`,
      "Pending review",
      "Completed this month",
      `New ${plural} (7 days)`,
    ],
    chartLabel: `${titleCase(plural)} per week`,
    searchPlaceholder: `Search ${plural}`,
    rowActions: ["View", "Edit", "Archive"],
    defaultPersona: "Registered user",
    submitLabel: "Save",
    submittedState: `The ${singular} is saved`,
    sections: [
      {
        key: `${singular.replace(/\W+/g, "_")}_details`,
        name: `${title} details`,
        purpose: `Captures the main information of the ${singular}.`,
        fields: [
          {
            key: "name",
            type: "text_input",
            label: "Name",
            placeholder: `Enter a ${singular} name`,
            required: true,
            validation: [
              "Mandatory",
              "Between 2 and 100 characters",
              `Must be unique — inline error "A ${singular} with this name already exists"`,
            ],
            dataBinding: `${singular}.name`,
            inferred: ["validation"],
          },
          {
            key: "category",
            type: "dropdown",
            label: "Category",
            placeholder: "Select a category",
            required: true,
            validation: ["Mandatory — one option must be selected"],
            dataBinding: `${singular}.category`,
            inferred: ["options"],
          },
          {
            key: "owner",
            type: "combobox",
            label: "Owner",
            placeholder: "Search people…",
            required: false,
            validation: ["Optional", "Must be an active user"],
            dataBinding: `${singular}.ownerId`,
            inferred: ["validation"],
          },
          {
            key: "start_date",
            type: "date_picker",
            label: "Start date",
            placeholder: "dd/mm/yyyy",
            required: false,
            validation: [
              "Optional",
              "Valid calendar date in dd/mm/yyyy format",
            ],
            dataBinding: `${singular}.startDate`,
            inferred: ["validation"],
          },
          {
            key: "description",
            type: "textarea",
            label: "Description",
            placeholder: "Add a short description",
            helperText: "0/1000",
            required: false,
            validation: ["Optional", "Max 1,000 characters"],
            dataBinding: `${singular}.description`,
          },
        ],
      },
      {
        key: "form_actions",
        name: "Form actions",
        purpose: `Saves or cancels the ${singular}.`,
        fields: [
          {
            key: "active",
            type: "toggle",
            label: "Active",
            defaultValue: "On",
            behavior: `Inactive ${plural} are hidden from default lists.`,
            dataBinding: `${singular}.active`,
          },
          {
            key: "cancel",
            type: "button",
            label: "Cancel",
            behavior:
              "Discards unsaved changes after confirmation and returns to the previous screen.",
          },
          {
            key: "save",
            type: "button",
            label: "Save",
            states: [
              "disabled until all mandatory fields are valid",
              "loading while saving",
            ],
            behavior: `Validates and saves the ${singular}, then shows "${title} saved".`,
          },
        ],
      },
    ],
  };
}

const CUSTOMER_PROFILE: EntityProfile = {
  ...genericProfile("customer"),
  idLabel: "Account #",
  sampleId: "C-20417",
  columns: [
    "Account #",
    "Company",
    "Contact",
    "City",
    "Credit limit",
    "Status",
  ],
  statuses: ["Prospect", "Active", "On credit hold", "Inactive"],
  kpis: [
    "Active customers",
    "On credit hold",
    "New this month",
    "Average order value",
  ],
  searchPlaceholder: "Search by company, contact or account #",
  rowActions: ["View details", "Edit", "Place order", "Deactivate"],
  defaultPersona: "Account manager",
  sections: [
    {
      key: "company_details",
      name: "Company details",
      purpose: "Captures the customer company and its main contact.",
      fields: [
        {
          key: "company_name",
          type: "text_input",
          label: "Company name",
          required: true,
          validation: ["Mandatory", "Between 2 and 120 characters"],
          dataBinding: "customer.companyName",
          inferred: ["validation"],
        },
        {
          key: "vat_number",
          type: "text_input",
          label: "VAT number",
          placeholder: "e.g. GB123456789",
          required: false,
          validation: [
            "Optional",
            "Country prefix followed by 8–12 letters or digits",
          ],
          dataBinding: "customer.vatNumber",
          inferred: ["validation"],
        },
        {
          key: "contact_email",
          type: "email_input",
          label: "Contact email",
          placeholder: "name@company.com",
          required: true,
          validation: ["Mandatory", "Valid email address, max 254 characters"],
          dataBinding: "customer.contactEmail",
          inferred: ["validation"],
        },
        {
          key: "phone",
          type: "phone_input",
          label: "Phone",
          placeholder: "+44 20 7946 0000",
          required: false,
          validation: [
            "Optional",
            'International format starting with "+", 8–15 digits',
          ],
          dataBinding: "customer.phone",
          inferred: ["validation"],
        },
        {
          key: "payment_terms",
          type: "dropdown",
          label: "Payment terms",
          defaultValue: "Net 30",
          options: ["Prepaid", "Net 15", "Net 30", "Net 60"],
          required: true,
          validation: ["Mandatory"],
          dataBinding: "customer.paymentTerms",
        },
        {
          key: "credit_limit",
          type: "currency_input",
          label: "Credit limit",
          required: false,
          validation: [
            "Optional",
            "Amount from 0 to 1,000,000 with 2 decimals",
          ],
          dataBinding: "customer.creditLimit",
          inferred: ["validation"],
        },
      ],
    },
    genericProfile("customer").sections[1]!,
  ],
};

const PRODUCT_PROFILE: EntityProfile = {
  ...genericProfile("product"),
  idLabel: "SKU",
  sampleId: "SKU-88213",
  columns: ["SKU", "Product name", "Category", "Price", "Stock", "Status"],
  statuses: ["Active", "Low stock", "Out of stock", "Discontinued"],
  kpis: ["Active products", "Low stock", "Out of stock", "Inventory value"],
  searchPlaceholder: "Search by product name or SKU",
  rowActions: ["View", "Edit", "Adjust stock", "Discontinue"],
  defaultPersona: "Product manager",
};

const USER_PROFILE: EntityProfile = {
  ...genericProfile("user"),
  idLabel: "Name",
  sampleId: "Anna Berg",
  columns: ["Name", "Email", "Role", "Last sign-in", "Status"],
  statuses: ["Invited", "Active", "Suspended"],
  kpis: ["Active users", "Pending invitations", "Suspended", "Signed in today"],
  searchPlaceholder: "Search by name or email",
  rowActions: ["Edit role", "Reset password", "Suspend"],
  defaultPersona: "Administrator",
};

const TICKET_PROFILE: EntityProfile = {
  ...genericProfile("ticket"),
  idLabel: "Ticket #",
  sampleId: "T-3307",
  columns: [
    "Ticket #",
    "Subject",
    "Requester",
    "Priority",
    "Assignee",
    "Status",
  ],
  statuses: ["New", "Open", "Pending", "Resolved", "Closed"],
  kpis: ["Open tickets", "Unassigned", "Breaching SLA", "Resolved today"],
  searchPlaceholder: "Search by ticket #, subject or requester",
  rowActions: ["View", "Assign to me", "Change priority", "Close"],
  defaultPersona: "Support agent",
};

const INVOICE_PROFILE: EntityProfile = {
  ...genericProfile("invoice"),
  idLabel: "Invoice #",
  sampleId: "INV-2026-0311",
  columns: [
    "Invoice #",
    "Customer",
    "Issue date",
    "Due date",
    "Amount",
    "Status",
  ],
  statuses: ["Draft", "Sent", "Partially paid", "Paid", "Overdue", "Void"],
  kpis: ["Outstanding", "Overdue", "Paid this month", "Average days to pay"],
  searchPlaceholder: "Search by invoice # or customer",
  rowActions: ["View", "Send reminder", "Record payment", "Void"],
  defaultPersona: "Finance clerk",
};

const PROFILE_SYNONYMS: [RegExp, EntityProfile][] = [
  [/\b(orders?|purchase orders?|sales orders?|po)\b/i, ORDER_PROFILE],
  [/\b(customers?|clients?|accounts?|companies|company)\b/i, CUSTOMER_PROFILE],
  [
    /\b(products?|items?|skus?|catalog(ue)?|inventory|stock)\b/i,
    PRODUCT_PROFILE,
  ],
  [/\b(users?|members?|employees?|staff|team|people)\b/i, USER_PROFILE],
  [/\b(tickets?|cases?|requests?|issues?|incidents?)\b/i, TICKET_PROFILE],
  [/\b(invoices?|bills?|payments?)\b/i, INVOICE_PROFILE],
];

const KIND_WORDS =
  /\b(new|create|add|edit|update|list|lists|details?|view|search|results|manage|management|overview|page|screen|all|my|form|browse|the|a|an)\b/gi;

/** Entity named by the screen itself ("New order" → order), if any. */
export function entityFromScreenName(name: string): EntityProfile | undefined {
  for (const [pattern, profile] of PROFILE_SYNONYMS)
    if (pattern.test(name)) return profile;
  // Only screens that are about "things" (lists, forms, details) name an entity of their own.
  const kind = detectScreenKind({ name, notes: "" });
  if (
    kind !== "list" &&
    kind !== "form" &&
    kind !== "detail" &&
    kind !== "generic"
  )
    return undefined;
  const rest = name
    .replace(/[_-]+/g, " ")
    .replace(KIND_WORDS, " ")
    .replace(/\s+/g, " ")
    .trim();
  const last = rest.split(" ").pop() ?? "";
  if (last.length < 3 || !/^[a-z]+$/i.test(last)) return undefined;
  return genericProfile(last);
}

/** The project's main entity: from list/form screens first, then the description. */
export function primaryEntity(project: Project): EntityProfile {
  for (const s of [...project.screens].sort((a, b) => a.order - b.order)) {
    const kind = detectScreenKind(s);
    if (kind === "list" || kind === "form" || kind === "detail") {
      const p = entityFromScreenName(s.name);
      if (p) return p;
    }
  }
  const text = `${project.description} ${project.additionalContext}`;
  let best: { profile: EntityProfile; count: number } | undefined;
  for (const [pattern, profile] of PROFILE_SYNONYMS) {
    const count = (text.match(new RegExp(pattern.source, "gi")) ?? []).length;
    if (count > 0 && (!best || count > best.count)) best = { profile, count };
  }
  return best?.profile ?? genericProfile("item");
}

export function entityForScreen(
  project: Project,
  screen: Screen,
): EntityProfile {
  return entityFromScreenName(screen.name) ?? primaryEntity(project);
}

/* ── Personas ────────────────────────────────────────────────────────── */

const ROLE_PATTERNS: [RegExp, string][] = [
  [/\bsales ?reps?\b|\bsales representatives?\b/i, "Sales representative"],
  [
    /\bcustomer service (agents?|representatives?|team)\b/i,
    "Customer service agent",
  ],
  [/\baccount managers?\b/i, "Account manager"],
  [/\bsupport agents?\b/i, "Support agent"],
  [/\bbuyers?\b|\bpurchasers?\b|\bprocurement\b/i, "Buyer"],
  [/\bwarehouse\b/i, "Warehouse operator"],
  [/\bfinance\b|\baccountants?\b/i, "Finance clerk"],
  [/\bmanagers?\b|\bsupervisors?\b/i, "Manager"],
  [/\bdispatchers?\b/i, "Dispatcher"],
  [/\badmin(istrator)?s?\b/i, "Administrator"],
  [/\bclerks?\b/i, "Clerk"],
  [/\bagents?\b/i, "Agent"],
  [/\bemployees?\b|\bstaff\b/i, "Employee"],
  [/\bcustomers?\b/i, "Customer"],
  [/\bmembers?\b/i, "Member"],
];

export interface ContextRole {
  name: string;
  description: string;
}

const ROLE_HEADING =
  /^\s*(?:#+\s*)?(roles?|personas?|users?|user roles?|actors?)\s*:?\s*$/i;
const ROLE_LINE =
  /^\s*[-*•]\s*\**([A-Za-z][A-Za-z /&'-]{1,40}?)\**\s*(?:—|–|-|:)\s+(.+)$/;

/**
 * Roles the BA listed in the additional context ("Roles:" followed by "- Sales rep — …" lines), in order.
 * They are the BA's own vocabulary, so they beat any guess from the description.
 */
export function contextRoles(
  project: Pick<Project, "additionalContext">,
): ContextRole[] {
  const roles: ContextRole[] = [];
  let inRoles = false;
  for (const line of project.additionalContext.split(/\r?\n/)) {
    if (ROLE_HEADING.test(line)) {
      inRoles = true;
      continue;
    }
    if (!inRoles) continue;
    if (!line.trim()) {
      if (roles.length) break;
      continue;
    }
    const m = ROLE_LINE.exec(line);
    if (!m) break;
    const name = m[1].trim();
    if (!roles.some((r) => r.name.toLowerCase() === name.toLowerCase()))
      roles.push({ name, description: m[2].trim() });
  }
  return roles;
}

/**
 * The main role: the first role the BA listed in the additional context, else the most specific role named
 * in the description (the list above is ordered from specific to generic), else the entity's typical persona.
 */
export function primaryPersona(project: Project): string {
  const listed = contextRoles(project)[0];
  if (listed) return listed.name;
  const text = `${project.description} ${project.additionalContext}`;
  for (const [pattern, role] of ROLE_PATTERNS) {
    if (pattern.test(text)) return role;
  }
  return primaryEntity(project).defaultPersona;
}

/* ── Layout (plausible bounds in % of the full image) ─────────────────── */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Splits a region box into `n` boxes laid out in a row, column or grid, with small gaps. */
export function layoutBoxes(
  box: Box,
  n: number,
  flow: "row" | "column" | "grid",
  cols = 2,
  weights?: number[],
): Box[] {
  if (n <= 0) return [];
  const pad = 0.6;
  const inner: Box = {
    x: box.x + pad,
    y: box.y + pad,
    width: Math.max(1, box.width - 2 * pad),
    height: Math.max(1, box.height - 2 * pad),
  };
  const round = (v: number): number => Math.round(v * 10) / 10;
  if (flow === "row") {
    const gap = Math.min(1.5, inner.width / (n * 6));
    const w = (inner.width - gap * (n - 1)) / n;
    return Array.from({ length: n }, (_, i) => ({
      x: round(inner.x + i * (w + gap)),
      y: round(inner.y),
      width: round(w),
      height: round(inner.height),
    }));
  }
  if (flow === "grid") {
    const c = Math.max(1, Math.min(cols, n));
    const rows = Math.ceil(n / c);
    const gapX = 1.5;
    const gapY = 1;
    const w = (inner.width - gapX * (c - 1)) / c;
    const h = (inner.height - gapY * (rows - 1)) / rows;
    return Array.from({ length: n }, (_, i) => ({
      x: round(inner.x + (i % c) * (w + gapX)),
      y: round(inner.y + Math.floor(i / c) * (h + gapY)),
      width: round(w),
      height: round(h),
    }));
  }
  const ws =
    weights && weights.length === n
      ? weights
      : Array.from({ length: n }, () => 1);
  const total = ws.reduce((a, b) => a + b, 0);
  const gap = Math.min(1, inner.height / (n * 8));
  const usable = inner.height - gap * (n - 1);
  let y = inner.y;
  return ws.map((wt) => {
    const h = (usable * wt) / total;
    const b = {
      x: round(inner.x),
      y: round(y),
      width: round(inner.width),
      height: round(h),
    };
    y += h + gap;
    return b;
  });
}
