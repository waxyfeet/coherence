import { afterEach, expect, it, vi } from "vitest";
import {
  createWorkspaceHistory,
  replaceWorkspaceHash,
} from "./workspaceHistory";

/** Model the browser cursor separately from URLs: replacing one cannot undo a traversal. */
function fixture(
  options: {
    native?: boolean;
    entries?: { hash: string; state: unknown }[];
    cursor?: number;
  } = {},
) {
  const entries = structuredClone(
    options.entries ?? [{ hash: "#overview", state: null as unknown }],
  );
  let cursor = options.cursor ?? 0;
  const listeners = new Set<() => void>();
  const moves: number[] = [];
  const moveCalls: number[] = [];
  const history = {
    get state() {
      return structuredClone(entries[cursor].state);
    },
    pushState(state: unknown, _unused: string, hash: string) {
      entries.splice(++cursor, entries.length, {
        hash,
        state: structuredClone(state),
      });
    },
    replaceState(state: unknown, _unused: string, hash?: string) {
      entries[cursor] = {
        hash: hash ?? entries[cursor].hash,
        state: structuredClone(state),
      };
    },
    go(delta: number) {
      moveCalls.push(delta);
      moves.push(delta);
    },
  };
  const host = {
    history,
    location: {
      get hash() {
        return entries[cursor].hash;
      },
    },
    navigation:
      options.native === false
        ? undefined
        : {
            get currentEntry() {
              return { index: cursor };
            },
          },
    addEventListener: (_type: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) =>
      listeners.delete(listener),
  } as unknown as Window;
  let dirty = false;
  const navigated: string[] = [];
  const blocked: (() => void)[] = [];
  const notices: (string | undefined)[] = [];
  const callbacks = {
    shouldBlock: () => dirty,
    onNavigate: (hash: string) => {
      navigated.push(hash);
      dirty = false;
    },
    onBlocked: (retry: () => void, notice?: string) => {
      blocked.push(retry);
      notices.push(notice);
    },
  };
  const controller = createWorkspaceHistory(callbacks, host);
  const flush = () => {
    let count = 0;
    while (moves.length) {
      if (++count > 20) throw Error("History restoration loop");
      const next = cursor + moves.shift()!;
      if (next < 0 || next >= entries.length || next === cursor) continue;
      cursor = next;
      for (const listener of listeners) listener();
    }
  };
  return {
    entries,
    history,
    host,
    callbacks,
    controller,
    navigated,
    blocked,
    notices,
    moveCalls,
    flush,
    get cursor() {
      return cursor;
    },
    set dirty(value: boolean) {
      dirty = value;
    },
    rawHash(hash: string) {
      history.pushState(null, "", hash);
      for (const listener of listeners) listener();
      flush();
    },
    move(delta: number) {
      history.go(delta);
      flush();
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

it("restores the cursor after repeated cancelled Back without overwriting either entry", () => {
  const f = fixture();
  f.controller.push("#screens");
  f.controller.push("#use-cases");
  const before = structuredClone(f.entries);
  f.dirty = true;
  f.move(-1);
  f.move(-1);
  expect(f.cursor).toBe(2);
  expect(f.entries).toEqual(before);
  expect(f.navigated).toEqual([]);
  expect(f.blocked).toHaveLength(2);
  f.dirty = false;
  f.move(-1);
  f.move(1);
  expect(f.navigated).toEqual(["#screens", "#use-cases"]);
});
it("restores Forward and only replays the reviewed destination on explicit discard", () => {
  const f = fixture();
  f.controller.push("#use-cases");
  f.controller.push("#screens");
  f.move(-1);
  f.dirty = true;
  f.move(1);
  expect(f.cursor).toBe(1);
  expect(f.navigated).toEqual(["#use-cases"]);
  f.blocked.at(-1)!();
  f.flush();
  expect(f.cursor).toBe(2);
  expect(f.navigated).toEqual(["#use-cases", "#screens"]);
  f.move(-1);
  expect(f.navigated.at(-1)).toBe("#use-cases");
});
it("retains intermediate entries across blocked multi-step project traversal", () => {
  const f = fixture();
  f.controller.push("#project-B/screens");
  f.controller.push("#project-B/use-cases");
  f.dirty = true;
  f.move(-2);
  expect(f.cursor).toBe(2);
  f.blocked.at(-1)!();
  f.flush();
  expect(f.cursor).toBe(0);
  f.move(1);
  f.move(1);
  expect(f.navigated).toEqual([
    "#overview",
    "#project-B/screens",
    "#project-B/use-cases",
  ]);
});
it("protects raw hash entries without changing existing URLs or losing their forward destination", () => {
  const f = fixture();
  f.controller.push("#use-cases");
  f.dirty = true;
  f.rawHash("#project-B/overview");
  expect(f.cursor).toBe(1);
  expect(f.entries.map((e) => e.hash)).toEqual([
    "#overview",
    "#use-cases",
    "#project-B/overview",
  ]);
  f.dirty = false;
  f.move(1);
  expect(f.navigated).toEqual(["#project-B/overview"]);
});
it("preserves entry and unrelated state during document replacements and reload", () => {
  const f = fixture();
  f.controller.push("#screens");
  f.controller.push("#use-cases");
  f.history.replaceState(
    { ...(f.history.state as object), other: "retained" },
    "",
  );
  vi.stubGlobal("history", f.history);
  const before = f.history.state;
  replaceWorkspaceHash("#use-cases?file=example.md&case=UC-021&line=120");
  expect(f.history.state).toEqual(before);
  f.controller.dispose();
  const reloaded = createWorkspaceHistory(f.callbacks, f.host);
  f.dirty = true;
  f.move(-1);
  expect(f.cursor).toBe(2);
  expect(f.host.location.hash).toContain("case=UC-021&line=120");
  f.dirty = false;
  f.move(-1);
  expect(f.navigated.at(-1)).toBe("#screens");
  reloaded.dispose();
});
it("ignores a stale discarded-prompt callback after a newer history decision", () => {
  const f = fixture();
  f.controller.push("#screens");
  f.controller.push("#use-cases");
  f.dirty = true;
  f.move(-1);
  const oldRetry = f.blocked[0];
  f.move(-2);
  oldRetry();
  f.flush();
  expect(f.cursor).toBe(2);
  expect(f.navigated).toEqual([]);
  f.blocked.at(-1)!();
  f.flush();
  expect(f.cursor).toBe(0);
});
it("removes its listener on unmount", () => {
  const f = fixture();
  f.controller.push("#screens");
  f.controller.dispose();
  f.move(-1);
  expect(f.navigated).toEqual([]);
  expect(f.blocked).toEqual([]);
});

const legacy = ["#overview", "#screens", "#use-cases?case=UC-021"].map(
  (hash) => ({ hash, state: null as unknown }),
);
it("uses the browser cursor for intact unmarked entries left by an old UI after reload", () => {
  const f = fixture({ entries: legacy, cursor: 2 });
  f.dirty = true;
  f.move(-1);
  f.move(-1);
  expect(f.cursor).toBe(2);
  expect(f.entries.map((e) => e.hash)).toEqual(legacy.map((e) => e.hash));
  expect(f.notices).toEqual([undefined, undefined]);
  expect(f.navigated).toEqual([]);
  f.dirty = false;
  f.move(-1);
  f.move(-1);
  f.move(1);
  f.move(1);
  expect(f.navigated).toEqual([
    "#screens",
    "#overview",
    "#screens",
    "#use-cases?case=UC-021",
  ]);
});
it("uses the real positive delta for unmarked old Forward entries and explicit discard", () => {
  const f = fixture({ entries: legacy, cursor: 1 });
  f.dirty = true;
  f.move(1);
  expect(f.cursor).toBe(1);
  expect(f.navigated).toEqual([]);
  f.blocked.at(-1)!();
  f.flush();
  expect(f.cursor).toBe(2);
  expect(f.navigated).toEqual(["#use-cases?case=UC-021"]);
});
it("does not trust foreign-scope indices when the browser verifies a different position", () => {
  const entries = structuredClone(legacy);
  entries[0].state = {
    "screenscribe.workspace-history": { scope: "older-UI", index: 999 },
  };
  const f = fixture({ entries, cursor: 2 });
  f.dirty = true;
  f.move(-2);
  expect(f.cursor).toBe(2);
  expect(f.moveCalls).toEqual([-2, 2]);
  f.blocked.at(-1)!();
  f.flush();
  expect(f.cursor).toBe(0);
});
it("retains ordinary tracked Back/Forward when the optional browser API is absent", () => {
  const f = fixture({ native: false });
  f.controller.push("#screens");
  f.controller.push("#use-cases");
  f.dirty = true;
  f.move(-2);
  expect(f.cursor).toBe(2);
  expect(f.notices).toEqual([undefined]);
  f.dirty = false;
  f.move(-1);
  f.move(1);
  expect(f.navigated).toEqual(["#screens", "#use-cases"]);
});
it("without a verifiable old cursor, keeps the exact draft route and offers a disclosed fallback instead of guessing go", () => {
  const f = fixture({ native: false, entries: legacy, cursor: 2 });
  vi.stubGlobal("history", f.history);
  replaceWorkspaceHash("#use-cases?case=UC-021&file=edited.md&line=120");
  f.dirty = true;
  f.move(-1);
  expect(f.cursor).toBe(2);
  expect(f.host.location.hash).toBe(
    "#use-cases?case=UC-021&file=edited.md&line=120",
  );
  expect(f.entries[1].hash).toBe("#screens");
  expect(f.moveCalls).toEqual([-1]);
  expect(f.notices[0]).toContain("Forward history may have been shortened");
  expect(f.navigated).toEqual([]);
  f.dirty = false;
  f.move(-1);
  f.move(1);
  expect(f.navigated).toEqual([
    "#screens",
    "#use-cases?case=UC-021&file=edited.md&line=120",
  ]);
});
it("the unverified-cursor fallback discards only on the user's decision and reaches the exact old target", () => {
  const f = fixture({ native: false, entries: legacy, cursor: 2 });
  f.dirty = true;
  f.move(-2);
  expect(f.host.location.hash).toBe(legacy[2].hash);
  expect(f.navigated).toEqual([]);
  f.blocked.at(-1)!();
  f.flush();
  expect(f.host.location.hash).toBe("#overview");
  expect(f.navigated).toEqual(["#overview"]);
});
it("unmarked clean traversal changes the actual route without attempting an inferred restoration", () => {
  const f = fixture({ native: false, entries: legacy, cursor: 2 });
  f.move(-1);
  f.move(-1);
  f.move(1);
  expect(f.host.location.hash).toBe("#screens");
  expect(f.navigated).toEqual(["#screens", "#overview", "#screens"]);
  expect(f.moveCalls).toEqual([-1, -1, 1]);
  expect(f.notices).toEqual([]);
});
