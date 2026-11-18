/**
 * Vision (image input) capability resolution. connection.vision = 'auto' means "decide from the
 * provider preset", refined by what we know about the model name — e.g. an Ollama text model
 * like qwen3 must not be sent images even though the Ollama preset defaults to a vision model.
 */
import { PROVIDER_PRESETS } from "./providers";
import type { LLMConnection, ProviderKind } from "./types";

/** Local model names that indicate image support (Ollama tags, LM Studio / vLLM model ids). */
export const VISION_MODEL_PATTERN =
  /(vl|vision|llava|gemma3|gemma-3|minicpm-v|qwen2\.5vl|llama4|llama-4|mistral-small3|mistral-small-3|moondream|pixtral)/i;

/** OpenAI models that are text-only. */
const OPENAI_TEXT_ONLY =
  /^(o1-mini|o3-mini|gpt-3\.5|text-|davinci|babbage|gpt-oss)/i;

export function modelSupportsVision(
  provider: ProviderKind,
  model: string,
): boolean {
  const preset = PROVIDER_PRESETS[provider];
  const suggested = preset.suggestedModels.find((m) => m.id === model);
  if (suggested) return suggested.vision;
  switch (provider) {
    case "ollama":
    case "openai-compatible":
      return VISION_MODEL_PATTERN.test(model);
    case "openai":
    case "azure-openai":
      return !OPENAI_TEXT_ONLY.test(model);
    default:
      return preset.visionByDefault;
  }
}

export function resolveVision(connection: LLMConnection): boolean {
  if (connection.vision === "yes") return true;
  if (connection.vision === "no") return false;
  const model =
    connection.model || PROVIDER_PRESETS[connection.provider].defaultModel;
  return modelSupportsVision(connection.provider, model);
}
