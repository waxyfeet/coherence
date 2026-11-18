/**
 * Rough per-model prices (USD per million tokens) for cost estimates shown in the UI.
 * Estimates only — providers change prices; unknown models simply show token counts.
 * Local providers (ollama, openai-compatible on localhost) and the mock provider cost 0.
 */
import type { ProviderKind } from "./types";

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Keyed by exact model id. A longer id matches a key only when the rest is a version or date suffix
 * (gpt-4o-2024-08-06, gemini-2.5-flash-preview-05-20) — never a different, cheaper variant (gpt-4o-mini).
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic (first-party API rates)
  "claude-fable-5-1": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  // OpenAI (standard tier, prompts up to 272k tokens — verify)
  "gpt-5.6-sol": { inputPerMTok: 4, outputPerMTok: 20 },
  "gpt-5.6-terra": { inputPerMTok: 2, outputPerMTok: 12 },
  "gpt-5.6-luna": { inputPerMTok: 0.2, outputPerMTok: 1.2 },
  "gpt-5.5": { inputPerMTok: 5, outputPerMTok: 30 },
  "gpt-5.4": { inputPerMTok: 2.5, outputPerMTok: 15 },
  "gpt-5.4-mini": { inputPerMTok: 0.75, outputPerMTok: 4.5 },
  "gpt-5.4-nano": { inputPerMTok: 0.2, outputPerMTok: 1.25 },
  "gpt-5.2": { inputPerMTok: 1.75, outputPerMTok: 14 },
  "gpt-5.1": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "gpt-5": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "gpt-5-mini": { inputPerMTok: 0.25, outputPerMTok: 2 },
  "gpt-5-nano": { inputPerMTok: 0.05, outputPerMTok: 0.4 },
  "gpt-4.1": { inputPerMTok: 2, outputPerMTok: 8 },
  "gpt-4.1-mini": { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  "gpt-4.1-nano": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  // Google Gemini 3.x (paid tier; 3.8 and 3.6 Flash are at their 2026 rate, doubling on 2027-01-01; 3.1 Pro is the
  // ≤200k-token-prompt rate — verify)
  "gemini-3.8-flash": { inputPerMTok: 0.75, outputPerMTok: 3.75 },
  "gemini-3.6-flash": { inputPerMTok: 0.75, outputPerMTok: 3.75 },
  "gemini-3.5-flash-lite": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  "gemini-3.1-pro-preview": { inputPerMTok: 2, outputPerMTok: 12 },
  "gemini-3.1-flash-lite": { inputPerMTok: 0.25, outputPerMTok: 1.5 },
  "gemini-3-flash-preview": { inputPerMTok: 0.5, outputPerMTok: 3 },
  // Gemini 2.5 (being shut down — kept so existing connections still show a cost)
  "gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  "gemini-2.5-flash-lite": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
};

/** What may follow a priced id: a date or version (-2024-08-06, -20250929, -002, @20250929), -latest, -preview…, -exp…. */
const VERSION_SUFFIX =
  /^(?:-\d{4}-\d{2}-\d{2}|-\d{8}|-\d{3,4}|-latest|-preview(?:-[\w.-]+)?|-exp(?:-[\w.-]+)?|@[\w.-]+)$/i;

const FREE_PROVIDERS: ProviderKind[] = ["ollama", "mock"];

function isLocalUrl(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

export function priceFor(
  provider: ProviderKind,
  model: string,
  baseUrl?: string,
): ModelPrice | undefined {
  if (FREE_PROVIDERS.includes(provider))
    return { inputPerMTok: 0, outputPerMTok: 0 };
  if (provider === "openai-compatible" && isLocalUrl(baseUrl))
    return { inputPerMTok: 0, outputPerMTok: 0 };
  if (Object.hasOwn(MODEL_PRICES, model)) return MODEL_PRICES[model];
  const prefix = Object.keys(MODEL_PRICES)
    .filter(
      (k) => model.startsWith(k) && VERSION_SUFFIX.test(model.slice(k.length)),
    )
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? MODEL_PRICES[prefix] : undefined;
}

/** USD, or undefined when the price is unknown. */
export function estimateCostUsd(
  provider: ProviderKind,
  model: string,
  inputTokens: number,
  outputTokens: number,
  baseUrl?: string,
): number | undefined {
  const price = priceFor(provider, model, baseUrl);
  if (!price) return undefined;
  return (
    (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) /
    1_000_000
  );
}

export function formatUsd(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value === 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}
