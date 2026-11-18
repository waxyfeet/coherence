/**
 * Plumbing shared by every agent: call options wired to the job (usage, logs, cancellation), derived job
 * contexts, and the compact text blocks that describe the project, screens, elements and use cases in prompts.
 */
import type {
  FlowLink,
  LLMConnection,
  LLMUsage,
  LogLevel,
  Persona,
  Project,
  Screen,
  ScreenAnalysis,
  UIElement,
  UseCase,
} from "@shared/types";
import { CancelledError } from "../errors";
import type { JobContext } from "../jobs/jobManager";
import type { CallOptionsBase } from "../llm/structured";
import { oneLine } from "./text";

/** Options every generateStructured call needs, wired to the job. */
export function callBase(
  ctx: JobContext,
  connection: LLMConnection,
  purpose: string,
): Pick<
  CallOptionsBase,
  "connection" | "purpose" | "signal" | "onUsage" | "log" | "resources" | "live"
> {
  return {
    connection,
    purpose,
    live: ctx.live,
    resources: ctx.resources,
    signal: ctx.signal,
    onUsage: (u) =>
      ctx.addUsage({
        calls: 1,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        costUsd: u.costUsd,
      }),
    log: (level: LogLevel, message: string) => ctx.log(level, message),
  };
}

export function isMockConnection(connection: LLMConnection): boolean {
  return connection.provider === "mock";
}

export interface DerivedContextOptions {
  /** Replaces the job's signal (e.g. a child signal that aborts siblings when one call fails). */
  signal?: AbortSignal;
  /** Called for every warning, in addition to the job log (lets the pipeline collect warnings). */
  onWarn?: (message: string) => void;
}

/**
 * A JobContext that delegates to `ctx` (method by method — the real context may be a class instance, so
 * spreading it would lose its prototype methods) with an optional different signal and warning tap.
 */
export function deriveContext(
  ctx: JobContext,
  opts: DerivedContextOptions,
): JobContext {
  const signal = opts.signal ?? ctx.signal;
  const warn = (message: string): void => {
    opts.onWarn?.(message);
    ctx.warn(message);
  };
  return {
    jobId: ctx.jobId,
    resources: ctx.resources,
    live: ctx.live,
    projectId: ctx.projectId,
    signal,
    log: (level, message) => {
      if (level === "warn") warn(message);
      else ctx.log(level, message);
    },
    info: (message) => ctx.info(message),
    warn,
    setStages: (stages) => ctx.setStages(stages),
    stage: (name, total) => ctx.stage(name, total),
    progress: (current, total, label) => ctx.progress(current, total, label),
    tick: (label) => ctx.tick(label),
    addUsage: (usage: Partial<LLMUsage>) => ctx.addUsage(usage),
    throwIfCancelled: () => {
      ctx.throwIfCancelled();
      if (signal.aborted) {
        const reason: unknown = signal.reason;
        throw reason instanceof Error ? reason : new CancelledError();
      }
    },
  };
}

/** Child abort controller that follows the parent signal. */
export function childAbort(parent: AbortSignal): {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
    dispose: () => parent.removeEventListener("abort", onAbort),
  };
}

/* ── Prompt data blocks ─────────────────────────────────────────────── */

export function sortedScreens(project: Project): Screen[] {
  return [...project.screens].sort((a, b) => a.order - b.order);
}

/**
 * Project context appended to every system prompt (after the static instructions, identical for all calls
 * of one run so providers can cache the prefix).
 */
export function projectContextBlock(project: Project): string {
  const screens = sortedScreens(project);
  const lines: string[] = [
    "# Project context",
    `Project name: ${project.name}`,
    "",
    "Description (from the business analyst):",
    project.description.trim() || "(no description given)",
  ];
  if (project.additionalContext.trim()) {
    lines.push(
      "",
      "Additional context (roles, domain rules, NFRs, constraints):",
      project.additionalContext.trim(),
    );
  }
  lines.push(
    "",
    `Screens in this project (${screens.length}), in the BA's journey order:`,
  );
  for (const [i, s] of screens.entries()) {
    const notes = screenNotesText(s.notes, "   ");
    lines.push(
      `${i + 1}. id=${s.id} · "${s.name}"${notes ? ` · BA notes: ${notes}` : ""}`,
    );
  }
  return lines.join("\n");
}

/**
 * A screen's BA notes in full (facts from the product owner — never cut: screen-level rules such as "Save as
 * draft saves without validation" exist nowhere else). Whitespace is tidied; line breaks are kept, indented.
 */
export function screenNotesText(notes: string, indent = ""): string {
  return (notes ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(`\n${indent}`);
}

function flag(label: string, on: boolean | undefined): string {
  return on ? ` · ${label}` : "";
}

/** One line per element — enough for planning and journey mapping. */
export function compactElementLine(
  e: UIElement,
  screensById?: ReadonlyMap<string, Screen>,
): string {
  const parts = [`${e.id} · ${e.type}`];
  if (e.label) parts.push(`"${oneLine(e.label, 80)}"`);
  if (e.options?.length)
    parts.push(
      `${e.options.length} options${e.options.length <= 6 ? `: ${e.options.map((o) => `"${oneLine(o, 30)}"`).join(", ")}` : ""}`,
    );
  if (e.navigatesToScreenId) {
    const target = screensById?.get(e.navigatesToScreenId);
    parts.push(
      `→ ${target ? `"${target.name}" (${e.navigatesToScreenId})` : e.navigatesToScreenId}`,
    );
  } else if (e.navigatesToHint) {
    parts.push(`→ ${oneLine(e.navigatesToHint, 60)}`);
  }
  return `${parts.join(" · ")}${flag("required", e.required)}`;
}

/** Screens → regions → elements, compact. */
export function compactInventoryBlock(
  analyses: readonly ScreenAnalysis[],
  screens: readonly Screen[],
): string {
  const byId = new Map(screens.map((s) => [s.id, s]));
  const out: string[] = [];
  for (const a of analyses) {
    const screen = byId.get(a.screenId);
    out.push(
      `## Screen "${screen?.name ?? a.title}" · id=${a.screenId} · key=${a.screenKey} · type=${a.screenType}`,
    );
    if (a.purpose) out.push(`Purpose: ${oneLine(a.purpose, 300)}`);
    if (a.personas.length) out.push(`Personas: ${a.personas.join(", ")}`);
    const elementsById = new Map(a.elements.map((e) => [e.id, e]));
    for (const r of a.regions) {
      out.push(
        `### Region ${r.id} — ${r.name}${r.purpose ? `: ${oneLine(r.purpose, 160)}` : ""}`,
      );
      for (const id of r.elementIds) {
        const e = elementsById.get(id);
        if (e) out.push(`- ${compactElementLine(e, byId)}`);
      }
    }
    out.push("");
  }
  return out.join("\n").trim();
}

/** Every fact the analyst recorded about an element — what the Writer needs to spell out rules. */
export function detailedElementBlock(
  e: UIElement,
  regionName: string,
  screensById: ReadonlyMap<string, Screen>,
): string {
  const lines = [
    `- id: ${e.id}`,
    `  type: ${e.type}`,
    `  label: ${JSON.stringify(e.label)}`,
    `  region: ${regionName}`,
  ];
  if (e.description) lines.push(`  description: ${e.description}`);
  if (e.placeholder)
    lines.push(`  placeholder: ${JSON.stringify(e.placeholder)}`);
  if (e.defaultValue)
    lines.push(`  default: ${JSON.stringify(e.defaultValue)}`);
  if (e.helperText)
    lines.push(`  helper text: ${JSON.stringify(e.helperText)}`);
  if (e.options?.length)
    lines.push(
      `  options (verbatim, in order): ${e.options.map((o) => JSON.stringify(o)).join(", ")}`,
    );
  if (e.required !== undefined)
    lines.push(`  required: ${e.required ? "yes" : "no"}`);
  if (e.validation?.length)
    lines.push(`  validation: ${e.validation.join(" | ")}`);
  if (e.states?.length) lines.push(`  states: ${e.states.join(" | ")}`);
  if (e.behavior) lines.push(`  behaviour: ${e.behavior}`);
  if (e.navigatesToScreenId)
    lines.push(
      `  navigates to screen: "${screensById.get(e.navigatesToScreenId)?.name ?? e.navigatesToScreenId}"`,
    );
  if (e.navigatesToHint) lines.push(`  navigation hint: ${e.navigatesToHint}`);
  if (e.dataBinding) lines.push(`  data: ${e.dataBinding}`);
  if (e.inferred.length)
    lines.push(
      `  inferred (not visible in the design): ${e.inferred.join(", ")}`,
    );
  return lines.join("\n");
}

export function personasBlock(personas: readonly Persona[]): string {
  if (!personas.length) return "Personas: (none identified)";
  return [
    "Personas:",
    ...personas.map(
      (p) =>
        `- ${p.name}: ${oneLine(p.description, 200)}${p.goals.length ? ` Goals: ${p.goals.join("; ")}` : ""}`,
    ),
  ].join("\n");
}

export function flowsBlock(
  flows: readonly FlowLink[],
  screens: readonly Screen[],
): string {
  if (!flows.length) return "Flows between screens: (none identified)";
  const name = (id: string): string =>
    screens.find((s) => s.id === id)?.name ?? id;
  return [
    "Flows between screens:",
    ...flows.map(
      (f) =>
        `- "${name(f.fromScreenId)}" → "${name(f.toScreenId)}" via ${f.trigger}${f.elementId ? ` (${f.elementId})` : ""}${f.condition ? ` when ${f.condition}` : ""}`,
    ),
  ].join("\n");
}

/** Compact one-use-case summary for chain context and the reviewer. */
export function useCaseHeadline(uc: UseCase): string {
  return `${uc.id} "${uc.title}"`;
}

export function chainContextBlock(
  uc: UseCase,
  all: readonly UseCase[],
): string {
  const byId = new Map(all.map((u) => [u.id, u]));
  const lines: string[] = [];
  const preds = uc.dependsOn
    .map((id) => byId.get(id))
    .filter((u): u is UseCase => Boolean(u));
  if (preds.length) {
    lines.push(
      "Depends on (its postconditions establish this use case's preconditions):",
    );
    for (const p of preds)
      lines.push(
        `- ${useCaseHeadline(p)} — postconditions: ${p.postconditions.map((t) => JSON.stringify(t)).join("; ") || "(none)"}`,
      );
  } else {
    lines.push("Depends on: nothing — this is an entry point.");
  }
  const successors = all.filter((u) => u.dependsOn.includes(uc.id));
  if (successors.length) {
    lines.push(
      "Leads to (these use cases start from this one's postconditions — keep those postconditions verbatim):",
    );
    for (const s of successors)
      lines.push(
        `- ${useCaseHeadline(s)} — first precondition: ${JSON.stringify(s.preconditions[0] ?? "")}`,
      );
  }
  return lines.join("\n");
}
