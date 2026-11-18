import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateIndex: 0,
  refIndex: 0,
  push: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.values))
      hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [
      hooks.values[index],
      (value: unknown) => {
        hooks.values[index] =
          typeof value === "function" ? value(hooks.values[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = hooks.refIndex++;
    return (hooks.refs[index] ??= {
      current: index === 7 ? { push: hooks.push } : initial,
    });
  },
  useCallback: (value: unknown) => value,
  useEffect: () => {},
}));
import RealApp from "./RealApp";
import { BrandMark } from "./BrandMark";
import { initialSettings } from "./data";
import { Confirm, Menu } from "./ui";
function elements(
  node: ReactNode,
): { type: unknown; props: Record<string, unknown> }[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function render() {
  hooks.stateIndex = 0;
  hooks.refIndex = 0;
  return elements(RealApp());
}
function choose(nodes: ReturnType<typeof render>, label: string) {
  const menu = nodes.find(
    (n) =>
      n.type === Menu &&
      isValidElement<Record<string, unknown>>(n.props.trigger) &&
      n.props.trigger.props.className === "project-switcher",
  )!;
  const item = (
    menu.props.items as { label: string; onSelect: () => void }[]
  ).find((i) => i.label === label)!;
  item.onSelect();
}
beforeEach(() => {
  hooks.values = [];
  hooks.refs = [];
  hooks.push.mockReset();
  vi.stubGlobal("location", {
    hash: "#/projects/synthetic-a/use-cases?case=UC-001",
  });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  hooks.values[3] = [
    {
      id: "synthetic-a",
      name: "Synthetic A",
      description: "",
      status: "draft",
      screenCount: 0,
      useCaseCount: 0,
    },
    {
      id: "synthetic-b",
      name: "Synthetic B",
      description: "",
      status: "draft",
      screenCount: 0,
      useCaseCount: 0,
    },
  ];
  hooks.values[9] = {
    id: "synthetic-a",
    name: "Synthetic A",
    llm: {},
    screens: [],
    description: "",
  };
  hooks.values[15] = {};
  hooks.values[16] = initialSettings;
  hooks.values[24] = false;
});
afterEach(() => vi.unstubAllGlobals());
it("the live application header uses Coherence and the approved asset component", () => {
  const header = render().find((n) => n.props.className === "app-brand")!;
  const children = elements(header.props.children as ReactNode);
  expect(children.some((n) => n.type === BrandMark)).toBe(true);
  expect(children.some((n) => n.props.children === "Coherence")).toBe(true);
  expect(children.some((n) => n.props.children === "ScreenScribe")).toBe(false);
});
it.each([0, 1])(
  "Home project card %i opens Overview, including the remembered active project",
  (index) => {
    hooks.values[2] = true;
    const cards = render().filter((n) => n.props.className === "project-card");
    (cards[index].props.onClick as () => void)();
    const id = index === 0 ? "synthetic-a" : "synthetic-b";
    expect(hooks.push).toHaveBeenCalledExactlyOnceWith(
      `#/projects/${id}/overview`,
    );
    expect(hooks.values[0]).toBe(id);
    expect(hooks.values[1]).toBe("overview");
    expect(hooks.values[2]).toBe(false);
  },
);
it("Home project cards retain Keep editing and explicit-discard protection", () => {
  hooks.values[2] = true;
  const nodes = render();
  hooks.refs[6].current = true;
  const card = nodes.filter((n) => n.props.className === "project-card")[1];
  (card.props.onClick as () => void)();
  expect(hooks.push).not.toHaveBeenCalled();
  let confirm = render().find((n) => n.type === Confirm)!;
  expect(confirm.props.open).toBe(true);
  (confirm.props.onCancel as () => void)();
  expect(hooks.values[0]).toBe("synthetic-a");
  expect(hooks.values[1]).toBe("use-cases");
  expect(hooks.values[2]).toBe(true);
  expect(hooks.refs[6].current).toBe(true);
  (card.props.onClick as () => void)();
  confirm = render().find((n) => n.type === Confirm)!;
  (confirm.props.onDiscard as () => void)();
  expect(hooks.push).toHaveBeenCalledExactlyOnceWith(
    "#/projects/synthetic-b/overview",
  );
});
it("selecting a different project from the real switcher opens Overview through the existing navigation path", () => {
  choose(render(), "Synthetic B");
  expect(hooks.push).toHaveBeenCalledExactlyOnceWith(
    "#/projects/synthetic-b/overview",
  );
  expect(hooks.values[0]).toBe("synthetic-b");
  expect(hooks.values[1]).toBe("overview");
});
it("Keep editing blocks project switching without modifying the active draft or history", () => {
  const nodes = render();
  hooks.refs[6].current = true; // the real navigation's dirtyRef
  choose(nodes, "Synthetic B");
  expect(hooks.push).not.toHaveBeenCalled();
  const confirm = render().find((n) => n.type === Confirm)!;
  expect(confirm.props.open).toBe(true);
  (confirm.props.onCancel as () => void)();
  expect(hooks.values[0]).toBe("synthetic-a");
  expect(hooks.values[1]).toBe("use-cases");
  expect(hooks.refs[6].current).toBe(true);
  expect(hooks.push).not.toHaveBeenCalled();
});
it("explicitly discarding before a switch completes the requested Overview navigation once", () => {
  const nodes = render();
  hooks.refs[6].current = true;
  choose(nodes, "Synthetic B");
  const confirm = render().find((n) => n.type === Confirm)!;
  (confirm.props.onDiscard as () => void)();
  expect(hooks.push).toHaveBeenCalledExactlyOnceWith(
    "#/projects/synthetic-b/overview",
  );
});
it("the empty library renders a friendly message across the full grid while filtered searches retain recovery", () => {
  hooks.values[2] = true;
  hooks.values[3] = [];
  hooks.values[9] = null;
  const empty = render().find((n) => n.props.className === "library-empty")!;
  const copy = JSON.stringify(empty.props.children);
  expect(copy).toContain("Your next idea starts here.");
  expect(copy).toContain("Create your first project");
  hooks.values[3] = [
    { id: "synthetic-a", name: "Synthetic A", description: "" },
  ];
  hooks.values[8] = "unmatched";
  const filtered = render().find((n) => n.props.className === "library-empty")!;
  expect(JSON.stringify(filtered.props.children)).toContain(
    "No projects match your search.",
  );
  const reset = elements(filtered.props.children as ReactNode).find(
    (n) => n.props.children === "Show all projects",
  )!;
  (reset.props.onClick as () => void)();
  expect(hooks.values[8]).toBe("");
  expect(hooks.values[5]).toBe("all");
});
