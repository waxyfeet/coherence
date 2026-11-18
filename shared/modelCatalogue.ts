/** Catalogue facts are provider-reported metadata, never independently tested capability. */
export interface CatalogueModel {
  id: string;
  label?: string;
  reported?: {
    vision?: boolean;
    contextWindow?: number;
    /** Separate input-only limit; do not subtract output from this value. */
    inputTokenLimit?: number;
    outputTokenLimit?: number;
    supportedParameters?: (
      | "reasoning"
      | "reasoning_effort"
      | "response_format"
      | "structured_outputs"
    )[];
    reasoning?: { mandatory?: boolean; supportedEfforts?: string[] };
    loaded?: boolean;
  };
}
export interface ModelCatalogue {
  models: CatalogueModel[];
  refreshedAt: string;
  source:
    | "openai"
    | "anthropic"
    | "gemini"
    | "ollama"
    | "lm-studio-v1"
    | "lm-studio-v0"
    | "compatible";
  complete: boolean;
}
export type CatalogueFailure =
  | "auth"
  | "unreachable"
  | "timeout"
  | "unsupported"
  | "malformed"
  | "partial"
  | "rate-limit"
  | "policy"
  | "superseded";
export function visibleModels(connection: {
  modelIds?: string[];
  visibleModelIds?: string[];
}) {
  const configured = connection.modelIds ?? [];
  return (
    connection.visibleModelIds?.filter((id) => configured.includes(id)) ??
    configured
  );
}
