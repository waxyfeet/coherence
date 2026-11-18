import { expect, it } from "vitest";
import { DEFAULT_GENERATION_OPTIONS } from "./types";
import {
  projectConnectionChoices,
  savedGenerationKind,
} from "./generationContext";
const offline = { visionConnectionId: "demo", textConnectionId: "demo" };
const gemini = {
  ...DEFAULT_GENERATION_OPTIONS,
  visionConnectionId: "gemini",
  textConnectionId: "gemini",
};
it("prefers the last submitted run over a demo project's original defaults", () => {
  expect(
    projectConnectionChoices({ llm: offline, generationPreferences: gemini }),
  ).toEqual({ visionConnectionId: "gemini", textConnectionId: "gemini" });
});
it("uses saved model options for legacy projects without remembered run preferences", () => {
  expect(projectConnectionChoices({ llm: offline }, gemini)).toEqual({
    visionConnectionId: "gemini",
    textConnectionId: "gemini",
  });
});
it("retains project defaults when no run selected those roles", () => {
  expect(
    projectConnectionChoices({
      llm: offline,
      generationPreferences: DEFAULT_GENERATION_OPTIONS,
    }),
  ).toEqual(offline);
});
it("classifies persisted provider routes without consulting mutable Settings or dropdowns", () => {
  expect(
    savedGenerationKind({ vision: "gemini/model", text: "gemini/model" }),
  ).toBe("provider");
  expect(savedGenerationKind({ vision: "mock/demo", text: "mock/demo" })).toBe(
    "offline",
  );
  expect(
    savedGenerationKind({ vision: "mock/demo", text: "gemini/model" }),
  ).toBe("mixed");
  expect(savedGenerationKind({ vision: "", text: "" })).toBe("unknown");
});
