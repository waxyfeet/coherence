/**
 * Offline Screen Analyst: a plausible, deterministic element inventory inferred from the screen's name
 * (login, sign-up, dashboard, list, detail, form, settings, checkout, generic), with an application header
 * on every signed-in screen whose navigation links point at the project's other screens.
 */
import type { ElementType, Project, Screen, ScreenType } from "@shared/types";
import type { ScreenAnalysisOutput, InspectorOutput } from "../schemas";
import { oneLine, titleCase, upperFirst } from "../text";
import { SAMPLE_SCREENS, type SampleScreen } from "./sampleScreens";
import {
  addNotedOptionElements,
  applyNotedOptions,
  localiseOutput,
} from "./notes";
import {
  detectScreenKind,
  entityForScreen,
  entityFromScreenName,
  isAuthKind,
  layoutBoxes,
  primaryPersona,
  type Box,
  type EntityProfile,
  type MockField,
  type MockScreenKind,
} from "./heuristics";

interface El {
  key: string;
  type: ElementType;
  label: string;
  description: string;
  placeholder?: string;
  defaultValue?: string;
  helperText?: string;
  options?: string[];
  required?: boolean;
  validation?: string[];
  states?: string[];
  behavior?: string;
  nav?: string;
  navHint?: string;
  data?: string;
  inferred?: string[];
  /** Relative height within a column layout. */
  weight?: number;
  /** Explicit bounds (overrides the region layout). */
  box?: Box;
}

interface Region {
  key: string;
  name: string;
  purpose: string;
  layout: string;
  box: Box;
  flow: "row" | "column" | "grid";
  cols?: number;
  elements: El[];
}

interface ScreenTemplate {
  title: string;
  purpose: string;
  screenType: ScreenType;
  regions: Region[];
  dataEntities: string[];
  openQuestions: string[];
  personas?: string[];
}

interface MockContext {
  project: Project;
  screen: Screen;
  kind: MockScreenKind;
  screens: Screen[];
  kinds: Map<string, MockScreenKind>;
  persona: string;
  entity: EntityProfile;
}

function firstScreenOf(
  c: MockContext,
  kinds: MockScreenKind[],
  entity?: EntityProfile,
): Screen | undefined {
  return c.screens.find(
    (s) =>
      s.id !== c.screen.id &&
      kinds.includes(c.kinds.get(s.id)!) &&
      (!entity || entityFromScreenName(s.name)?.id === entity.id),
  );
}

function landingScreen(c: MockContext): Screen | undefined {
  return c.screens.find((s) => !isAuthKind(c.kinds.get(s.id)!));
}

function typeWords(type: ElementType): string {
  return upperFirst(type.replace(/_/g, " "));
}

function fieldToEl(f: MockField, regionName: string): El {
  const where = `in the ${regionName} section`;
  return {
    key: f.key,
    type: f.type,
    label: f.label,
    description: `${typeWords(f.type)} labelled "${f.label}" ${where}.`,
    placeholder: f.placeholder,
    defaultValue: f.defaultValue,
    helperText: f.helperText,
    options: f.options,
    required: f.required,
    validation: f.validation,
    states: f.states,
    behavior: f.behavior,
    data: f.dataBinding,
    inferred: f.inferred,
    weight: f.type === "table" ? 4 : f.type === "textarea" ? 2 : 1,
  };
}

/* ── Shared header ───────────────────────────────────────────────────── */

function headerRegion(c: MockContext): Region {
  const navTargets = c.screens.filter((s) => {
    const k = c.kinds.get(s.id)!;
    return k === "dashboard" || k === "list";
  });
  const targets = navTargets.length
    ? navTargets
    : c.screens.filter(
        (s) => !isAuthKind(c.kinds.get(s.id)!) && c.kinds.get(s.id) !== "form",
      );
  const login = c.screens.find((s) => c.kinds.get(s.id) === "login");
  const settings = c.screens.find((s) => c.kinds.get(s.id) === "settings");
  const dashboard = c.screens.find((s) => c.kinds.get(s.id) === "dashboard");
  const elements: El[] = [
    {
      key: "logo",
      type: "logo",
      label: c.project.name,
      description: `Product logo and name "${c.project.name}" at the far left of the header.`,
      behavior:
        dashboard && dashboard.id !== c.screen.id
          ? `Selecting the logo opens the ${dashboard.name} screen.`
          : "Selecting the logo returns to the start screen.",
      nav: dashboard && dashboard.id !== c.screen.id ? dashboard.id : undefined,
      box: { x: 1.5, y: 1.5, width: 12, height: 4.5 },
    },
  ];
  targets.forEach((t, i) => {
    const active = t.id === c.screen.id;
    elements.push({
      key: `nav_${t.name}`,
      type: "link",
      label: t.name,
      description: `Main navigation link "${t.name}" in the header${active ? " (current page)" : ""}.`,
      states: active
        ? [
            "active — highlighted with an underline because this is the current page",
          ]
        : ["default", "hover"],
      behavior: `Opens the ${t.name} screen.`,
      nav: active ? undefined : t.id,
      box: { x: 17 + i * 10, y: 2, width: 8.5, height: 3.5 },
    });
  });
  elements.push(
    {
      key: "notifications",
      type: "icon_button",
      label: "Notifications",
      description:
        "Bell icon button with an unread-count badge, right side of the header.",
      states: [
        "badge shows the number of unread notifications",
        "badge hidden when there are none",
      ],
      behavior: "Opens a panel listing the latest notifications.",
      inferred: ["behavior"],
      box: { x: 86, y: 1.5, width: 3.5, height: 4.5 },
    },
    {
      key: "user_menu",
      type: "menu",
      label: "Anna Berg",
      description:
        "Avatar with the signed-in user's name at the far right of the header; opens the user menu.",
      options: ["My profile", "Settings", "Sign out"],
      behavior: `Opens a menu; "Sign out" ends the session and returns to the ${login?.name ?? "sign-in"} screen${settings ? `; "Settings" opens the ${settings.name} screen` : ""}.`,
      nav: login?.id,
      navHint: login
        ? undefined
        : "Sign-in page (not among the uploaded screens)",
      data: "currentUser.displayName",
      box: { x: 90.5, y: 1.5, width: 8, height: 4.5 },
    },
  );
  return {
    key: "header",
    name: "Header",
    purpose:
      "Application header shared by all signed-in screens: logo, main navigation, notifications and user menu.",
    layout: "full-width top bar, ~64px high",
    box: { x: 0, y: 0, width: 100, height: 7.5 },
    flow: "row",
    elements,
  };
}

/* ── Templates ───────────────────────────────────────────────────────── */

function loginTemplate(c: MockContext): ScreenTemplate {
  const landing = landingScreen(c);
  const forgot = c.screens.find((s) => c.kinds.get(s.id) === "forgot");
  const signup = c.screens.find((s) => c.kinds.get(s.id) === "signup");
  // A tagline is one short sentence; a long description sentence would be cut mid-word, so use a neutral line then.
  const firstSentence = oneLine(
    c.project.description.split(/(?<=[.!?])\s/)[0] ?? "",
    1000,
  );
  const tagline =
    firstSentence && firstSentence.length <= 140
      ? firstSentence
      : `Sign in to continue to ${c.project.name}.`;
  return {
    title: "Sign in",
    purpose: `Lets a registered ${c.persona.toLowerCase()} sign in to ${c.project.name} with email and password or single sign-on.`,
    screenType: "auth",
    dataEntities: ["User account"],
    openQuestions: [
      "Is single sign-on mandatory for some users, or offered alongside email and password?",
      'How long does "Remember me" keep the user signed in?',
      "After how many failed attempts is the account locked, and for how long?",
    ],
    regions: [
      {
        key: "brand_panel",
        name: "Brand panel",
        purpose: "Introduces the product next to the sign-in form.",
        layout: "left half, full height, brand colour background",
        box: { x: 0, y: 0, width: 45, height: 100 },
        flow: "column",
        elements: [
          {
            key: "logo",
            type: "logo",
            label: c.project.name,
            description: `Product logo and name "${c.project.name}" at the top of the brand panel.`,
            weight: 1,
          },
          {
            key: "welcome_heading",
            type: "heading",
            label: `Welcome to ${c.project.name}`,
            description:
              "Large welcome heading in the middle of the brand panel.",
            weight: 1.4,
          },
          {
            key: "tagline",
            type: "text",
            label: tagline,
            description: "Short product tagline below the welcome heading.",
            weight: 1,
          },
        ],
      },
      {
        key: "sign_in_form",
        name: "Sign-in form",
        purpose: "Collects the user's credentials and signs them in.",
        layout: "centred card ~400px wide in the right half",
        box: { x: 54, y: 16, width: 36, height: 60 },
        flow: "column",
        elements: [
          {
            key: "form_heading",
            type: "heading",
            label: "Sign in",
            description: "Card heading at the top of the sign-in form.",
            weight: 0.8,
          },
          {
            key: "email",
            type: "email_input",
            label: "Email address",
            placeholder: "you@company.com",
            required: true,
            description: "Email field, first field of the sign-in form.",
            validation: [
              "Mandatory",
              "Must be a valid email address (name@domain.tld), max 254 characters",
              'Inline error "Enter a valid email address" when focus leaves an invalid value',
            ],
            states: ["red border while the value is invalid"],
            behavior:
              "Captures the user's sign-in email; leading and trailing spaces are trimmed.",
            data: "user.email",
            inferred: ["validation"],
          },
          {
            key: "password",
            type: "password_input",
            label: "Password",
            placeholder: "Enter your password",
            required: true,
            description:
              "Password field with an eye icon to show or hide the characters, below Email address.",
            validation: [
              "Mandatory",
              "Not checked for strength at sign-in; compared with the stored password",
            ],
            states: ["masked by default"],
            behavior:
              "Selecting the eye icon toggles between hidden and visible characters.",
            data: "user.password",
            inferred: ["validation"],
          },
          {
            key: "remember_me",
            type: "checkbox",
            label: "Remember me",
            defaultValue: "Unchecked",
            required: false,
            description: "Checkbox below the password field, left aligned.",
            behavior:
              "When checked, the session is kept for 30 days instead of ending when the browser closes.",
            inferred: ["behavior"],
            weight: 0.7,
          },
          {
            key: "forgot_password",
            type: "link",
            label: "Forgot password?",
            description:
              'Text link on the same row as "Remember me", right aligned.',
            behavior: "Opens the password reset flow.",
            nav: forgot?.id,
            navHint: forgot
              ? undefined
              : "Password reset page (not among the uploaded screens)",
            weight: 0.7,
          },
          {
            key: "sign_in",
            type: "button",
            label: "Sign in",
            description: "Primary full-width button at the bottom of the form.",
            states: [
              "disabled until Email address and Password are filled",
              "loading spinner while signing in",
            ],
            behavior: `Submits the credentials; on success opens the ${landing?.name ?? "start"} screen.`,
            nav: landing?.id,
          },
          {
            key: "error_banner",
            type: "alert",
            label: "Incorrect email address or password. Please try again.",
            description: "Red error banner above the form fields.",
            states: ["hidden until a sign-in attempt fails"],
            behavior:
              'Shown after a failed sign-in attempt; after 5 consecutive failures it reads "Your account is locked for 15 minutes."',
            inferred: ["states", "behavior"],
          },
        ],
      },
      {
        key: "single_sign_on",
        name: "Single sign-on",
        purpose: "Alternative sign-in with the company identity provider.",
        layout: "below the form card, same width",
        box: { x: 54, y: 78, width: 36, height: 16 },
        flow: "column",
        elements: [
          {
            key: "sso_divider",
            type: "divider",
            label: "or",
            description:
              'Horizontal divider with the word "or" between the form and single sign-on.',
            weight: 0.5,
          },
          {
            key: "sso_microsoft",
            type: "button",
            label: "Sign in with Microsoft",
            description: "Secondary full-width button with the Microsoft logo.",
            behavior: `Starts single sign-on with the user's Microsoft Entra ID work account; on success opens the ${landing?.name ?? "start"} screen.`,
            nav: landing?.id,
            inferred: ["behavior"],
          },
          signup
            ? {
                key: "create_account",
                type: "link",
                label: "Create an account",
                description: "Link below the single sign-on button.",
                behavior: `Opens the ${signup.name} screen.`,
                nav: signup.id,
                weight: 0.6,
              }
            : {
                key: "help_text",
                type: "text",
                label: "Need an account? Contact your administrator.",
                description: "Help text at the bottom of the screen.",
                weight: 0.6,
              },
        ],
      },
    ],
  };
}

function signupTemplate(c: MockContext): ScreenTemplate {
  const landing = landingScreen(c);
  const login = c.screens.find((s) => c.kinds.get(s.id) === "login");
  return {
    title: "Create account",
    purpose: `Lets a new ${c.persona.toLowerCase()} create an account for ${c.project.name}.`,
    screenType: "auth",
    dataEntities: ["User account", "Company"],
    openQuestions: [
      "Must new accounts be approved by an administrator before first sign-in?",
      "Which email domains are allowed to register?",
    ],
    regions: [
      {
        key: "sign_up_form",
        name: "Sign-up form",
        purpose: "Collects the details needed to create an account.",
        layout: "centred card ~480px wide",
        box: { x: 30, y: 8, width: 40, height: 84 },
        flow: "column",
        elements: [
          {
            key: "form_heading",
            type: "heading",
            label: "Create your account",
            description: "Card heading.",
            weight: 0.8,
          },
          {
            key: "full_name",
            type: "text_input",
            label: "Full name",
            required: true,
            description: "First field of the form.",
            validation: ["Mandatory", "Between 2 and 100 characters"],
            data: "user.fullName",
            inferred: ["validation"],
          },
          {
            key: "work_email",
            type: "email_input",
            label: "Work email",
            placeholder: "you@company.com",
            required: true,
            description: "Email field below Full name.",
            validation: [
              "Mandatory",
              "Valid email address, max 254 characters",
              'Must not already be registered — inline error "An account with this email already exists"',
            ],
            data: "user.email",
            inferred: ["validation"],
          },
          {
            key: "company",
            type: "text_input",
            label: "Company name",
            required: true,
            description: "Company field below Work email.",
            validation: ["Mandatory", "Max 120 characters"],
            data: "company.name",
            inferred: ["validation"],
          },
          {
            key: "password",
            type: "password_input",
            label: "Password",
            required: true,
            helperText:
              "At least 12 characters, including a number and a symbol",
            description: "Password field with a strength meter.",
            validation: [
              "Mandatory",
              "At least 12 characters including at least one number and one symbol",
              "Strength meter shows Weak / Fair / Strong",
            ],
            data: "user.password",
          },
          {
            key: "confirm_password",
            type: "password_input",
            label: "Confirm password",
            required: true,
            description: "Repeat-password field.",
            validation: [
              "Mandatory",
              'Must match Password — inline error "Passwords do not match"',
            ],
            inferred: ["validation"],
          },
          {
            key: "accept_terms",
            type: "checkbox",
            label: "I agree to the Terms of Service and Privacy Policy",
            required: true,
            defaultValue: "Unchecked",
            description: "Consent checkbox with links to the terms.",
            validation: ["Must be checked to create the account"],
          },
          {
            key: "create_account",
            type: "button",
            label: "Create account",
            description: "Primary full-width submit button.",
            states: [
              "disabled until the form is valid",
              "loading while creating the account",
            ],
            behavior: `Creates the account and signs the user in; opens the ${landing?.name ?? "start"} screen.`,
            nav: landing?.id,
          },
          {
            key: "sign_in_link",
            type: "link",
            label: "Already have an account? Sign in",
            description: "Link below the submit button.",
            behavior: "Opens the sign-in screen.",
            nav: login?.id,
            navHint: login ? undefined : "Sign-in page",
            weight: 0.6,
          },
        ],
      },
    ],
  };
}

function forgotTemplate(c: MockContext): ScreenTemplate {
  const login = c.screens.find((s) => c.kinds.get(s.id) === "login");
  return {
    title: "Reset password",
    purpose:
      "Lets a user who forgot their password request a reset link by email.",
    screenType: "auth",
    dataEntities: ["User account"],
    openQuestions: ["How long is the reset link valid?"],
    regions: [
      {
        key: "reset_form",
        name: "Password reset form",
        purpose: "Requests a password reset link.",
        layout: "centred card ~400px wide",
        box: { x: 32, y: 20, width: 36, height: 56 },
        flow: "column",
        elements: [
          {
            key: "form_heading",
            type: "heading",
            label: "Reset your password",
            description: "Card heading.",
            weight: 0.8,
          },
          {
            key: "instructions",
            type: "text",
            label:
              "Enter the email address you use to sign in and we will send you a link to reset your password.",
            description: "Instruction text below the heading.",
          },
          {
            key: "email",
            type: "email_input",
            label: "Email address",
            placeholder: "you@company.com",
            required: true,
            description: "Email field.",
            validation: [
              "Mandatory",
              "Valid email address, max 254 characters",
            ],
            data: "user.email",
            inferred: ["validation"],
          },
          {
            key: "send_link",
            type: "button",
            label: "Send reset link",
            description: "Primary button.",
            states: [
              "disabled until a valid email is entered",
              "loading while sending",
            ],
            behavior:
              "Requests a reset email and shows the confirmation banner.",
          },
          {
            key: "confirmation",
            type: "alert",
            label:
              "If an account exists for this email, we've sent a link to reset your password.",
            description: "Green confirmation banner.",
            states: ["hidden until the link is requested"],
            inferred: ["states"],
          },
          {
            key: "back_to_sign_in",
            type: "link",
            label: "Back to sign in",
            description: "Link at the bottom of the card.",
            behavior: "Returns to the sign-in screen.",
            nav: login?.id,
            navHint: login ? undefined : "Sign-in page",
            weight: 0.6,
          },
        ],
      },
    ],
  };
}

function dashboardTemplate(c: MockContext): ScreenTemplate {
  const e = c.entity;
  const list = firstScreenOf(c, ["list"], e) ?? firstScreenOf(c, ["list"]);
  const form = firstScreenOf(c, ["form"], e) ?? firstScreenOf(c, ["form"]);
  const detail = firstScreenOf(c, ["detail"], e);
  const plural = e.plural;
  return {
    title: c.screen.name,
    purpose: `Gives the ${c.persona.toLowerCase()} an overview of key ${e.singular} metrics, recent ${plural} and quick actions after signing in.`,
    screenType: "dashboard",
    dataEntities: [titleCase(e.singular), "KPI"],
    openQuestions: [
      `Are the KPI values limited to the ${plural} the signed-in user owns, or company-wide?`,
      "How often are the dashboard figures refreshed?",
    ],
    regions: [
      headerRegion(c),
      {
        key: "page_header",
        name: "Page header",
        purpose: "Page title and personal greeting.",
        layout: "full-width title row",
        box: { x: 3, y: 9, width: 94, height: 7 },
        flow: "row",
        elements: [
          {
            key: "page_title",
            type: "heading",
            label: c.screen.name,
            description: "Page heading at the top left of the content area.",
          },
          {
            key: "greeting",
            type: "text",
            label: "Good morning, Anna — here is what is happening today.",
            description:
              "Greeting text next to the page heading, using the signed-in user's first name.",
            data: "currentUser.firstName",
          },
        ],
      },
      {
        key: "kpis",
        name: "Key metrics",
        purpose: `Headline figures about ${plural} for the selected period.`,
        layout: "row of 4 equal tiles with a period selector above",
        box: { x: 3, y: 17, width: 94, height: 18 },
        flow: "grid",
        cols: 5,
        elements: [
          {
            key: "period",
            type: "dropdown",
            label: "Period",
            defaultValue: "Last 30 days",
            options: [
              "Today",
              "Last 7 days",
              "Last 30 days",
              "This quarter",
              "Year to date",
            ],
            required: true,
            description: "Period selector above the KPI tiles, right aligned.",
            behavior:
              "Changing the period reloads all KPI tiles and the chart for that period.",
            data: "dashboard.period",
          },
          ...e.kpis.map((k): El => ({
            key: `kpi_${k}`,
            type: "tile",
            label: k,
            description: `KPI tile "${k}" showing the current value and the change versus the previous period.`,
            behavior: `Shows the ${k.toLowerCase()} for the selected period with a trend indicator (▲/▼ %).${list ? ` Selecting the tile opens the ${list.name} screen filtered accordingly.` : ""}`,
            nav: list?.id,
            data: `kpi.${k.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
            states: ["loading skeleton while figures load"],
            inferred: ["behavior"],
          })),
        ],
      },
      {
        key: "trend_chart",
        name: `${e.chartLabel} chart`,
        purpose: `Trend of ${plural} over the selected period.`,
        layout: "wide card, left two thirds",
        box: { x: 3, y: 37, width: 61, height: 34 },
        flow: "column",
        elements: [
          {
            key: "chart_view",
            type: "tabs",
            label: "Chart view",
            options: ["Count", "Value"],
            defaultValue: "Count",
            description:
              "Segmented control at the top right of the chart card.",
            behavior:
              "Switches the chart between the number and the value of " +
              plural +
              ".",
            weight: 0.5,
          },
          {
            key: "trend_chart",
            type: "chart",
            label: e.chartLabel,
            description: `Bar chart "${e.chartLabel}" with one bar per week.`,
            behavior:
              "Hovering a bar shows the week and the exact figure in a tooltip.",
            data: `${e.singular}.countPerWeek`,
            states: ['empty: "No data for this period"'],
            weight: 4,
          },
        ],
      },
      {
        key: "quick_actions",
        name: "Quick actions",
        purpose: "Shortcuts to the most common tasks.",
        layout: "narrow card, right third",
        box: { x: 66, y: 37, width: 31, height: 34 },
        flow: "column",
        elements: [
          {
            key: "quick_actions_heading",
            type: "heading",
            label: "Quick actions",
            description: "Card heading.",
            weight: 0.6,
          },
          {
            key: `new_${e.id}`,
            type: "button",
            label: `New ${e.singular}`,
            description: "Primary button in the Quick actions card.",
            behavior: form
              ? `Opens the ${form.name} screen.`
              : `Starts a new ${e.singular}.`,
            nav: form?.id,
            navHint: form
              ? undefined
              : `New ${e.singular} form (not among the uploaded screens)`,
          },
          {
            key: `import_${e.plural}`,
            type: "button",
            label: `Import ${plural}`,
            description: "Secondary button below the primary action.",
            behavior: `Opens a dialog to upload a CSV file of ${plural} (max 5 MB, template provided).`,
            inferred: ["behavior"],
          },
          {
            key: "download_report",
            type: "link",
            label: "Download monthly report",
            description: "Text link at the bottom of the card.",
            behavior: "Downloads the current month's report as a PDF.",
            navHint: "PDF download",
            inferred: ["behavior"],
          },
        ],
      },
      {
        key: `recent_${e.plural}`,
        name: `Recent ${plural}`,
        purpose: `The most recently updated ${plural}.`,
        layout: "full-width card with a table",
        box: { x: 3, y: 73, width: 94, height: 25 },
        flow: "column",
        elements: [
          {
            key: "recent_heading",
            type: "heading",
            label: `Recent ${plural}`,
            description: "Card heading.",
            weight: 0.5,
          },
          {
            key: `recent_${e.plural}_table`,
            type: "table",
            label: `Recent ${plural}`,
            options: e.columns.slice(0, 5),
            description: `Table of the 5 most recently updated ${plural}.`,
            behavior: `Shows the 5 most recently updated ${plural}, newest first.${detail ? ` Selecting a row opens the ${detail.name} screen.` : ""}`,
            nav: detail?.id,
            data: `${e.singular}[]`,
            states: [`empty: "No ${plural} yet"`],
            weight: 3,
          },
          {
            key: `view_all_${e.plural}`,
            type: "link",
            label: `View all ${plural}`,
            description: "Link at the bottom right of the card.",
            behavior: list
              ? `Opens the ${list.name} screen.`
              : `Opens the full list of ${plural}.`,
            nav: list?.id,
            weight: 0.5,
          },
        ],
      },
    ],
  };
}

function listTemplate(c: MockContext): ScreenTemplate {
  const e = c.entity;
  const form = firstScreenOf(c, ["form"], e);
  const detail = firstScreenOf(c, ["detail"], e);
  const title = titleCase(e.plural);
  const dateColumn =
    e.columns.find((col) => /date|created|sign-in/i.test(col)) ?? "Created";
  const bulkAction = e.rowActions[e.rowActions.length - 1] ?? "Archive";
  return {
    title: c.screen.name,
    purpose: `Lets the ${c.persona.toLowerCase()} find, review and act on ${e.plural}.`,
    screenType: "list",
    dataEntities: [titleCase(e.singular)],
    openQuestions: [
      `Does the list show all ${e.plural} or only those the signed-in user is responsible for?`,
      "Which columns are sortable, and what is the default sort order?",
    ],
    regions: [
      headerRegion(c),
      {
        key: "page_header",
        name: "Page header",
        purpose: `Title, ${e.singular} count and the main action.`,
        layout: "full-width title row",
        box: { x: 3, y: 9, width: 94, height: 7 },
        flow: "row",
        elements: [
          {
            key: "page_title",
            type: "heading",
            label: title,
            description: "Page heading at the top left of the content area.",
          },
          {
            key: "result_count",
            type: "text",
            label: `248 ${e.plural}`,
            description:
              "Total count next to the heading; reflects the active filters.",
            data: `${e.singular}.count`,
          },
          {
            key: `new_${e.id}`,
            type: "button",
            label: `New ${e.singular}`,
            description: "Primary button at the top right of the page.",
            behavior: form
              ? `Opens the ${form.name} screen.`
              : `Opens the form to create a new ${e.singular}.`,
            nav: form?.id,
            navHint: form
              ? undefined
              : `New ${e.singular} form (not among the uploaded screens)`,
          },
        ],
      },
      {
        key: "filters",
        name: "Filter bar",
        purpose: `Narrows the ${e.singular} list.`,
        layout: "single row of filters above the table",
        box: { x: 3, y: 17, width: 94, height: 7 },
        flow: "row",
        elements: [
          {
            key: "search",
            type: "search_input",
            label: "",
            placeholder: e.searchPlaceholder,
            required: false,
            description: "Search box at the left of the filter bar.",
            validation: [
              "Optional",
              "Search starts after 2 characters, 300 ms after typing stops",
              "Matches anywhere in the searched fields, case-insensitive",
            ],
            behavior: "Filters the table as the user types.",
            inferred: ["validation"],
          },
          {
            key: "status_filter",
            type: "dropdown",
            label: "Status",
            defaultValue: "All statuses",
            options: ["All statuses", ...e.statuses],
            required: false,
            description: "Status filter next to the search box.",
            behavior: `Shows only ${e.plural} with the selected status.`,
            data: `${e.singular}.status`,
          },
          {
            key: "date_filter",
            type: "date_range_picker",
            label: dateColumn,
            placeholder: "From – To",
            required: false,
            description: `Date range filter on ${dateColumn.toLowerCase()}.`,
            validation: [
              "Optional",
              '"To" must be the same as or later than "From"',
              "Dates in dd/mm/yyyy format",
            ],
            inferred: ["validation"],
          },
          {
            key: "clear_filters",
            type: "link",
            label: "Clear filters",
            description: "Link at the right end of the filter bar.",
            states: ["hidden while no filter is applied"],
            behavior:
              "Resets search, status and date filters to their defaults.",
          },
        ],
      },
      {
        key: `${e.plural}_table`,
        name: `${title} table`,
        purpose: `Lists the ${e.plural} that match the filters.`,
        layout: "full-width data table",
        box: { x: 3, y: 25, width: 94, height: 58 },
        flow: "column",
        elements: [
          {
            key: `${e.plural}_table`,
            type: "table",
            label: `${title}`,
            options: e.columns,
            description: `Data table with one row per ${e.singular}; columns ${e.columns.join(", ")}.`,
            behavior: `Selecting a column header sorts by that column; selecting a row opens the ${e.singular}${detail ? ` on the ${detail.name} screen` : ""}.`,
            nav: detail?.id,
            navHint: detail
              ? undefined
              : `${titleCase(e.singular)} detail page (not among the uploaded screens)`,
            data: `${e.singular}[]`,
            states: [
              "loading skeleton rows",
              "sorted by the newest first by default",
            ],
            inferred: ["behavior"],
            weight: 6,
          },
          {
            key: "status_badge",
            type: "badge",
            label: "Status",
            options: e.statuses,
            description:
              "Coloured status badge in the Status column of each row.",
            behavior:
              "Colour per status (grey Draft, blue in progress, green completed, red cancelled).",
            data: `${e.singular}.status`,
            inferred: ["behavior"],
            weight: 0.5,
          },
          {
            key: "empty_state",
            type: "text",
            label: `No ${e.plural} match your search or filters.`,
            description:
              "Empty-state message shown in place of the table rows.",
            states: ["shown only when no row matches"],
            weight: 0.6,
          },
        ],
      },
      {
        key: "row_actions",
        name: "Row and bulk actions",
        purpose: `Actions on one or several ${e.plural}.`,
        layout:
          "checkbox column, kebab menu per row and a bulk action bar above the table",
        box: { x: 3, y: 25, width: 94, height: 5 },
        flow: "row",
        elements: [
          {
            key: "select_all",
            type: "checkbox",
            label: "Select all",
            defaultValue: "Unchecked",
            description:
              "Checkbox in the table header; each row has its own checkbox.",
            behavior:
              "Selects or clears all rows on the current page and shows the bulk action bar.",
          },
          {
            key: "row_menu",
            type: "menu",
            label: "More actions",
            options: e.rowActions,
            description: "Kebab (⋮) menu at the end of each row.",
            behavior: `Each item applies to that ${e.singular}; destructive actions ask for confirmation.`,
            inferred: ["behavior"],
          },
          {
            key: "export_selected",
            type: "button",
            label: "Export CSV",
            description: "Secondary button in the bulk action bar.",
            behavior: `Downloads the selected ${e.plural} (or all filtered ${e.plural} when none are selected) as a CSV file.`,
            inferred: ["behavior"],
          },
          {
            key: "bulk_action",
            type: "button",
            label: `${bulkAction.replace(new RegExp(`\\s*${e.singular}$`, "i"), "")} selected`,
            description: "Destructive button in the bulk action bar.",
            states: ["disabled until at least one row is selected"],
            behavior: `Asks for confirmation, then applies "${bulkAction}" to every selected ${e.singular} it is allowed for.`,
            inferred: ["behavior"],
          },
        ],
      },
      {
        key: "pagination",
        name: "Pagination",
        purpose: "Moves between pages of results.",
        layout: "row below the table",
        box: { x: 3, y: 85, width: 94, height: 6 },
        flow: "row",
        elements: [
          {
            key: "range_text",
            type: "text",
            label: `Showing 1–25 of 248`,
            description: "Range of rows shown, left of the pager.",
            data: "pagination.range",
          },
          {
            key: "page_size",
            type: "dropdown",
            label: "Rows per page",
            defaultValue: "25",
            options: ["10", "25", "50", "100"],
            required: false,
            description: "Page-size selector in the middle of the row.",
            behavior:
              "Changes the number of rows per page and returns to page 1.",
          },
          {
            key: "pager",
            type: "pagination",
            label: "Pagination",
            description: "Previous / page numbers / Next control at the right.",
            states: [
              "Previous disabled on the first page",
              "Next disabled on the last page",
            ],
            behavior: "Moves to the selected page.",
          },
        ],
      },
    ],
  };
}

function formTemplate(c: MockContext): ScreenTemplate {
  const e = c.entity;
  const list =
    firstScreenOf(c, ["list"], e) ?? firstScreenOf(c, ["list", "dashboard"]);
  const editing = /\b(edit|update)\b/i.test(c.screen.name);
  const heading = editing
    ? `Edit ${e.singular} ${e.sampleId}`
    : `New ${e.singular}`;
  const sectionCount = e.sections.length;
  const top = 18;
  const available = 80;
  const regions: Region[] = [
    headerRegion(c),
    {
      key: "page_header",
      name: "Page header",
      purpose: "Breadcrumb, title and form instructions.",
      layout: "full-width title row",
      box: { x: 3, y: 9, width: 94, height: 8 },
      flow: "row",
      elements: [
        {
          key: "breadcrumb",
          type: "breadcrumb",
          label: `${titleCase(e.plural)} / ${heading}`,
          options: [titleCase(e.plural), heading],
          description: "Breadcrumb above the page heading.",
          behavior: list
            ? `The first crumb opens the ${list.name} screen.`
            : "The first crumb returns to the list.",
          nav: list?.id,
        },
        {
          key: "page_title",
          type: "heading",
          label: heading,
          description: "Page heading.",
        },
        {
          key: "required_hint",
          type: "text",
          label: "Fields marked * are required.",
          description: "Hint text under the heading.",
        },
      ],
    },
  ];
  e.sections.forEach((section, i) => {
    const fields = section.fields.map((f) => {
      const el = fieldToEl(f, section.name);
      if (/^(submit|save)$/.test(f.key)) {
        el.label = editing ? "Save changes" : f.label;
        if (list) {
          el.nav = list.id;
          const behavior = f.behavior ?? "Saves the form.";
          // Say where it goes only once ("… returns to the order list" already does).
          el.behavior = /\b(returns? to|opens|goes to|navigates to)\b/i.test(
            behavior,
          )
            ? behavior
            : `${behavior} Then opens the ${list.name} screen.`;
        }
      }
      if (f.key === "cancel" && list) el.nav = list.id;
      return el;
    });
    const height = available / sectionCount - 2;
    regions.push({
      key: section.key,
      name: section.name,
      purpose: section.purpose,
      layout:
        i === sectionCount - 1
          ? "card with the form totals and action buttons"
          : "card with a two-column form grid",
      box: { x: 3, y: top + i * (available / sectionCount), width: 94, height },
      flow: fields.some((f) => f.type === "table") ? "column" : "grid",
      cols: 2,
      elements: fields,
    });
  });
  return {
    title: heading,
    purpose: `Lets the ${c.persona.toLowerCase()} ${editing ? "change" : "capture"} ${/^[aeiou]/i.test(e.singular) ? "an" : "a"} ${e.singular} with all mandatory details and submit it.`,
    screenType: "form",
    dataEntities: [
      titleCase(e.singular),
      ...(e.id === "order" ? ["Order line", "Customer", "Product"] : []),
    ],
    openQuestions: [
      `Can ${/^[aeiou]/i.test(e.singular) ? "an" : "a"} ${e.singular} be saved as a draft without all mandatory fields?`,
      ...(e.id === "order"
        ? [
            "Which customers can the user select — all active accounts or only the ones assigned to them?",
            "Is there a maximum number of order lines per order?",
          ]
        : [
            `Who is notified when ${/^[aeiou]/i.test(e.singular) ? "an" : "a"} ${e.singular} is saved?`,
          ]),
    ],
    regions,
  };
}

function detailTemplate(c: MockContext): ScreenTemplate {
  const e = c.entity;
  const list = firstScreenOf(c, ["list"], e) ?? firstScreenOf(c, ["list"]);
  const form = firstScreenOf(c, ["form"], e);
  const heading = `${titleCase(e.singular)} ${e.sampleId}`;
  return {
    title: heading,
    purpose: `Shows everything about one ${e.singular} and the actions available on it.`,
    screenType: "detail",
    dataEntities: [titleCase(e.singular)],
    openQuestions: [`Which actions are allowed for each ${e.singular} status?`],
    regions: [
      headerRegion(c),
      {
        key: "page_header",
        name: "Page header",
        purpose: `Identifies the ${e.singular} and offers its main actions.`,
        layout: "full-width title row",
        box: { x: 3, y: 9, width: 94, height: 9 },
        flow: "row",
        elements: [
          {
            key: "breadcrumb",
            type: "breadcrumb",
            label: `${titleCase(e.plural)} / ${heading}`,
            options: [titleCase(e.plural), heading],
            description: "Breadcrumb above the heading.",
            behavior: list
              ? `The first crumb opens the ${list.name} screen.`
              : "The first crumb returns to the list.",
            nav: list?.id,
          },
          {
            key: "page_title",
            type: "heading",
            label: heading,
            description: "Page heading with the identifier.",
          },
          {
            key: "status",
            type: "badge",
            label: e.statuses[1] ?? "Active",
            options: e.statuses,
            description: "Status badge next to the heading.",
            data: `${e.singular}.status`,
          },
          {
            key: "edit",
            type: "button",
            label: "Edit",
            description: "Primary button at the top right.",
            states: [`hidden when the ${e.singular} is closed or cancelled`],
            behavior: form
              ? `Opens the ${form.name} screen for this ${e.singular}.`
              : `Opens the ${e.singular} in edit mode.`,
            nav: form?.id,
            inferred: ["states"],
          },
          {
            key: "more_actions",
            type: "menu",
            label: "More actions",
            options: e.rowActions.filter((a) => !/^view/i.test(a)),
            description: "Kebab menu next to Edit.",
            behavior: "Destructive actions ask for confirmation.",
            inferred: ["behavior"],
          },
        ],
      },
      {
        key: "summary",
        name: "Summary",
        purpose: `Key facts of the ${e.singular}.`,
        layout: "card with a 3-column key/value grid",
        box: { x: 3, y: 20, width: 94, height: 20 },
        flow: "grid",
        cols: 3,
        elements: e.columns.slice(1).map((col): El => ({
          key: `field_${col}`,
          type: "text",
          label: col,
          description: `Read-only "${col}" value in the summary card.`,
          data: `${e.singular}.${col.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
        })),
      },
      {
        key: "detail_tabs",
        name: "Detail tabs",
        purpose: `Further information about the ${e.singular}.`,
        layout: "tab bar with a content panel",
        box: { x: 3, y: 42, width: 94, height: 54 },
        flow: "column",
        elements: [
          {
            key: "tabs",
            type: "tabs",
            label: "Sections",
            options: ["Overview", "Activity", "Documents"],
            defaultValue: "Overview",
            description: "Tab bar at the top of the panel.",
            behavior:
              "Switches the content panel; the selected tab is underlined.",
            weight: 0.6,
          },
          {
            key: "activity_list",
            type: "list",
            label: "Activity",
            description:
              "Chronological list of changes with user, date and description.",
            behavior:
              'Newest first; shows 20 entries with "Load more" at the end.',
            data: `${e.singular}.history[]`,
            states: ['empty: "No activity yet"'],
            inferred: ["behavior"],
            weight: 4,
          },
        ],
      },
    ],
  };
}

function settingsTemplate(c: MockContext): ScreenTemplate {
  return {
    title: c.screen.name,
    purpose:
      "Lets the signed-in user maintain their profile and notification preferences.",
    screenType: "settings",
    dataEntities: ["User profile", "Notification preferences"],
    openQuestions: [
      "Can users change their own email address, or only an administrator?",
    ],
    regions: [
      headerRegion(c),
      {
        key: "page_header",
        name: "Page header",
        purpose: "Title and settings sections.",
        layout: "title row with a tab bar",
        box: { x: 3, y: 9, width: 94, height: 10 },
        flow: "column",
        elements: [
          {
            key: "page_title",
            type: "heading",
            label: "Settings",
            description: "Page heading.",
          },
          {
            key: "settings_tabs",
            type: "tabs",
            label: "Settings sections",
            options: ["Profile", "Security", "Notifications"],
            defaultValue: "Profile",
            description: "Tab bar under the heading.",
            behavior: "Switches between settings sections.",
          },
        ],
      },
      {
        key: "profile_form",
        name: "Profile",
        purpose: "Personal details and regional preferences.",
        layout: "card with a two-column form grid",
        box: { x: 3, y: 21, width: 94, height: 40 },
        flow: "grid",
        cols: 2,
        elements: [
          {
            key: "full_name",
            type: "text_input",
            label: "Full name",
            defaultValue: "Anna Berg",
            required: true,
            description: "First field of the profile form.",
            validation: ["Mandatory", "Between 2 and 100 characters"],
            data: "user.fullName",
            inferred: ["validation"],
          },
          {
            key: "email",
            type: "email_input",
            label: "Email address",
            defaultValue: "anna.berg@example.com",
            description: "Read-only email field.",
            states: ["read-only"],
            data: "user.email",
          },
          {
            key: "phone",
            type: "phone_input",
            label: "Phone number",
            placeholder: "+44 20 7946 0000",
            required: false,
            description: "Phone field.",
            validation: [
              "Optional",
              'International format starting with "+", 8–15 digits',
            ],
            data: "user.phone",
            inferred: ["validation"],
          },
          {
            key: "language",
            type: "dropdown",
            label: "Language",
            defaultValue: "English (UK)",
            options: [
              "English (UK)",
              "English (US)",
              "Deutsch",
              "Français",
              "Español",
            ],
            required: true,
            description: "Language dropdown.",
            behavior: "Changes the interface language after saving.",
            data: "user.locale",
          },
          {
            key: "time_zone",
            type: "dropdown",
            label: "Time zone",
            defaultValue: "(UTC+00:00) London",
            options: [
              "(UTC-05:00) New York",
              "(UTC+00:00) London",
              "(UTC+01:00) Berlin",
              "(UTC+08:00) Singapore",
            ],
            required: true,
            description: "Time zone dropdown.",
            behavior: "All dates and times are shown in this time zone.",
            data: "user.timeZone",
            inferred: ["options"],
          },
        ],
      },
      {
        key: "notifications",
        name: "Notifications",
        purpose: "Email notification preferences.",
        layout: "card with toggles",
        box: { x: 3, y: 63, width: 94, height: 18 },
        flow: "column",
        elements: [
          {
            key: "email_notifications",
            type: "toggle",
            label: "Email notifications",
            defaultValue: "On",
            description: "Toggle in the Notifications card.",
            behavior:
              "Sends an email when something needs the user's attention.",
            data: "user.notifyByEmail",
          },
          {
            key: "weekly_summary",
            type: "toggle",
            label: "Weekly summary email",
            defaultValue: "Off",
            description: "Toggle below Email notifications.",
            behavior:
              "Sends a summary every Monday at 08:00 in the user's time zone.",
            data: "user.weeklySummary",
            inferred: ["behavior"],
          },
        ],
      },
      {
        key: "form_actions",
        name: "Form actions",
        purpose: "Saves or discards the changes.",
        layout: "right-aligned button row",
        box: { x: 60, y: 84, width: 37, height: 7 },
        flow: "row",
        elements: [
          {
            key: "cancel",
            type: "button",
            label: "Cancel",
            description: "Secondary button.",
            behavior: "Discards unsaved changes.",
          },
          {
            key: "save",
            type: "button",
            label: "Save changes",
            description: "Primary button.",
            states: [
              "disabled until something changed and the form is valid",
              "loading while saving",
            ],
            behavior: 'Saves the settings and shows "Settings saved".',
          },
        ],
      },
    ],
  };
}

function checkoutTemplate(c: MockContext): ScreenTemplate {
  return {
    title: c.screen.name,
    purpose:
      "Lets the user confirm delivery and payment details and place the order.",
    screenType: "checkout",
    dataEntities: ["Order", "Delivery address", "Payment"],
    openQuestions: [
      "Which payment methods are offered to which customers?",
      "Can the user save the delivery address for later?",
    ],
    regions: [
      headerRegion(c),
      {
        key: "progress",
        name: "Checkout progress",
        purpose: "Shows the checkout steps.",
        layout: "full-width stepper",
        box: { x: 3, y: 9, width: 94, height: 7 },
        flow: "row",
        elements: [
          {
            key: "stepper",
            type: "stepper",
            label: "Checkout steps",
            options: ["Cart", "Delivery", "Payment", "Review"],
            defaultValue: "Payment",
            description: "Stepper with the current step highlighted.",
            behavior: "Completed steps can be selected to go back.",
          },
        ],
      },
      {
        key: "delivery",
        name: "Delivery address",
        purpose: "Where the order is delivered.",
        layout: "card, left column",
        box: { x: 3, y: 18, width: 60, height: 38 },
        flow: "grid",
        cols: 2,
        elements: [
          {
            key: "recipient",
            type: "text_input",
            label: "Recipient name",
            required: true,
            description: "First field.",
            validation: ["Mandatory", "Max 100 characters"],
            inferred: ["validation"],
          },
          {
            key: "address_line",
            type: "text_input",
            label: "Address line 1",
            required: true,
            description: "Street and number.",
            validation: ["Mandatory", "Max 120 characters"],
            inferred: ["validation"],
          },
          {
            key: "city",
            type: "text_input",
            label: "City",
            required: true,
            description: "City field.",
            validation: ["Mandatory", "Max 60 characters"],
            inferred: ["validation"],
          },
          {
            key: "postcode",
            type: "text_input",
            label: "Postcode",
            required: true,
            description: "Postcode field.",
            validation: [
              "Mandatory",
              "Valid postcode for the selected country",
            ],
            inferred: ["validation"],
          },
          {
            key: "country",
            type: "dropdown",
            label: "Country",
            defaultValue: "United Kingdom",
            options: [
              "United Kingdom",
              "Ireland",
              "Germany",
              "France",
              "Netherlands",
            ],
            required: true,
            description: "Country dropdown.",
            inferred: ["options"],
          },
        ],
      },
      {
        key: "payment",
        name: "Payment",
        purpose: "How the order is paid.",
        layout: "card, left column below delivery",
        box: { x: 3, y: 58, width: 60, height: 30 },
        flow: "column",
        elements: [
          {
            key: "payment_method",
            type: "radio_group",
            label: "Payment method",
            defaultValue: "Invoice (30 days)",
            options: ["Invoice (30 days)", "Credit card", "Bank transfer"],
            required: true,
            description: "Radio group of payment methods.",
            behavior:
              "The selected method decides which further fields are shown.",
          },
          {
            key: "po_reference",
            type: "text_input",
            label: "Purchase order reference",
            required: false,
            description: "Reference printed on the invoice.",
            validation: ["Optional", "Max 30 characters"],
            inferred: ["validation"],
          },
        ],
      },
      {
        key: "summary",
        name: "Order summary",
        purpose: "Totals and the final action.",
        layout: "sticky card, right column",
        box: { x: 66, y: 18, width: 31, height: 50 },
        flow: "column",
        elements: [
          {
            key: "subtotal",
            type: "text",
            label: "Subtotal",
            description: "Sum of the items.",
            data: "order.subtotal",
          },
          {
            key: "shipping",
            type: "text",
            label: "Shipping",
            description: "Shipping cost.",
            data: "order.shippingCost",
          },
          {
            key: "total",
            type: "text",
            label: "Total",
            description: "Grand total including VAT.",
            data: "order.total",
          },
          {
            key: "place_order",
            type: "button",
            label: "Place order",
            description: "Primary full-width button.",
            states: [
              "disabled until delivery and payment are valid",
              "loading while placing the order",
            ],
            behavior:
              "Places the order and shows the confirmation with the order number.",
          },
          {
            key: "back",
            type: "link",
            label: "Back to cart",
            description: "Link below the button.",
            behavior:
              "Returns to the previous step without losing entered data.",
          },
        ],
      },
    ],
  };
}

function genericTemplate(c: MockContext): ScreenTemplate {
  const e = entityFromScreenName(c.screen.name) ?? c.entity;
  const section = e.sections[0]!;
  const actions = e.sections[e.sections.length - 1]!;
  return {
    title: c.screen.name,
    purpose: `${c.screen.name} screen of ${c.project.name}${c.screen.notes ? ` (BA note: ${oneLine(c.screen.notes, 160)})` : ""}.`,
    screenType: "form",
    dataEntities: [titleCase(e.singular)],
    openQuestions: [
      `The purpose of the "${c.screen.name}" screen was inferred from its name only — confirm the fields and actions.`,
    ],
    regions: [
      headerRegion(c),
      {
        key: "page_header",
        name: "Page header",
        purpose: "Screen title.",
        layout: "full-width title row",
        box: { x: 3, y: 9, width: 94, height: 7 },
        flow: "row",
        elements: [
          {
            key: "page_title",
            type: "heading",
            label: c.screen.name,
            description: "Page heading.",
          },
        ],
      },
      {
        key: section.key,
        name: section.name,
        purpose: section.purpose,
        layout: "card with a two-column form grid",
        box: { x: 3, y: 18, width: 94, height: 52 },
        flow: "grid",
        cols: 2,
        elements: section.fields.map((f) => fieldToEl(f, section.name)),
      },
      ...(actions !== section
        ? [
            {
              key: actions.key,
              name: actions.name,
              purpose: actions.purpose,
              layout: "right-aligned button row",
              box: { x: 50, y: 74, width: 47, height: 10 },
              flow: "row" as const,
              elements: actions.fields.map((f) => fieldToEl(f, actions.name)),
            },
          ]
        : []),
    ],
  };
}

const TEMPLATES: Record<MockScreenKind, (c: MockContext) => ScreenTemplate> = {
  login: loginTemplate,
  signup: signupTemplate,
  forgot: forgotTemplate,
  dashboard: dashboardTemplate,
  list: listTemplate,
  detail: detailTemplate,
  form: formTemplate,
  settings: settingsTemplate,
  checkout: checkoutTemplate,
  generic: genericTemplate,
};

/** Deterministic Screen Analyst output for the offline provider. */
/** The hand-authored inventory of a bundled sample screen, recognised by the SHA-256 of its image. */
function sampleFixture(
  imageSha256: string | undefined,
): SampleScreen | undefined {
  return imageSha256
    ? SAMPLE_SCREENS.find((f) => f.sha256 === imageSha256)
    : undefined;
}

/** The fixture as a template: navigation by kind resolves to this project's own screens. */
function fixtureTemplate(f: SampleScreen, c: MockContext): ScreenTemplate {
  return {
    title: f.title,
    purpose: f.purpose,
    screenType: f.screenType,
    personas: f.personas,
    dataEntities: f.dataEntities,
    openQuestions: f.openQuestions,
    regions: f.regions.map((r) => ({
      key: r.key,
      name: r.name,
      purpose: r.purpose,
      layout: r.layout,
      box: { x: 0, y: 0, width: 100, height: 100 },
      flow: "column" as const,
      elements: r.elements.map((e): El => {
        const target = e.navKind
          ? c.screens.find(
              (s) => s.id !== c.screen.id && c.kinds.get(s.id) === e.navKind,
            )
          : undefined;
        return {
          key: e.key,
          type: e.type,
          label: e.label,
          description: e.description,
          placeholder: e.placeholder,
          defaultValue: e.defaultValue,
          helperText: e.helperText,
          options: e.options,
          required: e.required === undefined ? undefined : e.required === "yes",
          validation: e.validation,
          states: e.states,
          behavior: e.behavior,
          nav: target?.id,
          navHint: target
            ? undefined
            : (e.navHint ??
              (e.navKind
                ? {
                    login: "Sign in",
                    dashboard: "Dashboard",
                    list: "Orders",
                    form: "New order",
                  }[e.navKind]
                : undefined)),
          data: e.dataBinding,
          inferred: e.inferred,
          box: e.bounds,
        };
      }),
    })),
  };
}

/**
 * @param imageSha256 SHA-256 of the screen image; the four bundled sample screens (recognised by it) get their
 * real inventory instead of one guessed from the screen's name.
 */
export function mockScreenAnalysis(
  project: Project,
  screen: Screen,
  imageSha256?: string,
): ScreenAnalysisOutput {
  const screens = [...project.screens].sort((a, b) => a.order - b.order);
  if (!screens.some((s) => s.id === screen.id)) screens.push(screen);
  const kinds = new Map(screens.map((s) => [s.id, detectScreenKind(s)]));
  const kind = kinds.get(screen.id)!;
  const ctx: MockContext = {
    project,
    screen,
    kind,
    screens,
    kinds,
    persona: primaryPersona(project),
    entity: entityForScreen(project, screen),
  };
  const fixture = sampleFixture(imageSha256);
  const template = fixture
    ? fixtureTemplate(fixture, ctx)
    : TEMPLATES[kind](ctx);

  const regions = template.regions.map((r) => ({
    key: r.key,
    name: r.name,
    purpose: r.purpose,
    layout: r.layout,
  }));
  const elements: ScreenAnalysisOutput["elements"] = [];
  for (const region of template.regions) {
    const boxes = layoutBoxes(
      region.box,
      region.elements.length,
      region.flow,
      region.cols,
      region.elements.map((e) => e.weight ?? 1),
    );
    region.elements.forEach((el, i) => {
      const b = el.box ?? boxes[i]!;
      elements.push({
        key: el.key,
        regionKey: region.key,
        type: el.type,
        label: el.label,
        description: el.description,
        placeholder: el.placeholder ?? "",
        defaultValue: el.defaultValue ?? "",
        helperText: el.helperText ?? "",
        options: el.options ?? [],
        required:
          el.required === true
            ? "yes"
            : el.required === false
              ? "no"
              : "unknown",
        validation: el.validation ?? [],
        states: el.states ?? [],
        behavior: el.behavior ?? "",
        navigatesToScreenId: el.nav ?? "",
        navigatesToHint: el.nav ? "" : (el.navHint ?? ""),
        dataBinding: el.data ?? "",
        inferred: el.inferred ?? [],
        bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
      });
    });
  }
  const output: ScreenAnalysisOutput = {
    title: template.title,
    purpose: template.purpose,
    screenType: template.screenType,
    personas: template.personas ?? [ctx.persona],
    regions,
    elements,
    dataEntities: template.dataEntities,
    openQuestions: template.openQuestions,
  };
  // Facts the BA wrote down beat the template's guesses.
  localiseOutput(output, project);
  const noted = [
    ...applyNotedOptions(output, screen.notes),
    ...addNotedOptionElements(output, screen.notes),
  ];
  if (noted.length) {
    const confirmed = new Set(noted);
    output.openQuestions = output.openQuestions.filter(
      (q) =>
        !output.elements.some(
          (e) =>
            confirmed.has(e.key) &&
            e.label &&
            q.includes(e.label) &&
            /options/i.test(q),
        ),
    );
    // The template's "Showing 1–25 of …" must agree with a page size the notes changed.
    const pageSize = output.elements.find(
      (e) =>
        e.key === "page_size" &&
        confirmed.has(e.key) &&
        /^\d+$/.test(e.defaultValue),
    );
    const range = output.elements.find((e) => e.key === "range_text");
    if (pageSize && range)
      range.label = range.label.replace(
        /^(Showing 1–)\d+( of \d+)$/,
        `$1${pageSize.defaultValue}$2`,
      );
  }
  return output;
}

/** Inspector mock: offline mode cannot see more than the first pass, so the inventory is confirmed as-is. */
export function mockInspection(first: ScreenAnalysisOutput): InspectorOutput {
  return {
    ...first,
    regions: [],
    elements: [],
    boundsCorrections: [],
    labelCorrections: [],
    corrections: [],
  };
}
