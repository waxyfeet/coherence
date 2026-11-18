import { expect, it } from "vitest";
import {
  analysisModelDefaults,
  changeDefaultConnection,
  defaultRoleIssue,
  sameAnalysisDefaults,
} from "./analysisDefaults";
const accounts = [
  { id: "cloud", provider: "gemini", modelIds: ["constructor", "writer"] },
  { id: "offline", provider: "mock", modelIds: ["demo"], vision: "no" },
];
const defaults = {
  visionConnectionId: "cloud",
  visionModelId: "constructor",
  textConnectionId: "cloud",
  textModelId: "writer",
};
it("keeps legacy starting choices Offline even if the first account is cloud", () => {
  expect(analysisModelDefaults(undefined, accounts)).toEqual({
    visionConnectionId: "offline",
    visionModelId: "demo",
    textConnectionId: "offline",
    textModelId: "demo",
  });
});
it("retains exact dangling choices, drops consent/unknown fields and returns an independent snapshot", () => {
  const raw = { ...defaults, visionAcknowledged: true, extra: "synthetic" };
  const result = analysisModelDefaults(raw, []);
  expect(result).toEqual(defaults);
  result.textModelId = "other";
  expect(raw.textModelId).toBe("writer");
});
it.each([
  null,
  [],
  1,
  "invalid",
  { visionConnectionId: false },
  Object.create({ ...defaults }),
])(
  "does not substitute a real or Offline destination for damaged explicit defaults: %j",
  (value) => {
    expect(analysisModelDefaults(value, accounts)).toEqual({
      visionConnectionId: "",
      visionModelId: "",
      textConnectionId: "",
      textModelId: "",
    });
  },
);
it("changing a real account clears the model; choosing Offline sets its only model", () => {
  expect(changeDefaultConnection(defaults, accounts, true, "cloud")).toEqual({
    ...defaults,
    visionModelId: "",
  });
  expect(changeDefaultConnection(defaults, accounts, false, "offline")).toEqual(
    { ...defaults, textConnectionId: "offline", textModelId: "demo" },
  );
  expect(defaults.textModelId).toBe("writer");
});
it("allows Unknown exact models without claiming capability or requiring paid tests", () => {
  expect(defaultRoleIssue(defaults, accounts, true)).toBeUndefined();
  expect(defaultRoleIssue(defaults, accounts, false)).toBeUndefined();
  expect(
    defaultRoleIssue(
      analysisModelDefaults(undefined, accounts),
      accounts,
      true,
    ),
  ).toBeUndefined();
});
it.each([true, false])(
  "rejects missing connections and models for reading=%s",
  (reading) => {
    expect(defaultRoleIssue(defaults, [], reading)).toMatch(/connection/);
    expect(
      defaultRoleIssue(
        defaults,
        accounts.map((c) => ({ ...c, modelIds: [] })),
        reading,
      ),
    ).toMatch(/configured model/);
  },
);
it("blocks definitive capability negatives without confusing the roles", () => {
  const at = new Date().toISOString();
  const negative = {
    capability: "image",
    at,
    state: "unsupported",
    outcome: "failed",
    reason: "unsupported",
  };
  const withEvidence = [
    { ...accounts[0], capabilities: { constructor: [negative] } },
  ];
  expect(defaultRoleIssue(defaults, withEvidence, true)).toMatch(/images/);
  expect(defaultRoleIssue(defaults, withEvidence, false)).toBeUndefined();
  expect(
    defaultRoleIssue(defaults, [{ ...accounts[0], vision: "no" }], true),
  ).toMatch(/images/);
});
it("compares pairs independently of object key order", () => {
  expect(
    sameAnalysisDefaults(defaults, {
      textModelId: "writer",
      textConnectionId: "cloud",
      visionModelId: "constructor",
      visionConnectionId: "cloud",
    }),
  ).toBe(true);
  expect(
    sameAnalysisDefaults(defaults, { ...defaults, textModelId: "constructor" }),
  ).toBe(false);
});
