/**
 * OWNER: formats builder.
 * Deterministic, human-readable diff between two versions of a use case. Used when the BA edits a .md
 * file (→ "Analyse knock-on effects") and after impact-apply rewrites.
 */
import type {
  BddScenario,
  BusinessRule,
  UseCase,
  UseCaseDiff,
  UseCaseSection,
} from "@shared/types";

const SECTION_ORDER: UseCaseSection[] = [
  "title",
  "story",
  "scope",
  "preconditions",
  "postconditions",
  "rules",
  "scenarios",
  "assumptions",
  "openQuestions",
  "notes",
  "dependencies",
  "elements",
  "status",
];

const TYPE_LABEL: Record<string, string> = {
  happy: "happy path",
  alternate: "alternate",
  negative: "negative",
  edge: "edge case",
};

/** Whitespace-insensitive comparison key (formatting-only edits are not changes). */
function norm(text: string | undefined | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function q(text: string | undefined | null, max = 80): string {
  const s = norm(text);
  return `'${s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s}'`;
}

type Op = { kind: "eq" | "del" | "ins"; value: string };

/** LCS-based list diff on normalised items. */
function diffLists(before: string[], after: string[]): Op[] {
  const a = before.map(norm).filter(Boolean);
  const b = after.map(norm).filter(Boolean);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", value: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: "del", value: a[i++] });
    } else {
      ops.push({ kind: "ins", value: b[j++] });
    }
  }
  while (i < n) ops.push({ kind: "del", value: a[i++] });
  while (j < m) ops.push({ kind: "ins", value: b[j++] });
  return ops;
}

/**
 * Human lines for a list change. Removals and additions in the same spot are paired as "changed",
 * which reads naturally for edits ("min 8 characters" → "min 12 characters").
 */
function listChanges(
  before: string[],
  after: string[],
  phrase: {
    changed: (from: string, to: string) => string;
    added: (v: string) => string;
    removed: (v: string) => string;
  },
): string[] {
  const ops = diffLists(before, after);
  const out: string[] = [];
  let dels: string[] = [];
  let ins: string[] = [];
  const flush = () => {
    const pairs = Math.min(dels.length, ins.length);
    for (let k = 0; k < pairs; k++) out.push(phrase.changed(dels[k], ins[k]));
    for (const d of dels.slice(pairs)) out.push(phrase.removed(d));
    for (const a of ins.slice(pairs)) out.push(phrase.added(a));
    dels = [];
    ins = [];
  };
  for (const op of ops) {
    if (op.kind === "eq") flush();
    else if (op.kind === "del") dels.push(op.value);
    else ins.push(op.value);
  }
  flush();
  return out;
}

function simpleList(noun: string): Parameters<typeof listChanges>[2] {
  return {
    changed: (from, to) => `Changed ${noun} ${q(from)} → ${q(to)}`,
    added: (v) => `Added ${noun} ${q(v)}`,
    removed: (v) => `Removed ${noun} ${q(v)}`,
  };
}

function ruleLabel(rule: BusinessRule): string {
  const type = rule.elementType.replace(/_/g, " ");
  return norm(rule.element)
    ? `${norm(rule.element)} — ${type.charAt(0).toUpperCase()}${type.slice(1)}`
    : type;
}

function diffRules(before: BusinessRule[], after: BusinessRule[]): string[] {
  const out: string[] = [];
  const beforeById = new Map(before.map((r) => [r.id, r]));
  const afterIds = new Set(after.map((r) => r.id));
  for (const r of before) {
    if (!afterIds.has(r.id)) out.push(`Removed ${r.id} ${q(ruleLabel(r))}`);
  }
  for (const r of after) {
    const old = beforeById.get(r.id);
    if (!old) {
      out.push(`Added ${r.id} ${q(ruleLabel(r))}`);
      continue;
    }
    if (
      norm(old.element) !== norm(r.element) ||
      old.elementType !== r.elementType
    ) {
      out.push(
        `${r.id} element changed: ${q(ruleLabel(old))} → ${q(ruleLabel(r))}`,
      );
    }
    if ((old.elementId ?? "") !== (r.elementId ?? "")) {
      out.push(
        r.elementId
          ? `${r.id} now governs ${r.elementId}${old.elementId ? ` (was ${old.elementId})` : ""}`
          : `${r.id} no longer names an element (was ${old.elementId})`,
      );
    }
    if (norm(old.description) !== norm(r.description)) {
      out.push(
        `${r.id} description changed: ${q(old.description)} → ${q(r.description)}`,
      );
    }
    out.push(
      ...listChanges(old.rules, r.rules, {
        changed: (from, to) => `${r.id} rules changed: ${q(from)} → ${q(to)}`,
        added: (v) => `${r.id} rule added: ${q(v)}`,
        removed: (v) => `${r.id} rule removed: ${q(v)}`,
      }),
    );
  }
  return out;
}

function diffScenarios(before: BddScenario[], after: BddScenario[]): string[] {
  const out: string[] = [];
  const beforeById = new Map(before.map((s) => [s.id, s]));
  const afterIds = new Set(after.map((s) => s.id));
  for (const s of before) {
    if (!afterIds.has(s.id)) out.push(`Removed ${s.id} ${q(s.title)}`);
  }
  for (const s of after) {
    const old = beforeById.get(s.id);
    if (!old) {
      out.push(`Added ${s.id} ${q(s.title)}`);
      continue;
    }
    if (norm(old.title) !== norm(s.title))
      out.push(`${s.id} title changed: ${q(old.title)} → ${q(s.title)}`);
    if (old.type !== s.type)
      out.push(
        `${s.id} type changed: ${TYPE_LABEL[old.type] ?? old.type} → ${TYPE_LABEL[s.type] ?? s.type}`,
      );
    for (const [key, keyword] of [
      ["given", "GIVEN"],
      ["when", "WHEN"],
      ["then", "THEN"],
    ] as const) {
      out.push(
        ...listChanges(old[key], s[key], {
          changed: (from, to) =>
            `${s.id} ${keyword} changed: ${q(from)} → ${q(to)}`,
          added: (v) => `${s.id} ${keyword} added: ${q(v)}`,
          removed: (v) => `${s.id} ${keyword} removed: ${q(v)}`,
        }),
      );
    }
  }
  return out;
}

function idSetChanges(
  before: string[],
  after: string[],
  added: (id: string) => string,
  removed: (id: string) => string,
): string[] {
  const a = new Set(before);
  const b = new Set(after);
  return [
    ...after.filter((id) => !a.has(id)).map(added),
    ...before.filter((id) => !b.has(id)).map(removed),
  ];
}

/** Returns a diff with changedSections = [] when nothing meaningful changed. */
export function diffUseCases(before: UseCase, after: UseCase): UseCaseDiff {
  const bySection = new Map<UseCaseSection, string[]>();
  const add = (section: UseCaseSection, lines: string[]) => {
    if (!lines.length) return;
    bySection.set(section, [...(bySection.get(section) ?? []), ...lines]);
  };

  if (norm(before.title) !== norm(after.title))
    add("title", [`Title changed: ${q(before.title)} → ${q(after.title)}`]);

  const storyLines: string[] = [];
  for (const [key, label] of [
    ["asA", "As a"],
    ["iWant", "I want to"],
    ["soThat", "So that"],
  ] as const) {
    const from = before.story?.[key];
    const to = after.story?.[key];
    if (norm(from) !== norm(to))
      storyLines.push(`User story "${label}" changed: ${q(from)} → ${q(to)}`);
  }
  if ((before.personaId ?? "") !== (after.personaId ?? "")) {
    storyLines.push(
      `Persona changed: ${before.personaId || "none"} → ${after.personaId || "none"}`,
    );
  }
  add("story", storyLines);

  const scopeLines: string[] = [];
  if (norm(before.scope) !== norm(after.scope))
    scopeLines.push(`Scope changed: ${q(before.scope)} → ${q(after.scope)}`);
  if ((before.featureId ?? "") !== (after.featureId ?? "")) {
    scopeLines.push(
      `Feature changed: ${before.featureId || "none"} → ${after.featureId || "none"}`,
    );
  }
  if (before.size !== after.size)
    scopeLines.push(`Size changed: ${before.size} → ${after.size}`);
  add("scope", scopeLines);

  add(
    "preconditions",
    listChanges(
      before.preconditions,
      after.preconditions,
      simpleList("precondition"),
    ),
  );
  add(
    "postconditions",
    listChanges(
      before.postconditions,
      after.postconditions,
      simpleList("postcondition"),
    ),
  );
  add("rules", diffRules(before.businessRules, after.businessRules));
  add("scenarios", diffScenarios(before.scenarios, after.scenarios));
  add(
    "assumptions",
    listChanges(
      before.assumptions,
      after.assumptions,
      simpleList("assumption"),
    ),
  );
  add(
    "openQuestions",
    listChanges(
      before.openQuestions,
      after.openQuestions,
      simpleList("open question"),
    ),
  );

  const notesBefore = norm(before.notes);
  const notesAfter = norm(after.notes);
  if (notesBefore !== notesAfter) {
    add("notes", [
      !notesBefore
        ? `Notes added: ${q(after.notes)}`
        : !notesAfter
          ? "Notes removed"
          : `Notes changed: ${q(after.notes)}`,
    ]);
  }

  add(
    "dependencies",
    idSetChanges(
      before.dependsOn,
      after.dependsOn,
      (id) => `Now depends on ${id}`,
      (id) => `No longer depends on ${id}`,
    ),
  );
  add("elements", [
    ...idSetChanges(
      before.elementIds,
      after.elementIds,
      (id) => `Now covers element ${id}`,
      (id) => `No longer covers element ${id}`,
    ),
    ...idSetChanges(
      before.screenIds,
      after.screenIds,
      (id) => `Now appears on screen ${id}`,
      (id) => `No longer appears on screen ${id}`,
    ),
  ]);
  if (before.status !== after.status)
    add("status", [`Status changed: ${before.status} → ${after.status}`]);

  const changedSections = SECTION_ORDER.filter((s) => bySection.has(s));
  const details = changedSections.flatMap((s) => bySection.get(s) ?? []);
  return {
    useCaseId: after.id || before.id,
    changedSections,
    summary: summarise(details),
    details,
  };
}

function summarise(details: string[]): string {
  if (!details.length) return "No changes";
  // "Added SC-05 …" reads as "…; added SC-05 …" mid-sentence, but ids ("BR-02 …") keep their case.
  const shown = details
    .slice(0, 3)
    .map((d, i) =>
      i > 0 && /^[A-Z][a-z]/.test(d)
        ? d.charAt(0).toLowerCase() + d.slice(1)
        : d,
    );
  const more = details.length - shown.length;
  return `${shown.join("; ")}${more > 0 ? `; and ${more} more change${more === 1 ? "" : "s"}` : ""}`;
}

/** True when the diff touches anything besides the status (content or structure changed). */
export function hasContentChanges(diff: UseCaseDiff): boolean {
  return diff.changedSections.some((s) => s !== "status");
}
