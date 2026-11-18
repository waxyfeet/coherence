import { expect, it } from "vitest";
import { documentedModelFacts, effectiveModelFacts } from "./modelFacts";
const official = { provider: "gemini" };
it("uses exact documented native model identities without pretending to test them", () => {
  expect(documentedModelFacts(official, "gemini-3.5-flash-lite")).toEqual({
    vision: true,
    inputTokenLimit: 1048576,
    outputTokenLimit: 65536,
  });
  expect(
    documentedModelFacts(official, "gemini-3.5-flash-lite-custom"),
  ).toBeUndefined();
  expect(documentedModelFacts(official, "constructor")).toBeUndefined();
});
it.each([
  {
    provider: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com",
  },
  { provider: "azure-openai" },
  { provider: "gemini", endpoint: "https://synthetic.invalid" },
  {
    provider: "gemini",
    baseUrl: "https://synthetic:synthetic@generativelanguage.googleapis.com",
  },
  { provider: "gemini", baseUrl: "http://generativelanguage.googleapis.com" },
  {
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/custom",
  },
])(
  "does not transfer vendor facts to another endpoint/configuration: %j",
  (c) => {
    expect(documentedModelFacts(c, "gemini-3.5-flash-lite")).toBeUndefined();
  },
);
it("honours explicit provider negatives and the smaller output ceiling", () => {
  expect(
    effectiveModelFacts(official, "gemini-3.5-flash-lite", {
      id: "gemini-3.5-flash-lite",
      reported: { vision: false, outputTokenLimit: 8192 },
    }).reported,
  ).toMatchObject({ vision: false, outputTokenLimit: 8192 });
  expect(
    effectiveModelFacts(official, "gemini-3.5-flash-lite", {
      id: "gemini-3.5-flash-lite",
      reported: { outputTokenLimit: 999999 },
    }).reported?.outputTokenLimit,
  ).toBe(65536);
});
it("does not attach another model's catalogue facts to an exact ID", () => {
  expect(
    effectiveModelFacts({ provider: "openai-compatible" }, "Model-B", {
      id: "Model-A",
      reported: { vision: true, outputTokenLimit: 1000 },
    }).reported,
  ).toEqual({});
});
