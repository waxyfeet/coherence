import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { Job, Project } from "../shared/types";
import { initialSettings, newConnection, type Connection } from "./data";
import { RealAnalysis } from "./RealAnalysis";

function render(
  connection: Connection,
  acknowledged = false,
  reader = "Exact-Reader",
  job: Job | null = null,
) {
  const project: Project = {
    id: "synthetic-analysis",
    name: "Synthetic preflight",
    description: "Synthetic",
    additionalContext: "",
    formatId: "use-case-bdd",
    outputDir: "synthetic",
    llm: {
      visionConnectionId: connection.id,
      textConnectionId: connection.id,
      visionModelId: connection.provider === "mock" ? "demo" : reader,
      textModelId: connection.provider === "mock" ? "demo" : "Exact-Writer",
      visionAcknowledged: acknowledged,
    },
    screens: [
      {
        id: "screen",
        name: "Synthetic",
        notes: "",
        order: 0,
        version: 1,
        fileName: "fixture.png",
        originalFileName: "fixture.png",
        mimeType: "image/png",
        width: 64,
        height: 64,
        sizeBytes: 128,
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    status: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return renderToStaticMarkup(
    <RealAnalysis
      project={project}
      model={null}
      settings={{
        ...initialSettings,
        connections: [connection],
        visionId: connection.id,
        textId: connection.id,
      }}
      job={job}
      busy={false}
      onGenerate={() => {}}
      onCancel={() => {}}
      onAbandon={() => {}}
      onSettings={() => {}}
      onSpecs={() => {}}
      onProjectConnections={async () => {}}
    />,
  );
}
const account = () => ({
  ...newConnection("compatible", "synthetic-account"),
  modelIds: ["Exact-Reader", "Exact-Writer"],
});
const generationButton = (markup: string, label = "Generate specifications") =>
  markup
    .match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    ?.find((value) => value.includes(label));
it("keeps Offline generation enabled without real image evidence or acknowledgement", () => {
  const markup = render({ ...newConnection("mock", "offline"), modelIds: [] });
  const button = generationButton(markup, "Generate offline example");
  expect(button).toBeTruthy();
  expect(button).not.toContain("disabled");
  expect(markup).toContain("Simulated");
});
it("blocks automatic unknown real readers and offers an explicit acknowledgement", () => {
  const markup = render(account());
  expect(generationButton(markup)).toContain("disabled");
  expect(markup).toContain("I confirm this model accepts screenshots");
  expect(markup).toContain(
    "Saving a connection or choosing a default does not verify image support",
  );
  expect(markup).toContain("Check screenshot support in Connections");
  expect(markup).toContain("Save choices for this project to remember it");
});
it("uses documented native Gemini image support without requiring a user certification or test", () => {
  const c = {
    ...newConnection("gemini"),
    modelIds: ["gemini-3.5-flash-lite", "Exact-Writer"],
    // A Gemini key is required; this test is about image evidence.
    keyPresent: true,
  };
  const markup = render(c, false, "gemini-3.5-flash-lite");
  expect(generationButton(markup)).not.toContain("disabled");
  expect(markup).toContain(
    "The provider lists screenshot support for this model",
  );
  expect(markup).toContain("No extra test is required before generating");
  expect(markup).not.toContain("Check screenshot support in Connections");
  expect(markup).not.toContain("I confirm this model accepts screenshots");
  expect(
    generationButton(
      render(
        { ...c, provider: "compatible", endpoint: "http://127.0.0.1:1234/v1" },
        false,
        "gemini-3.5-flash-lite",
      ),
    ),
  ).toContain("disabled");
});
it("accepts a saved explicit image acknowledgement without a mandatory paid test", () => {
  expect(generationButton(render(account(), true))).not.toContain("disabled");
});
it("uses explicit provider image metadata without requiring a user declaration", () => {
  const markup = render({
    ...account(),
    catalogue: {
      source: "compatible",
      refreshedAt: new Date().toISOString(),
      complete: true,
      models: [{ id: "Exact-Reader", reported: { vision: true } }],
    },
  });
  expect(generationButton(markup)).not.toContain("disabled");
  expect(markup).not.toContain("I confirm this model accepts screenshots");
  expect(markup).toContain(
    "The provider lists screenshot support for this model",
  );
  expect(markup).not.toContain("Check screenshot support in Connections");
});
it("honours a deliberate account override while clearly retaining unknown evidence", () => {
  const markup = render({ ...account(), vision: "yes" });
  expect(generationButton(markup)).not.toContain("disabled");
  expect(markup).toContain("your declaration, not a verified capability");
  expect(markup).not.toContain(
    "Screenshot support passed Coherence’s sample-image test",
  );
});
it("keeps a failed but unknown writing test eligible and still blocks a genuine negative", () => {
  const c = { ...account(), vision: "yes" };
  const record = {
    capability: "text" as const,
    at: new Date().toISOString(),
    state: "unknown" as const,
    outcome: "failed" as const,
    reason: "failed" as const,
  };
  expect(
    generationButton(
      render({ ...c, capabilities: { "Exact-Writer": [record] } }),
    ),
  ).not.toContain("disabled");
  expect(
    generationButton(
      render({
        ...c,
        capabilities: {
          "Exact-Writer": [
            { ...record, state: "unsupported", reason: "unsupported" },
          ],
        },
      }),
    ),
  ).toContain("disabled");
});
it("blocks known-unsupported image input even with an override and acknowledgement", () => {
  const markup = render(
    {
      ...account(),
      vision: "yes",
      catalogue: {
        source: "compatible",
        refreshedAt: new Date().toISOString(),
        complete: true,
        models: [{ id: "Exact-Reader", reported: { vision: false } }],
      },
    },
    true,
  );
  expect(generationButton(markup)).toContain("disabled");
});
it("enables current image proof and blocks expired proof without silently acknowledging", () => {
  const c = account();
  const record = {
    capability: "image" as const,
    at: new Date().toISOString(),
    state: "tested" as const,
    outcome: "passed" as const,
    reason: "passed" as const,
  };
  expect(
    generationButton(
      render({ ...c, capabilities: { "Exact-Reader": [record] } }),
    ),
  ).not.toContain("disabled");
  const tested = render({ ...c, capabilities: { "Exact-Reader": [record] } });
  expect(tested).toContain(
    "Screenshot support passed Coherence’s sample-image test",
  );
  expect(tested).not.toContain("Check screenshot support in Connections");
  expect(
    generationButton(
      render({
        ...c,
        capabilities: {
          "Exact-Reader": [{ ...record, at: "2020-01-01T00:00:00.000Z" }],
        },
      }),
    ),
  ).toContain("disabled");
});

it("shows a failed run in plain words, not the technical line", () => {
  const job: Job = {
    id: "job_failed",
    kind: "generate",
    projectId: "synthetic-analysis",
    status: "failed",
    progress: { stage: "", stageIndex: 0, stageCount: 0, current: 0, total: 0 },
    logs: [],
    usage: { calls: 5, inputTokens: 10, outputTokens: 10 },
    error: "The OpenAI-compatible server rate limit reached (429)",
    failure: {
      kind: "rate-limited",
      action: "wait",
      message: "OpenRouter's rate limit for Exact-Reader was reached.",
    },
    createdAt: "2026-11-03T00:00:00.000Z",
  };
  const markup = render(account(), true, "Exact-Reader", job);
  expect(markup).toContain(
    "OpenRouter&#x27;s rate limit for Exact-Reader was reached.",
  );
  expect(markup).not.toContain("(429)");
  const older = render(account(), true, "Exact-Reader", {
    ...job,
    failure: undefined,
  });
  expect(older).toContain("rate limit reached (429)");
});

it("stops before the run when a provider that always needs a key has none", () => {
  const markup = render(
    {
      ...newConnection("anthropic", "keyless"),
      name: "Keyless Claude",
      modelIds: ["Exact-Reader", "Exact-Writer"],
    },
    true,
  );
  expect(markup).toContain(
    "No API key is saved for Keyless Claude. Add it in Settings → AI connections.",
  );
  expect(generationButton(markup)).toContain("disabled");
});

it("only warns when an online gateway has no key, since some need none", () => {
  const markup = render(
    { ...account(), name: "Gateway", endpoint: "https://gateway.example/v1" },
    true,
  );
  expect(markup).toContain(
    "No API key is saved for Gateway. If the service needs one, the run will stop at its first request.",
  );
  const local = render({ ...account(), name: "Local" }, true);
  expect(local).not.toContain("No API key is saved");
  const saved = render(
    {
      ...account(),
      name: "Gateway",
      endpoint: "https://gateway.example/v1",
      keyPresent: true,
    },
    true,
  );
  expect(saved).not.toContain("No API key is saved");
});

const stoppedJob = (extra: Partial<Job> = {}): Job => ({
  id: "job_stopped",
  kind: "generate",
  projectId: "synthetic-analysis",
  status: "failed",
  progress: { stage: "", stageIndex: 0, stageCount: 0, current: 0, total: 0 },
  logs: [],
  usage: { calls: 5, inputTokens: 10, outputTokens: 10 },
  createdAt: "2026-11-03T00:00:00.000Z",
  ...extra,
});

it("offers Try again, Change models and Abandon for a stopped run, with a paused run's reset time (owner test note 7)", () => {
  const markup = render(
    account(),
    true,
    "Exact-Reader",
    stoppedJob({
      failure: {
        kind: "rate-limited",
        action: "wait",
        message: "Gateway's rate limit for Exact-Writer was reached.",
        resetAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      },
    }),
  );
  expect(markup).toContain("This run is paused until ");
  expect(markup).toContain("Gateway&#x27;s rate limit for Exact-Writer");
  expect(markup).toContain("Try again reuses the steps this run finished");
  expect(generationButton(markup, "Try again")).not.toContain("disabled");
  expect(generationButton(markup, "Change models")).toBeTruthy();
  expect(generationButton(markup, "Abandon run")).toBeTruthy();
  // One primary action: the ordinary Generate button gives way to Try again.
  expect(generationButton(markup)).toBeUndefined();
});

it("says plainly that a cancelled run was cancelled", () => {
  const markup = render(
    account(),
    true,
    "Exact-Reader",
    stoppedJob({ status: "cancelled", error: "Cancelled by the user" }),
  );
  expect(markup).toContain("This run was cancelled");
  expect(markup).toContain("You cancelled it.");
});

it("explains a blocked start beside the button and offers a reader that can see screenshots", () => {
  const markup = render(
    {
      ...account(),
      modelIds: ["Exact-Reader", "Exact-Writer", "Vision-Reader"],
      catalogue: {
        source: "compatible",
        refreshedAt: new Date().toISOString(),
        complete: true,
        models: [
          { id: "Exact-Reader", reported: { vision: false } },
          { id: "Vision-Reader", reported: { vision: true } },
        ],
      },
    },
    true,
  );
  expect(markup).toContain("Can&#x27;t start yet");
  expect(markup).toContain(
    "This model is reported as unable to read images. Choose another reading model.",
  );
  expect(
    generationButton(markup, "Read screens with Vision-Reader"),
  ).toBeTruthy();
  expect(generationButton(markup)).toContain("disabled");
});

it("offers a saved connection with the same model when the project's connection was removed (owner test note 6)", () => {
  const removed = { ...account(), id: "connection-removed" };
  const markup = renderToStaticMarkup(
    <RealAnalysis
      project={{
        id: "synthetic-analysis",
        name: "Synthetic",
        description: "",
        additionalContext: "",
        formatId: "use-case-bdd",
        outputDir: "synthetic",
        llm: {
          visionConnectionId: removed.id,
          textConnectionId: removed.id,
          visionModelId: "Exact-Reader",
          textModelId: "Exact-Writer",
        },
        screens: [],
        status: "draft",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }}
      model={null}
      settings={{
        ...initialSettings,
        connections: [{ ...account(), name: "Replacement gateway" }],
      }}
      job={null}
      busy={false}
      onGenerate={() => {}}
      onCancel={() => {}}
      onAbandon={() => {}}
      onSettings={() => {}}
      onSpecs={() => {}}
      onProjectConnections={async () => {}}
    />,
  );
  expect(markup).toContain("Missing connection");
  expect(
    generationButton(
      markup,
      "Use Replacement gateway, which has the same model",
    ),
  ).toBeTruthy();
});
