import { expect, it } from "vitest";
import { keyCheckText } from "./ConnectionModels";

it("explains a recognised service's key check in plain words (owner test note 3)", () => {
  expect(keyCheckText("accepted")).toBe(" The service accepted the key.");
  expect(keyCheckText("refused")).toMatch(/refused this key/);
  expect(keyCheckText("missing")).toMatch(/No API key is entered yet/);
  expect(keyCheckText(undefined)).toBe("");
});
