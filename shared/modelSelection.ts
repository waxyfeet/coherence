import { PROVIDER_PRESETS } from "./providers";
import type { ProviderKind } from "./types";

export const OFFLINE_MODEL_ID = PROVIDER_PRESETS.mock.defaultModel;
export const validModelId = (id: unknown): id is string =>
  typeof id === "string" &&
  id.length > 0 &&
  id.length <= 300 &&
  id === id.trim() &&
  !/[\r\n\u0000-\u001f]/.test(id);

/** Configuration/preset evidence only; never a claim of tested capability. */
export function imageInputEvidence(
  provider: ProviderKind,
  modelId: string,
  override = "auto",
  reportedVision?: boolean,
) {
  if (provider === "mock") return "simulated" as const;
  if (override === "no") return "unsupported" as const;
  if (override === "yes") return "user-declared" as const;
  if (reportedVision !== undefined)
    return reportedVision
      ? ("provider-reported" as const)
      : ("unsupported" as const);
  const suggested = PROVIDER_PRESETS[provider].suggestedModels.find(
    (m) => m.id === modelId,
  );
  if (suggested)
    return suggested.vision
      ? ("provider-suggested" as const)
      : ("unsupported" as const);
  return "unknown" as const;
}
