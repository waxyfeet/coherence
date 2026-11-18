/**
 * Provider presets shown in the "Add connection" form and used as server-side defaults.
 * Model suggestions are only suggestions — every provider also supports "List models" and free text.
 */
import type { Effort, ProviderKind } from "./types";

export interface ProviderPreset {
  kind: ProviderKind;
  label: string;
  /** Frontier (cloud) vs local. */
  category: "frontier" | "local" | "testing";
  description: string;
  defaultBaseUrl?: string;
  baseUrlRequired: boolean;
  baseUrlHint?: string;
  apiKeyRequired: boolean;
  apiKeyHint?: string;
  /** Environment variable the server reads when no key is stored. */
  apiKeyEnvVar?: string;
  defaultModel: string;
  suggestedModels: { id: string; label: string; vision: boolean }[];
  /** Default assumption about image support when connection.vision === 'auto'. */
  visionByDefault: boolean;
  supportsEffort: boolean;
  effortLevels?: Effort[];
  defaultEffort?: Effort;
  supportsTemperature: boolean;
  supportsNativeJsonSchema: boolean;
  supportsRefusalFallback: boolean;
  defaultConcurrency: number;
  defaultTimeoutSec: number;
  needsAzureApiVersion?: boolean;
  docsUrl?: string;
}

export const PROVIDER_PRESETS: Record<ProviderKind, ProviderPreset> = {
  anthropic: {
    kind: "anthropic",
    label: "Anthropic (Claude)",
    category: "frontier",
    description:
      "Claude models via the Anthropic API. Strong at reading UI screenshots and long structured specs.",
    defaultBaseUrl: "https://api.anthropic.com",
    baseUrlRequired: false,
    apiKeyRequired: true,
    apiKeyHint: "sk-ant-…",
    apiKeyEnvVar: "SCREENSCRIBE_V2_ANTHROPIC_API_KEY",
    defaultModel: "claude-opus-5-5",
    suggestedModels: [
      {
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5 (recommended)",
        vision: true,
      },
      {
        id: "claude-fable-5-1",
        label: "Claude Fable 5.1 (most capable)",
        vision: true,
      },
      {
        id: "claude-sonnet-5-5",
        label: "Claude Sonnet 5.5 (faster, cheaper)",
        vision: true,
      },
      {
        id: "claude-haiku-5-5",
        label: "Claude Haiku 5.5 (fastest)",
        vision: true,
      },
    ],
    visionByDefault: true,
    supportsEffort: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    supportsTemperature: false,
    supportsNativeJsonSchema: true,
    supportsRefusalFallback: true,
    defaultConcurrency: 4,
    defaultTimeoutSec: 600,
    docsUrl: "https://platform.claude.com/docs",
  },
  openai: {
    kind: "openai",
    label: "OpenAI",
    category: "frontier",
    description: "OpenAI models via the official API.",
    defaultBaseUrl: "https://api.openai.com/v1",
    baseUrlRequired: false,
    apiKeyRequired: true,
    apiKeyHint: "sk-…",
    apiKeyEnvVar: "SCREENSCRIBE_V2_OPENAI_API_KEY",
    defaultModel: "gpt-5.6-sol",
    suggestedModels: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol (reasoning)", vision: true },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra (reasoning)", vision: true },
      {
        id: "gpt-5.6-luna",
        label: "GPT-5.6 Luna (reasoning, lowest cost)",
        vision: true,
      },
      { id: "gpt-5.5", label: "GPT-5.5 (reasoning)", vision: true },
    ],
    visionByDefault: true,
    supportsEffort: true,
    effortLevels: ["low", "medium", "high"],
    supportsTemperature: true,
    supportsNativeJsonSchema: true,
    supportsRefusalFallback: false,
    defaultConcurrency: 4,
    defaultTimeoutSec: 600,
    docsUrl: "https://platform.openai.com/docs",
  },
  "azure-openai": {
    kind: "azure-openai",
    label: "Azure OpenAI",
    category: "frontier",
    description:
      'OpenAI models hosted in your Azure subscription. "Model" is your deployment name.',
    baseUrlRequired: true,
    baseUrlHint: "https://<resource>.openai.azure.com",
    apiKeyRequired: true,
    apiKeyEnvVar: "SCREENSCRIBE_V2_AZURE_OPENAI_API_KEY",
    defaultModel: "",
    suggestedModels: [],
    visionByDefault: true,
    supportsEffort: true,
    effortLevels: ["low", "medium", "high"],
    supportsTemperature: true,
    supportsNativeJsonSchema: true,
    supportsRefusalFallback: false,
    defaultConcurrency: 4,
    defaultTimeoutSec: 600,
    needsAzureApiVersion: true,
    docsUrl: "https://learn.microsoft.com/azure/ai-services/openai/",
  },
  gemini: {
    kind: "gemini",
    label: "Google Gemini",
    category: "frontier",
    description: "Gemini models via the Google AI (Gemini) API.",
    baseUrlRequired: false,
    apiKeyRequired: true,
    apiKeyEnvVar: "SCREENSCRIBE_V2_GEMINI_API_KEY",
    defaultModel: "gemini-3.8-flash",
    suggestedModels: [
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", vision: true },
      {
        id: "gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro (preview)",
        vision: true,
      },
      {
        id: "gemini-3.5-flash-lite",
        label: "Gemini 3.5 Flash-Lite (lowest cost)",
        vision: true,
      },
    ],
    visionByDefault: true,
    supportsEffort: false,
    supportsTemperature: true,
    supportsNativeJsonSchema: true,
    supportsRefusalFallback: false,
    defaultConcurrency: 4,
    defaultTimeoutSec: 600,
    docsUrl: "https://ai.google.dev/gemini-api/docs",
  },
  ollama: {
    kind: "ollama",
    label: "Ollama (local)",
    category: "local",
    description:
      "Models running locally in Ollama. Use a vision model (e.g. qwen3-vl, gemma3) to read screens.",
    defaultBaseUrl: "http://localhost:11434",
    baseUrlRequired: true,
    apiKeyRequired: false,
    defaultModel: "qwen3-vl:8b-instruct",
    suggestedModels: [
      {
        id: "qwen3-vl:8b-instruct",
        label: "Qwen3-VL 8B Instruct (vision)",
        vision: true,
      },
      {
        id: "qwen3-vl:30b-a3b-instruct",
        label: "Qwen3-VL 30B-A3B Instruct (vision)",
        vision: true,
      },
      { id: "gemma3:27b", label: "Gemma 3 27B (vision)", vision: true },
    ],
    visionByDefault: true,
    supportsEffort: false,
    supportsTemperature: true,
    supportsNativeJsonSchema: true,
    supportsRefusalFallback: false,
    defaultConcurrency: 1,
    defaultTimeoutSec: 1800,
    docsUrl: "https://ollama.com/library",
  },
  "openai-compatible": {
    kind: "openai-compatible",
    label: "Custom OpenAI-compatible",
    category: "local",
    description:
      "Any server exposing the OpenAI Chat Completions API, local or hosted.",
    defaultBaseUrl: "http://localhost:1234/v1",
    baseUrlRequired: true,
    baseUrlHint:
      "LM Studio: http://localhost:1234/v1 · vLLM: http://localhost:8000/v1",
    apiKeyRequired: false,
    defaultModel: "",
    suggestedModels: [],
    visionByDefault: false,
    supportsEffort: false,
    supportsTemperature: true,
    supportsNativeJsonSchema: false,
    supportsRefusalFallback: false,
    defaultConcurrency: 1,
    defaultTimeoutSec: 1800,
  },
  mock: {
    kind: "mock",
    label: "Offline demo (no AI)",
    category: "testing",
    description:
      "Deterministic heuristic output with no network calls. For trying the workflow end-to-end; it cannot actually see your screens.",
    baseUrlRequired: false,
    apiKeyRequired: false,
    defaultModel: "demo",
    suggestedModels: [{ id: "demo", label: "Demo", vision: true }],
    visionByDefault: true,
    supportsEffort: false,
    supportsTemperature: false,
    supportsNativeJsonSchema: true,
    supportsRefusalFallback: false,
    defaultConcurrency: 4,
    defaultTimeoutSec: 60,
  },
};

export const PROVIDER_ORDER: ProviderKind[] = [
  "anthropic",
  "openai",
  "azure-openai",
  "gemini",
  "ollama",
  "openai-compatible",
  "mock",
];
