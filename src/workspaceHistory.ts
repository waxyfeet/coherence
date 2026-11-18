const entryKey = "screenscribe.workspace-history";
const replacements = new WeakMap<History, (hash: string) => void>();
interface Entry {
  scope: string;
  index: number;
}
type HistoryHost = Pick<
  Window,
  "history" | "location" | "addEventListener" | "removeEventListener"
> & {
  navigation?: { readonly currentEntry: { readonly index: number } | null };
};
function browserPosition(host: HistoryHost): number | null {
  try {
    const index = host.navigation?.currentEntry?.index;
    return typeof index === "number" &&
      Number.isSafeInteger(index) &&
      index >= 0
      ? index
      : null;
  } catch {
    return null;
  }
}
function entry(state: unknown): Entry | null {
  const value = (state as Record<string, unknown> | null)?.[entryKey] as
    Entry | undefined;
  return value &&
    typeof value.scope === "string" &&
    value.scope.length > 0 &&
    Number.isSafeInteger(value.index)
    ? value
    : null;
}
function stateWithEntry(state: unknown, value: Entry) {
  return {
    ...(state && typeof state === "object" ? state : {}),
    [entryKey]: value,
  };
}

/** A document/selection update changes the URL, not the browser entry's identity. */
export function replaceWorkspaceHash(hash: string) {
  history.replaceState(history.state, "", hash);
  replacements.get(history)?.(hash);
}

/**
 * Track entry positions, so blocking Back/Forward restores the actual cursor.
 * Never replace a destination URL to disguise a traversal: that destroys history.
 * Our marker contains only an opaque chain ID and relative position.
 */
export function createWorkspaceHistory(
  callbacks: {
    shouldBlock: () => boolean;
    onNavigate: (hash: string) => void;
    onBlocked: (retry: () => void, notice?: string) => void;
  },
  host: HistoryHost = window,
) {
  const { history, location } = host;
  let current = entry(history.state) ?? {
    scope: crypto.randomUUID(),
    index: 0,
  };
  history.replaceState(stateWithEntry(history.state, current), "");
  let position = browserPosition(host);
  let sourceHash = location.hash;
  let sourceState = history.state;
  const replaced = (hash: string) => {
    sourceHash = hash;
    sourceState = history.state;
  };
  replacements.set(history, replaced);
  let restoring: Entry | null = null;
  let replay: Entry | null = null;
  let revision = 0;
  const same = (a: Entry | null, b: Entry) =>
    a?.scope === b.scope && a.index === b.index;
  const offerRetry = (target: Entry, notice?: string) => {
    const blockedRevision = ++revision;
    callbacks.onBlocked(() => {
      if (revision !== blockedRevision || !same(entry(history.state), current))
        return;
      replay = target;
      history.go(target.index - current.index);
    }, notice);
  };
  const pop = () => {
    const nextPosition = browserPosition(host);
    const marked = entry(history.state);
    // The browser's real position is authoritative, even for intact older or
    // foreign-scope entries. Missing state conveys no traversal direction.
    const destination =
      position !== null && nextPosition !== null
        ? {
            scope: current.scope,
            index: current.index + nextPosition - position,
          }
        : marked?.scope === current.scope
          ? marked
          : null;
    if (!destination) {
      restoring = null;
      replay = null;
      const target = { scope: crypto.randomUUID(), index: 0 };
      history.replaceState(stateWithEntry(history.state, target), "");
      if (callbacks.shouldBlock()) {
        // No trustworthy delta: never guess another go(). Keep the destination
        // intact and add the source as a new entry so URL and draft agree.
        // This may shorten old Forward history; the prompt discloses that limit.
        current = { scope: target.scope, index: 1 };
        history.pushState(stateWithEntry(sourceState, current), "", sourceHash);
        position = browserPosition(host);
        sourceState = history.state;
        offerRetry(
          target,
          "This browser could not verify an older history position. Your draft is kept here. Forward history may have been shortened; Discard opens the requested destination.",
        );
      } else {
        current = target;
        position = nextPosition;
        sourceHash = location.hash;
        sourceState = history.state;
        revision++;
        callbacks.onNavigate(location.hash);
      }
      return;
    }
    history.replaceState(stateWithEntry(history.state, destination), "");
    if (restoring) {
      if (!same(destination, current)) {
        // Another traversal while returning must not apply a route or clear a draft.
        if (destination?.scope === current.scope)
          history.go(current.index - destination.index);
        return;
      }
      const target = restoring;
      restoring = null;
      offerRetry(target);
      return;
    }
    const approved = same(replay, destination);
    replay = null;
    if (callbacks.shouldBlock() && !approved) {
      restoring = destination;
      history.go(current.index - destination.index);
      return;
    }
    current = destination;
    position = nextPosition;
    sourceHash = location.hash;
    sourceState = history.state;
    revision++;
    callbacks.onNavigate(location.hash);
  };
  // popstate covers both history traversals and direct hash navigation, once each.
  host.addEventListener("popstate", pop);
  return {
    push(hash: string) {
      if (location.hash === hash) return;
      current = { scope: current.scope, index: current.index + 1 };
      revision++;
      history.pushState(stateWithEntry(history.state, current), "", hash);
      position = browserPosition(host);
      sourceHash = hash;
      sourceState = history.state;
    },
    dispose() {
      revision++;
      host.removeEventListener("popstate", pop);
      if (replacements.get(history) === replaced) replacements.delete(history);
    },
  };
}
