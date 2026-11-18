/**
 * OWNER: formats builder (frozen contract — extend, don't change existing members).
 * An OutputFormat decides how use cases are phrased (writer guidance) and how they are rendered to /
 * parsed from markdown. v1 ships one format: 'use-case-bdd' (User story + Business rules + BDD scenarios).
 * New formats register in ./registry.ts and need no changes elsewhere.
 */
import type {
  OutputFormatInfo,
  Project,
  SolutionModel,
  UseCase,
} from "@shared/types";

export interface RenderContext {
  project: Project;
  model: SolutionModel;
  /** Embed screen images (copied to <outputDir>/screens/images/) in the markdown. */
  embedScreenImages: boolean;
}

export interface ParsedUseCase {
  /**
   * Fields recovered from the markdown. Always includes id. Content fields (title, story, scope,
   * preconditions, postconditions, businessRules, scenarios, assumptions, openQuestions, notes) and
   * front-matter fields (featureId, personaId, screenIds, elementIds, dependsOn, size, status, revision,
   * external) are present when found.
   */
  useCase: Partial<UseCase> & { id: string };
  /** Fatal problems (e.g. missing front matter id) — the file cannot be merged. */
  errors: string[];
  /** Non-fatal problems (e.g. unknown keyword in a scenario line) — merged anyway. */
  warnings: string[];
}

export interface SupportFile {
  /** POSIX path relative to outputDir, e.g. "README.md", "screens/login.md". */
  path: string;
  content: string;
}

export interface OutputFormat {
  info: OutputFormatInfo;
  /**
   * Prompt guidance appended to the Use Case Writer agent's system prompt: tone, granularity and the exact
   * meaning of each field for this format.
   */
  writerGuidance: string;
  /** POSIX path relative to outputDir for a use case file, e.g. "use-cases/UC-001-sign-in.md". */
  useCasePath(uc: UseCase): string;
  /** Full markdown including YAML front matter. Must round-trip through parseUseCase. */
  renderUseCase(uc: UseCase, ctx: RenderContext): string;
  parseUseCase(markdown: string): ParsedUseCase;
  /**
   * Optional: refresh only the generated, display-only parts (front matter, summary header with its links)
   * of a use case file the BA owns (edited / approved), keeping every content section byte for byte. Used
   * when such a file is preserved while the rest of the specs are regenerated (ids and links may change).
   * Formats without it get a front-matter-only refresh.
   */
  refreshGeneratedParts?(
    markdown: string,
    uc: UseCase,
    ctx: RenderContext,
  ): string;
  /**
   * Optional: every front-matter key the format writes or reads. When set, rewriting a file's front matter keeps
   * the keys a BA added that are not in this list (with their comments); without it the block is replaced.
   */
  frontMatterKeys?: readonly string[];
  /** README.md (index + dependency chain), screens/<key>.md (element inventories), REVIEW.md, CHANGELOG.md. */
  renderSupportFiles(ctx: RenderContext): SupportFile[];
}
