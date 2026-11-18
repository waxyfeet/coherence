import { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  pending: { current: null as AbortController | null },
  api: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = state.index++;
    if (!(i in state.values)) state.values[i] = initial;
    return [
      state.values[i],
      (value: unknown) => {
        state.values[i] = value;
      },
    ];
  },
  useRef: () => state.pending,
  useEffect: () => {},
}));
vi.mock("./api", () => ({ api: state.api }));
import {
  ProjectFiles,
  ProjectLocationField,
  ReconnectProject,
} from "./ProjectFiles";
import type { Project } from "../shared/types";
type Element = { type: unknown; props: Record<string, unknown> };
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function content(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(content).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return content(node.props.children);
  return "";
}
function button(nodes: Element[], label: string) {
  return nodes.find(
    (n) =>
      typeof n.props.onClick === "function" &&
      content(n.props.children) === label,
  )!;
}
const info = {
  layout: "portable",
  workspace: "D:\\Synthetic Workspace",
  globalData: "C:\\Synthetic Global",
};
beforeEach(() => {
  state.values = [];
  state.index = 0;
  state.pending.current = null;
  state.api.mockReset();
});
function location(project?: Project) {
  state.index = 0;
  const onWorkspaceChange = vi.fn();
  return {
    nodes: elements(
      ProjectLocationField({
        onWorkspaceChange,
        project,
      }),
    ),
    onWorkspaceChange,
  };
}
it("Browse changes only the unsaved workspace field", async () => {
  state.values = [info, "", false, ""];
  state.api.mockResolvedValue({ path: "D:\\Chosen Workspace" });
  const view = location();
  const browse = view.nodes.find(
    (n) => n.props.className === "output-folder-picker",
  )!;
  (browse.props.onClick as () => void)();
  await vi.waitFor(() =>
    expect(view.onWorkspaceChange).toHaveBeenCalledExactlyOnceWith(
      "D:\\Chosen Workspace",
    ),
  );
  expect(state.api).toHaveBeenCalledExactlyOnceWith(
    "/storage/choose-folder",
    "POST",
    { purpose: "workspace", initialPath: info.workspace },
    expect.any(AbortSignal),
  );
});
it("cancelled folder selection never applies a late chooser result", async () => {
  state.values = [info, "", false, ""];
  let finish!: (result: { path: string }) => void;
  state.api.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const first = location();
  (
    first.nodes.find((n) => n.props.className === "output-folder-picker")!.props
      .onClick as () => void
  )();
  const signal = state.pending.current!.signal;
  (
    button(location().nodes, "Cancel folder selection").props
      .onClick as () => void
  )();
  expect(signal.aborted).toBe(true);
  finish({ path: "D:\\Cancelled Late Result" });
  await Promise.resolve();
  await Promise.resolve();
  expect(first.onWorkspaceChange).not.toHaveBeenCalled();
});
it("the existing project reveals only its registered project ID without changing its location", async () => {
  state.values = [info, "", false, ""];
  state.api.mockResolvedValue({ ok: true });
  const view = location({
    id: "synthetic-project",
    projectPath: "D:\\Workspace\\synthetic-project",
    storage: {
      format: "coherence-project",
      version: 1,
      folderId: "00000000-0000-4000-8000-000000000000",
      requirements: "specs",
    },
  } as Project);
  (button(view.nodes, "Open project folder").props.onClick as () => void)();
  expect(state.api).toHaveBeenCalledExactlyOnceWith(
    "/storage/reveal/synthetic-project",
    "POST",
    {},
  );
  expect(view.onWorkspaceChange).not.toHaveBeenCalled();
});
it("Open existing uses the native chosen folder and opens exactly the returned project", async () => {
  state.values = [true, info, false, "", false, ""];
  const onOpened = vi.fn();
  state.api.mockImplementation((route: string) =>
    Promise.resolve(
      route === "/storage/choose-folder"
        ? { path: "D:\\Complete Project" }
        : { id: "exact-returned-project" },
    ),
  );
  state.index = 0;
  const nodes = elements(ProjectFiles({ onOpened }));
  (
    button(nodes, "Open existing Coherence project").props.onClick as () => void
  )();
  await vi.waitFor(() =>
    expect(onOpened).toHaveBeenCalledExactlyOnceWith("exact-returned-project"),
  );
  expect(state.api).toHaveBeenCalledWith("/storage/open", "POST", {
    path: "D:\\Complete Project",
  });
  expect(
    state.api.mock.calls.some(([route]) => route === "/storage/workspace"),
  ).toBe(false);
});
it("reconnect binds to the expected missing project ID and cancelled choices do not open anything", async () => {
  state.api.mockResolvedValue({ path: null });
  let onOpened = vi.fn();
  state.index = 0;
  let nodes = elements(ReconnectProject({ id: "missing-project", onOpened }));
  (button(nodes, "Reconnect project folder").props.onClick as () => void)();
  await vi.waitFor(() => expect(state.pending.current).toBeNull());
  expect(onOpened).not.toHaveBeenCalled();
  expect(state.api).toHaveBeenCalledTimes(1);
  state.api.mockImplementation((route: string) =>
    Promise.resolve(
      route === "/storage/choose-folder"
        ? { path: "D:\\Relocated Project" }
        : { id: "missing-project" },
    ),
  );
  state.index = 0;
  nodes = elements(ReconnectProject({ id: "missing-project", onOpened }));
  (button(nodes, "Reconnect project folder").props.onClick as () => void)();
  await vi.waitFor(() => expect(onOpened).toHaveBeenCalledOnce());
  expect(state.api).toHaveBeenCalledWith("/storage/open", "POST", {
    path: "D:\\Relocated Project",
    expectedId: "missing-project",
  });
});
