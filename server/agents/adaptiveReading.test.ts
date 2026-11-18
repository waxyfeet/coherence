import { expect, it } from "vitest";
import {
  adaptiveReading,
  coreFor,
  emptyReadingParts,
  mergeReadingParts,
  ownSection,
  validReadingParts,
  reuseReadingKeys,
  parseReadingParts,
  type ReadingParts,
} from "./adaptiveReading";
import { CapacityError } from "../llm/capacity";
import { ProviderError } from "../llm/errors";
import { ScreenReadingSchema } from "./readerContract";
import type { ScreenAnalysisOutput } from "./schemas";
import { toScreenAnalysis } from "./ids";
import { screen } from "./testFixtures";

const output = (
  label = "Exact €1,234.56",
  key = "value",
): ScreenAnalysisOutput =>
  ScreenReadingSchema.parse({
    title: "Synthetic",
    purpose: "Read evidence",
    screenType: "form",
    personas: [],
    regions: [{ key: "main", name: "Main", purpose: "", layout: "" }],
    elements: [
      {
        key,
        regionKey: "main",
        type: "text_input",
        label,
        bounds: { x: 10, y: 10, width: 30, height: 30 },
        options: ["One", "one", "Two"],
        helperText: "Do not lose this",
        inferred: ["An assumption, not visible text"],
      },
    ],
    dataEntities: [],
    openQuestions: [],
  });
const partOutput = (p: string, label = "Exact") => {
  const o = output(label);
  const c = coreFor(p, 1000, 1000);
  o.elements[0].bounds = {
    x: c.x + c.width * 0.1,
    y: c.y + c.height * 0.1,
    width: c.width * 0.3,
    height: c.height * 0.3,
  };
  return o;
};
const base = () => ({
  width: 1000,
  height: 1000,
  signal: new AbortController().signal,
  inform: () => {},
});

it("uses a single simple task when it succeeds", async () => {
  const seen: string[] = [];
  const result = await adaptiveReading({
    ...base(),
    read: async (p) => {
      seen.push(p);
      return output();
    },
  });
  expect(seen).toEqual([""]);
  expect(result.parts).toBe(1);
  expect(result.output).toEqual(output());
});
it("automatically partitions on classified capacity failure and retains exact values", async () => {
  const seen: string[] = [];
  const r = await adaptiveReading({
    ...base(),
    read: async (p) => {
      seen.push(p);
      if (!p) throw new CapacityError("output", "fixture");
      return partOutput(p, "Exact " + p);
    },
  });
  expect(seen).toEqual(["", "0", "1"]);
  expect(r.parts).toBe(2);
  expect(r.output.elements.map((e) => e.label)).toEqual(["Exact 0", "Exact 1"]);
  expect(r.output.elements[0].options).toEqual(["One", "one", "Two"]);
  expect(r.output.elements[0].helperText).toBe("Do not lose this");
});
it.each(["auth", "quota", "rate_limit", "format_unsupported"] as const)(
  "does not partition a %s failure or change destination",
  async (failure) => {
    let calls = 0;
    await expect(
      adaptiveReading({
        ...base(),
        read: async () => {
          calls++;
          throw new ProviderError("fixture", { failure });
        },
      }),
    ).rejects.toThrow("fixture");
    expect(calls).toBe(1);
  },
);
it("resumes completed pieces without retrying the failed whole screen", async () => {
  let saved: ReadingParts | undefined;
  await expect(
    adaptiveReading({
      ...base(),
      read: async (p) => {
        if (!p) throw new CapacityError("output", "size");
        if (p === "1")
          throw new ProviderError("disconnected", { failure: "network" });
        return partOutput(p, "retained");
      },
      save: async (state) => {
        saved = state;
      },
    }),
  ).rejects.toThrow("disconnected");
  const seen: string[] = [];
  const r = await adaptiveReading({
    ...base(),
    state: saved,
    read: async (p) => {
      seen.push(p);
      return partOutput(p, "new");
    },
  });
  expect(seen).toEqual(["1"]);
  expect(r.output.elements.map((e) => e.label)).toEqual(["retained", "new"]);
});
it("does not mutate a saved state supplied by the caller", async () => {
  const state = emptyReadingParts();
  await adaptiveReading({ ...base(), state, read: async () => output() });
  expect(state).toEqual(emptyReadingParts());
});
it("rejects missing sections and ambiguous duplicate record keys", () => {
  expect(() =>
    mergeReadingParts({
      version: 1,
      split: [""],
      completed: [{ path: "0", output: output() }],
    }),
  ).toThrow(/every screen section/);
  const duplicate = output();
  duplicate.elements.push({ ...duplicate.elements[0] });
  expect(() =>
    mergeReadingParts({
      version: 1,
      split: [""],
      completed: [
        { path: "0", output: duplicate },
        { path: "1", output: output() },
      ],
    }),
  ).toThrow(/partial inventory/);
});
it.each([
  { version: 1, split: [""], completed: [{ path: "00", output: output() }] },
  { version: 1, split: ["", ""], completed: [] },
  {
    version: 1,
    split: [],
    completed: [{ path: "__proto__", output: output() }],
  },
])("rejects damaged or ambiguous checkpoint structure", (state) =>
  expect(validReadingParts(state)).toBe(false),
);
it("cancels before issuing the next section and keeps previous checkpoint", async () => {
  const c = new AbortController();
  let saved: ReadingParts | undefined;
  let calls = 0;
  await expect(
    adaptiveReading({
      ...base(),
      signal: c.signal,
      read: async (p) => {
        calls++;
        if (!p) throw new CapacityError("output", "size");
        c.abort();
        return partOutput(p);
      },
      save: async (s) => {
        saved = s;
      },
    }),
  ).rejects.toThrow(/cancel/i);
  expect(calls).toBe(2);
  expect(saved?.completed).toHaveLength(1);
});
it("stops bounded decomposition instead of accepting incomplete JSON", async () => {
  let calls = 0;
  await expect(
    adaptiveReading({
      ...base(),
      read: async () => {
        calls++;
        throw new CapacityError("output", "size");
      },
    }),
  ).rejects.toThrow(/even a small screen section/);
  expect(calls).toBe(4);
});
it("partitions along the longest physical dimension with exact coverage", () => {
  expect(coreFor("0", 100, 1000)).toEqual({
    x: 0,
    y: 0,
    width: 100,
    height: 50,
  });
  expect(coreFor("1", 100, 1000)).toEqual({
    x: 0,
    y: 50,
    width: 100,
    height: 50,
  });
  expect(coreFor("00", 1000, 1000)).toEqual({
    x: 0,
    y: 0,
    width: 50,
    height: 50,
  });
});
it("maps crop bounds to global coordinates and assigns a seam element once", () => {
  const raw = output();
  raw.elements[0].bounds = { x: 45, y: 10, width: 10, height: 20 };
  const left = ownSection(
    raw,
    { x: 0, y: 0, width: 50, height: 100 },
    { x: 0, y: 0, width: 100, height: 100 },
  );
  const right = ownSection(
    raw,
    { x: 50, y: 0, width: 50, height: 100 },
    { x: 0, y: 0, width: 100, height: 100 },
  );
  expect(left.elements).toHaveLength(0);
  expect(right.elements).toHaveLength(1);
  const mapped = ownSection(
    output(),
    { x: 50, y: 0, width: 50, height: 100 },
    { x: 48, y: 0, width: 52, height: 100 },
  );
  expect(mapped.elements[0].bounds.x).toBeCloseTo(53.2);
});
it("refuses unknown coordinates instead of silently dropping possible evidence", () => {
  const raw = output();
  raw.elements[0].bounds.x = -1;
  expect(() =>
    ownSection(
      raw,
      { x: 0, y: 0, width: 50, height: 100 },
      { x: 0, y: 0, width: 52, height: 100 },
    ),
  ).toThrow(/uncertain coordinates/);
});

it("reuses only unambiguous previous keys without merging duplicate labels", () => {
  const prior = output("Label", "original");
  const next = output("Label", "p0_label");
  expect(reuseReadingKeys(next, prior).elements[0].key).toBe("original");
  next.elements.push({ ...next.elements[0], key: "p1_label" });
  expect(reuseReadingKeys(next, prior).elements.map((e) => e.key)).toEqual([
    "p0_label",
    "p1_label",
  ]);
});

it.each([false, true])(
  "reserves a retained field's ID before allocating a colliding new field (reverse=%s)",
  (reverse) => {
    const prior = output("Email", "email");
    const next = output("Auxiliary code", "email");
    next.elements.push(output("Email", "fresh_email").elements[0]);
    if (reverse) next.elements.reverse();
    const before = structuredClone(next);
    const raw = reuseReadingKeys(next, prior);
    const domain = toScreenAnalysis({
      raw,
      screen: screen("scr", "Synthetic", 0),
      version: 1,
      screenKey: "synthetic",
      validScreenIds: ["scr"],
    }).analysis;
    expect(domain.elements.find((e) => e.id === "synthetic.email")?.label).toBe(
      "Email",
    );
    expect(
      domain.elements.find((e) => e.label === "Auxiliary code")?.id,
    ).not.toBe("synthetic.email");
    expect(new Set(domain.elements.map((e) => e.id)).size).toBe(2);
    expect(next).toEqual(before);
  },
);

it.each(["E-MAIL", "é_mail", "x".repeat(40)])(
  "keeps reserved IDs unique after slug conversion and truncation (%s)",
  (key) => {
    const oldKey = key === "x".repeat(40) ? key : "e_mail";
    const prior = output("Email", oldKey);
    const next = output("Auxiliary code", key);
    next.elements.push(output("Email", "fresh").elements[0]);
    const raw = reuseReadingKeys(next, prior);
    const domain = toScreenAnalysis({
      raw,
      screen: screen("scr", "Synthetic", 0),
      version: 1,
      screenKey: "synthetic",
      validScreenIds: ["scr"],
    }).analysis;
    expect(
      domain.elements.find((e) => e.id === `synthetic.${oldKey}`)?.label,
    ).toBe("Email");
    expect(new Set(domain.elements.map((e) => e.id)).size).toBe(2);
    expect(raw.elements.every((e) => e.key.length <= 40)).toBe(true);
  },
);

it("preserves an uncontested explicit key for a renamed field without inventing an ambiguous label match", () => {
  const prior = output("Email", "email");
  expect(
    reuseReadingKeys(output("Work email", "email"), prior).elements[0].key,
  ).toBe("email");
  const next = output("Email", "email");
  next.elements.push(output("Email", "other").elements[0]);
  expect(reuseReadingKeys(next, prior).elements.map((e) => e.key)).toEqual([
    "email",
    "other",
  ]);
});

it("matches the domain's label trimming without changing case or inventing a rename match", () => {
  const prior = output("Email", "email");
  expect(
    reuseReadingKeys(output(" Email ", "fresh"), prior).elements[0].key,
  ).toBe("email");
  expect(
    reuseReadingKeys(output("email", "fresh"), prior).elements[0].key,
  ).toBe("fresh");
});

it("preserves the matched identity across partitioned reading namespaces", () => {
  const prior = output("Email", "p0_email");
  const left = partOutput("0", "Auxiliary code");
  left.elements[0].key = "email";
  const right = partOutput("1", "Email");
  right.elements[0].key = "fresh_email";
  const raw = reuseReadingKeys(
    mergeReadingParts({
      version: 1,
      split: [""],
      completed: [
        { path: "0", output: left },
        { path: "1", output: right },
      ],
    }),
    prior,
  );
  expect(raw.elements.find((e) => e.key === "p0_email")?.label).toBe("Email");
  expect(new Set(raw.elements.map((e) => e.key)).size).toBe(2);
});

it.each([false, true])(
  "canonicalizes defaulted fields before root/split checkpoint reuse (split=%s)",
  async (split) => {
    const state = {
      version: 1,
      split: split ? [""] : [],
      completed: (split ? ["0", "1"] : [""]).map((path) => ({
        path,
        output: path ? partOutput(path, path) : output(),
      })),
    };
    for (const p of state.completed)
      for (const key of [
        "description",
        "placeholder",
        "defaultValue",
        "helperText",
        "options",
        "required",
        "validation",
        "states",
        "behavior",
        "navigatesToScreenId",
        "navigatesToHint",
        "dataBinding",
        "inferred",
      ])
        delete (p.output.elements[0] as unknown as Record<string, unknown>)[
          key
        ];
    expect(validReadingParts(state)).toBe(true);
    expect(
      parseReadingParts(state)?.completed[0].output.elements[0].description,
    ).toBe("");
    const r = await adaptiveReading({
      ...base(),
      state,
      read: async () => {
        throw Error("A complete checkpoint must not request a model");
      },
    });
    expect(r.parts).toBe(split ? 2 : 1);
    expect(
      r.output.elements.every(
        (e) => e.description === "" && Array.isArray(e.inferred),
      ),
    ).toBe(true);
    expect(state.completed[0].output.elements[0]).not.toHaveProperty(
      "description",
    );
  },
);

it("rejects an impossible terminal split and rereads a malformed checkpoint safely", async () => {
  expect(
    parseReadingParts({
      version: 1,
      split: ["", "0", "00", "000"],
      completed: [],
    }),
  ).toBeUndefined();
  const bad = {
    version: 1,
    split: [],
    completed: [
      { path: "", output: { ...output(), elements: [{ key: "broken" }] } },
    ],
  };
  const seen: string[] = [];
  const r = await adaptiveReading({
    ...base(),
    state: bad,
    read: async (p) => {
      seen.push(p);
      return output();
    },
  });
  expect(seen).toEqual([""]);
  expect(r.output.elements[0].label).toBe("Exact €1,234.56");
});

it("resumes only the unfinished section after canonicalizing a partial checkpoint", async () => {
  const left = partOutput("0", "Retained left");
  delete (left.elements[0] as unknown as Record<string, unknown>).description;
  const seen: string[] = [];
  const r = await adaptiveReading({
    ...base(),
    state: {
      version: 1,
      split: [""],
      completed: [{ path: "0", output: left }],
    },
    read: async (p) => {
      seen.push(p);
      return partOutput(p, "New right");
    },
  });
  expect(seen).toEqual(["1"]);
  expect(r.output.elements[0].description).toBe("");
  expect(r.output.elements.map((e) => e.label)).toEqual([
    "Retained left",
    "New right",
  ]);
});
