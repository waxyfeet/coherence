import { expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { OutputBudgetField } from "./OutputBudgetField";
import { Picker } from "./ui";
function elements(
  node: ReactNode,
): { type: unknown; props: Record<string, unknown> }[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
it.each(["", "0"])(
  "clearing or typing zero in Custom does not silently switch to Automatic: %j",
  (value) => {
    const onChange = vi.fn();
    const input = elements(
      OutputBudgetField({ id: "tokens", value: 16384, onChange, live: true }),
    ).find((n) => n.type === "input")!;
    (input.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value },
    });
    const next = onChange.mock.calls[0][0];
    expect(Number.isNaN(next)).toBe(true);
    const nodes = elements(
      OutputBudgetField({ id: "tokens", value: next, onChange, live: true }),
    );
    expect(nodes.find((n) => n.type === Picker)?.props.value).toBe("custom");
    expect(nodes.find((n) => n.type === "input")?.props.value).toBe("");
  },
);
it("only an explicit mode choice clears a custom cap, and Automatic has no numeric limit input", () => {
  const onChange = vi.fn();
  const mode = elements(
    OutputBudgetField({ id: "tokens", value: 16384, onChange, live: true }),
  ).find((n) => n.type === Picker)!;
  (mode.props.onChange as (value: string) => void)("auto");
  expect(onChange).toHaveBeenCalledExactlyOnceWith(0);
  expect(
    elements(
      OutputBudgetField({ id: "tokens", value: 0, onChange, live: true }),
    ).some((n) => n.type === "input"),
  ).toBe(false);
});
