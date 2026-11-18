import type { AnalysisModelDefaults } from "./types";
import type { CatalogueModel } from "./modelCatalogue";
import { modelEvidenceForConnection } from "./modelCapabilities";
import { OFFLINE_MODEL_ID, validModelId } from "./modelSelection";

export interface DefaultAccount {
  id: string;
  provider: string;
  modelIds?: string[];
  vision?: string;
  capabilities?: unknown;
  catalogue?: { models: CatalogueModel[] };
}
const keys = [
  "visionConnectionId",
  "visionModelId",
  "textConnectionId",
  "textModelId",
] as const;
/** Missing legacy settings use the existing Offline starting point, never the first cloud account. */
export function analysisModelDefaults(
  value: unknown,
  accounts: DefaultAccount[],
): AnalysisModelDefaults {
  if (value === undefined) {
    const id = accounts.find((c) => c.provider === "mock")?.id ?? "";
    return {
      visionConnectionId: id,
      visionModelId: id ? OFFLINE_MODEL_ID : "",
      textConnectionId: id,
      textModelId: id ? OFFLINE_MODEL_ID : "",
    };
  }
  // Damaged or dangling explicit selections require repair, not a substituted destination.
  const data =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const field = (key: (typeof keys)[number]) => {
    const value = Object.hasOwn(data, key) ? data[key] : undefined;
    return typeof value === "string" ? value : "";
  };
  return {
    visionConnectionId: field("visionConnectionId"),
    visionModelId: field("visionModelId"),
    textConnectionId: field("textConnectionId"),
    textModelId: field("textModelId"),
  };
}
export function sameAnalysisDefaults(
  a: AnalysisModelDefaults,
  b: AnalysisModelDefaults,
) {
  return keys.every((key) => a[key] === b[key]);
}
/** Selecting an account never silently chooses its first real model. */
export function changeDefaultConnection(
  value: AnalysisModelDefaults,
  accounts: DefaultAccount[],
  reading: boolean,
  id: string,
): AnalysisModelDefaults {
  const model =
    accounts.find((c) => c.id === id)?.provider === "mock"
      ? OFFLINE_MODEL_ID
      : "";
  return reading
    ? { ...value, visionConnectionId: id, visionModelId: model }
    : { ...value, textConnectionId: id, textModelId: model };
}
export function defaultRoleIssue(
  defaults: AnalysisModelDefaults,
  accounts: DefaultAccount[],
  reading: boolean,
): string | undefined {
  const id = reading ? defaults.visionConnectionId : defaults.textConnectionId,
    model = reading ? defaults.visionModelId : defaults.textModelId,
    label = reading ? "Read screens" : "Write use cases / reasoning",
    c = accounts.find((c) => c.id === id);
  if (!c) return `${label}: choose an available connection.`;
  if (
    !validModelId(model) ||
    (c.provider === "mock"
      ? model !== OFFLINE_MODEL_ID
      : !c.modelIds?.includes(model))
  )
    return `${label}: choose a configured model for this connection.`;
  if (c.provider !== "mock") {
    const e = modelEvidenceForConnection(c, model);
    if (reading && (c.vision === "no" || e.image.state === "unsupported"))
      return `${label}: this model is reported as unable to read images. Choose another model.`;
    if (!reading && e.text.state === "unsupported")
      return `${label}: this model is reported as unable to generate text. Choose another model.`;
  }
}
