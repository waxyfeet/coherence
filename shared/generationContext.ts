import type {
  GenerationOptions,
  Project,
  ProjectLLMSelection,
  SolutionModel,
} from "./types";

/** Last submitted run choices win; explicitly saving project defaults synchronizes them in the store. */
export function projectConnectionChoices(
  project: Pick<Project, "llm" | "generationPreferences">,
  legacyRun?: GenerationOptions,
): ProjectLLMSelection {
  const run = project.generationPreferences ?? legacyRun;
  const readingRun =
    run?.visionConnectionId !== undefined || run?.visionModelId !== undefined;
  const writingRun =
    run?.textConnectionId !== undefined || run?.textModelId !== undefined;
  return {
    visionConnectionId: readingRun
      ? run?.visionConnectionId
      : project.llm.visionConnectionId,
    textConnectionId: writingRun
      ? run?.textConnectionId
      : project.llm.textConnectionId,
    visionModelId: readingRun ? run?.visionModelId : project.llm.visionModelId,
    textModelId: writingRun ? run?.textModelId : project.llm.textModelId,
    visionAcknowledged: readingRun
      ? run?.visionAcknowledged
      : project.llm.visionAcknowledged,
  };
}

/** Saved provenance is independent of current Settings, connection names and next-run dropdowns. */
export function savedGenerationKind(
  generator: SolutionModel["generator"],
): "offline" | "provider" | "mixed" | "unknown" {
  const routes = [generator.vision, generator.text];
  if (routes.some((route) => !route || !route.includes("/"))) return "unknown";
  const offline = routes.map((route) => route.startsWith("mock/"));
  return offline.every(Boolean)
    ? "offline"
    : offline.some(Boolean)
      ? "mixed"
      : "provider";
}
