import { capacityBatches } from "./capacityBatches";
/**
 * Review stage: deterministic checks (coverage, chain, size, duplicate governance) + the Reviewer agent
 * (consistency / ambiguity / gaps a careful human would catch) + an optional self-repair round that
 * rewrites the use cases with error/warning findings and re-checks them.
 */
import type {
  LLMConnection,
  Project,
  ReviewCategory,
  ReviewFinding,
  ReviewSeverity,
  SolutionModel,
  UseCase,
} from "@shared/types";
import { CancelledError, errorMessage } from "../errors";
import { stopsTheRun } from "../llm/errors";
import type { OutputFormat } from "../formats/types";
import type { JobContext } from "../jobs/jobManager";
import { generateStructured } from "../llm/structured";
import {
  chainHolds,
  happyPathCoversPostconditions,
  happyPathCoversPreconditions,
} from "./chain";
import { callBase, sortedScreens } from "./context";
import { indexElements } from "./ids";
import { reviewerSystem } from "./prompts";
import { ReviewerOutputSchema, type ReviewerOutput } from "./schemas";
import { containsText, joinAnd, normText, oneLine } from "./text";
import { writeUseCaseContent } from "./writer";

export type DraftFinding = Omit<ReviewFinding, "id">;

/** Above these a use case is too big to build as one unit of work. */
export const MAX_RULES_PER_USE_CASE = 12;
export const MAX_SCENARIOS_PER_USE_CASE = 10;
/** Cap on LLM findings so the review stays actionable. */
const MAX_LLM_FINDINGS = 25;

const SEVERITY_RANK: Record<ReviewSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function listIds(ids: readonly string[], max = 6): string {
  return `${ids.slice(0, max).join(", ")}${ids.length > max ? `, … (${ids.length} in total)` : ""}`;
}

/* ── Deterministic checks (pure) ────────────────────────────────────── */

/**
 * Rules that measure the build effort: the same element repeated on several screens (the shared header on
 * every page) is built once, so its instances count once.
 */
export function distinctRuleCount(uc: Pick<UseCase, "businessRules">): number {
  const keys = new Set<string>();
  let general = 0;
  for (const r of uc.businessRules) {
    if (r.elementId) keys.add(`${r.elementType}|${normText(r.element)}`);
    else general += 1;
  }
  return keys.size + general;
}

export function deterministicReview(
  model: Pick<SolutionModel, "screens" | "useCases">,
): DraftFinding[] {
  const findings: DraftFinding[] = [];
  for (const a of model.screens)
    if (a.reading?.inspection === "failed")
      findings.push({
        severity: "warning",
        category: "other",
        useCaseIds: model.useCases
          .filter((u) => u.screenIds.includes(a.screenId))
          .map((u) => u.id),
        message: `The first reading of "${a.title}" was retained, but its independent inspection did not complete.`,
        suggestion:
          "Review this screen's inventory or rerun analysis when the selected model is available.",
        resolved: false,
      });
  const elements = indexElements(model.screens);
  const byId = new Map(model.useCases.map((u) => [u.id, u]));

  // Coverage: every element belongs to a use case…
  const covered = new Set(model.useCases.flatMap((u) => u.elementIds));
  for (const a of model.screens) {
    const missing = a.elements
      .filter((e) => !covered.has(e.id))
      .map((e) => e.id);
    if (!missing.length) continue;
    findings.push({
      severity: "error",
      category: "coverage",
      useCaseIds: model.useCases
        .filter((u) => u.screenIds.includes(a.screenId))
        .map((u) => u.id),
      message: `${missing.length} element(s) on "${a.title}" are not covered by any use case: ${listIds(missing)}.`,
      suggestion:
        "Add these elements to the use case of their screen region (or a layout use case) and describe them with business rules.",
      resolved: false,
    });
  }
  // …and every element a use case owns is governed by a business rule.
  for (const uc of model.useCases) {
    const governed = new Set(
      uc.businessRules.map((r) => r.elementId).filter(Boolean),
    );
    const gone = uc.elementIds.filter((id) => !elements.has(id));
    const ungoverned = uc.elementIds.filter(
      (id) => elements.has(id) && !governed.has(id),
    );
    if (ungoverned.length) {
      findings.push({
        severity: "warning",
        category: "coverage",
        useCaseIds: [uc.id],
        message: `${uc.id} is responsible for ${ungoverned.length} element(s) that no business rule governs: ${listIds(ungoverned)}.`,
        suggestion:
          "Add one business rule per element: what it is (verbatim label) and every rule that governs it.",
        resolved: false,
      });
    }
    if (gone.length) {
      findings.push({
        severity: "warning",
        category: "coverage",
        useCaseIds: [uc.id],
        message: `${uc.id} refers to element(s) that are no longer on the analysed screens: ${listIds(gone)}.`,
        suggestion:
          "Remove the rules and scenario steps for these elements, or re-check the screen design.",
        resolved: false,
      });
    }
  }

  // Chain.
  for (const uc of model.useCases) {
    const unknown = uc.dependsOn.filter((id) => !byId.has(id));
    if (unknown.length) {
      findings.push({
        severity: "error",
        category: "chain",
        useCaseIds: [uc.id],
        message: `${uc.id} depends on use case(s) that do not exist: ${unknown.join(", ")}.`,
        suggestion:
          "Point the dependency at the use case whose postcondition this one starts from.",
        resolved: false,
      });
    }
    const preds = uc.dependsOn
      .map((id) => byId.get(id))
      .filter((u): u is UseCase => Boolean(u));
    if (preds.length && !chainHolds(uc, preds)) {
      const anywhere = preds.some((p) =>
        p.postconditions.some((post) => containsText(uc.preconditions, post)),
      );
      findings.push(
        anywhere
          ? {
              severity: "info",
              category: "chain",
              useCaseIds: [uc.id, ...preds.map((p) => p.id)],
              message: `${uc.id} copies a postcondition of ${joinAnd(preds.map((p) => p.id))}, but not as its first precondition.`,
              suggestion:
                "Move the chained precondition to the top so the build order reads naturally.",
              resolved: false,
            }
          : {
              severity: "error",
              category: "chain",
              useCaseIds: [uc.id, ...preds.map((p) => p.id)],
              message: `${uc.id} depends on ${joinAnd(preds.map((p) => p.id))}, but none of their postconditions (${
                preds
                  .flatMap((p) => p.postconditions)
                  .map((p) => `"${oneLine(p, 60)}"`)
                  .join(", ") || "none"
              }) appears in its preconditions.`,
              suggestion: `Make the first precondition of ${uc.id} a verbatim copy of the postcondition it relies on.`,
              resolved: false,
            },
      );
    }
    if (!uc.dependsOn.length && !uc.preconditions.length) {
      findings.push({
        severity: "warning",
        category: "chain",
        useCaseIds: [uc.id],
        message: `${uc.id} has no preconditions — the starting state of the use case is undefined.`,
        suggestion:
          'Add an environment precondition such as "The user has opened the application".',
        resolved: false,
      });
    }
    const happy = uc.scenarios.find((s) => s.type === "happy");
    if (!happy) {
      if (uc.scenarios.length || uc.businessRules.length) {
        findings.push({
          severity: "error",
          category: "chain",
          useCaseIds: [uc.id],
          message: `${uc.id} has no happy path scenario, so its chain (preconditions → postconditions) is not testable.`,
          suggestion:
            "Add SC-01 as the happy path: GIVEN the preconditions … THEN the postconditions.",
          resolved: false,
        });
      }
      continue;
    }
    if (!happyPathCoversPreconditions(uc)) {
      findings.push({
        severity: "warning",
        category: "chain",
        useCaseIds: [uc.id],
        message: `${uc.id} ${happy.id}: the happy path GIVEN does not start from all of the use case's preconditions.`,
        suggestion:
          "Start the happy path with every precondition, verbatim and in order.",
        resolved: false,
      });
    }
    if (!happyPathCoversPostconditions(uc)) {
      findings.push({
        severity: "warning",
        category: "chain",
        useCaseIds: [uc.id],
        message: `${uc.id} ${happy.id}: the happy path's THEN lines do not state all of the use case's postconditions.`,
        suggestion:
          "End the happy path with every postcondition as a THEN line, verbatim.",
        resolved: false,
      });
    }
  }

  // Size.
  for (const uc of model.useCases) {
    const ruleCount = distinctRuleCount(uc);
    const tooManyRules = ruleCount > MAX_RULES_PER_USE_CASE;
    const tooManyScenarios = uc.scenarios.length > MAX_SCENARIOS_PER_USE_CASE;
    if (!tooManyRules && !tooManyScenarios) continue;
    const what = [
      tooManyRules ? `${ruleCount} distinct business rules` : "",
      tooManyScenarios ? `${uc.scenarios.length} scenarios` : "",
    ].filter(Boolean);
    findings.push({
      severity: "warning",
      category: "size",
      useCaseIds: [uc.id],
      message: `${uc.id} "${oneLine(uc.title, 60)}" has ${joinAnd(what)} — probably too big to build and test as one unit of work.`,
      suggestion:
        "Split it by user goal (e.g. one form section or one set of actions per use case) or re-generate with finer granularity.",
      resolved: false,
    });
  }

  // The same element governed differently in two use cases.
  const governance = new Map<
    string,
    { ucId: string; ruleId: string; key: string }[]
  >();
  for (const uc of model.useCases) {
    for (const r of uc.businessRules) {
      if (!r.elementId) continue;
      const list = governance.get(r.elementId) ?? [];
      list.push({
        ucId: uc.id,
        ruleId: r.id,
        key: r.rules.map(normText).sort().join("|"),
      });
      governance.set(r.elementId, list);
    }
  }
  for (const [elementId, list] of governance) {
    const ucIds = [...new Set(list.map((l) => l.ucId))];
    if (ucIds.length < 2 || new Set(list.map((l) => l.key)).size < 2) continue;
    findings.push({
      severity: "info",
      category: "consistency",
      useCaseIds: ucIds,
      message: `${elementId} is governed by different rules in ${joinAnd(list.map((l) => `${l.ucId} ${l.ruleId}`))}.`,
      suggestion:
        "Make sure both use cases describe the element the same way, or keep its rules in one use case only.",
      resolved: false,
    });
  }
  return findings;
}

/** Stable identity of a finding (used to tell which findings a repair resolved). */
export function findingKey(
  f: Pick<ReviewFinding, "category" | "useCaseIds" | "message">,
): string {
  return `${f.category}|${[...f.useCaseIds].sort().join(",")}|${normText(f.message)}`;
}

/** Sorted by severity (stable) and numbered RV-01… */
export function numberFindings(
  findings: readonly DraftFinding[],
): ReviewFinding[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort(
      (a, b) =>
        Number(a.f.resolved) - Number(b.f.resolved) ||
        SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] ||
        a.i - b.i,
    )
    .map(({ f }, i) => {
      const finding: ReviewFinding = {
        id: `RV-${String(i + 1).padStart(2, "0")}`,
        severity: f.severity,
        category: f.category,
        useCaseIds: [...f.useCaseIds],
        message: f.message,
        resolved: f.resolved,
      };
      if (f.suggestion) finding.suggestion = f.suggestion;
      return finding;
    });
}

/* ── Offline reviewer heuristics (also a cheap sanity net) ──────────── */

/** Words that make a rule untestable unless a number, quote or example pins them down. */
const VAGUE =
  /\b(appropriate(ly)?|proper(ly)?|as needed|as required|etc|user[- ]friendly|fast|quickly|reasonable|suitable|relevant|in a timely manner|(must|should) be (valid|correct)|valid (value|input|data|format))\b/i;

/** Rule bullets that a tester could not verify: vague words with no number, quote or example. */
export function vagueRuleFindings(
  useCases: readonly UseCase[],
): ReviewerOutput["findings"] {
  const out: ReviewerOutput["findings"] = [];
  for (const uc of useCases) {
    for (const r of uc.businessRules) {
      const vague = r.rules.find((b) => VAGUE.test(b) && !/\d|["“”'(]/.test(b));
      if (!vague) continue;
      out.push({
        severity: "info",
        category: "ambiguity",
        useCaseIds: [uc.id],
        message: `${uc.id} ${r.id} (${r.element}): "${oneLine(vague, 120)}" is not testable as written.`,
        suggestion: `${r.id}: state the exact limit, format, allowed values or message instead.`,
      });
      break;
    }
  }
  return out;
}

export function mockReview(useCases: readonly UseCase[]): ReviewerOutput {
  const findings = vagueRuleFindings(useCases);
  const withQuestions = useCases.filter((u) => u.openQuestions.length);
  if (withQuestions.length) {
    const total = withQuestions.reduce((n, u) => n + u.openQuestions.length, 0);
    findings.push({
      severity: "info",
      category: "ambiguity",
      useCaseIds: withQuestions.map((u) => u.id),
      message: `${total} open question(s) across ${withQuestions.length} use case(s) must be answered before build, e.g. "${oneLine(withQuestions[0].openQuestions[0], 120)}".`,
      suggestion:
        "Walk through QUESTIONS.md with the product owner and update the affected business rules.",
    });
  }
  const inferred = useCases.filter((u) =>
    u.assumptions.some((a) => /inferred/i.test(a)),
  );
  if (inferred.length) {
    findings.push({
      severity: "info",
      category: "other",
      useCaseIds: inferred.map((u) => u.id),
      message: `${inferred.length} use case(s) rely on details inferred from the designs rather than shown in them (validation limits, message wording).`,
      suggestion:
        "Confirm the assumptions with UX and the product owner; remove each assumption once confirmed.",
    });
  }
  return { findings: findings.slice(0, MAX_LLM_FINDINGS) };
}

/* ── Reviewer agent ─────────────────────────────────────────────────── */

/** Compact, complete text of one use case for the reviewer. */
export function useCaseReviewText(
  uc: UseCase,
  model: Pick<SolutionModel, "features" | "personas">,
  screenName: (id: string) => string,
): string {
  const lines = [
    `## ${uc.id} "${uc.title}" · feature ${model.features.find((f) => f.id === uc.featureId)?.name ?? uc.featureId} · persona ${model.personas.find((p) => p.id === uc.personaId)?.name ?? uc.story.asA} · screens ${uc.screenIds.map(screenName).join(", ")} · depends on ${uc.dependsOn.join(", ") || "—"} · status ${uc.status}`,
    `Story: As a ${uc.story.asA}, I want to ${uc.story.iWant}, so that ${uc.story.soThat}.`,
    `Scope: ${uc.scope}`,
    `Preconditions: ${uc.preconditions.map((p) => JSON.stringify(p)).join("; ") || "—"}`,
    `Postconditions: ${uc.postconditions.map((p) => JSON.stringify(p)).join("; ") || "—"}`,
    "Business rules:",
    ...uc.businessRules.map(
      (r) =>
        `- ${r.id} ${r.element} (${r.elementType}${r.elementId ? `, ${r.elementId}` : ""}): ${r.description} | ${r.rules.join(" | ")}`,
    ),
    "Scenarios:",
    ...uc.scenarios.map(
      (s) =>
        `- ${s.id} (${s.type}) ${s.title}: GIVEN ${s.given.join(" AND ") || "—"}; WHEN ${s.when.join(" AND ") || "—"}; THEN ${s.then.join(" THEN ") || "—"}`,
    ),
  ];
  if (uc.assumptions.length)
    lines.push(`Assumptions: ${uc.assumptions.join(" | ")}`);
  if (uc.openQuestions.length)
    lines.push(`Open questions: ${uc.openQuestions.join(" | ")}`);
  return lines.join("\n");
}

export interface ReviewArgs {
  ctx: JobContext;
  project: Project;
  model: SolutionModel;
  connection: LLMConnection;
  /** Findings of the deterministic checks (shown to the agent so it does not repeat them). */
  deterministic: readonly DraftFinding[];
}

/** Reviewer agent findings (consistency, ambiguity, gaps), validated against the real use case ids. */
export async function reviewUseCases(
  args: ReviewArgs,
): Promise<DraftFinding[]> {
  const { ctx, project, model, connection } = args;
  const screens = sortedScreens(project);
  const screenName = (id: string): string =>
    `"${screens.find((s) => s.id === id)?.name ?? id}"`;
  const reviewContent = (subset: readonly UseCase[]) =>
    [
      `# Use cases (${model.useCases.length}, in build order)`,
      ...subset.map((uc) => useCaseReviewText(uc, model, screenName)),
      ...(subset === model.useCases
        ? []
        : [
            "# Cross-batch contract index (detailed consistency across batches requires human review)",
            ...model.useCases.map((u) =>
              JSON.stringify({
                id: u.id,
                title: u.title,
                dependsOn: u.dependsOn,
                preconditions: u.preconditions,
                postconditions: u.postconditions,
              }),
            ),
          ]),
      "",
      "# Findings of the deterministic checks (do not repeat these)",
      ...(args.deterministic.length
        ? args.deterministic.map(
            (f) => `- [${f.severity}/${f.category}] ${f.message}`,
          )
        : ["- none"]),
      "",
      "Review the use cases and report the consistency, ambiguity and gap findings a careful lead BA would raise.",
    ].join("\n");

  const batches = await capacityBatches(
    model.useCases,
    (subset) =>
      generateStructured({
        ...callBase(ctx, connection, "review"),
        system: reviewerSystem(project),
        content: [{ type: "text", text: reviewContent(subset) }],
        schema: ReviewerOutputSchema,
        schemaName: "review",
        mock: () => mockReview(subset),
      }),
    ctx.signal,
    (message) => ctx.warn(message),
  );
  const raw: ReviewerOutput = { findings: batches.flatMap((b) => b.findings) };

  const known = new Set(model.useCases.map((u) => u.id));
  const seen = new Set(args.deterministic.map(findingKey));
  const out: DraftFinding[] = [];
  for (const f of raw.findings) {
    const message = f.message.trim();
    if (!message) continue;
    const useCaseIds = [
      ...new Set(
        f.useCaseIds
          .map((id) => id.trim().toUpperCase())
          .filter((id) => known.has(id)),
      ),
    ];
    const finding: DraftFinding = {
      severity: f.severity,
      category: f.category,
      useCaseIds,
      message,
      resolved: false,
    };
    if (f.suggestion.trim()) finding.suggestion = f.suggestion.trim();
    const key = findingKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
    if (out.length >= MAX_LLM_FINDINGS) break;
  }
  return out;
}

/* ── Self-repair (thorough mode) ────────────────────────────────────── */

const REPAIRABLE: ReadonlySet<ReviewCategory> = new Set([
  "chain",
  "coverage",
  "consistency",
]);

export interface SelfRepairArgs {
  ctx: JobContext;
  project: Project;
  model: SolutionModel;
  connection: LLMConnection;
  format: OutputFormat;
  includeImages: boolean;
  deterministic: readonly DraftFinding[];
  agent: readonly DraftFinding[];
  /** Use cases that must not be rewritten (kept as edited/approved by the BA). */
  lockedIds: ReadonlySet<string>;
}

export interface SelfRepairResult {
  useCases: UseCase[];
  findings: DraftFinding[];
  rewritten: string[];
}

function revisionNotesFor(
  ucId: string,
  findings: readonly DraftFinding[],
): string {
  return [
    "The review found these problems in this use case. Fix each of them; keep everything else (including the postconditions other use cases depend on) unchanged:",
    ...findings.map(
      (f) =>
        `- [${f.severity}/${f.category}] ${f.message}${f.suggestion ? ` Suggested fix: ${f.suggestion}` : ""}`,
    ),
    `Keep the ids of the business rules and scenarios of ${ucId} that still exist.`,
  ].join("\n");
}

/**
 * One repair round: rewrite use cases with error/warning chain/coverage/consistency findings, then re-check
 * the deterministic findings (agent findings stay open; see below).
 */
export async function selfRepair(
  args: SelfRepairArgs,
): Promise<SelfRepairResult> {
  const { ctx, model } = args;
  const all = [...args.deterministic, ...args.agent];
  const targets = new Map<string, DraftFinding[]>();
  for (const f of all) {
    if (f.resolved || f.severity === "info" || !REPAIRABLE.has(f.category))
      continue;
    for (const id of f.useCaseIds) {
      if (args.lockedIds.has(id) || !model.useCases.some((u) => u.id === id))
        continue;
      const list = targets.get(id) ?? [];
      list.push(f);
      targets.set(id, list);
    }
  }
  if (!targets.size)
    return { useCases: model.useCases, findings: [...all], rewritten: [] };

  ctx.info(
    `Self-repair: rewriting ${targets.size} use case(s) to address ${all.filter((f) => !f.resolved && f.severity !== "info" && REPAIRABLE.has(f.category)).length} finding(s).`,
  );
  const rewritten = new Map<string, UseCase>();
  await Promise.all(
    [...targets.entries()].map(async ([id, findings]) => {
      const uc = model.useCases.find((u) => u.id === id)!;
      try {
        const next = await writeUseCaseContent({
          ctx,
          project: args.project,
          model,
          useCase: uc,
          connection: args.connection,
          format: args.format,
          revisionNotes: revisionNotesFor(id, findings),
          includeImages: args.includeImages,
        });
        rewritten.set(id, { ...next, revision: uc.revision });
      } catch (err) {
        if (
          err instanceof CancelledError ||
          ctx.signal.aborted ||
          stopsTheRun(err)
        )
          throw err;
        ctx.warn(
          `Self-repair of ${id} failed (${errorMessage(err)}) — keeping the first version.`,
        );
      }
    }),
  );

  const useCases = model.useCases.map((u) => rewritten.get(u.id) ?? u);
  const after = deterministicReview({ screens: model.screens, useCases });
  const afterKeys = new Set(after.map(findingKey));
  const beforeKeys = new Set(args.deterministic.map(findingKey));

  // Deterministic findings are re-checked. An agent finding cannot be: nothing proves the rewrite fixed it
  // (or that the other use cases it names were rewritten at all), so it stays open — an open error keeps the
  // project in "needs review" — and only notes the attempt for the BA.
  const findings: DraftFinding[] = [
    ...args.deterministic.map((f) =>
      afterKeys.has(findingKey(f)) ? f : { ...f, resolved: true },
    ),
    ...after.filter((f) => !beforeKeys.has(findingKey(f))),
    ...args.agent.map((f) => {
      const attempted = f.useCaseIds.filter((id) => rewritten.has(id));
      if (
        !REPAIRABLE.has(f.category) ||
        f.severity === "info" ||
        !attempted.length
      )
        return f;
      return {
        ...f,
        suggestion: `${f.suggestion ? `${f.suggestion} ` : ""}(The automatic repair pass rewrote ${attempted.join(", ")} to address this — verify that it is fixed.)`,
      };
    }),
  ];
  const resolved = findings.filter((f) => f.resolved).length;
  ctx.info(
    `Self-repair rewrote ${rewritten.size} use case(s); ${resolved} finding(s) resolved.`,
  );
  return { useCases, findings, rewritten: [...rewritten.keys()] };
}
