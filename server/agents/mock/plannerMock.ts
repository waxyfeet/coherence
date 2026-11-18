/**
 * Offline Use Case Planner: groups each screen's regions into use cases by user goal (a shared application
 * shell, sign-in, browse vs filter vs row actions, form sections chained to their submit…), sized by the
 * requested granularity, with verbatim chained pre/postconditions. Works on any ScreenAnalysis, not only on
 * the mock's own inventories (analyses can be reused from an earlier real run).
 */
import type {
  Granularity,
  Project,
  Screen,
  ScreenAnalysis,
  ScreenRegion,
  UIElement,
  UseCase,
} from "@shared/types";
import { INPUT_TYPES, INTERACTIVE_TYPES, isShellRegion } from "../ids";
import type {
  CoverageRepairOutput,
  PlanOutput,
  PlannedUseCase,
} from "../schemas";
import {
  dedupeText,
  joinAnd,
  keySlug,
  lowerFirst,
  oneLine,
  titleCase,
  uniqueKey,
} from "../text";
import {
  detectScreenKind,
  entityForScreen,
  isAuthKind,
  primaryPersona,
  type EntityProfile,
  type MockScreenKind,
} from "./heuristics";

type Role =
  | "auth"
  | "sso"
  | "signup"
  | "heading"
  | "pagination"
  | "filters"
  | "form"
  | "dataview"
  | "chart"
  | "metrics"
  | "actions"
  | "content";

interface Unit {
  screen: Screen;
  kind: MockScreenKind;
  regions: ScreenRegion[];
  elements: UIElement[];
  role: Role;
  hasSubmit: boolean;
  /** Coarse granularity: the unit is the whole screen. */
  whole?: boolean;
  /** Set when a split produced this unit (1-based part number). */
  part?: number;
  partLabels?: string[];
  /** The unit a split part came from (all parts share its title). */
  origin?: Unit;
  key?: string;
  title?: string;
  featureKey?: string;
  preconditions?: string[];
  postconditions?: string[];
  dependsOn?: string[];
}

const SUBMIT_LABEL =
  /\b(submit|save|create|send|place|sign in|sign up|log in|register|confirm|apply|update|continue|next|finish|request|pay)\b/i;
const HEADING_REGION =
  /\b(page ?header|title|heading|intro|hero|welcome|greeting|brand|breadcrumbs?|progress)\b/i;
const FILTER_REGION = /\b(filters?|search|toolbar|facets?)\b/i;
const PAGINATION_REGION = /\b(pagination|pager|paging)\b/i;

function interactive(elements: readonly UIElement[]): UIElement[] {
  return elements.filter(
    (e) =>
      INTERACTIVE_TYPES.has(e.type) &&
      e.type !== "breadcrumb" &&
      e.type !== "stepper",
  );
}

function classify(
  region: ScreenRegion,
  elements: UIElement[],
  authScreen: boolean,
): { role: Role; hasSubmit: boolean } {
  const text = `${region.key.replace(/_/g, " ")} ${region.name}`;
  const inputs = elements.filter(
    (e) => INPUT_TYPES.has(e.type) && e.type !== "search_input",
  );
  const buttons = elements.filter(
    (e) => e.type === "button" || e.type === "icon_button",
  );
  const hasSubmit = buttons.some((b) => SUBMIT_LABEL.test(b.label));
  const passwords = elements.filter((e) => e.type === "password_input").length;
  const live = interactive(elements);

  if (
    passwords >= 2 ||
    buttons.some((b) => /\b(create account|sign up|register)\b/i.test(b.label))
  )
    return { role: "signup", hasSubmit: true };
  if (
    passwords === 1 &&
    (authScreen || buttons.some((b) => /\b(sign|log) ?in\b/i.test(b.label)))
  )
    return { role: "auth", hasSubmit: true };
  if (
    !inputs.length &&
    buttons.some((b) =>
      /\b(sign in with|continue with|single sign-on|sso)\b/i.test(b.label),
    )
  )
    return { role: "sso", hasSubmit: true };
  if (live.length === 0) return { role: "content", hasSubmit };
  if (HEADING_REGION.test(text)) return { role: "heading", hasSubmit };
  if (
    PAGINATION_REGION.test(text) ||
    (elements.some((e) => e.type === "pagination") && live.length <= 3)
  )
    return { role: "pagination", hasSubmit };
  if (
    FILTER_REGION.test(text) ||
    elements.some((e) => e.type === "search_input")
  )
    return { role: "filters", hasSubmit };
  if (inputs.length >= 2 || (inputs.length >= 1 && hasSubmit))
    return { role: "form", hasSubmit };
  if (elements.some((e) => e.type === "table" || e.type === "list"))
    return { role: "dataview", hasSubmit };
  if (elements.some((e) => e.type === "chart"))
    return { role: "chart", hasSubmit };
  if (
    elements.filter((e) => e.type === "tile" || e.type === "card").length >= 2
  )
    return { role: "metrics", hasSubmit };
  return { role: "actions", hasSubmit };
}

function primaryPriority(kind: MockScreenKind): Role[] {
  if (kind === "dashboard")
    return ["metrics", "chart", "dataview", "form", "filters", "actions"];
  return [
    "auth",
    "signup",
    "dataview",
    "form",
    "metrics",
    "chart",
    "filters",
    "actions",
    "sso",
  ];
}

function pickPrimary(units: Unit[], kind: MockScreenKind): Unit | undefined {
  for (const role of primaryPriority(kind)) {
    const u = units.find((x) => x.role === role);
    if (u) return u;
  }
  return undefined;
}

function mergeInto(target: Unit, source: Unit): void {
  target.regions.push(...source.regions);
  target.elements.push(...source.elements);
  target.hasSubmit = target.hasSubmit || source.hasSubmit;
}

function isPluralPhrase(phrase: string): boolean {
  const last = phrase.trim().split(/\s+/).pop() ?? "";
  return /[^s]s$/i.test(last);
}

function sizeFor(count: number): "S" | "M" | "L" {
  return count <= 4 ? "S" : count <= 9 ? "M" : "L";
}

function splitUnit(u: Unit, maxInteractive: number): Unit[] {
  const live = interactive(u.elements);
  // Credentials and their submit button are one goal at every granularity.
  if (u.role === "auth" || u.role === "signup" || live.length <= maxInteractive)
    return [u];
  const chunks: UIElement[][] = [];
  let current: UIElement[] = [];
  let count = 0;
  for (const e of u.elements) {
    current.push(e);
    if (interactive([e]).length) count += 1;
    if (count >= maxInteractive) {
      chunks.push(current);
      current = [];
      count = 0;
    }
  }
  if (current.length) {
    if (interactive(current).length || !chunks.length) chunks.push(current);
    else chunks[chunks.length - 1]!.push(...current);
  }
  if (chunks.length <= 1) return [u];
  return chunks.map((els, i) => ({
    ...u,
    elements: els,
    regions: u.regions.filter((r) => els.some((e) => e.regionId === r.id)),
    hasSubmit: els.some(
      (e) => e.type === "button" && SUBMIT_LABEL.test(e.label),
    ),
    part: i + 1,
    origin: u,
    partLabels: interactive(els)
      .map((e) => e.label)
      .filter(Boolean)
      .slice(0, 3),
  }));
}

export interface MockPlanArgs {
  project: Project;
  analyses: readonly ScreenAnalysis[];
  personaNames: readonly string[];
  granularity: Granularity;
  locked: readonly UseCase[];
}

export function mockPlan(args: MockPlanArgs): PlanOutput {
  const { project, granularity } = args;
  const screens = [...project.screens].sort((a, b) => a.order - b.order);
  const analysisOf = new Map(args.analyses.map((a) => [a.screenId, a]));
  const lockedElements = new Set(args.locked.flatMap((u) => u.elementIds));
  const persona = args.personaNames[0] ?? primaryPersona(project);
  const kinds = new Map(screens.map((s) => [s.id, detectScreenKind(s)]));
  const isAuthScreen = (s: Screen): boolean =>
    isAuthKind(kinds.get(s.id)!) || analysisOf.get(s.id)?.screenType === "auth";
  const landing = screens.find((s) => analysisOf.has(s.id) && !isAuthScreen(s));
  // Locked (edited/approved) use cases are already specified: new ones chain onto them, as the real planner is told.
  const allElements = new Map(
    args.analyses.flatMap((a) => a.elements.map((e) => [e.id, e] as const)),
  );
  const lockedAuth = args.locked.filter(
    (l) =>
      l.screenIds.length > 0 &&
      l.screenIds.every((id) => {
        const s = screens.find((x) => x.id === id);
        return s !== undefined && isAuthScreen(s);
      }),
  );
  const lockedSignIn = lockedAuth.find((l) =>
    l.postconditions.includes("The user is signed in"),
  );
  const lockedShell = args.locked.find((l) =>
    l.postconditions.includes("The main navigation is displayed"),
  );
  /** The email/password sign-in when planned, else a locked sign-in, else any planned auth use case. */
  const signInKey = (): string | undefined =>
    authUnits.find((u) => u.role === "auth")?.key ??
    lockedSignIn?.id ??
    authUnits[0]?.key;
  const elementsOf = (a: ScreenAnalysis, r: ScreenRegion): UIElement[] =>
    r.elementIds
      .map((id) => a.elements.find((e) => e.id === id))
      .filter(
        (e): e is UIElement => e !== undefined && !lockedElements.has(e.id),
      );

  const features = new Map<
    string,
    { key: string; name: string; description: string }
  >();
  const addFeature: AddFeature = (key, name, description) => {
    if (!features.has(key)) features.set(key, { key, name, description });
    return key;
  };
  const accessFeature = (): string =>
    addFeature(
      "access",
      "Access & navigation",
      "Signing in and moving around the application.",
    );
  const usedKeys = new Set<string>();
  const usedTitles = new Set<string>();
  const planned: Unit[] = [];
  const authUnits: Unit[] = [];
  let shell: Unit | undefined;

  const finishUnit = (u: Unit, title: string): void => {
    let t = title;
    if (usedTitles.has(t.toLowerCase())) t = `${title} (${u.screen.name})`;
    usedTitles.add(t.toLowerCase());
    u.title = t;
    u.key = uniqueKey(
      keySlug(t, 50).replace(/_/g, "-") || "use-case",
      usedKeys,
      "-",
    );
    planned.push(u);
  };

  // 1. The application shell: header / navigation / sidebar / footer regions of every signed-in screen.
  const shellRegions: ScreenRegion[] = [];
  const shellElements: UIElement[] = [];
  const shellScreens: Screen[] = [];
  for (const s of screens) {
    const a = analysisOf.get(s.id);
    if (!a || isAuthScreen(s)) continue;
    const regions = a.regions.filter(isShellRegion);
    const els = regions.flatMap((r) => elementsOf(a, r));
    if (!els.length) continue;
    shellRegions.push(...regions);
    shellElements.push(...els);
    shellScreens.push(s);
  }

  const planShell = (): Unit => {
    const signIn = signInKey();
    const u: Unit = {
      screen: shellScreens[0]!,
      kind: kinds.get(shellScreens[0]!.id)!,
      regions: shellRegions,
      elements: shellElements,
      role: "actions",
      hasSubmit: false,
      featureKey: accessFeature(),
      dependsOn: signIn ? [signIn] : [],
      preconditions: signIn
        ? ["The user is signed in"]
        : ["The user has opened the application"],
      postconditions: ["The main navigation is displayed"],
    };
    finishUnit(u, "Application shell & navigation");
    return u;
  };

  // 2. Units per screen (regions classified by role, then merged by user goal).
  const screenUnits = new Map<string, Unit[]>();
  for (const s of screens) {
    const a = analysisOf.get(s.id);
    if (!a) continue;
    const auth = isAuthScreen(s);
    const kind = kinds.get(s.id)!;
    const units: Unit[] = [];
    for (const r of a.regions) {
      if (!auth && isShellRegion(r)) continue;
      const els = elementsOf(a, r);
      if (!els.length) continue;
      const { role, hasSubmit } = classify(r, els, auth);
      units.push({
        screen: s,
        kind,
        regions: [r],
        elements: els,
        role,
        hasSubmit,
      });
    }
    // A form's submit/cancel actions belong with the form; pagination belongs with its table.
    const merged: Unit[] = [];
    for (const u of units) {
      const prev = merged[merged.length - 1];
      if (u.role === "actions" && u.hasSubmit && prev?.role === "form") {
        mergeInto(prev, u);
        continue;
      }
      if (u.role === "pagination") {
        const view = [...merged].reverse().find((m) => m.role === "dataview");
        if (view) {
          mergeInto(view, u);
          continue;
        }
        u.role = "actions";
      }
      merged.push(u);
    }
    // Headings and static content join the screen's primary use case.
    const statics = merged.filter(
      (u) => u.role === "heading" || u.role === "content",
    );
    let rest = merged.filter(
      (u) => u.role !== "heading" && u.role !== "content",
    );
    const primary = pickPrimary(rest, kind);
    if (primary) {
      for (const st of statics) mergeInto(primary, st);
      rest = [primary, ...rest.filter((u) => u !== primary)];
    } else if (statics.length) {
      const [first, ...others] = statics;
      for (const o of others) mergeInto(first!, o);
      first!.role = "content";
      rest = [first!];
    }

    if (granularity === "coarse") {
      const total = rest.reduce(
        (n, u) => n + interactive(u.elements).length,
        0,
      );
      if (rest.length > 1 && total <= 14 && !auth) {
        const [first, ...others] = rest;
        for (const o of others) mergeInto(first!, o);
        first!.whole = true;
        rest = [first!];
      }
    } else {
      rest = rest.flatMap((u) => splitUnit(u, granularity === "fine" ? 4 : 10));
    }
    screenUnits.set(s.id, rest);
  }

  // 3. Titles, features and the chain, screen by screen in journey order (shell right after sign-in).
  const entryChain = (
    s: Screen,
  ): { dependsOn: string[]; preconditions: string[] } => {
    const shown = `The ${s.name} screen is displayed`;
    const landingAuth = authUnits.filter((a) =>
      a.postconditions!.includes(shown),
    );
    const landingKey =
      landingAuth.find((a) => a.role === "auth")?.key ??
      lockedAuth.find((l) => l.postconditions.includes(shown))?.id ??
      landingAuth[0]?.key;
    if (landingKey) return { dependsOn: [landingKey], preconditions: [shown] };
    const shellKey = shell?.key ?? lockedShell?.id;
    const shellNav = shell
      ? shell.elements.find((e) => e.navigatesToScreenId === s.id)
      : lockedShell?.elementIds
          .map((id) => allElements.get(id))
          .find((e) => e?.navigatesToScreenId === s.id);
    if (shellKey && shellNav) {
      return {
        dependsOn: [shellKey],
        preconditions: [
          "The main navigation is displayed",
          `The user has selected "${shellNav.label || s.name}" in the main navigation`,
        ],
      };
    }
    const entity = entityForScreen(project, s);
    const score = (p: Unit): number =>
      (entityForScreen(project, p.screen).id === entity.id ? 2 : 0) +
      (p.role === "dataview" ? 1 : 0);
    const candidates = planned
      .filter(
        (p) =>
          p !== shell &&
          p.screen.id !== s.id &&
          p.elements.some((e) => e.navigatesToScreenId === s.id),
      )
      .sort((a, b) => score(b) - score(a));
    const via = candidates[0];
    if (via) {
      const trigger = via.elements.find((e) => e.navigatesToScreenId === s.id)!;
      return {
        dependsOn: [via.key!],
        preconditions: [
          via.postconditions![0]!,
          `The user has selected "${trigger.label || s.name}"`,
        ],
      };
    }
    if (shellKey)
      return {
        dependsOn: [shellKey],
        preconditions: ["The main navigation is displayed", shown],
      };
    const signIn = signInKey();
    if (signIn)
      return {
        dependsOn: [signIn],
        preconditions: ["The user is signed in", shown],
      };
    const before = planned.filter((p) => p.screen.id !== s.id).pop();
    if (before)
      return {
        dependsOn: [before.key!],
        preconditions: [before.postconditions![0]!, shown],
      };
    return {
      dependsOn: [],
      preconditions: ["The user has opened the application", shown],
    };
  };

  for (const s of screens) {
    const units = screenUnits.get(s.id) ?? [];
    const kind = kinds.get(s.id)!;
    const entity = entityForScreen(project, s);
    const auth = isAuthScreen(s);
    const formCount = units.filter((u) => u.role === "form").length;
    const primary = units[0];
    let previousForm: Unit | undefined;

    for (const u of units) {
      u.featureKey = auth
        ? accessFeature()
        : featureFor(kind, s, entity, addFeature);
      u.postconditions = postconditionsFor(
        u,
        kind,
        entity,
        s,
        landing,
        screens,
        analysisOf,
      );
      const title = titleFor(u, kind, entity, formCount, s, project);

      if (auth) {
        u.dependsOn = [];
        u.preconditions =
          u.role === "form"
            ? ["The user has opened the application"]
            : [
                "The user has opened the application",
                "The user is not signed in",
              ];
        finishUnit(u, title);
        if (u.role === "auth" || u.role === "sso" || u.role === "signup")
          authUnits.push(u);
        continue;
      }

      if (u === primary) {
        if (!shell && shellElements.length) shell = planShell();
        const chain = entryChain(s);
        u.dependsOn = chain.dependsOn;
        u.preconditions = chain.preconditions;
      } else if (
        (kind === "list" || kind === "detail") &&
        primary?.role === "dataview"
      ) {
        u.dependsOn = [primary.key!];
        u.preconditions = [primary.postconditions![0]!];
      } else if (
        u.role === "form" &&
        previousForm &&
        (kind === "form" || kind === "checkout" || kind === "generic")
      ) {
        u.dependsOn = [previousForm.key!];
        u.preconditions = [previousForm.postconditions![0]!];
      } else if (primary) {
        u.dependsOn = [...(primary.dependsOn ?? [])];
        u.preconditions = [...(primary.preconditions ?? [])];
      }
      if (u.role === "form") previousForm = u;
      finishUnit(u, title);
    }
  }
  if (!shell && shellElements.length) shell = planShell();

  // The shell is built first among the signed-in use cases.
  const ordered = [...planned];
  if (shell) {
    ordered.splice(ordered.indexOf(shell), 1);
    const lastAuth = ordered.reduce(
      (idx, u, i) => (authUnits.includes(u) ? i : idx),
      -1,
    );
    ordered.splice(lastAuth + 1, 0, shell);
  }

  const useCases: PlannedUseCase[] = ordered.map((u) => ({
    key: u.key!,
    title: u.title!,
    featureKey: u.featureKey!,
    personaName: persona,
    screenIds: u === shell ? shellScreens.map((s) => s.id) : [u.screen.id],
    regionIds: [...new Set(u.regions.map((r) => r.id))],
    elementIds: [...new Set(u.elements.map((e) => e.id))],
    dependsOn: u.dependsOn ?? [],
    size: sizeFor(u.elements.length),
    scope: scopeFor(u, u === shell, shellScreens),
    preconditions: u.preconditions ?? [],
    postconditions: u.postconditions ?? [],
  }));

  const usedFeatureKeys = new Set(useCases.map((u) => u.featureKey));
  return {
    features: [...features.values()].filter((f) => usedFeatureKeys.has(f.key)),
    useCases,
  };
}

type AddFeature = (key: string, name: string, description: string) => string;

function featureFor(
  kind: MockScreenKind,
  s: Screen,
  entity: EntityProfile,
  add: AddFeature,
): string {
  const E = titleCase(entity.singular);
  switch (kind) {
    case "dashboard":
      return add(
        "insights",
        "Dashboard & insights",
        "Overview of key figures and recent activity.",
      );
    case "list":
    case "detail":
      return add(
        `${entity.id}-management`,
        `${E} management`,
        `Finding, reviewing and acting on ${entity.plural}.`,
      );
    case "form":
      return /\b(edit|update)\b/i.test(s.name)
        ? add(
            `${entity.id}-maintenance`,
            `${E} maintenance`,
            `Changing existing ${entity.plural}.`,
          )
        : add(
            `${entity.id}-entry`,
            `${E} entry`,
            `Capturing new ${entity.plural}.`,
          );
    case "settings":
      return add(
        "settings",
        "Settings & profile",
        "Personal settings and preferences.",
      );
    case "checkout":
      return add(
        "checkout",
        "Checkout & payment",
        "Confirming delivery and payment and placing the order.",
      );
    default:
      return add(
        keySlug(s.name).replace(/_/g, "-") || "general",
        s.name,
        `Functionality of the ${s.name} screen.`,
      );
  }
}

function mainRegionName(u: Unit, fallback: string): string {
  return (
    (
      u.regions.find(
        (r) => !HEADING_REGION.test(r.name) && !isShellRegion(r),
      ) ?? u.regions[0]
    )?.name ?? fallback
  );
}

function titleFor(
  u: Unit,
  kind: MockScreenKind,
  entity: EntityProfile,
  formCount: number,
  s: Screen,
  project: Project,
): string {
  const base = baseTitle(u.origin ?? u, kind, entity, formCount, s, project);
  if (u.part && u.part > 1 && u.partLabels?.length)
    return `${base} (part ${u.part}: ${joinAnd(u.partLabels.map((l) => oneLine(l, 30)))})`;
  if (u.part && u.part > 1) return `${base} (part ${u.part})`;
  return base;
}

function baseTitle(
  u: Unit,
  kind: MockScreenKind,
  entity: EntityProfile,
  formCount: number,
  s: Screen,
  project: Project,
): string {
  const regionName = mainRegionName(u, s.name);
  const { singular, plural } = entity;
  if (u.whole) {
    switch (kind) {
      case "dashboard":
        return `View the ${lowerFirst(s.name)}`;
      case "list":
        return `Find and manage ${plural}`;
      case "form":
        return /\b(edit|update)\b/i.test(s.name)
          ? `Edit ${articleFor(singular)} ${singular}`
          : `Create a new ${singular}`;
      case "detail":
        return `View and manage ${articleFor(singular)} ${singular}`;
      case "settings":
        return `Manage ${lowerFirst(s.name)}`;
      case "checkout":
        return "Check out and place the order";
      default:
        return `Use the ${s.name} screen`;
    }
  }
  switch (u.role) {
    case "auth":
      return "Sign in with email and password";
    case "sso":
      return "Sign in with single sign-on";
    case "signup":
      return "Create an account";
    case "filters":
      return `Search and filter ${plural}`;
    case "metrics":
      return `View key ${singular} metrics`;
    case "chart": {
      const chart = u.elements.find((e) => e.type === "chart");
      return `Review the ${lowerFirst(chart?.label || regionName)} chart`;
    }
    case "dataview":
      if (kind === "dashboard") return `View recent ${plural}`;
      if (kind === "detail") return `View ${singular} details`;
      return `Browse the ${singular} list`;
    case "actions":
      if (kind === "dashboard") return "Use the dashboard quick actions";
      if (kind === "list") return `Act on ${plural} from the list`;
      return `Use the ${lowerFirst(regionName)}`;
    case "form":
      if (kind === "forgot") return "Request a password reset link";
      if (kind === "settings")
        return `Update ${lowerFirst(regionName)}${/(preferences|settings|details|profile)$/i.test(regionName) ? "" : " settings"}`;
      if (u.hasSubmit) {
        if (kind === "checkout") return "Pay and place the order";
        if (formCount > 1) return `Review and submit the ${singular}`;
        return /\b(edit|update)\b/i.test(s.name)
          ? `Edit ${articleFor(singular)} ${singular}`
          : `Create a new ${singular}`;
      }
      if (u.elements.some((e) => e.type === "table"))
        return `Add ${lowerFirst(regionName)}`;
      return `Enter the ${lowerFirst(regionName)}`;
    default:
      return kind === "login" && u.role === "content"
        ? `View the ${project.name} sign-in page`
        : `View ${s.name} layout and content`;
  }
}

function articleFor(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function postconditionsFor(
  u: Unit,
  kind: MockScreenKind,
  entity: EntityProfile,
  s: Screen,
  landing: Screen | undefined,
  screens: Screen[],
  analysisOf: Map<string, ScreenAnalysis>,
): string[] {
  const regionName = mainRegionName(u, s.name);
  const { singular, plural } = entity;
  const submitTarget = (): Screen | undefined => {
    const btn = u.elements.find(
      (e) =>
        e.type === "button" &&
        SUBMIT_LABEL.test(e.label) &&
        e.navigatesToScreenId,
    );
    return btn
      ? screens.find(
          (x) => x.id === btn.navigatesToScreenId && analysisOf.has(x.id),
        )
      : undefined;
  };
  switch (u.role) {
    case "auth":
    case "sso":
      return landing
        ? ["The user is signed in", `The ${landing.name} screen is displayed`]
        : ["The user is signed in"];
    case "signup":
      return ["The user account is created", "The user is signed in"];
    default:
      break;
  }
  if (u.whole) {
    switch (kind) {
      case "dashboard":
        return ["The key metrics and recent activity are displayed"];
      case "list":
        return [`The ${singular} list is displayed`];
      case "detail":
        return [`The ${singular} details are displayed`];
      default:
        break;
    }
  }
  switch (u.role) {
    case "filters":
      return [
        `The ${singular} list shows only the ${plural} that match the search and filters`,
      ];
    case "metrics":
      return ["The key metrics for the selected period are displayed"];
    case "chart": {
      const chart = u.elements.find((e) => e.type === "chart");
      return [
        `The ${lowerFirst(chart?.label || regionName)} chart is displayed for the selected period`,
      ];
    }
    case "dataview":
      if (kind === "dashboard") return [`The recent ${plural} are displayed`];
      if (kind === "detail") return [`The ${singular} details are displayed`];
      return [`The ${singular} list is displayed`];
    case "actions":
      if (kind === "dashboard")
        return ["The screen for the selected quick action is displayed"];
      if (kind === "list")
        return [`The selected action is applied to the chosen ${plural}`];
      return [`The selected ${lowerFirst(regionName)} action is completed`];
    case "form": {
      if (kind === "forgot")
        return ["A password reset link is sent to the user's email address"];
      if (kind === "settings")
        return [`The ${lowerFirst(regionName)} changes are saved`];
      if (u.hasSubmit || u.whole) {
        if (kind === "checkout")
          return ["The order is placed", "The order confirmation is displayed"];
        const target = submitTarget();
        const saved =
          kind === "form" ? entity.submittedState : `The ${singular} is saved`;
        return target
          ? [saved, `The ${target.name} screen is displayed`]
          : [saved];
      }
      if (u.elements.some((e) => e.type === "table") && singular === "order") {
        return [
          "The order has at least one valid order line",
          "The order total is calculated",
        ];
      }
      const name = lowerFirst(regionName);
      return [`The ${name} ${isPluralPhrase(name) ? "are" : "is"} captured`];
    }
    default:
      return [`The ${s.name} screen content is displayed`];
  }
}

function scopeFor(u: Unit, isShell: boolean, shellScreens: Screen[]): string {
  // Shared shell elements repeat on every screen: name each label once.
  const labels = dedupeText(
    interactive(u.elements)
      .map((e) => e.label)
      .filter(Boolean),
  );
  const shown = labels.slice(0, 6).map((l) => `"${oneLine(l, 40)}"`);
  if (isShell) {
    return `The application header shared by the ${joinAnd(shellScreens.map((s) => s.name))} screens: logo, main navigation, notifications and user menu${shown.length ? ` (${joinAnd(shown)}${labels.length > 6 ? ", …" : ""})` : ""}. Page content is covered by other use cases.`;
  }
  const regions = joinAnd([...new Set(u.regions.map((r) => r.name))]);
  const extra =
    u.role === "dataview" && !u.whole && u.kind === "list"
      ? " Searching, filtering and row actions are separate use cases."
      : "";
  return `${regions} on the ${u.screen.name} screen${shown.length ? `, including ${joinAnd(shown)}${labels.length > 6 ? " and more" : ""}` : ""}.${extra}`;
}

/** Offline coverage repair: each uncovered element joins the use case covering most of its region (else its screen). */
export function mockCoverageRepair(
  plan: readonly { key: string; elementIds: readonly string[] }[],
  uncovered: readonly UIElement[],
  elementIndex: ReadonlyMap<string, UIElement>,
): CoverageRepairOutput {
  const assignments: CoverageRepairOutput["assignments"] = [];
  for (const e of uncovered) {
    let best: { key: string; score: number } | undefined;
    for (const p of plan) {
      let score = 0;
      for (const id of p.elementIds) {
        const other = elementIndex.get(id);
        if (!other || other.id === e.id) continue;
        if (other.regionId === e.regionId) score += 100;
        else if (other.screenId === e.screenId) score += 1;
      }
      if (score > 0 && (!best || score > best.score))
        best = { key: p.key, score };
    }
    if (best) assignments.push({ elementId: e.id, useCaseKey: best.key });
  }
  return { assignments, newFeatures: [], newUseCases: [] };
}
