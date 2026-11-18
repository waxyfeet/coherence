import { expect, it } from "vitest";
import {
  capabilityRecords,
  currentEvidence,
  modelEvidence,
  modelEvidenceForConnection,
  type CapabilityInventory,
  type CapabilityRecord,
} from "./modelCapabilities";

const passed: CapabilityRecord = {
  capability: "text",
  at: new Date().toISOString(),
  outcome: "passed",
  state: "tested",
  reason: "passed",
};
it("shares exact provider-documented facts without labelling them Tested or transferring them to gateways", () => {
  const c = { provider: "gemini" };
  expect(
    modelEvidenceForConnection(c, "gemini-3.5-flash-lite").image.state,
  ).toBe("provider-reported");
  expect(
    modelEvidenceForConnection(c, "gemini-3.5-flash-lite").text.state,
  ).toBe("unknown");
  expect(
    modelEvidenceForConnection(
      { provider: "openai-compatible" },
      "gemini-3.5-flash-lite",
    ).image.state,
  ).toBe("unknown");
  expect(
    modelEvidenceForConnection(c, "gemini-3.5-flash-lite-custom").image.state,
  ).toBe("unknown");
});
it("never lets documented facts override a current model-specific negative or a provider negative", () => {
  const c = {
    provider: "gemini",
    capabilities: {
      "gemini-3.5-flash-lite": [
        {
          ...passed,
          capability: "image",
          outcome: "failed",
          state: "unsupported",
          reason: "unsupported",
        },
      ],
    },
  };
  expect(
    modelEvidenceForConnection(c, "gemini-3.5-flash-lite").image.state,
  ).toBe("unsupported");
  expect(
    modelEvidenceForConnection(
      {
        provider: "gemini",
        catalogue: {
          models: [
            { id: "gemini-3.5-flash-lite", reported: { vision: false } },
          ],
        },
      },
      "gemini-3.5-flash-lite",
    ).image.state,
  ).toBe("unsupported");
});

it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
  "treats inherited %s inventory values as unknown, without throwing",
  (id) => {
    const inventory: CapabilityInventory = {};
    expect(capabilityRecords(inventory, id)).toEqual([]);
    expect(modelEvidence(inventory[id]).text.state).toBe("unknown");
  },
);
it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])(
  "supports an own exact %s entry, through JSON and without prototype mutation",
  (id) => {
    const inventory = JSON.parse(JSON.stringify({ [id]: [passed] }));
    expect(modelEvidence(capabilityRecords(inventory, id)).text.state).toBe(
      "tested",
    );
    expect(Object.getPrototypeOf(inventory)).toBe(Object.prototype);
    expect(Object.keys({})).toEqual([]);
  },
);
it("does not inherit model evidence from another object's prototype", () => {
  const inventory = Object.create({ exact: [passed] });
  expect(capabilityRecords(inventory, "exact")).toEqual([]);
  Object.defineProperty(inventory, "exact", { value: [passed] });
  expect(modelEvidence(capabilityRecords(inventory, "exact")).text.state).toBe(
    "tested",
  );
});
it.each([
  null,
  {},
  Object,
  "text",
  3,
  [null],
  [{ ...passed, state: "other" }],
  [{ ...passed, controls: {} }],
  [{ ...passed, reported: { text: "yes" } }],
  [{ ...passed, capability: "structured" }],
  [{ ...passed, at: "invalid" }],
  [{ ...passed, outcome: "failed" }],
  [null, passed],
])(
  "treats malformed evidence as unknown without resurrecting older success: %j",
  (value) => {
    expect(modelEvidence(value).text.state).toBe("unknown");
    expect(capabilityRecords({ exact: value }, "exact")).toEqual([]);
  },
);
it("does not certify malformed individual records or leak extra fields", () => {
  expect(currentEvidence({ ...passed, state: "arbitrary" })).toEqual({
    state: "unknown",
  });
  expect(
    capabilityRecords(
      { exact: [{ ...passed, raw: "synthetic-private-field" }] },
      "exact",
    ),
  ).toEqual([passed]);
});
