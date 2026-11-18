/**
 * Offline demo provider: never touches the network. generateStructured / generateText short-circuit to
 * the caller's mock() before reaching this adapter; complete() exists for the registry's connection test.
 */
import type { LLMConnection } from "@shared/types";
import { CancelledError } from "../../errors";
import type { LLMProvider, LLMRequest, LLMResponse, ModelInfo } from "../types";

export class MockProvider implements LLMProvider {
  readonly supportsNativeSchema = true;
  readonly supportsVision = true;

  constructor(readonly connection: LLMConnection) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (req.signal?.aborted) throw new CancelledError();
    return {
      text: req.jsonSchema || req.json ? "{}" : "OK",
      model: this.connection.model || "demo",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "end",
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "demo", label: "Demo", vision: true }];
  }
}
