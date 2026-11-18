import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { LLMConnection } from "@shared/types";
import {
  closeServers,
  connection as fixtureConnection,
  json,
  serve,
} from "../llm/reliabilityFixtures";
import { BadRequestError, CancelledError } from "../errors";
import { CapacityError, RunAllowanceError } from "../llm/capacity";
import { ModelDeclinedError, ProviderError } from "../llm/errors";
import { withOrigin } from "../llm/origin";
import { missingKeyError } from "../llm/providers/common";
import { generateStructured } from "../llm/structured";
import { describeFailure } from "./failure";

afterEach(closeServers);

const NOW = Date.parse("2026-11-03T00:00:00.000Z");

const conn = (extra: Partial<LLMConnection> = {}): LLMConnection => ({
  id: "conn_test",
  name: "OpenRouter",
  provider: "openai-compatible",
  model: "vendor/reader:free",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "sk-or-synthetic-key",
  concurrency: 1,
  requestTimeoutSec: 0,
  structuredOutput: "auto",
  vision: "auto",
  refusalFallback: false,
  createdAt: "",
  updatedAt: "",
  ...extra,
});

const provider = (
  failure: ConstructorParameters<typeof ProviderError>[1]["failure"],
  extra: Partial<ConstructorParameters<typeof ProviderError>[1]> = {},
) =>
  new ProviderError(`technical: provider said SECRET-DETAIL (${failure})`, {
    failure,
    ...extra,
  });

describe("describeFailure", () => {
  it.each([
    ["forbidden", "access-refused", "change-model"],
    ["not_found", "model-not-found", "change-model"],
    ["quota", "quota", "change-model"],
    ["image_unsupported", "cannot-read-images", "change-model"],
    ["too_large", "too-large", "change-model"],
    ["timeout", "timeout", "try-again"],
    ["network", "unreachable", "try-again"],
    ["unreachable", "unreachable", "try-again"],
    ["server", "service-error", "try-again"],
    ["bad_request", "request-rejected", "change-model"],
    ["format_unsupported", "request-rejected", "change-model"],
    ["other", "other", "try-again"],
  ] as const)(
    "maps %s to %s with the next step %s, in Coherence's own words",
    (failure, kind, action) => {
      const result = describeFailure(
        withOrigin(provider(failure), conn()),
        NOW,
      )!;
      expect(result).toMatchObject({
        kind,
        action,
        connectionId: "conn_test",
        connectionName: "OpenRouter",
        model: "vendor/reader:free",
      });
      expect(result.message).not.toMatch(/SECRET-DETAIL|technical/);
      expect(result.resetAt).toBeUndefined();
    },
  );

  it("tells a refused key from a missing one", () => {
    expect(
      describeFailure(withOrigin(provider("auth"), conn()), NOW),
    ).toMatchObject({ kind: "key-refused", action: "fix-connection" });
    expect(
      describeFailure(
        withOrigin(provider("auth"), conn({ apiKey: undefined })),
        NOW,
      ),
    ).toMatchObject({ kind: "no-key", action: "fix-connection" });
    const missing = conn({ provider: "anthropic", apiKey: "" });
    expect(
      describeFailure(withOrigin(missingKeyError(missing), missing), NOW)!
        .message,
    ).toMatch(/^No API key is saved for OpenRouter/);
  });

  it("names when a rate limit resets, but not for a wait of seconds", () => {
    const long = describeFailure(
      withOrigin(
        provider("rate_limit", { retryAfterMs: 10 * 60 * 60 * 1000 }),
        conn(),
      ),
      NOW,
    )!;
    expect(long).toMatchObject({
      kind: "rate-limited",
      action: "wait",
      resetAt: "2026-11-03T10:00:00.000Z",
    });
    expect(long.message).toMatch(/should reset at about /);
    const short = describeFailure(
      withOrigin(provider("rate_limit", { retryAfterMs: 2000 }), conn()),
      NOW,
    )!;
    expect(short.message).toMatch(/Wait a few minutes/);
    const unknown = describeFailure(
      withOrigin(provider("rate_limit"), conn()),
      NOW,
    )!;
    expect(unknown.resetAt).toBeUndefined();
  });

  it("keeps Coherence's own wording for cut-offs, the run allowance and its own checks", () => {
    const cutOff = new CapacityError(
      "output",
      "The selected model could not finish this task.",
    );
    expect(describeFailure(cutOff, NOW)).toMatchObject({
      kind: "too-large",
      action: "change-model",
      message: "The selected model could not finish this task.",
    });
    expect(describeFailure(new RunAllowanceError(), NOW)).toMatchObject({
      kind: "other",
      action: "try-again",
      message: expect.stringMatching(/automatic request allowance/),
    });
    expect(
      describeFailure(new BadRequestError("No elements were found."), NOW),
    ).toMatchObject({ kind: "other", message: "No elements were found." });
    expect(
      describeFailure(new ModelDeclinedError("declined"), NOW),
    ).toMatchObject({ kind: "declined", action: "change-model" });
  });

  it("never shows an unexpected error's own text", () => {
    const result = describeFailure(
      new Error("ENOENT C:\\Users\\someone\\secret.json"),
      NOW,
    )!;
    expect(result.kind).toBe("other");
    expect(result.message).not.toMatch(/ENOENT|secret/);
    expect(result.connectionId).toBeUndefined();
  });

  it("has nothing to say about a cancelled job", () => {
    expect(describeFailure(new CancelledError(), NOW)).toBeUndefined();
  });

  it("finds the provider error behind a wrapper", () => {
    const inner = withOrigin(provider("forbidden"), conn());
    const outer = new Error("wrapped", { cause: inner });
    expect(describeFailure(outer, NOW)).toMatchObject({
      kind: "access-refused",
      connectionName: "OpenRouter",
    });
  });

  it("learns the connection and model from a real call, and whether a key went with it", async () => {
    const endpoint = await serve((_req, res) =>
      json(res, { error: { message: "No auth credentials found" } }, 401),
    );
    const call = (apiKey?: string) =>
      generateStructured({
        connection: fixtureConnection({
          baseUrl: endpoint.url + "/v1",
          apiKey,
          name: "Local gateway",
        }),
        system: "Synthetic contract",
        content: [{ type: "text", text: "Return the answer" }],
        purpose: "synthetic-failure",
        schema: z.object({ answer: z.string() }),
        schemaName: "synthetic_contract",
        mock: () => ({ answer: "x" }),
      }).catch((err: unknown) => err);
    expect(describeFailure(await call(undefined), NOW)).toMatchObject({
      kind: "no-key",
      connectionName: "Local gateway",
    });
    expect(describeFailure(await call("sk-synthetic"), NOW)).toMatchObject({
      kind: "key-refused",
    });
  });
});
