import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Project, Screen } from "@shared/types";
import { useTempDataDir, removeDir } from "../storage/testUtils";
import { ScreenReadingSchema } from "./readerContract";
import { toScreenAnalysis } from "./ids";
import { recordingContext } from "./testContext";
import { RequestBudget } from "../llm/capacity";
import {
  closeServers,
  completion,
  connection,
  json,
  serve,
} from "../llm/reliabilityFixtures";

let dir: string,
  project: Project,
  screen: Screen,
  manifest: Buffer,
  image: Buffer,
  human: string;
let store: typeof import("../storage/projectStore"),
  state: typeof import("./runState"),
  analyst: typeof import("./screenAnalyst");
const fingerprint = "a".repeat(64);
const output = (label = "Email", key = "email", x = 5) =>
  ScreenReadingSchema.parse({
    title: "Synthetic",
    purpose: "Exact fixture evidence",
    screenType: "form",
    personas: [],
    regions: [{ key: "main", name: "Main", purpose: "", layout: "" }],
    elements: [
      {
        key,
        regionKey: "main",
        type: "text_input",
        label,
        bounds: { x, y: 5, width: 20, height: 20 },
      },
    ],
    dataEntities: [],
    openQuestions: [],
  });
beforeAll(async () => {
  dir = await useTempDataDir("adaptive-remediation");
  vi.resetModules();
  store = await import("../storage/projectStore");
  state = await import("./runState");
  analyst = await import("./screenAnalyst");
  await store.ensureDataDirs();
  const created = await store.createProject({
    name: "Synthetic adaptive remediation",
    description: "Isolated fixtures only",
  });
  image = await sharp({
    create: { width: 100, height: 100, channels: 4, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  [screen] = await store.addScreens(created.id, [
    { originalName: "synthetic.png", mimeType: "image/png", buffer: image },
  ]);
  project = await store.getProject(created.id);
  manifest = await fs.readFile(path.join(project.projectPath!, "project.json"));
  human = path.join(project.projectPath!, "human-note.md");
  await fs.writeFile(human, "SYNTHETIC APPROVED HUMAN CONTENT");
});
afterEach(async () => {
  await closeServers();
  expect(
    await fs.readFile(path.join(project.projectPath!, "project.json")),
  ).toEqual(manifest);
  expect(
    await fs.readFile(
      path.join(project.projectPath!, "screens", screen.fileName),
    ),
  ).toEqual(image);
  expect(await fs.readFile(human, "utf8")).toBe(
    "SYNTHETIC APPROVED HUMAN CONTENT",
  );
});
afterAll(async () => {
  await removeDir(dir);
});
const args = (c: ReturnType<typeof connection>) => ({
  ctx: Object.assign(recordingContext(project.id), {
    resources: new RequestBudget(),
  }),
  project,
  screen,
  connection: c,
  thoroughness: "standard" as const,
  takenScreenKeys: [],
});

it.each([false, true])(
  "keeps the old Email ID on Email through actual SDK reading regardless of record order (reverse=%s)",
  async (reverse) => {
    const prior = toScreenAnalysis({
      raw: output(),
      screen,
      version: 1,
      screenKey: "synthetic",
      validScreenIds: [screen.id],
    }).analysis;
    const response = output("Auxiliary code", "email");
    response.elements.push(output("Email", "fresh_email", 65).elements[0]);
    if (reverse) response.elements.reverse();
    const endpoint = await serve((_req, res) =>
      json(res, completion(JSON.stringify(response))),
    );
    const c = connection({
      baseUrl: endpoint.url + "/v1",
      model: "Synthetic/Identity",
      modelOutputTokenLimit: 8000,
    });
    const actual = await analyst.analyseScreen({ ...args(c), previous: prior });
    expect(endpoint.requests).toHaveLength(1);
    expect(actual.elements.find((e) => e.id === "synthetic.email")?.label).toBe(
      "Email",
    );
    expect(
      actual.elements.find((e) => e.label === "Auxiliary code")?.id,
    ).not.toBe("synthetic.email");
    expect(new Set(actual.elements.map((e) => e.id)).size).toBe(2);
  },
);

it.each([false, true])(
  "normalizes on-disk root/split checkpoint defaults before real analysis conversion without inference (split=%s)",
  async (split) => {
    const checkpoint = {
      version: 1 as const,
      split: split ? [""] : [],
      completed: split
        ? [
            { path: "0", output: output("Left field", "left") },
            { path: "1", output: output("Right field", "right", 65) },
          ]
        : [{ path: "", output: output() }],
    };
    await state.cacheReadingParts(
      project.id,
      screen.id,
      fingerprint,
      checkpoint,
    );
    const file = path.join(
      project.projectPath!,
      "analysis-cache",
      screen.id + ".parts.json",
    );
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    for (const part of raw.state.completed)
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
        delete part.output.elements[0][key];
    const damaged = JSON.stringify(raw);
    await fs.writeFile(file, damaged);
    const loaded = await state.readReadingParts(
      project.id,
      screen.id,
      fingerprint,
    );
    expect(loaded?.completed[0].output.elements[0].description).toBe("");
    const endpoint = await serve((_req, res) =>
      json(res, completion(JSON.stringify(output()))),
    );
    const c = connection({
      baseUrl: endpoint.url + "/v1",
      model: "Synthetic/Checkpoint",
      modelOutputTokenLimit: 8000,
    });
    const actual = await analyst.analyseScreen({
      ...args(c),
      readingParts: loaded,
    });
    expect(endpoint.requests).toHaveLength(0);
    expect(actual.reading?.parts).toBe(split ? 2 : 1);
    expect(actual.elements.every((e) => e.description === "")).toBe(true);
    expect(actual.elements.map((e) => e.label)).toEqual(
      split ? ["Left field", "Right field"] : ["Email"],
    );
    expect(await fs.readFile(file, "utf8")).toBe(damaged);
  },
);

it("ignores and retains an unsafe checkpoint, then obtains a new valid reading", async () => {
  const file = path.join(
    project.projectPath!,
    "analysis-cache",
    screen.id + ".parts.json",
  );
  const malformed = JSON.stringify({
    fingerprint,
    state: {
      version: 1,
      split: [],
      completed: [
        { path: "", output: { ...output(), elements: [{ key: "broken" }] } },
      ],
    },
  });
  await fs.writeFile(file, malformed);
  const loaded = await state.readReadingParts(
    project.id,
    screen.id,
    fingerprint,
  );
  expect(loaded).toBeUndefined();
  const endpoint = await serve((_req, res) =>
    json(res, completion(JSON.stringify(output()))),
  );
  const actual = await analyst.analyseScreen({
    ...args(
      connection({
        baseUrl: endpoint.url + "/v1",
        modelOutputTokenLimit: 8000,
      }),
    ),
    readingParts: loaded,
  });
  expect(endpoint.requests).toHaveLength(1);
  expect(actual.elements[0].label).toBe("Email");
  expect(await fs.readFile(file, "utf8")).toBe(malformed);
});
