import { expect, it } from "vitest";
import { matchesConnectionFilter } from "./connectionFilters";
import { newConnection, type Provider } from "./data";

it.each([
  ["gemini", "https://generativelanguage.googleapis.com", "cloud"],
  ["anthropic", "https://api.anthropic.com", "cloud"],
  ["azure", "https://synthetic.openai.azure.com", "cloud"],
  ["compatible", "https://openrouter.ai/api/v1", "cloud"],
  ["compatible", "http://127.0.0.1:1234/v1", "local"],
  ["compatible", "http://localhost:1234/v1", "local"],
  ["compatible", "http://[::1]:1234/v1", "local"],
  ["compatible", "http://192.168.1.20:8000/v1", "local"],
  ["compatible", "http://[fd00::1]:8000/v1", "local"],
  ["compatible", "http://models.local:8000/v1", "local"],
  ["compatible", "unfinished", "cloud"],
  ["lmstudio", "http://127.0.0.1:1234/v1", "local"],
  ["ollama", "http://10.0.0.5:11434", "local"],
] as const)(
  "groups %s %s for display without modifying the account",
  (provider, endpoint, group) => {
    const c = { ...newConnection(provider as Provider, "synthetic"), endpoint };
    const before = structuredClone(c);
    expect(matchesConnectionFilter(c, "all")).toBe(true);
    expect(matchesConnectionFilter(c, "cloud")).toBe(group === "cloud");
    expect(matchesConnectionFilter(c, "local")).toBe(group === "local");
    expect(c).toEqual(before);
  },
);
it("keeps built-in Offline in All without mislabelling it a cloud or local AI account", () => {
  const c = newConnection("mock", "synthetic");
  expect(matchesConnectionFilter(c, "all")).toBe(true);
  expect(matchesConnectionFilter(c, "cloud")).toBe(false);
  expect(matchesConnectionFilter(c, "local")).toBe(false);
});
