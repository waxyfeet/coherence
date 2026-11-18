import type { CatalogueModel } from "./modelCatalogue";

/**
 * Exact provider-documented facts, checked 25 October 2026; never test results.
 * https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
 * https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash
 * https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
 * Vendor facts never apply to compatible gateways, Azure deployments or guessed IDs.
 */
export function documentedModelFacts(
  account: { provider: string; baseUrl?: string; endpoint?: string },
  modelId: string,
): CatalogueModel["reported"] | undefined {
  if (account.provider !== "gemini") return;
  try {
    const url = new URL(
      account.baseUrl ||
        account.endpoint ||
        "https://generativelanguage.googleapis.com",
    );
    if (
      url.origin !== "https://generativelanguage.googleapis.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["/", "/v1beta", "/v1beta/", "/v1", "/v1/"].includes(url.pathname)
    )
      return;
  } catch {
    return;
  }
  if (
    !["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash"].includes(
      modelId,
    )
  )
    return;
  return { vision: true, inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 };
}

/** Catalogue negatives win; output limits use the smaller reliable ceiling. */
export function effectiveModelFacts(
  account: Parameters<typeof documentedModelFacts>[0],
  modelId: string,
  catalogue?: CatalogueModel,
): CatalogueModel {
  const documented = documentedModelFacts(account, modelId);
  if (catalogue?.id !== modelId) catalogue = undefined;
  const reported = { ...documented, ...catalogue?.reported };
  const limits = [
    documented?.outputTokenLimit,
    catalogue?.reported?.outputTokenLimit,
  ].filter((n): n is number => Number.isSafeInteger(n) && n! > 0);
  if (limits.length) reported.outputTokenLimit = Math.min(...limits);
  return { id: modelId, reported };
}
