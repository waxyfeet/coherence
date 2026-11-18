/**
 * OWNER: formats builder.
 * renderSupportFiles — every derived file of the spec folder (README, screen docs, reports, Gherkin).
 */
import type { RenderContext, SupportFile } from "../types";
import { renderFeatureFile } from "./gherkin";
import { buildLookup } from "./lookup";
import { renderReadme } from "./readme";
import {
  renderBuildPlan,
  renderChangelog,
  renderDataDictionary,
  renderQuestions,
  renderReview,
  renderTraceability,
} from "./reports";
import { renderScreenDocs } from "./screenDocs";

/** Report files at the root of the output folder (all derived, rewritten on every write). */
export const REPORT_FILES = [
  "BUILD-PLAN.md",
  "QUESTIONS.md",
  "TRACEABILITY.md",
  "DATA-DICTIONARY.md",
  "REVIEW.md",
  "CHANGELOG.md",
] as const;

export function renderSupportFiles(
  ctx: RenderContext,
  formatName: string,
): SupportFile[] {
  const lookup = buildLookup(ctx);
  const files: SupportFile[] = [
    { path: "README.md", content: renderReadme(lookup, formatName) },
    { path: "BUILD-PLAN.md", content: renderBuildPlan(lookup) },
    ...renderScreenDocs(lookup),
    { path: "QUESTIONS.md", content: renderQuestions(lookup) },
    { path: "TRACEABILITY.md", content: renderTraceability(lookup) },
    { path: "DATA-DICTIONARY.md", content: renderDataDictionary(lookup) },
    { path: "REVIEW.md", content: renderReview(lookup) },
    { path: "CHANGELOG.md", content: renderChangelog(lookup) },
    ...lookup.orderedUseCases.map((uc) => renderFeatureFile(lookup, uc)),
  ];
  return files;
}
