import { describe, expect, it } from "vitest";
import {
  callBase,
  deriveContext,
  projectContextBlock,
  screenNotesText,
} from "./context";
import { recordingContext } from "./testContext";
import { plannerSystem, reviewerSystem, writerSystem } from "./prompts";
import { project, screen } from "./testFixtures";

// The demo's New order notes: the screen-level facts at the end are 700+ characters in.
const LONG_NOTES = [
  "Country dropdown options, in this order: Australia (default), New Zealand, South Africa, United Kingdom, United States.",
  "Postcode format depends on the country: Australia, New Zealand and South Africa 4 digits; United Kingdom a valid UK postcode; United States a 5-digit ZIP or ZIP+4.",
  "Customer lists the sales rep's assigned customers; changing it reloads contract prices and the account's default delivery address.",
  "Product search matches SKU or product name; each line shows the contract unit price and line total; the bin icon removes a line.",
  "The order summary recalculates live; GST only applies to Australian addresses.",
  '"Submit order" validates all required fields and the credit limit.',
  '"Save as draft" saves without validation of order lines.\n"Cancel" asks for confirmation if anything was entered.',
].join(" ");

describe("BA screen notes in prompts", () => {
  const p = project([
    screen(
      "scr_login",
      "Login",
      0,
      'Wrong credentials show "Incorrect email or password".',
    ),
    screen("scr_new", "New order", 1, LONG_NOTES),
  ]);

  it("are never cut in the project context every agent gets", () => {
    expect(LONG_NOTES.length).toBeGreaterThan(700);
    const block = projectContextBlock(p);
    expect(block).toContain(
      '"Save as draft" saves without validation of order lines.',
    );
    expect(block).toContain(
      '"Cancel" asks for confirmation if anything was entered.',
    );
    for (const system of [
      writerSystem(p, "", "balanced"),
      plannerSystem(p, "balanced"),
      reviewerSystem(p),
    ]) {
      expect(system).toContain(
        '"Cancel" asks for confirmation if anything was entered.',
      );
    }
  });

  it("keep the BA's line breaks but tidy whitespace", () => {
    expect(
      screenNotesText("  First   line.\r\n\r\n  Second line. ", "   "),
    ).toBe("First line.\n   Second line.");
    expect(screenNotesText("")).toBe("");
  });
});

describe("derived job contexts", () => {
  it("pass live progress through to every AI call, however deeply derived (tester build WP6)", () => {
    const live = { start: () => ({ stream: () => {}, end: () => {} }) };
    const root = { ...recordingContext("p"), live };
    const reading = deriveContext(deriveContext(root, {}), {
      signal: new AbortController().signal,
    });
    expect(reading.live).toBe(live);
    expect(
      callBase(
        reading,
        {
          id: "c",
          name: "c",
          provider: "mock",
          model: "demo",
          concurrency: 1,
          requestTimeoutSec: 0,
          structuredOutput: "auto",
          vision: "auto",
          refusalFallback: false,
          createdAt: "",
          updatedAt: "",
        },
        "journey-map",
      ).live,
    ).toBe(live);
  });
});
