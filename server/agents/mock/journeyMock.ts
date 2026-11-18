/**
 * Offline Journey Mapper: personas, flows (from navigation targets in the inventories), data entities and the
 * journey order, derived deterministically from the screen analyses.
 */
import type { Project, ScreenAnalysis } from "@shared/types";
import type { JourneyOutput } from "../schemas";
import {
  dedupeText,
  joinAnd,
  leadSentences,
  lowerFirst,
  pluralize,
  sentence,
  stripTrailingPeriod,
  upperFirst,
} from "../text";
import {
  contextRoles,
  detectScreenKind,
  primaryEntity,
  primaryPersona,
} from "./heuristics";

export function mockJourney(
  project: Project,
  analyses: readonly ScreenAnalysis[],
): JourneyOutput {
  const screens = [...project.screens].sort((a, b) => a.order - b.order);
  const nameOf = (id: string): string =>
    screens.find((s) => s.id === id)?.name ?? id;
  const entity = primaryEntity(project);
  const persona = primaryPersona(project);
  const kinds = screens.map((s) => detectScreenKind(s));

  const goals: string[] = [];
  if (kinds.some((k) => k === "login" || k === "signup"))
    goals.push(`Sign in to ${project.name} quickly and securely`);
  if (kinds.includes("dashboard"))
    goals.push("See at a glance what needs attention today");
  if (kinds.includes("list"))
    goals.push(`Find any ${entity.singular} in seconds`);
  if (kinds.includes("form"))
    goals.push(`Capture ${entity.plural} accurately without rework`);
  if (kinds.includes("detail"))
    goals.push(`Check the full details and history of a ${entity.singular}`);
  if (kinds.includes("settings"))
    goals.push("Keep personal settings and notifications up to date");
  if (!goals.length)
    goals.push(`Complete their daily work in ${project.name} efficiently`);

  // Roles the BA listed come first, in their words; then roles the screens imply.
  const listed = contextRoles(project);
  const personaNames = dedupeText([
    ...listed.map((r) => r.name),
    persona,
    ...analyses.flatMap((a) => a.personas),
  ]);
  const personas = personaNames.map((name, i) => {
    const role = listed.find((r) => r.name === name);
    const screensUsed = analyses
      .filter((a) => a.personas.includes(name))
      .map((a) => nameOf(a.screenId));
    let description: string;
    if (role) description = sentence(leadSentences(role.description, 300));
    else if (i === 0)
      description = `Main user of ${project.name}: works with ${entity.plural} every day${project.description ? ` (${stripTrailingPeriod(leadSentences(project.description, 160))})` : ""}.`;
    else
      description = `${name} who uses the ${joinAnd(screensUsed) || project.name} screen${screensUsed.length === 1 ? "" : "s"}.`;
    return {
      name,
      description,
      goals: i === 0 ? goals.slice(0, 4) : goals.slice(0, 2),
    };
  });

  const flows: JourneyOutput["flows"] = [];
  const seen = new Set<string>();
  for (const a of analyses) {
    for (const e of a.elements) {
      if (!e.navigatesToScreenId || e.navigatesToScreenId === a.screenId)
        continue;
      const key = `${a.screenId}>${e.navigatesToScreenId}>${e.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const isSubmit = /sign in|create account|submit|save|place order/i.test(
        e.label,
      );
      flows.push({
        fromScreenId: a.screenId,
        toScreenId: e.navigatesToScreenId,
        trigger:
          e.type === "table" || e.type === "list"
            ? `Select a row in "${e.label}"`
            : `Select "${e.label}"`,
        elementId: e.id,
        condition: /sign in/i.test(e.label)
          ? "Credentials are valid"
          : isSubmit
            ? "All mandatory fields are valid"
            : "",
      });
    }
  }

  const entityNames = dedupeText(analyses.flatMap((a) => a.dataEntities));
  const dataEntities = entityNames.map((name) => {
    const prefix = name.replace(/\s+/g, "").toLowerCase();
    const fields = dedupeText(
      analyses.flatMap((a) =>
        a.elements
          .filter(
            (e) =>
              e.dataBinding &&
              e.dataBinding.toLowerCase().startsWith(`${prefix}.`),
          )
          .map((e) => e.label || e.dataBinding!.split(".").pop() || ""),
      ),
    );
    const screenIds = analyses
      .filter((a) =>
        a.dataEntities.some((d) => d.toLowerCase() === name.toLowerCase()),
      )
      .map((a) => a.screenId);
    return {
      name,
      description: `${name} as shown on the ${joinAnd(screenIds.map(nameOf))} screen${screenIds.length === 1 ? "" : "s"}.`,
      fields,
      screenIds,
    };
  });

  const order = screens.map((s) => s.id);
  const journey = order.map(nameOf).join(" → ");
  // Whole sentences only: the summary opens the README and the Overview page.
  const users = joinAnd(
    personaNames.map((n, i) =>
      i ? lowerFirst(pluralize(n)) : upperFirst(pluralize(n)),
    ),
  );
  const summary = [
    project.description
      ? sentence(leadSentences(project.description, 240))
      : `${project.name}.`,
    `${users || pluralize(persona)} use ${screens.length} screen${screens.length === 1 ? "" : "s"}: ${joinAnd(screens.map((s) => s.name))}.`,
    `The main journey is ${journey}.`,
    flows.length
      ? `There are ${flows.length} navigation paths between the screens.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return { summary, personas, flows, dataEntities, journeyOrder: order };
}
