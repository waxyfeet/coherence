import { beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { AnalysisModelDefaults } from "./AnalysisModelDefaults";
import { newConnection } from "./data";
import { Picker, Toggle } from "./ui";
const hooks = vi.hoisted(() => ({ separate: false }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: boolean) => [
    hooks.separate,
    (value: boolean) => {
      hooks.separate = value;
    },
  ],
}));
beforeEach(() => {
  hooks.separate = false;
});
const c = {
  ...newConnection("gemini", "synthetic"),
  modelIds: ["reader", "writer"],
};
function elements(
  node: ReactNode,
): { type: unknown; props: Record<string, unknown> }[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
it("a single model selection explicitly sets both roles without modifying the input or calling Connections", () => {
  const value = {
    visionConnectionId: c.id,
    visionModelId: "reader",
    textConnectionId: c.id,
    textModelId: "reader",
  };
  const onChange = vi.fn(),
    onConnections = vi.fn();
  const nodes = elements(
    AnalysisModelDefaults({ value, connections: [c], onChange, onConnections }),
  );
  const select = nodes.find(
    (n) => n.type === Picker && n.props.label === "Default reading model",
  )!;
  (select.props.onChange as (id: string) => void)("writer");
  expect(onChange).toHaveBeenCalledExactlyOnceWith({
    ...value,
    visionModelId: "writer",
    textModelId: "writer",
  });
  expect(value.visionModelId).toBe("reader");
  expect(onConnections).not.toHaveBeenCalled();
  expect(nodes.some((n) => n.props.label === "Default writing model")).toBe(
    false,
  );
});
it("the optional separate writer changes only its own role; collapsing explicitly reunifies the pair", () => {
  const value = {
    visionConnectionId: c.id,
    visionModelId: "reader",
    textConnectionId: c.id,
    textModelId: "writer",
  };
  const onChange = vi.fn();
  hooks.separate = true;
  const nodes = elements(
    AnalysisModelDefaults({
      value,
      connections: [c],
      onChange,
      onConnections: vi.fn(),
    }),
  );
  const writer = nodes.find(
    (n) => n.type === Picker && n.props.label === "Default writing model",
  )!;
  (writer.props.onChange as (id: string) => void)("reader");
  expect(onChange).toHaveBeenLastCalledWith({
    ...value,
    textModelId: "reader",
  });
  const toggle = nodes.find((n) => n.type === Toggle)!;
  (toggle.props.onChange as (checked: boolean) => void)(false);
  expect(onChange).toHaveBeenLastCalledWith({
    ...value,
    textModelId: "reader",
  });
  expect(hooks.separate).toBe(false);
});
