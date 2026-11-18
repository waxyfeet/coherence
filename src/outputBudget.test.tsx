import { expect, it } from "vitest";
import { connectionInput, settingsFromPublic } from "./api";
import { newConnection } from "./data";
import type { PublicSettings } from "../shared/types";
function settings(cap?: number): PublicSettings {
  return {
    connections: [
      {
        id: "synthetic",
        name: "Synthetic",
        provider: "gemini",
        modelIds: ["Exact"],
        concurrency: 2,
        requestTimeoutSec: 180,
        structuredOutput: "auto",
        vision: "auto",
        refusalFallback: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        hasApiKey: true,
        maxOutputTokens: cap,
      },
    ],
    integrations: {},
    dataDir: "synthetic",
    settingsPath: "synthetic/settings.json",
  };
}
it("new connection drafts use Automatic without sending an invented hard cap", () => {
  const c = newConnection("gemini");
  expect(c.maxTokens).toBe(0);
  expect(connectionInput(c).maxOutputTokens).toBeUndefined();
});
it("a read/save round trip preserves an unset cap as Automatic", () => {
  const c = settingsFromPublic(settings()).connections[0];
  expect(c.maxTokens).toBe(0);
  expect(JSON.stringify(connectionInput(c))).not.toContain("maxOutputTokens");
});
it("new connection drafts leave the request timeout to the provider's default, and keep a chosen one", () => {
  const c = newConnection("compatible");
  expect(c.timeout).toBe(0);
  expect(connectionInput(c).requestTimeoutSec).toBeUndefined();
  expect(connectionInput({ ...c, timeout: 300 }).requestTimeoutSec).toBe(300);
  // A saved connection keeps its saved timeout (the server always stores a number).
  const saved = settingsFromPublic(settings()).connections[0];
  expect(connectionInput(saved).requestTimeoutSec).toBe(180);
});
it("preserves a legacy manual limit until an explicit switch to Automatic", () => {
  const c = settingsFromPublic(settings(16384)).connections[0];
  expect(connectionInput(c).maxOutputTokens).toBe(16384);
  expect(
    connectionInput({ ...c, maxTokens: 0 }).maxOutputTokens,
  ).toBeUndefined();
});
