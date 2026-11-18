/** Resolve only the assigned destinations. Missing saved connections fail closed until explicitly replaced. */
import type { LLMConnection, Project } from "@shared/types";
import { projectConnectionChoices } from "@shared/generationContext";
import { loadModel } from "../storage/projectStore";
import { NotFoundError, BadRequestError } from "../errors";
import { allowsLocalAnalysis } from "@shared/localModelPolicy";
import { resolveConnection, resolveModelSelection } from "../llm/registry";
import { cachedCatalogue, executionCatalogue } from "../llm/catalogue";
import { cachedCapabilities } from "../llm/capabilities";
import { capabilityRecords, modelEvidence } from "@shared/modelCapabilities";
import { effectiveModelFacts } from "@shared/modelFacts";
import type { ProviderConnection } from "@shared/types";

export interface SavedConnectionChoice {
  /** Connection id saved on the project (may be dangling). */
  id: string | undefined;
  modelId?: string;
  acknowledged?: boolean;
  /** What the project uses it for, for the warning ("reading screens"). */
  use: string;
}

/** Compatibility with older projects whose last run choices lived only in model.options. */
export async function savedProjectConnections(project: Project) {
  const legacy = project.generationPreferences
    ? undefined
    : (await loadModel(project.id))?.options;
  return projectConnectionChoices(project, legacy);
}

export interface ResolvedConnection {
  connection: LLMConnection;
  acknowledged?: boolean;
}

/** Explicit job choices win; saved assignments must exist. Defaults apply only to unassigned roles. */
export async function resolveJobConnection(
  project: Project,
  explicit: string | undefined,
  saved: readonly SavedConnectionChoice[],
  fallback?: LLMConnection,
  selection: {
    modelId?: string;
    reading?: boolean;
    acknowledged?: boolean;
    /** Only an explicit running job refreshes metadata; selection/preflight stays read-only/offline. */
    refreshMetadata?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<ResolvedConnection> {
  const checked = async (
    connection: ProviderConnection,
    modelId?: string,
    acknowledged?: boolean,
  ): Promise<ResolvedConnection> => {
    if (project.localOnly && connection.provider !== "mock") {
      const local = allowsLocalAnalysis(connection);
      if (!local)
        throw new BadRequestError(
          "This project is local-only. Select Offline demo or an Ollama/OpenAI-compatible connection on this computer's loopback address. No data was sent.",
        );
    }
    const catalogue =
      connection.provider === "mock"
        ? undefined
        : await (selection.refreshMetadata
            ? executionCatalogue(connection, selection.signal)
            : cachedCatalogue(connection));
    const facts = effectiveModelFacts(
      connection,
      modelId ?? "",
      catalogue?.models.find((m) => m.id === modelId),
    );
    const evidence = modelEvidence(
      capabilityRecords(await cachedCapabilities(connection), modelId ?? ""),
      facts,
    );
    const composed = resolveModelSelection(connection, modelId, {
      reading: selection.reading,
      acknowledged,
      reportedVision: facts.reported?.vision,
      modelOutputTokenLimit: facts.reported?.outputTokenLimit,
      imageEvidence: evidence.image.state,
      textEvidence: evidence.text.state,
    });
    return {
      connection: {
        ...composed,
        modelContextWindow:
          composed.provider === "ollama"
            ? Math.min(
                32768,
                evidence.contextWindow ??
                  facts.reported?.contextWindow ??
                  32768,
              )
            : facts.reported?.contextWindow,
        modelInputTokenLimit: facts.reported?.inputTokenLimit,
        modelFactsAt: catalogue?.refreshedAt,
        modelReasoning: facts.reported?.reasoning
          ? {
              ...facts.reported.reasoning,
              automaticExtraction: connection.effort === undefined,
            }
          : undefined,
        modelStructuredMode:
          evidence.nativeStructured.state === "tested" ||
          facts.reported?.supportedParameters?.includes("structured_outputs")
            ? "native"
            : evidence.promptStructured.state === "tested"
              ? "prompt"
              : undefined,
        // Apply account-wide optional values only when this exact model accepted them.
        effort:
          evidence.reasoning.state === "tested" ? composed.effort : undefined,
        temperature:
          evidence.sampling.state === "tested"
            ? composed.temperature
            : undefined,
      },
      acknowledged: !!acknowledged,
    };
  };
  if (explicit) {
    const remembered = saved.find((choice) => choice.id === explicit);
    return checked(
      await resolveConnection(explicit),
      selection.modelId ?? remembered?.modelId,
      selection.acknowledged ??
        (selection.modelId === undefined ||
        selection.modelId === remembered?.modelId
          ? remembered?.acknowledged
          : false),
    );
  }
  for (const choice of saved) {
    if (!choice.id) continue;
    try {
      return checked(
        await resolveConnection(choice.id),
        selection.modelId ?? choice.modelId,
        selection.acknowledged ??
          (selection.modelId === undefined ||
          selection.modelId === choice.modelId
            ? choice.acknowledged
            : false),
      );
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      throw new NotFoundError(
        `The saved AI connection for ${choice.use} no longer exists. Choose an available connection explicitly in Analysis before retrying. No replacement provider was selected.`,
      );
    }
  }
  // The built-in simulation is the only unassigned fallback. Never choose a cloud/local account implicitly.
  if (fallback && fallback.provider !== "mock")
    throw new BadRequestError(
      "Choose an exact writing model in Analysis. No reading model or replacement destination was substituted.",
    );
  const unassigned =
    fallback?.provider === "mock"
      ? fallback
      : await resolveConnection(undefined);
  if (unassigned.provider !== "mock")
    throw new BadRequestError(
      "Choose a provider connection and exact model for both roles in Analysis. No replacement destination was selected.",
    );
  return checked({ ...unassigned, modelIds: [] }, selection.modelId);
}
