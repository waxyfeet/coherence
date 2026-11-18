import { beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ComponentProps, type ReactNode } from "react";
import { RealAnalysis } from "./RealAnalysis";
import { Button } from "./ui";
import { initialSettings, newConnection } from "./data";
import type { Project } from "../shared/types";

// Exercise the actual component's callbacks without a browser/profile or DOM.
// The component only uses state hooks; children remain ordinary React elements.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = hooks.cursor++;
      if (!Object.hasOwn(hooks.values, i)) hooks.values[i] = initial;
      return [hooks.values[i], (value: unknown) => (hooks.values[i] = value)];
    },
  };
});
beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
});
type Props = ComponentProps<typeof RealAnalysis>;
const offline = newConnection("mock", "synthetic-offline"),
  gemini = {
    ...newConnection("gemini", "synthetic-gemini"),
    modelIds: ["Exact-Reader", "Exact-Writer"],
    // Gemini always needs a key; these tests are about defaults and image consent.
    keyPresent: true,
  },
  defaults = {
    visionConnectionId: gemini.id,
    visionModelId: "Exact-Reader",
    textConnectionId: gemini.id,
    textModelId: "Exact-Writer",
  };
function fixture(): Props {
  return {
    project: {
      id: "synthetic-before-defaults",
      name: "Synthetic prepared project",
      description: "Human-entered description",
      additionalContext: "Human context",
      formatId: "use-case-bdd",
      outputDir: "synthetic",
      llm: {
        visionConnectionId: offline.id,
        textConnectionId: offline.id,
        visionModelId: "demo",
        textModelId: "demo",
      },
      screens: [
        {
          id: "screen",
          name: "Synthetic",
          notes: "Human screen description",
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
    } satisfies Project,
    model: null,
    settings: {
      ...initialSettings,
      connections: [offline, gemini],
      analysisDefaults: defaults,
      visionId: offline.id,
      textId: offline.id,
    },
    job: null,
    busy: false,
    onGenerate: vi.fn(),
    onCancel: vi.fn(),
    onAbandon: vi.fn(),
    onSettings: vi.fn(),
    onSpecs: vi.fn(),
    onProjectConnections: vi.fn(async () => {}),
  };
}
function elements(node: ReactNode): {
  type: unknown;
  props: Record<string, unknown>;
}[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return isValidElement<{ children?: ReactNode }>(node)
    ? text(node.props.children)
    : "";
}
function view(props: Props) {
  hooks.cursor = 0;
  const nodes = elements(RealAnalysis(props));
  return {
    button(label: string) {
      const node = nodes.find(
        (n) =>
          n.type === Button && text(n.props.children as ReactNode) === label,
      );
      expect(node, label).toBeTruthy();
      return node!.props;
    },
    select(label: string) {
      const node = nodes.find((n) => n.props.label === label);
      expect(node, label).toBeTruthy();
      return node!.props;
    },
    checkbox() {
      return nodes.find(
        (n) => n.type === "input" && n.props.type === "checkbox",
      )?.props;
    },
  };
}
function click(props: Record<string, unknown>) {
  expect(props.disabled).not.toBeTruthy();
  (props.onClick as () => void)();
}
it("keeps a prepared project's Offline choices until explicit adoption, with no writes or generation", () => {
  const p = fixture(),
    original = structuredClone(p.project);
  const first = view(p);
  expect(first.select("Read screens connection").value).toBe(offline.id);
  click(first.button("Use saved analysis defaults"));
  const next = view(p);
  expect(next.select("Read screens connection").value).toBe(gemini.id);
  expect(next.select("Read screens model").value).toBe("Exact-Reader");
  expect(next.select("Write use cases / reasoning model").value).toBe(
    "Exact-Writer",
  );
  expect(next.checkbox()?.checked).toBe(false);
  expect(next.button("Generate specifications").disabled).toBe(true);
  expect(p.project).toEqual(original);
  expect(p.onProjectConnections).not.toHaveBeenCalled();
  expect(p.onGenerate).not.toHaveBeenCalled();
  expect(next.button("Use saved analysis defaults").disabled).toBe(true);
});
it("lets a user explicitly acknowledge and save adopted Unknown models; changing the reader clears consent", () => {
  const p = fixture();
  click(view(p).button("Use saved analysis defaults"));
  const checkbox = view(p).checkbox()!;
  (checkbox.onChange as (e: { target: { checked: boolean } }) => void)({
    target: { checked: true },
  });
  click(view(p).button("Save choices for this project"));
  expect(p.onProjectConnections).toHaveBeenCalledExactlyOnceWith({
    ...defaults,
    visionAcknowledged: true,
  });
  click(view(p).button("Generate specifications"));
  expect(p.onGenerate).toHaveBeenCalledWith(
    expect.objectContaining({ ...defaults, visionAcknowledged: true }),
  );
  const select = view(p).select("Read screens model");
  (select.onChange as (value: string) => void)("Exact-Writer");
  expect(view(p).checkbox()?.checked).toBe(false);
  expect(view(p).button("Generate specifications").disabled).toBe(true);
});
it("adoption clears earlier reader consent rather than inheriting it from another choice", () => {
  const p = fixture();
  p.project.llm.visionAcknowledged = true;
  click(view(p).button("Use saved analysis defaults"));
  expect(view(p).checkbox()?.checked).toBe(false);
  expect(p.project.llm.visionAcknowledged).toBe(true);
});
it.each([
  "missing-account",
  "removed-model",
  "unsupported-reader",
  "unsupported-writer",
  "local-only",
  "busy",
])("does not offer unsafe or unavailable adoption: %s", (scenario) => {
  const p = fixture();
  if (scenario === "missing-account") p.settings.connections = [offline];
  if (scenario === "removed-model")
    p.settings.connections = [offline, { ...gemini, modelIds: [] }];
  if (scenario === "unsupported-reader")
    p.settings.connections = [offline, { ...gemini, vision: "no" }];
  if (scenario === "unsupported-writer")
    p.settings.connections = [
      offline,
      {
        ...gemini,
        capabilities: {
          "Exact-Writer": [
            {
              capability: "text",
              at: new Date().toISOString(),
              outcome: "failed",
              state: "unsupported",
              reason: "unsupported",
            },
          ],
        },
      },
    ];
  if (scenario === "local-only") p.project.localOnly = true;
  if (scenario === "busy") p.busy = true;
  expect(view(p).button("Use saved analysis defaults").disabled).toBe(true);
  expect(p.onProjectConnections).not.toHaveBeenCalled();
  expect(p.onGenerate).not.toHaveBeenCalled();
});
it("uses newly saved Settings while Analysis stays mounted, without silently replacing its selections", () => {
  const p = fixture();
  p.settings.analysisDefaults = {
    visionConnectionId: offline.id,
    visionModelId: "demo",
    textConnectionId: offline.id,
    textModelId: "demo",
  };
  expect(view(p).button("Use saved analysis defaults").disabled).toBe(true);
  p.settings = { ...p.settings, analysisDefaults: defaults };
  const next = view(p);
  expect(next.select("Read screens connection").value).toBe(offline.id);
  click(next.button("Use saved analysis defaults"));
  expect(view(p).select("Read screens model").value).toBe("Exact-Reader");
  expect(p.onProjectConnections).not.toHaveBeenCalled();
  expect(p.onGenerate).not.toHaveBeenCalled();
});
it("does not require acknowledgement when the adopted exact reader has current image proof", () => {
  const p = fixture();
  p.settings.connections = [
    offline,
    {
      ...gemini,
      capabilities: {
        "Exact-Reader": [
          {
            capability: "image",
            at: new Date().toISOString(),
            outcome: "passed",
            state: "tested",
            reason: "passed",
          },
        ],
      },
    },
  ];
  click(view(p).button("Use saved analysis defaults"));
  expect(view(p).checkbox()).toBeUndefined();
  expect(view(p).button("Generate specifications").disabled).toBe(false);
  expect(p.onGenerate).not.toHaveBeenCalled();
});
