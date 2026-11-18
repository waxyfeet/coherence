/**
 * OWNER: server-core builder.
 * Creates a ready-to-generate sample project ("Acme Orders — demo") from the PNGs in <repo>/samples/screens
 * (01-login.png, 02-dashboard.png, 03-orders.png, 04-new-order.png), with a realistic description and
 * per-screen notes, so a BA can try the whole flow (including the offline demo connection) in one click.
 * The name is made unique ("… (2)") if it already exists.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Project } from "@shared/types";
import { ROOT_DIR } from "../config";
import { HttpError } from "../errors";
import { isNotFound } from "./fsUtils";
import {
  addScreens,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  saveProject,
  withProjectLock,
} from "./projectStore";
import { getSettings, createConnection } from "./settingsStore";

export const DEMO_PROJECT_NAME = "Acme Orders — demo";
export const DEMO_SAMPLES_DIR = path.join(ROOT_DIR, "samples", "screens");

// The text below describes what the sample screens show plus the business policy a BA would know but a
// design cannot show — exactly the kind of context the agents need to write good rules.
const DEMO_DESCRIPTION =
  "Acme Orders is the B2B order-management portal of Acme Wholesale, an Australian distributor of industrial " +
  "hardware and fixings (widgets, brackets, fasteners) to trade customers such as retailers, manufacturers and " +
  "pharmacies. Acme sales reps use it to manage the orders of the customer accounts assigned to them, and customer " +
  "admins use it to place and track their own company's orders at their contract prices. The portal covers signing " +
  "in, a dashboard of open orders, approvals and credit holds, searching and bulk-managing the order list, and entering " +
  "a new order with delivery details, order lines and an automatic credit-limit check. The goal is to replace phone and " +
  "email ordering with self-service, cut order-entry errors and give everyone real-time visibility of each order from " +
  "Draft to Shipped.";

const DEMO_ADDITIONAL_CONTEXT = [
  "Roles:",
  '- Sales rep — Acme employee (e.g. Jane Cooper). Sees and manages the orders of the customer accounts assigned to them, can place orders on a customer\'s behalf, approve submitted orders and release orders on credit hold. Only sales reps see the Customers and Reports menus, the "Sales rep" filter and the "Add a customer" quick action.',
  "- Customer admin — staff member of a trade customer. Sees only their own company's orders, places orders for their own company (the Customer field is fixed to their account) and can cancel their orders while they are not yet shipped. Cannot approve orders.",
  "",
  "Order lifecycle and rules:",
  "- Order statuses: Draft → Submitted → Approved → Shipped. Draft, Submitted and Approved orders can be Cancelled; Shipped and Cancelled orders are read-only.",
  '- Every customer account has a credit limit. When an order is submitted, its total is checked against the customer\'s available credit (credit limit minus unpaid invoices and open orders). If it exceeds the available credit the order is placed on "Credit hold" and stays Submitted until a sales rep approves it; otherwise it can be approved straight away.',
  "- Orders older than 48 hours that are still awaiting approval are flagged on the dashboard.",
  "- Order numbers are assigned on first save in the format SO-NNNNN (e.g. SO-10482).",
  "- Prices are each customer's contract prices in AUD, excluding GST. GST of 10% applies to Australian delivery addresses only.",
  "- Shipping is a flat $85.00 per order; free when the items subtotal is $10,000.00 or more.",
  "- The requested delivery date must be at least 2 business days from today; Acme delivers Monday to Friday, excluding Australian public holidays.",
  "- Quantities are whole numbers from 1 to 9,999 per order line.",
  "",
  "Non-functional:",
  '- Sessions expire after 30 minutes of inactivity (unless "Remember me" was ticked). Accounts are locked for 15 minutes after 5 failed sign-in attempts.',
  "- Dates are shown as d MMM yyyy (e.g. 13 Oct 2026) and entered as dd/mm/yyyy.",
  "- Must meet WCAG 2.2 AA and work on desktop browsers from 1280 px wide.",
].join("\n");

interface DemoScreen {
  file: string;
  name: string;
  notes: string;
}

const DEMO_SCREENS: DemoScreen[] = [
  {
    file: "01-login.png",
    name: "Login",
    notes: [
      "Shared sign-in page for sales reps and customer admins; the role comes from the account.",
      '"Show" toggles the password between hidden and visible.',
      '"Remember me for 30 days" keeps the user signed in on this device for 30 days.',
      '"Forgot password?" emails a reset link that is valid for 60 minutes.',
      '"Sign in with Microsoft" uses the company\'s Microsoft Entra ID (single sign-on) and is available to Acme staff and to customers who have SSO enabled.',
      '"Request access" opens the trade-account application form handled by the sales team (out of scope here).',
      'Wrong credentials show "Incorrect email or password" without saying which one was wrong.',
    ].join(" "),
  },
  {
    file: "02-dashboard.png",
    name: "Dashboard",
    notes: [
      "Landing page after sign-in, shown here for a sales rep.",
      '"Period" options: Today, This week, This month (default), This quarter, This year — it drives the four KPI tiles.',
      "Open orders = Draft + Submitted + Approved; Awaiting approval = Submitted orders (including credit holds), with a warning for those older than 48h.",
      'The credit-hold banner only appears when at least one order is on credit hold; "Review held orders" opens Orders filtered to credit holds.',
      '"Recent orders" lists the 5 newest orders; clicking an order number opens that order. "View all orders" opens the Orders screen.',
      "Activity shows the 10 latest order events. The search box in the header searches orders and customers.",
    ].join(" "),
  },
  {
    file: "03-orders.png",
    name: "Orders",
    notes: [
      "Order list for the signed-in user (sales reps: their assigned customers; customer admins: their own company).",
      "Status tabs show counts and filter the list. Search matches order number or customer name.",
      '"Order date" options: Last 7 days, Last 30 days (default), Last 90 days, This year, Custom range. "Sales rep" is shown to sales reps only.',
      "Default sort is order number, newest first; columns are sortable.",
      "Selecting rows shows the bulk action bar: Approve (Submitted orders only, sales reps only), Cancel orders (Draft, Submitted or Approved only, asks for confirmation) and Print packing slips (Approved orders, opens a PDF).",
      'Row "…" menu: View, Duplicate (creates a new Draft with the same lines), Cancel.',
      'Rows per page: 10 (default), 25, 50. "Export CSV" downloads the currently filtered list.',
    ].join(" "),
  },
  {
    file: "04-new-order.png",
    name: "New order",
    notes: [
      "Country dropdown options, in this order: Australia (default), New Zealand, South Africa, United Kingdom, United States.",
      "Postcode format depends on the country: Australia, New Zealand and South Africa 4 digits; United Kingdom a valid UK postcode; United States a 5-digit ZIP or ZIP+4.",
      "Customer lists the sales rep's assigned customers (for a customer admin it is fixed to their own account); changing it reloads contract prices and the account's default delivery address.",
      "Product search matches SKU or product name; each line shows the contract unit price and line total; the bin icon removes a line.",
      "The order summary recalculates live; GST only applies to Australian addresses; shipping rule as in the project context.",
      '"Submit order" validates all required fields and the credit limit (orders over the available credit go on credit hold). "Save as draft" saves without validation of order lines. "Cancel" asks for confirmation if anything was entered.',
    ].join(" "),
  },
];

async function uniqueDemoName(): Promise<string> {
  const existing = new Set(
    (await listProjects()).map((p) => p.name.toLowerCase()),
  );
  if (!existing.has(DEMO_PROJECT_NAME.toLowerCase())) return DEMO_PROJECT_NAME;
  for (let n = 2; ; n++) {
    const candidate = `${DEMO_PROJECT_NAME} (${n})`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
}

async function readSample(file: string): Promise<Buffer> {
  const full = path.join(DEMO_SAMPLES_DIR, file);
  try {
    return await fs.readFile(full);
  } catch (err) {
    if (isNotFound(err)) {
      throw new HttpError(
        500,
        `The demo screen "${file}" is missing from ${DEMO_SAMPLES_DIR}. Restore the samples folder (or reinstall Coherence) to use the demo project.`,
        "DEMO_FILES_MISSING",
      );
    }
    throw err;
  }
}

export async function createDemoProject(): Promise<Project> {
  const settings = await getSettings();
  const offline =
    settings.connections.find((c) => c.provider === "mock") ??
    (await createConnection({
      name: "Offline demo (no AI)",
      provider: "mock",
      model: "demo",
    }));
  // Read every sample first so a missing file fails before anything is created.
  const buffers = await Promise.all(
    DEMO_SCREENS.map((s) => readSample(s.file)),
  );

  const project = await createProject({
    name: await uniqueDemoName(),
    description: DEMO_DESCRIPTION,
    additionalContext: DEMO_ADDITIONAL_CONTEXT,
  });
  try {
    const screens = await addScreens(
      project.id,
      DEMO_SCREENS.map((s, i) => ({
        originalName: s.file,
        mimeType: "image/png",
        buffer: buffers[i],
      })),
    );
    return await withProjectLock(project.id, async () => {
      const current = await getProject(project.id);
      current.llm = {
        visionConnectionId: offline.id,
        textConnectionId: offline.id,
      };
      screens.forEach((added, i) => {
        const screen = current.screens.find((s) => s.id === added.id);
        if (!screen) return;
        screen.name = DEMO_SCREENS[i].name;
        screen.notes = DEMO_SCREENS[i].notes;
      });
      return saveProject(current);
    });
  } catch (err) {
    // Do not leave a half-built demo project behind.
    await deleteProject(project.id).catch(() => {});
    throw err;
  }
}
