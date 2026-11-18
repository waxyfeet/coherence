import { expect, it } from "vitest";
import { newConnection } from "./data";
import { keyRequired, keyState } from "./connectionKey";

const gateway = {
  ...newConnection("compatible", "gateway"),
  endpoint: "https://gateway.example/v1",
};

it("tells typed, saved, misplaced, missing and unneeded keys apart", () => {
  expect(keyState({ ...gateway, apiKey: "sk-typed" })).toBe("typed");
  expect(keyState({ ...gateway, keyPresent: true }, gateway)).toBe("saved");
  expect(
    keyState(
      { ...gateway, keyPresent: true, endpoint: "https://gateway.example/v1/" },
      gateway,
    ),
  ).toBe("saved");
  expect(
    keyState(
      { ...gateway, keyPresent: true, endpoint: "https://other.example/v1" },
      gateway,
    ),
  ).toBe("saved-elsewhere");
  expect(keyState(gateway)).toBe("missing");
  expect(keyState({ ...gateway, endpoint: "http://localhost:1234/v1" })).toBe(
    "not-needed",
  );
  expect(
    keyState({ ...gateway, endpoint: "http://192.168.1.20:8000/v1" }),
  ).toBe("not-needed");
  expect(keyState(newConnection("mock", "offline"))).toBe("not-needed");
  expect(keyState(newConnection("anthropic", "claude"))).toBe("missing");
});

it("knows which providers always need a key", () => {
  expect(keyRequired(newConnection("anthropic", "a"))).toBe(true);
  expect(keyRequired(newConnection("gemini", "g"))).toBe(true);
  expect(keyRequired(gateway)).toBe(false);
  expect(keyRequired(newConnection("ollama", "o"))).toBe(false);
});
