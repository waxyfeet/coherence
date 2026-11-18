/**
 * Ollama adapter — native REST API via fetch (/api/chat streamed as NDJSON, /api/tags).
 * Images travel as base64 on the message (not interleaved), so image labels become numbered
 * "[Image n: …]" markers in the text to keep the association.
 */
import { listCatalogueModels } from "../catalogue";
import { readLines } from "./eventStream";
import { PROVIDER_PRESETS } from "@shared/providers";
import { providerFetch } from "../../security/endpointPolicy";
import type { LLMConnection } from "@shared/types";
import { CancelledError } from "../../errors";
import {
  ProviderError,
  cleanProviderMessage,
  isRetryableStatus,
} from "../errors";
import type {
  LLMContentPart,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStopReason,
  ModelInfo,
} from "../types";
import {
  RequestGuard,
  UNTIMED_FETCH_INIT,
  httpFailure,
  looksLikeFormatError,
  explicitlyRejectsStructuredOutput,
  explicitlyRejectsImageInput,
  networkError,
  normaliseBaseUrl,
  timeoutMs,
} from "./common";

/** Context window requested from Ollama (its default of 2–4k is far too small for screen analysis). */
export const OLLAMA_NUM_CTX = 32768;

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
}

interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** "http://localhost:11434/", ".../api" or ".../v1" → "http://localhost:11434". */
export function ollamaBaseUrl(baseUrl: string | undefined): string {
  const url =
    normaliseBaseUrl(baseUrl) ??
    PROVIDER_PRESETS.ollama.defaultBaseUrl ??
    "http://localhost:11434";
  return url.replace(/\/(api|v1)$/i, "");
}

export function toOllamaMessage(
  role: "user" | "assistant",
  parts: LLMContentPart[],
): OllamaMessage {
  const lines: string[] = [];
  const images: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text.trim()) lines.push(part.text);
      continue;
    }
    images.push(part.image.base64);
    lines.push(
      `[Image ${images.length}${part.image.label ? `: ${part.image.label}` : ""}]`,
    );
  }
  const message: OllamaMessage = { role, content: lines.join("\n\n") };
  if (images.length) message.images = images;
  return message;
}

export class OllamaProvider implements LLMProvider {
  readonly supportsNativeSchema = true;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(
    readonly connection: LLMConnection,
    readonly supportsVision: boolean,
  ) {
    this.baseUrl = ollamaBaseUrl(connection.baseUrl);
    this.model = connection.model || PROVIDER_PRESETS.ollama.defaultModel;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const messages: OllamaMessage[] = [];
    if (req.system.trim())
      messages.push({ role: "system", content: req.system });
    for (const m of req.messages)
      messages.push(toOllamaMessage(m.role, m.content));

    const options: Record<string, number> = {
      num_ctx: Math.min(
        OLLAMA_NUM_CTX,
        this.connection.modelContextWindow ?? OLLAMA_NUM_CTX,
      ),
    };
    const maxTokens = req.maxOutputTokens ?? this.connection.maxOutputTokens;
    if (maxTokens) options.num_predict = maxTokens;
    if (this.connection.temperature !== undefined)
      options.temperature = this.connection.temperature;

    // Streamed, so the connection timeout measures silence rather than total time: a slow local model writing a
    // long answer is never cut off (owner test note 4).
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      options,
    };
    if (req.jsonSchema) body.format = req.jsonSchema.schema;
    else if (req.json) body.format = "json";
    // Thinking models (qwen3-vl, …) otherwise spend the output budget reasoning before the JSON starts: a
    // planning call then hits the 16k/32k token cap and is reported as truncated. The answer is schema-constrained,
    // so there is little to gain from thinking.
    const structured = !!(req.structuredTask || req.jsonSchema || req.json);
    if (structured) body.think = false;

    try {
      return await this.chat(body, req);
    } catch (err) {
      // A model that does not know the field (older Ollama or model) is asked again without it.
      if (
        structured &&
        err instanceof ProviderError &&
        err.providerStatus === 400 &&
        /\bthink/i.test(err.message)
      ) {
        delete body.think;
        return this.chat(body, req);
      }
      throw err;
    }
  }

  private async chat(
    body: Record<string, unknown>,
    req: LLMRequest,
  ): Promise<LLMResponse> {
    const guard = new RequestGuard(req.signal, timeoutMs(this.connection));
    try {
      let res: Response;
      try {
        req.beforeAttempt?.();
        res = await providerFetch(this.connection)(`${this.baseUrl}/api/chat`, {
          // Loading a large model can take minutes before the first byte: undici's 300 s limit must not apply.
          ...UNTIMED_FETCH_INIT,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: guard.signal,
        });
      } catch (err) {
        throw guard.abortError("ollama") ?? this.mapNetworkError(err, req);
      }
      let payload: OllamaChatResponse;
      try {
        payload =
          res.ok && /ndjson/i.test(res.headers.get("content-type") ?? "")
            ? await this.collect(res, guard, req)
            : await this.whole(res, req);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw (
          guard.abortError("ollama") ??
          new ProviderError(
            `Ollama sent an unreadable response (${res.status}).`,
            {
              failure: "server",
              retryable: isRetryableStatus(res.status) || res.ok,
              status: res.status,
            },
          )
        );
      }
      return {
        ...this.toResponse(payload),
        acceptedControls:
          this.connection.temperature !== undefined ? ["temperature"] : [],
      };
    } finally {
      guard.dispose();
    }
  }

  /** An error, or a server (a proxy, say) that answered with one complete JSON body. */
  private async whole(
    res: Response,
    req: LLMRequest,
  ): Promise<OllamaChatResponse> {
    const text = await res.text();
    const payload = text ? (JSON.parse(text) as OllamaChatResponse) : {};
    if (!res.ok || payload.error)
      throw this.mapHttpError(res.status, payload.error ?? text, req);
    return payload;
  }

  /** A streamed answer collected into the shape of a complete one; the final line carries the counts. */
  private async collect(
    res: Response,
    guard: RequestGuard,
    req: LLMRequest,
  ): Promise<OllamaChatResponse> {
    let content = "";
    let thinking = "";
    let last: OllamaChatResponse = {};
    await readLines(
      res.body,
      () => guard.touch(),
      (line) => {
        const part = JSON.parse(line) as OllamaChatResponse;
        // An error after the 200 (e.g. the model ran out of memory mid-answer).
        if (part.error) throw this.mapHttpError(500, part.error, req);
        content += part.message?.content ?? "";
        thinking += part.message?.thinking ?? "";
        if (part.message?.content)
          req.onStream?.({ text: part.message.content.length });
        else if (part.message?.thinking) req.onStream?.({ thinking: true });
        last = part;
        return part.done === true;
      },
    );
    if (!last.done)
      throw new ProviderError(
        "Ollama stopped sending the answer before it finished.",
        { failure: "server", retryable: true, status: res.status },
      );
    return {
      ...last,
      message: { role: "assistant", content, thinking },
    };
  }

  private toResponse(payload: OllamaChatResponse): LLMResponse {
    // The whole output budget went on thinking: asking again with twice the budget only repeats that for minutes.
    if (
      payload.done_reason === "length" &&
      payload.message?.thinking?.trim() &&
      !payload.message.content?.trim()
    ) {
      throw new ProviderError(
        `The model '${this.model}' used all ${payload.eval_count ?? "its"} output tokens thinking and never started its answer. ` +
          "Use a non-thinking (instruct) version of the model — for qwen3-vl, e.g. qwen3-vl:8b-instruct — or a less aggressively quantised one.",
        { failure: "bad_request", retryable: false },
      );
    }
    let stopReason: LLMStopReason = "end";
    if (payload.done_reason === "length") stopReason = "max_tokens";
    else if (payload.done_reason && payload.done_reason !== "stop")
      stopReason = "other";
    return {
      text: payload.message?.content ?? "",
      model: payload.model || this.model,
      usage: {
        inputTokens: payload.prompt_eval_count ?? 0,
        outputTokens: payload.eval_count ?? 0,
      },
      stopReason,
    };
  }

  private mapNetworkError(err: unknown, req: LLMRequest): Error {
    if (req.signal?.aborted) return new CancelledError();
    return networkError("ollama", this.baseUrl, err);
  }

  private mapHttpError(
    status: number,
    rawMessage: string,
    req: LLMRequest,
  ): ProviderError {
    const message = rawMessage || `HTTP ${status}`;
    if (/not found/i.test(message) && /model/i.test(message)) {
      return new ProviderError(
        `The model '${this.model}' is not installed in Ollama. Run "ollama pull ${this.model}" in a terminal, then try again.`,
        { failure: "not_found", status },
      );
    }
    if (status === 404) {
      return new ProviderError(
        `The server at ${this.baseUrl} is not answering like Ollama (404). Check the base URL — it is usually http://localhost:11434.`,
        { failure: "not_found", status },
      );
    }
    if (
      /image/i.test(message) &&
      /(support|vision|missing data required)/i.test(message)
    ) {
      return new ProviderError(
        `The Ollama model '${this.model}' cannot read images. Pick a vision model (e.g. qwen3-vl:8b-instruct) or set Vision to "No" for this connection.`,
        {
          failure: explicitlyRejectsImageInput(message)
            ? "image_unsupported"
            : "bad_request",
          status,
        },
      );
    }
    if (/system memory|out of memory|insufficient memory/i.test(message)) {
      return new ProviderError(
        `Ollama does not have enough memory to run '${this.model}': ${cleanProviderMessage(message)}. Try a smaller model or close other applications.`,
        { failure: "bad_request", status },
      );
    }
    if (
      status === 400 &&
      (req.jsonSchema || req.json) &&
      looksLikeFormatError(message)
    ) {
      return new ProviderError(
        `Ollama could not use the JSON schema: ${cleanProviderMessage(message)}`,
        {
          failure: "format_unsupported",
          status,
          definitiveCapability: explicitlyRejectsStructuredOutput(message)
            ? "structured"
            : undefined,
        },
      );
    }
    return httpFailure({
      provider: "ollama",
      status: status || 500,
      message,
      model: this.model,
      baseUrl: this.baseUrl,
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    return listCatalogueModels(this.connection);
  }
}
