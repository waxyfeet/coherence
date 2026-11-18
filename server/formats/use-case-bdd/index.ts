/**
 * OWNER: formats builder.
 * The v1 output format: Use cases with a user story, business rules per UI element and BDD scenarios.
 */
import type { OutputFormat } from "../types";
import { USE_CASE_BDD_WRITER_GUIDANCE } from "./guidance";
import { useCasePathFor } from "./lookup";
import { parseUseCase } from "./parse";
import { refreshGeneratedParts, renderUseCase } from "./render";
import { renderSupportFiles } from "./support";
import { FORMAT_ID, FRONT_MATTER_KEYS } from "./vocabulary";

const NAME = "Use cases (User story · Business rules · BDD)";

export const useCaseBddFormat: OutputFormat = {
  info: {
    id: FORMAT_ID,
    name: NAME,
    description:
      "One markdown file per use case: a user story (As a … I want to … So that …), business rules for every UI " +
      "element (labels, validation, options, states, messages) and BDD scenarios (GIVEN / WHEN / AND / THEN). " +
      "Use cases are chained — one use case's postconditions are the next one's preconditions — and ordered for " +
      "building. Also writes an index with diagrams, screen inventories, a build plan, traceability, data " +
      "dictionary, open questions and Gherkin .feature files.",
    isDefault: true,
  },
  writerGuidance: USE_CASE_BDD_WRITER_GUIDANCE,
  useCasePath: (uc) => useCasePathFor(uc),
  renderUseCase,
  parseUseCase,
  refreshGeneratedParts,
  frontMatterKeys: FRONT_MATTER_KEYS,
  renderSupportFiles: (ctx) => renderSupportFiles(ctx, NAME),
};

export { FORMAT_ID as USE_CASE_BDD_FORMAT_ID };
