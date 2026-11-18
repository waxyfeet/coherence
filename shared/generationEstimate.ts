/** Adapted read-only reference planning heuristic. Estimates are illustrative, never a quote or completion forecast. */
import type { ProviderKind, Thoroughness } from "./types";
import { PROVIDER_PRESETS } from "./providers";
import { estimateCostUsd } from "./pricing";
export const ESTIMATE = {
  readInputPerScreen: 6000,
  readOutputPerScreen: 2000,
  useCasesPerScreen: 3,
  writeInputPerUseCase: 8000,
  writeOutputPerUseCase: 2500,
  thoroughRepairFactor: 1.25,
  /** Seconds per sequential batch of calls on a cloud model; local models are slower. */
  readSeconds: 45,
  writeSeconds: 40,
  fixedSeconds: 120,
  localSlowdown: 3,
} as const;

export interface EstimateConnection {
  provider: ProviderKind;
  model: string;
  baseUrl?: string;
  concurrency: number;
}

export interface EstimateInput {
  screenCount: number;
  /** Screens that will actually be read (the rest reuse their previous analysis). */
  screensToRead: number;
  thoroughness: Thoroughness;
  vision?: EstimateConnection;
  text?: EstimateConnection;
}

export interface GenerationEstimate {
  useCases: number;
  inputTokens: number;
  outputTokens: number;
  /** USD; undefined when the price of either model is unknown. */
  costUsd?: number;
  /** Rough wall-clock range in minutes. */
  minutes: { low: number; high: number };
  /** Every connection involved is the offline demo — no tokens, near-instant. */
  offline: boolean;
}

export function estimateGeneration(input: EstimateInput): GenerationEstimate {
  const vision = input.vision;
  const text = input.text ?? input.vision;
  const offline = vision?.provider === "mock" && text?.provider === "mock";
  const thorough = input.thoroughness === "thorough";
  const reads = Math.max(0, Math.min(input.screenCount, input.screensToRead));
  const useCases = Math.max(0, input.screenCount) * ESTIMATE.useCasesPerScreen;

  const readPasses = thorough ? 2 : 1;
  const writeFactor = thorough ? ESTIMATE.thoroughRepairFactor : 1;
  const readIn = reads * ESTIMATE.readInputPerScreen * readPasses;
  const readOut = reads * ESTIMATE.readOutputPerScreen * readPasses;
  const writeIn = Math.round(
    useCases * ESTIMATE.writeInputPerUseCase * writeFactor,
  );
  const writeOut = Math.round(
    useCases * ESTIMATE.writeOutputPerUseCase * writeFactor,
  );

  if (offline) {
    return {
      useCases,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      minutes: { low: 0, high: 1 },
      offline: true,
    };
  }

  const readCost = vision
    ? estimateCostUsd(
        vision.provider,
        vision.model,
        readIn,
        readOut,
        vision.baseUrl,
      )
    : undefined;
  const writeCost = text
    ? estimateCostUsd(
        text.provider,
        text.model,
        writeIn,
        writeOut,
        text.baseUrl,
      )
    : undefined;
  const costUsd =
    readCost === undefined || writeCost === undefined
      ? undefined
      : readCost + writeCost;

  const slow = (c?: EstimateConnection) =>
    c && PROVIDER_PRESETS[c.provider].category === "local"
      ? ESTIMATE.localSlowdown
      : 1;
  const visionConc = Math.max(1, vision?.concurrency ?? 1);
  const textConc = Math.max(1, text?.concurrency ?? 1);
  const seconds =
    Math.ceil(reads / visionConc) *
      ESTIMATE.readSeconds *
      readPasses *
      slow(vision) +
    ESTIMATE.fixedSeconds * slow(text) +
    Math.ceil(useCases / textConc) *
      ESTIMATE.writeSeconds *
      writeFactor *
      slow(text);
  const minutes = seconds / 60;
  return {
    useCases,
    inputTokens: readIn + writeIn,
    outputTokens: readOut + writeOut,
    costUsd,
    minutes: {
      low: Math.max(1, Math.round(minutes * 0.6)),
      high: Math.max(2, Math.round(minutes * 1.6)),
    },
    offline: false,
  };
}
