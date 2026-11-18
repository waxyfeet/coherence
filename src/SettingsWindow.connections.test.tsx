import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { isValidElement, type ComponentProps, type ReactNode } from "react";
import SettingsWindow from "./SettingsWindow";
import { AnalysisModelDefaults } from "./AnalysisModelDefaults";
import { ConnectionModels } from "./ConnectionModels";
import { Button, Confirm, Field, Menu, Picker } from "./ui";
import {
  initialSettings,
  newConnection,
  providers,
  type SettingsData,
} from "./data";

// Exercise the actual Settings callbacks, effects and state without launching a
// browser/profile. Child controls remain React elements; no provider is contacted.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  changed: false,
  effects: [] as (() => void)[],
  cleanups: [] as (() => void)[],
  keys: new Set<(event: unknown) => void>(),
}));
vi.mock("./appearance", () => ({ mountAppearance: () => () => {} }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useContext: () => true,
  useId: () => "synthetic-settings",
  useRef: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!Object.hasOwn(hooks.values, i)) hooks.values[i] = { current: initial };
    return hooks.values[i];
  },
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!Object.hasOwn(hooks.values, i))
      hooks.values[i] = typeof initial === "function" ? initial() : initial;
    return [
      hooks.values[i],
      (next: unknown) => {
        const value = typeof next === "function" ? next(hooks.values[i]) : next;
        if (!Object.is(value, hooks.values[i])) hooks.changed = true;
        hooks.values[i] = value;
      },
    ];
  },
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
    const i = hooks.cursor++;
    const old = hooks.values[i] as
      { deps?: unknown[]; cleanup?: () => void } | undefined;
    if (
      !deps ||
      !old?.deps ||
      deps.some((d, j) => !Object.is(d, old.deps?.[j]))
    ) {
      hooks.values[i] = { deps };
      hooks.effects.push(() => {
        old?.cleanup?.();
        const cleanup = effect();
        (hooks.values[i] as { cleanup?: () => void }).cleanup =
          cleanup || undefined;
        if (cleanup) hooks.cleanups.push(cleanup);
      });
    }
  },
}));
beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.changed = false;
  hooks.effects = [];
  hooks.cleanups = [];
  hooks.keys.clear();
  vi.stubGlobal("window", {
    addEventListener: (type: string, handler: (e: unknown) => void) => {
      if (type === "keydown") hooks.keys.add(handler);
    },
    removeEventListener: (type: string, handler: (e: unknown) => void) => {
      if (type === "keydown") hooks.keys.delete(handler);
    },
  });
});
afterEach(() => {
  hooks.cleanups.forEach((c) => c());
  vi.unstubAllGlobals();
});

type Props = ComponentProps<typeof SettingsWindow>;
type Node = { type: unknown; props: Record<string, unknown> };
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [
    node,
    ...nodes(node.props.children as ReactNode),
    ...nodes(node.props.actions as ReactNode),
    ...nodes(node.props.trigger as ReactNode),
  ];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return isValidElement<{ children?: ReactNode }>(node)
    ? text(node.props.children)
    : "";
}
function fixture(connections = [newConnection("mock", "offline")]): Props {
  const settings = {
    ...structuredClone(initialSettings),
    connections,
    defaultId: connections[0]?.id,
    visionId: connections[0]?.id,
    textId: connections[0]?.id,
  };
  const p: Props = {
    open: true,
    live: true,
    settings,
    notify: vi.fn(),
    onClose: vi.fn(),
    onTest: vi.fn(async () => ({ ok: true, message: "Synthetic test" })),
    onDiscover: vi.fn(async () => ({ models: [] })),
    onCapability: vi.fn(),
    onSave: vi.fn(async (value: SettingsData) => {
      p.settings = {
        ...value,
        connections: value.connections.map((c) => ({
          ...c,
          apiKey: "",
          keyPresent: c.keyPresent || !!c.apiKey,
        })),
      };
      return p.settings;
    }),
  };
  return p;
}
function view(p: Props) {
  let all: Node[] = [];
  for (let i = 0; i < 6; i++) {
    hooks.cursor = 0;
    hooks.changed = false;
    all = nodes(SettingsWindow(p));
    const effects = hooks.effects.splice(0);
    effects.forEach((e) => e());
    if (!hooks.changed) break;
    if (i === 5) throw Error("Unstable synthetic hook render");
  }
  return {
    all,
    button(label: string) {
      const n = all.find(
        (n) =>
          (n.type === Button || n.type === "button") &&
          text(n.props.children as ReactNode).trim() === label,
      );
      expect(n, `button ${label}`).toBeTruthy();
      return n!.props;
    },
    field(label: string) {
      const f = all.find((n) => n.type === Field && n.props.label === label);
      expect(f, label).toBeTruthy();
      const control = nodes(f!.props.children as ReactNode).find(
        (n) => n.type === "input" || n.type === Picker,
      );
      expect(control, label).toBeTruthy();
      return control!.props;
    },
    pills() {
      return all.filter(
        (n) =>
          n.type === "button" &&
          String(n.props.className).startsWith("connection-tab "),
      );
    },
    add(provider: string) {
      const menu = all.find(
        (n) =>
          n.type === Menu &&
          text(
            (n.props.trigger as { props: { children: ReactNode } }).props
              .children,
          ).trim() === "Add connection",
      );
      expect(menu).toBeTruthy();
      const item = (
        menu!.props.items as { label: string; onSelect: () => void }[]
      ).find(
        (i) => i.label === providers[provider as keyof typeof providers].label,
      );
      expect(item).toBeTruthy();
      item!.onSelect();
    },
  };
}
async function click(p: Record<string, unknown>) {
  expect(p.disabled).not.toBeTruthy();
  return (p.onClick as () => unknown)();
}
function edit(p: Props, label: string, value: string) {
  const field = view(p).field(label);
  if (label === "Provider") (field.onChange as (s: string) => void)(value);
  else
    (field.onChange as (e: { target: { value: string } }) => void)({
      target: { value },
    });
}
async function save(p: Props) {
  await click(view(p).button("Save connection"));
  // The click deliberately returns void; flush the onSave continuation.
  await Promise.resolve();
  await Promise.resolve();
}

it("starts with only existing saved accounts and one Connections destination; opening makes no provider request", () => {
  const p = fixture(),
    v = view(p);
  expect(v.pills()).toHaveLength(1);
  expect(text(v.pills()[0].props.children as ReactNode)).toContain("Built-in");
  expect(
    v.all.some((n) => n.type === Field && n.props.label === "Provider"),
  ).toBe(false);
  expect(
    v.all.some(
      (n) => text(n.props.children as ReactNode) === "Cloud providers",
    ),
  ).toBe(false);
  expect(p.onDiscover).not.toHaveBeenCalled();
  expect(p.onTest).not.toHaveBeenCalled();
  expect(p.onSave).not.toHaveBeenCalled();
});
it("lets an empty library choose Gemini without creating or preselecting Anthropic", () => {
  const p = fixture([]);
  expect(view(p).pills()).toHaveLength(0);
  view(p).add("gemini");
  const v = view(p);
  expect(v.field("Provider").value).toBe("gemini");
  expect(v.field("Connection name").value).toBe("Google Gemini connection");
  expect(v.pills()).toHaveLength(0);
  expect(p.settings.connections).toHaveLength(0);
  expect(p.onSave).not.toHaveBeenCalled();
});
it("updates the untouched suggested name across provider changes and preserves a custom name", () => {
  const p = fixture();
  view(p).add("anthropic");
  edit(p, "Provider", "gemini");
  expect(view(p).field("Connection name").value).toBe(
    "Google Gemini connection",
  );
  edit(p, "Provider", "openai");
  expect(view(p).field("Connection name").value).toBe("OpenAI connection");
  edit(p, "Connection name", "My company account");
  edit(p, "Provider", "gemini");
  expect(view(p).field("Connection name").value).toBe("My company account");
});
it("cancels only the new account, discards its synthetic key and retains unrelated edits", async () => {
  const p = fixture([newConnection("gemini", "saved")]);
  const original = structuredClone(p.settings);
  edit(p, "Connection name", "Saved account renamed in draft");
  view(p).add("anthropic");
  edit(p, "API key", "synthetic-not-a-real-key");
  await click(view(p).button("Cancel new connection"));
  const v = view(p);
  expect(v.pills()).toHaveLength(1);
  expect(v.field("Connection name").value).toBe(
    "Saved account renamed in draft",
  );
  expect(v.field("API key").value).toBe("");
  expect(v.button("Save all changes").disabled).toBe(false);
  expect(p.onSave).not.toHaveBeenCalled();
  expect(p.settings).toEqual(original);
});
it("adds the pill only after successful atomic save and never invokes discovery or inference automatically", async () => {
  const p = fixture();
  view(p).add("gemini");
  edit(p, "API key", "synthetic-not-a-real-key");
  expect(view(p).pills()).toHaveLength(1);
  await save(p);
  expect(view(p).pills()).toHaveLength(2);
  const added = p.settings.connections[1];
  expect(added.name).toBe("Google Gemini connection");
  expect(added.modelIds).toEqual([]);
  expect(added.keyPresent).toBe(true);
  expect(added.apiKey).toBe("");
  expect(p.onSave).toHaveBeenCalledTimes(1);
  expect(p.onDiscover).not.toHaveBeenCalled();
  expect(p.onTest).not.toHaveBeenCalled();
  expect(p.onCapability).not.toHaveBeenCalled();
});
it("retains the new draft after save failure and permits a clean cancellation", async () => {
  const p = fixture();
  p.onSave = vi.fn(async () => {
    throw Error("Synthetic save conflict; reload settings");
  });
  view(p).add("gemini");
  edit(p, "Connection name", "Unsaved Gemini");
  await save(p);
  const v = view(p);
  expect(v.pills()).toHaveLength(1);
  expect(v.field("Connection name").value).toBe("Unsaved Gemini");
  expect(
    v.all.some(
      (n) =>
        n.props.role === "alert" &&
        text(n.props.children as ReactNode).includes("Synthetic save conflict"),
    ),
  ).toBe(true);
  await click(v.button("Cancel new connection"));
  expect(view(p).pills()).toHaveLength(1);
});
it("validates a blank custom name without saving or showing a new pill", async () => {
  const p = fixture();
  view(p).add("gemini");
  edit(p, "Connection name", "");
  edit(p, "Provider", "anthropic");
  await save(p);
  expect(p.onSave).not.toHaveBeenCalled();
  expect(view(p).pills()).toHaveLength(1);
  expect(view(p).field("Connection name").value).toBe("");
  expect(
    view(p).all.find(
      (n) => n.type === Field && n.props.label === "Connection name",
    )?.props.error,
  ).toBeTruthy();
});
it("keeps pending connections out of analysis defaults and retains the draft across Settings navigation", async () => {
  const p = fixture();
  view(p).add("gemini");
  edit(p, "Connection name", "Not saved");
  await click(view(p).button("Analysis defaults"));
  const defaults = view(p).all.find((n) => n.type === AnalysisModelDefaults)!;
  expect(defaults.props.connections as unknown[]).toHaveLength(1);
  await click(view(p).button("Connections"));
  expect(view(p).field("Connection name").value).toBe("Not saved");
  expect(view(p).button("Cloud").disabled).toBe(true);
  expect(
    view(p)
      .pills()
      .every((n) => n.props.disabled),
  ).toBe(true);
});
it("preserves existing draft protections when closing or discarding a new connection", async () => {
  const p = fixture();
  const original = structuredClone(p.settings);
  view(p).add("gemini");
  await click(view(p).button("Cancel"));
  const confirm = view(p).all.find((n) => n.type === Confirm)!;
  expect(confirm.props.open).toBe(true);
  expect(p.onClose).not.toHaveBeenCalled();
  (confirm.props.onCancel as () => void)();
  expect(view(p).field("Provider").value).toBe("gemini");
  await click(view(p).button("Cancel"));
  (
    view(p).all.find((n) => n.type === Confirm)!.props.onDiscard as () => void
  )();
  expect(p.onSave).not.toHaveBeenCalled();
  expect(p.onClose).toHaveBeenCalledOnce();
  expect(p.settings).toEqual(original);
});
it("filters saved cloud/local accounts with no stale editor in an empty filter and retains edits", async () => {
  const p = fixture([
    newConnection("gemini", "cloud"),
    newConnection("lmstudio", "local"),
  ]);
  edit(p, "Connection name", "My Gemini draft");
  await click(view(p).button("Local"));
  expect(view(p).pills()).toHaveLength(1);
  expect(view(p).field("Provider").value).toBe("lmstudio");
  await click(view(p).button("Cloud"));
  expect(view(p).field("Connection name").value).toBe("My Gemini draft");
  expect(p.onSave).not.toHaveBeenCalled();
});
it.each(["cloud", "local"])(
  "keeps the former %s initial destination as a filter alias",
  (initialCategory) => {
    const p = fixture([
      newConnection("gemini", "cloud"),
      newConnection("lmstudio", "local"),
    ]);
    p.initialCategory = initialCategory;
    const v = view(p);
    expect(v.pills()).toHaveLength(1);
    expect(v.field("Provider").value).toBe(
      initialCategory === "cloud" ? "gemini" : "lmstudio",
    );
    expect(v.button("Connections")["aria-current"]).toBe("page");
  },
);
it("does not show the last connection's form when the selected filter is empty", async () => {
  const p = fixture();
  await click(view(p).button("Cloud"));
  expect(view(p).pills()).toHaveLength(0);
  expect(
    view(p).all.some((n) => n.type === Field && n.props.label === "Provider"),
  ).toBe(false);
  view(p).add("gemini");
  expect(view(p).field("Provider").value).toBe("gemini");
});
it("preserves custom saved names and invalidates credentials, models and evidence on a provider change", async () => {
  const c = {
    ...newConnection("anthropic", "saved"),
    name: "My chosen name",
    apiKey: "synthetic-not-a-real-key",
    keyPresent: true,
    modelIds: ["old-model"],
    visibleModelIds: ["old-model"],
    manualModelIds: ["old-model"],
  };
  const p = fixture([c]);
  edit(p, "Provider", "gemini");
  await click(view(p).button("Save all changes"));
  await Promise.resolve();
  await Promise.resolve();
  const saved = p.settings.connections[0];
  expect(saved.name).toBe("My chosen name");
  expect(saved.provider).toBe("gemini");
  expect(saved.endpoint).toBe(providers.gemini.endpoint);
  expect(saved.apiKey).toBe("");
  expect(saved.keyPresent).toBe(false);
  expect(saved.modelIds).toEqual([]);
  expect(saved.visibleModelIds).toEqual([]);
  expect(saved.manualModelIds).toEqual([]);
  expect(saved.capabilities).toBeUndefined();
  expect(saved.catalogue).toBeUndefined();
});
it("duplicates as a separate new draft without copying the saved secret", async () => {
  const p = fixture([
    { ...newConnection("gemini", "saved"), name: "Company", keyPresent: true },
  ]);
  const menu = view(p).all.find(
    (n) =>
      n.type === Menu &&
      (n.props.items as { label: string }[]).some(
        (i) => i.label === "Duplicate connection",
      ),
  )!;
  (menu.props.items as { label: string; onSelect: () => void }[])
    .find((i) => i.label === "Duplicate connection")!
    .onSelect();
  expect(view(p).pills()).toHaveLength(1);
  expect(view(p).field("API key").value).toBe("");
  edit(p, "Provider", "openai");
  expect(view(p).field("Connection name").value).toBe("Company copy");
  await save(p);
  expect(p.settings.connections).toHaveLength(2);
  expect(p.settings.connections[1].keyPresent).toBe(false);
});
it("keeps the new connection private while a save is in flight and blocks cancellation until completion", async () => {
  const p = fixture();
  let finish!: (value: SettingsData) => void;
  p.onSave = vi.fn(
    (value) =>
      new Promise<SettingsData>((resolve) => {
        finish = () => {
          p.settings = value;
          resolve(value);
        };
      }),
  );
  view(p).add("gemini");
  await click(view(p).button("Save connection"));
  expect(view(p).pills()).toHaveLength(1);
  expect(view(p).button("Cancel new connection").disabled).toBe(true);
  finish(p.settings);
  await Promise.resolve();
  await Promise.resolve();
  expect(view(p).pills()).toHaveLength(2);
});
it("saves a new connection through the existing Ctrl+S handler", async () => {
  const p = fixture();
  view(p).add("gemini");
  view(p);
  const preventDefault = vi.fn();
  hooks.keys.forEach((handler) =>
    handler({ ctrlKey: true, key: "s", preventDefault }),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(p.onSave).toHaveBeenCalledOnce();
  expect(view(p).pills()).toHaveLength(2);
});
it("preserves legacy read-only Offline tuning while saving a new connection", async () => {
  const p = fixture([
    {
      ...newConnection("mock", "offline"),
      maxTokens: 5,
      timeout: 1,
      concurrency: 0,
    },
  ]);
  const legacy = structuredClone(p.settings.connections[0]);
  view(p).add("gemini");
  await save(p);
  expect(p.onSave).toHaveBeenCalledOnce();
  expect(p.settings.connections[0]).toEqual(legacy);
});
it("keeps a pending manual model entry visible and blocks save until it is added or cleared", async () => {
  const p = fixture();
  view(p).add("gemini");
  const models = view(p).all.find((n) => n.type === ConnectionModels)!;
  (models.props.onEntry as (s: string) => void)("synthetic-model");
  await save(p);
  expect(p.onSave).not.toHaveBeenCalled();
  expect(view(p).pills()).toHaveLength(1);
  expect(
    view(p).all.find((n) => n.type === ConnectionModels)!.props.entry,
  ).toBe("synthetic-model");
});

it("clears a pending model and invalidates old catalogue/capability data when choosing another provider", () => {
  const p = fixture();
  view(p).add("anthropic");
  const models = view(p).all.find((n) => n.type === ConnectionModels)!;
  (models.props.onEntry as (s: string) => void)("old-provider-model");
  edit(p, "Provider", "gemini");
  expect(
    view(p).all.find((n) => n.type === ConnectionModels)!.props.entry,
  ).toBe("");
  expect(view(p).field("Connection name").value).toBe(
    "Google Gemini connection",
  );
});

it("does not label metadata-only updates as unsaved configuration", () => {
  const p = fixture([newConnection("gemini", "saved")]);
  const models = view(p).all.find((n) => n.type === ConnectionModels)!;
  (models.props.onChange as (value: unknown) => void)({
    catalogue: {
      models: [{ id: "synthetic-model" }],
      source: "gemini",
      refreshedAt: "2026-11-01T00:00:00.000Z",
      complete: true,
    },
  });
  const v = view(p);
  expect(text(v.pills()[0].props.children as ReactNode)).not.toContain(
    "Unsaved changes",
  );
  expect(v.button("Save all changes").disabled).toBe(true);
});

it("reopens on the saved connection without resurrecting a cancelled draft", async () => {
  const p = fixture([newConnection("gemini", "saved")]);
  view(p).add("anthropic");
  await click(view(p).button("Cancel new connection"));
  p.open = false;
  view(p);
  p.open = true;
  expect(view(p).field("Provider").value).toBe("gemini");
  expect(view(p).pills()).toHaveLength(1);
  expect(p.onSave).not.toHaveBeenCalled();
});

// Owner test note 3: a key must never disappear without a word.
const gateway = (extra: Partial<ReturnType<typeof newConnection>> = {}) => ({
  ...newConnection("compatible", "gateway"),
  name: "Gateway",
  endpoint: "https://gateway.example/v1",
  modelIds: ["vendor/model"],
  ...extra,
});
async function saveAll(p: Props) {
  await click(view(p).button("Save all changes"));
  await Promise.resolve();
  await Promise.resolve();
}
const keyField = (p: Props) =>
  view(p).all.find((n) => n.type === Field && n.props.label === "API key")!
    .props as { error?: string; hint?: ReactNode };

it("keeps a typed key when the address changes, and through Reset tuning", () => {
  const p = fixture([gateway()]);
  edit(p, "API key", "sk-synthetic-typed");
  edit(p, "Endpoint URL", "https://openrouter.example/api/v1");
  expect(view(p).field("API key").value).toBe("sk-synthetic-typed");
  click(view(p).button("Reset tuning"));
  expect(view(p).field("API key").value).toBe("sk-synthetic-typed");
});

it("asks for a saved key again when the address changes, and blocks the save the server would refuse", async () => {
  const p = fixture([gateway({ keyPresent: true })]);
  expect(keyField(p).error).toBeUndefined();
  edit(p, "Endpoint URL", "https://other.example/v1");
  expect(keyField(p).error).toMatch(
    /only sent to https:\/\/gateway\.example\/v1\. Enter the key again/,
  );
  await click(view(p).button("Save all changes"));
  await Promise.resolve();
  expect(p.onSave).not.toHaveBeenCalled();
  expect(keyField(p).error).toMatch(/Enter the API key again/);
  // Back to the saved address, the saved key applies again.
  edit(p, "Endpoint URL", "https://gateway.example/v1");
  expect(keyField(p).error).toBeUndefined();
  // Or a new key for the new address.
  edit(p, "Endpoint URL", "https://other.example/v1");
  edit(p, "API key", "sk-synthetic-new");
  await saveAll(p);
  expect(p.onSave).toHaveBeenCalledTimes(1);
});

it("warns about an online connection without a key, in the form and when saving", async () => {
  const p = fixture([gateway()]);
  expect(String(keyField(p).hint)).toMatch(/^No API key saved/);
  edit(p, "Connection name", "Gateway two");
  await saveAll(p);
  expect(p.notify).toHaveBeenCalledWith(
    expect.stringMatching(/Gateway two has no API key/),
  );
});

it("does not ask for a key for a server on this computer", async () => {
  const p = fixture([gateway({ endpoint: "http://localhost:1234/v1" })]);
  edit(p, "Connection name", "Local server");
  await saveAll(p);
  expect(p.notify).toHaveBeenCalledWith(
    "Settings saved to the Coherence data folder. Secrets are protected by Windows.",
  );
});

// Owner test note 2: the smarter OpenAI-compatible connection (tester build WP7).
const endpointField = (p: Props) =>
  view(p).all.find((n) => n.type === Field && n.props.label === "Endpoint URL")!
    .props as { error?: string; hint?: ReactNode };

it("starts a new OpenAI-compatible connection without a local address, and offers recognised ones", () => {
  const p = fixture();
  view(p).add("compatible");
  expect(view(p).field("Endpoint URL").value).toBe("");
  click(view(p).button("OpenRouter"));
  expect(view(p).field("Endpoint URL").value).toBe(
    "https://openrouter.ai/api/v1",
  );
  expect(String(endpointField(p).hint)).toContain(
    "Recognised address: OpenRouter. Recognised is not verified",
  );
  click(view(p).button("A server on this computer"));
  expect(view(p).field("Endpoint URL").value).toBe("http://localhost:1234/v1");
});

it("tidies a pasted address when the field loses focus, and says what changed", () => {
  const p = fixture([gateway({ endpoint: "" })]);
  edit(p, "Endpoint URL", "openrouter.ai/api/v1/chat/completions");
  (view(p).field("Endpoint URL").onBlur as () => void)();
  expect(view(p).field("Endpoint URL").value).toBe(
    "https://openrouter.ai/api/v1",
  );
  expect(String(endpointField(p).hint)).toContain(
    "Coherence added https://, removed /chat/completions.",
  );
});

it("asks for an address before saving a new OpenAI-compatible connection", async () => {
  const p = fixture();
  view(p).add("compatible");
  await click(view(p).button("Save connection"));
  await Promise.resolve();
  expect(p.onSave).not.toHaveBeenCalled();
  expect(endpointField(p).error).toBe(
    "Enter the service's API address, or choose one below.",
  );
});

it("uses the address where Find models found the API, keeping the models found", async () => {
  const p = fixture([
    gateway({ endpoint: "https://gateway.example", apiKey: "sk-typed" }),
  ]);
  const catalogue = {
    models: [{ id: "vendor/model" }],
    source: "compatible" as const,
    refreshedAt: "2026-11-03T00:00:00.000Z",
    complete: true,
  };
  p.onDiscover = vi.fn(async () => ({
    models: catalogue.models,
    catalogue,
    baseUrl: "https://gateway.example/v1",
  }));
  const models = view(p).all.find((n) => n.type === ConnectionModels)!;
  await (models.props.onFind as () => Promise<unknown>)();
  expect(view(p).field("Endpoint URL").value).toBe(
    "https://gateway.example/v1",
  );
  expect(p.notify).toHaveBeenCalledWith(
    "Found the service's API at https://gateway.example/v1, and used that address.",
  );
  const after = view(p).all.find((n) => n.type === ConnectionModels)!;
  expect(
    (after.props.connection as { catalogue?: typeof catalogue }).catalogue,
  ).toEqual(catalogue);
  // The typed key stays with the connection.
  expect(view(p).field("API key").value).toBe("sk-typed");
});

// Owner test notes 1 and 6: removing a connection says what it affects and saves at once (tester build WP8).
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const removalDialog = (p: Props) =>
  view(p).all.find((n) => n.type === Confirm && n.props.open === true)!
    .props as {
    description: string;
    saveLabel?: string;
    discardLabel?: string;
    onSave?: () => void;
    onDiscard: () => void;
  };
function twoGateways() {
  const a = {
    ...gateway({ keyPresent: true, modelIds: ["m1"] }),
    id: "connection-a",
    name: "Gateway A",
  };
  const b = {
    ...gateway({ keyPresent: true, modelIds: ["m1"] }),
    id: "connection-b",
    name: "Gateway B",
  };
  const p = fixture([a, b, newConnection("mock", "offline")]);
  p.settings.analysisDefaults = {
    visionConnectionId: a.id,
    visionModelId: "m1",
    textConnectionId: a.id,
    textModelId: "m1",
  };
  p.onConnectionUsage = vi.fn(async () => ({
    readingDefault: true,
    writingDefault: true,
    projects: [{ id: "p1", name: "Acme", roles: ["reading" as const] }],
    modelIds: ["m1"],
  }));
  p.onReassign = vi.fn(async () => ({ moved: 1, kept: 0 }));
  return { p, a, b };
}

it("removes a connection nothing uses after one confirmation, saved at once", async () => {
  const p = fixture([
    gateway({ keyPresent: true }),
    newConnection("mock", "offline"),
  ]);
  p.onConnectionUsage = vi.fn(async () => ({
    readingDefault: false,
    writingDefault: false,
    projects: [],
    modelIds: [],
  }));
  await click(view(p).button("Remove"));
  await settle();
  const dialog = removalDialog(p);
  expect(dialog.description).toContain("Any key saved for it is deleted");
  expect(dialog.description).toContain("Nothing uses it.");
  expect(dialog.onSave).toBeUndefined();
  dialog.onDiscard();
  await settle();
  expect(p.onSave).toHaveBeenCalledTimes(1);
  expect(p.settings.connections.map((c) => c.provider)).toEqual(["mock"]);
  expect(p.notify).toHaveBeenCalledWith(
    expect.stringMatching(/^Removed Gateway and its saved key\./),
  );
});

it("offers to move what uses it to a connection with the same models", async () => {
  const { p, a, b } = twoGateways();
  await click(view(p).button("Remove"));
  await settle();
  const dialog = removalDialog(p);
  expect(dialog.description).toContain(
    "It is used by the Read screens default, the Write use cases default and 1 project (Acme).",
  );
  expect(dialog.saveLabel).toBe("Move them to Gateway B and remove");
  dialog.onSave!();
  await settle();
  expect(p.settings.connections.map((c) => c.id)).not.toContain(a.id);
  expect(p.settings.analysisDefaults).toEqual({
    visionConnectionId: b.id,
    visionModelId: "m1",
    textConnectionId: b.id,
    textModelId: "m1",
  });
  expect(p.onReassign).toHaveBeenCalledWith(a.id, b.id);
  expect(p.notify).toHaveBeenLastCalledWith(
    expect.stringContaining("Moved 1 project to Gateway B."),
  );
});

it("puts the defaults on the Offline demo when the BA chooses later, and says so", async () => {
  const { p } = twoGateways();
  await click(view(p).button("Remove"));
  await settle();
  removalDialog(p).onDiscard();
  await settle();
  const offline = p.settings.connections.find((c) => c.provider === "mock")!;
  expect(p.settings.analysisDefaults).toEqual({
    visionConnectionId: offline.id,
    visionModelId: "demo",
    textConnectionId: offline.id,
    textModelId: "demo",
  });
  expect(p.onReassign).not.toHaveBeenCalled();
  const last = String((p.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1));
  expect(last).toContain("default are now the Offline demo");
  expect(last).toContain("1 project need another connection");
});
