import fs from "node:fs/promises";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ConnectionInput, IntegrationInput } from "@shared/api";
import { removeDir, useTempDataDir } from "./testUtils";

type Settings = typeof import("./settingsStore");

const ENV_VARS = [
  "SCREENSCRIBE_V2_ANTHROPIC_API_KEY",
  "SCREENSCRIBE_V2_OPENAI_API_KEY",
  "SCREENSCRIBE_V2_GEMINI_API_KEY",
  "SCREENSCRIBE_V2_FIGMA_TOKEN",
  "SCREENSCRIBE_V2_AZURE_OPENAI_API_KEY",
];
const savedEnv = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];

/** Fresh data dir + fresh module instance (the settings cache lives in module state). */
async function freshSettings(
  env: Record<string, string> = {},
): Promise<{ settings: Settings; dataDir: string }> {
  for (const k of ENV_VARS) delete process.env[k];
  Object.assign(process.env, env);
  const dataDir = await useTempDataDir("settings");
  dirs.push(dataDir);
  vi.resetModules();
  return { settings: await import("./settingsStore"), dataDir };
}

beforeEach(() => {
  for (const k of ENV_VARS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

afterAll(async () => {
  for (const d of dirs) await removeDir(d);
});

const anthropicInput: ConnectionInput = {
  name: "My Claude",
  provider: "anthropic",
  model: "claude-opus-5-5",
  apiKey: "sk-ant-secret-1234abcd",
};

describe("security remediation at settings boundaries", () => {
  it.each([
    "https://user:synthetic-password@fixture.invalid",
    "https://fixture.invalid?api_key=synthetic-query-secret",
    "https://fixture.invalid#synthetic-fragment",
    "http://remote.invalid/v1",
  ])(
    "rejects unsafe endpoint without persisting or echoing URL secrets: %s",
    async (baseUrl) => {
      const { settings, dataDir } = await freshSettings();
      await settings.getSettings();
      const before = await fs.readFile(
        path.join(dataDir, "settings.json"),
        "utf8",
      );
      const input = { ...anthropicInput, baseUrl };
      for (const action of [
        () => settings.createConnection(input),
        () => settings.resolveConnectionInput(input),
      ]) {
        const error = await action().catch((e) => e);
        expect(error.status).toBe(400);
        expect(error.message).not.toContain("synthetic-password");
        expect(error.message).not.toContain("synthetic-query-secret");
        expect(error.message).not.toContain("synthetic-fragment");
      }
      await expect(
        settings.setIntegration({
          system: "github",
          owner: "fixture",
          repo: "fixture",
          apiBaseUrl: baseUrl,
          token: "synthetic-token-712",
          labels: [],
          useMilestonesForFeatures: true,
        }),
      ).rejects.toThrow();
      expect(
        await fs.readFile(path.join(dataDir, "settings.json"), "utf8"),
      ).toBe(before);
    },
  );
  it("does not advertise an environment key as available to a custom endpoint; legacy URL metadata is masked", async () => {
    const { settings } = await freshSettings({
      SCREENSCRIBE_V2_OPENAI_API_KEY: "synthetic-env-binding-912",
    });
    const gateway = await settings.createConnection({
      name: "Gateway",
      provider: "openai",
      model: "fixture",
      baseUrl: "https://gateway.invalid/v1",
    });
    expect(settings.toPublicConnection(gateway).hasApiKey).toBe(false);
    expect(
      settings.toPublicConnection({
        ...gateway,
        baseUrl:
          "https://user:synthetic-legacy-secret@legacy.invalid?token=synthetic-query-secret",
      }).baseUrl,
    ).toContain("invalid endpoint");
    expect(
      JSON.stringify(
        settings.toPublicConnection({
          ...gateway,
          baseUrl: "https://legacy.invalid?token=synthetic-query-secret",
        }),
      ),
    ).not.toContain("synthetic-query-secret");
  });
});

describe("first load", () => {
  it("creates the offline demo connection as default when no keys are in the environment", async () => {
    const { settings, dataDir } = await freshSettings();
    const s = await settings.getSettings();
    expect(s.connections).toHaveLength(1);
    expect(s.connections[0]).toMatchObject({
      provider: "mock",
      name: "Offline demo (no AI)",
      modelIds: ["demo"],
      structuredOutput: "auto",
      vision: "auto",
    });
    expect(s.defaultConnectionId).toBe(s.connections[0].id);
    const onDisk = JSON.parse(
      await fs.readFile(path.join(dataDir, "settings.json"), "utf8"),
    );
    expect(onDisk.connections).toHaveLength(1);
  });

  it("adds env-key connections without storing the key and makes the first real one default", async () => {
    const { settings, dataDir } = await freshSettings({
      SCREENSCRIBE_V2_OPENAI_API_KEY: "sk-openai-test-9999",
      SCREENSCRIBE_V2_ANTHROPIC_API_KEY: "sk-ant-env-key-7777",
    });
    const s = await settings.getSettings();
    expect(s.connections.map((c) => c.provider)).toEqual([
      "anthropic",
      "openai",
      "mock",
    ]);
    expect(s.connections.every((c) => c.apiKey === undefined)).toBe(true);
    expect(s.defaultConnectionId).toBe(s.connections[0].id);
    expect(s.connections[0]).toMatchObject({
      modelIds: [],
      effort: "high",
      refusalFallback: true,
      concurrency: 4,
    });
    const raw = await fs.readFile(path.join(dataDir, "settings.json"), "utf8");
    expect(raw).not.toContain("sk-ant-env-key-7777");

    const pub = await settings.getPublicSettings();
    expect(pub.connections[0]).toMatchObject({
      hasApiKey: true,
      apiKeyHint: "from SCREENSCRIBE_V2_ANTHROPIC_API_KEY",
    });
    expect(pub.connections[2].hasApiKey).toBe(false);
    expect(JSON.stringify(pub)).not.toContain("sk-");
  });

  it("backs up a corrupt settings file and starts fresh", async () => {
    const { dataDir } = await freshSettings();
    await fs.writeFile(
      path.join(dataDir, "settings.json"),
      '{ "connections": [ broken',
    );
    vi.resetModules();
    const settings = await import("./settingsStore");
    const s = await settings.getSettings();
    expect(s.connections).toHaveLength(1);
    const files = await fs.readdir(dataDir);
    expect(files.some((f) => f.startsWith("settings.json.bak-"))).toBe(true);
  });

  it("normalises an older file with missing fields", async () => {
    const { dataDir } = await freshSettings();
    await fs.writeFile(
      path.join(dataDir, "settings.json"),
      JSON.stringify({
        version: 1,
        connections: [
          { id: "conn_old", name: "Old", provider: "ollama", model: "llava" },
          { id: "conn_bad", provider: "nope" },
        ],
        integrations: {},
      }),
    );
    vi.resetModules();
    const settings = await import("./settingsStore");
    const s = await settings.getSettings();
    expect(s.connections).toHaveLength(1);
    expect(s.connections[0]).toMatchObject({
      id: "conn_old",
      concurrency: 1,
      requestTimeoutSec: 1800,
      structuredOutput: "auto",
      vision: "auto",
    });
    expect(s.defaultConnectionId).toBe("conn_old");
  });
});

describe("connections", () => {
  it("creates with preset defaults and masks the key", async () => {
    const { settings } = await freshSettings();
    const c = await settings.createConnection(anthropicInput);
    expect(c).toMatchObject({
      provider: "anthropic",
      concurrency: 4,
      requestTimeoutSec: 600,
      structuredOutput: "auto",
      vision: "auto",
      refusalFallback: true,
      effort: "high",
    });
    expect(c.id).toMatch(/^conn_/);
    expect(c.baseUrl).toBeUndefined();
    const pub = settings.toPublicConnection(c);
    expect(pub).not.toHaveProperty("apiKey");
    expect(pub).toMatchObject({ hasApiKey: true, apiKeyHint: "…abcd" });
    // The first real connection replaces the offline demo as default.
    expect((await settings.getSettings()).defaultConnectionId).toBe(c.id);
  });

  it("fills required base URLs from the preset and validates them", async () => {
    const { settings } = await freshSettings();
    const ollama = await settings.createConnection({
      name: "",
      provider: "ollama",
      model: "",
    });
    expect(ollama).toMatchObject({
      name: "Ollama (local)",
      baseUrl: "http://localhost:11434",
      modelIds: [],
      concurrency: 1,
      refusalFallback: false,
    });
    await expect(
      settings.createConnection({
        name: "Azure",
        provider: "azure-openai",
        model: "my-deployment",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      settings.createConnection({
        name: "Azure",
        provider: "azure-openai",
        model: "",
        baseUrl: "https://x.openai.azure.com",
      }),
    ).resolves.toMatchObject({ modelIds: [] });
    await expect(
      settings.createConnection({
        name: "Bad",
        provider: "openai-compatible",
        model: "m",
        baseUrl: "localhost:1234",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      settings.createConnection({ ...anthropicInput, effort: "xhigh" }),
    ).resolves.toMatchObject({ effort: "xhigh" });
    await expect(
      settings.createConnection({
        name: "o",
        provider: "openai",
        model: "gpt-5",
        effort: "max",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("keeps the stored key on update unless replaced or cleared", async () => {
    const { settings } = await freshSettings();
    const c = await settings.createConnection(anthropicInput);
    const kept = await settings.updateConnection(c.id, {
      ...anthropicInput,
      apiKey: "",
      name: "Renamed",
    });
    expect(kept).toMatchObject({
      name: "Renamed",
      apiKey: anthropicInput.apiKey,
      createdAt: c.createdAt,
    });
    const replaced = await settings.updateConnection(c.id, {
      ...anthropicInput,
      apiKey: "sk-ant-new-key-zzzz",
    });
    expect(replaced.apiKey).toBe("sk-ant-new-key-zzzz");
    const cleared = await settings.updateConnection(c.id, {
      ...anthropicInput,
      apiKey: undefined,
      clearApiKey: true,
    });
    expect(cleared.apiKey).toBeUndefined();
    // Switching provider drops a key that belongs to another vendor.
    const again = await settings.updateConnection(c.id, { ...anthropicInput });
    const switched = await settings.updateConnection(again.id, {
      name: "Now OpenAI",
      provider: "openai",
      model: "gpt-5",
    });
    expect(switched.apiKey).toBeUndefined();
    await expect(
      settings.updateConnection("conn_missing", anthropicInput),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("resolves unsaved form input, reusing the stored key of an existing connection", async () => {
    const { settings } = await freshSettings();
    const c = await settings.createConnection(anthropicInput);
    const resolved = await settings.resolveConnectionInput(
      { ...anthropicInput, apiKey: "" },
      c.id,
    );
    expect(resolved.apiKey).toBe(anthropicInput.apiKey);
    expect(resolved.id).toBe(c.id);
    const unsaved = await settings.resolveConnectionInput({
      name: "x",
      provider: "gemini",
      model: "gemini-2.5-pro",
      apiKey: "g-key-12345678",
    });
    expect(unsaved.id).toMatch(/^conn_unsaved_/);
    expect(
      (await settings.getSettings()).connections.some(
        (x) => x.id === unsaved.id,
      ),
    ).toBe(false);
  });

  it("only reuses a stored key for the base URL it was saved with", async () => {
    const { settings } = await freshSettings();
    const c = await settings.createConnection(anthropicInput);
    const capture = {
      ...anthropicInput,
      apiKey: "",
      baseUrl: "http://127.0.0.1:4409",
    };
    await expect(
      settings.resolveConnectionInput(capture, c.id),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/Re-enter the API key/),
    });
    await expect(
      settings.updateConnection(c.id, capture),
    ).rejects.toMatchObject({ status: 400 });
    expect(await settings.getConnection(c.id)).toMatchObject({
      apiKey: anthropicInput.apiKey,
    });
    expect(() =>
      settings.reusableApiKey(c, "anthropic", "http://127.0.0.1:4409"),
    ).toThrow(/Re-enter/);

    // The provider's default URL, typed out (any case, trailing slash), is the same endpoint as "no base URL".
    const sameEndpoint = await settings.resolveConnectionInput(
      { ...anthropicInput, apiKey: "", baseUrl: "https://API.anthropic.com/" },
      c.id,
    );
    expect(sameEndpoint.apiKey).toBe(anthropicInput.apiKey);
    expect(settings.reusableApiKey(c, "anthropic", undefined)).toBe(
      anthropicInput.apiKey,
    );
    // A different provider never inherits the key (no error: it belongs to another vendor).
    expect(
      settings.reusableApiKey(c, "openai", "http://127.0.0.1:4409"),
    ).toBeUndefined();

    // A new URL together with a new key is fine, and from then on the key follows that URL.
    const moved = await settings.updateConnection(c.id, {
      ...capture,
      apiKey: "sk-ant-gateway-key-1111",
    });
    expect(moved).toMatchObject({
      baseUrl: "http://127.0.0.1:4409",
      apiKey: "sk-ant-gateway-key-1111",
    });
    await expect(
      settings.resolveConnectionInput({ ...anthropicInput, apiKey: "" }, c.id),
    ).rejects.toMatchObject({ status: 400 });

    // Nothing stored, nothing to leak: a keyless local connection can change URL freely.
    const ollama = await settings.createConnection({
      name: "Local",
      provider: "ollama",
      model: "llava",
    });
    await expect(
      settings.updateConnection(ollama.id, {
        name: "Local",
        provider: "ollama",
        model: "llava",
        baseUrl: "http://gpu-box:11434",
      }),
    ).resolves.toMatchObject({ baseUrl: "http://gpu-box:11434" });
  });

  it("sets and repairs the default connection", async () => {
    const { settings } = await freshSettings();
    const mockId = (await settings.getSettings()).connections[0].id;
    const a = await settings.createConnection(anthropicInput);
    const b = await settings.createConnection({
      name: "GPT",
      provider: "openai",
      model: "gpt-5",
      apiKey: "sk-openai-abcdefgh",
    });
    expect((await settings.getSettings()).defaultConnectionId).toBe(a.id);
    await settings.setDefaultConnection(b.id);
    expect((await settings.getPublicSettings()).defaultConnectionId).toBe(b.id);
    await settings.deleteConnection(b.id);
    expect((await settings.getSettings()).defaultConnectionId).toBe(a.id);
    await settings.deleteConnection(a.id);
    expect((await settings.getSettings()).defaultConnectionId).toBe(mockId);
    await expect(
      settings.setDefaultConnection("conn_nope"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(settings.getConnection("conn_nope")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("keeps a deliberately chosen demo default when more connections are added", async () => {
    const { settings } = await freshSettings();
    const mockId = (await settings.getSettings()).connections[0].id;
    await settings.createConnection(anthropicInput);
    await settings.setDefaultConnection(mockId);
    await settings.createConnection({
      name: "GPT",
      provider: "openai",
      model: "gpt-5",
      apiKey: "sk-openai-abcdefgh",
    });
    expect((await settings.getSettings()).defaultConnectionId).toBe(mockId);
  });

  it("survives concurrent edits without losing one", async () => {
    const { settings } = await freshSettings();
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        settings.createConnection({ ...anthropicInput, name: `C${i}` }),
      ),
    );
    expect((await settings.getSettings()).connections).toHaveLength(7);
  });
});

describe("integrations", () => {
  it("stores integrations, masks secrets and keeps the secret when omitted", async () => {
    const { settings } = await freshSettings();
    await settings.setIntegration({
      system: "jira",
      baseUrl: "https://acme.atlassian.net/",
      email: "ba@acme.com",
      apiToken: "jira-token-ABCD1234",
      projectKey: "ACME",
      issueType: "Story",
      epicIssueType: "Epic",
      labels: [" spec ", "spec", ""],
      linkType: "Blocks",
      deployment: "cloud",
    });
    let stored = await settings.getIntegration("jira");
    expect(stored).toMatchObject({
      baseUrl: "https://acme.atlassian.net",
      apiToken: "jira-token-ABCD1234",
      labels: ["spec"],
    });
    expect(stored).not.toHaveProperty("system");

    const pub = await settings.getPublicSettings();
    expect(pub.integrations.jira).toMatchObject({
      apiToken: "",
      hasSecret: true,
      secretHint: "…1234",
    });
    expect(JSON.stringify(pub)).not.toContain("jira-token-ABCD1234");

    await settings.setIntegration({
      system: "jira",
      baseUrl: "https://acme.atlassian.net",
      email: "ba@acme.com",
      projectKey: "NEW",
      issueType: "Story",
      epicIssueType: "Epic",
      labels: [],
      linkType: "Blocks",
      deployment: "cloud",
    });
    stored = await settings.getIntegration("jira");
    expect(stored).toMatchObject({
      projectKey: "NEW",
      apiToken: "jira-token-ABCD1234",
    });

    const forTest = await settings.resolveIntegrationInput({
      system: "jira",
      baseUrl: "https://ACME.atlassian.net/",
      email: "",
      projectKey: "T",
      issueType: "Story",
      epicIssueType: "Epic",
      labels: [],
      linkType: "Blocks",
      deployment: "server",
    });
    expect(forTest).toMatchObject({
      projectKey: "T",
      apiToken: "jira-token-ABCD1234",
    });
    const otherSite = await settings.resolveIntegrationInput({
      system: "jira",
      baseUrl: "https://other.atlassian.net",
      email: "",
      projectKey: "T",
      apiToken: "other-token-0000",
      issueType: "Story",
      epicIssueType: "Epic",
      labels: [],
      linkType: "Blocks",
      deployment: "server",
    });
    expect(otherSite).toMatchObject({
      baseUrl: "https://other.atlassian.net",
      apiToken: "other-token-0000",
    });
    expect((await settings.getIntegration("jira"))!.baseUrl).toBe(
      "https://acme.atlassian.net",
    );

    await settings.deleteIntegration("jira");
    expect(await settings.getIntegration("jira")).toBeUndefined();
  });

  it("never sends a stored secret to a URL other than the one it was saved with", async () => {
    const { settings } = await freshSettings();
    const jira: Extract<IntegrationInput, { system: "jira" }> = {
      system: "jira",
      baseUrl: "https://acme.atlassian.net",
      email: "ba@acme.com",
      projectKey: "ACME",
      issueType: "Story",
      epicIssueType: "Epic",
      labels: [],
      linkType: "Blocks",
      deployment: "cloud",
    };
    await settings.setIntegration({ ...jira, apiToken: "jira-token-ABCD1234" });
    const capture = { ...jira, baseUrl: "http://127.0.0.1:4409" };
    await expect(
      settings.resolveIntegrationInput(capture),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/Re-enter the Jira API token/),
    });
    await expect(settings.setIntegration(capture)).rejects.toMatchObject({
      status: 400,
    });
    expect(await settings.getIntegration("jira")).toMatchObject({
      baseUrl: "https://acme.atlassian.net",
      apiToken: "jira-token-ABCD1234",
    });

    await settings.setIntegration({
      system: "azdo",
      orgUrl: "https://dev.azure.com/acme",
      project: "Portal",
      pat: "pat-abcdefgh",
      workItemType: "User Story",
      parentWorkItemType: "Feature",
      tags: [],
    });
    await expect(
      settings.resolveIntegrationInput({
        system: "azdo",
        orgUrl: "https://dev.azure.com/evil",
        project: "Portal",
        workItemType: "User Story",
        parentWorkItemType: "Feature",
        tags: [],
      }),
    ).rejects.toMatchObject({ status: 400 });

    const github: Extract<IntegrationInput, { system: "github" }> = {
      system: "github",
      owner: "acme",
      repo: "specs",
      labels: [],
      apiBaseUrl: "",
      useMilestonesForFeatures: true,
    };
    await settings.setIntegration({ ...github, token: "ghp_1234567890" });
    // "" means the default API URL, which is where the token was saved for.
    await expect(
      settings.resolveIntegrationInput({
        ...github,
        apiBaseUrl: "https://api.github.com/",
      }),
    ).resolves.toMatchObject({ token: "ghp_1234567890" });
    await expect(
      settings.resolveIntegrationInput({
        ...github,
        apiBaseUrl: "http://127.0.0.1:4409",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await settings.setIntegration({
      ...github,
      apiBaseUrl: "https://ghe.example.com/api/v3",
      token: "ghp_enterprise_99",
    });
    expect(await settings.getIntegration("github")).toMatchObject({
      apiBaseUrl: "https://ghe.example.com/api/v3",
      token: "ghp_enterprise_99",
    });
  });

  it("requires a secret on first save", async () => {
    const { settings } = await freshSettings();
    await expect(
      settings.setIntegration({
        system: "github",
        owner: "acme",
        repo: "specs",
        labels: [],
        apiBaseUrl: "",
        useMilestonesForFeatures: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await settings.setIntegration({
      system: "github",
      owner: "acme",
      repo: "specs",
      token: "ghp_1234567890",
      labels: [],
      apiBaseUrl: "",
      useMilestonesForFeatures: false,
    });
    expect(await settings.getIntegration("github")).toMatchObject({
      apiBaseUrl: "https://api.github.com",
      token: "ghp_1234567890",
    });
    await settings.setIntegration({
      system: "azdo",
      orgUrl: "https://dev.azure.com/acme",
      project: "Portal",
      pat: "pat-abcdefgh",
      workItemType: "User Story",
      parentWorkItemType: "Feature",
      areaPath: "",
      tags: ["a"],
    });
    const azdo = await settings.getIntegration("azdo");
    expect(azdo).toMatchObject({ pat: "pat-abcdefgh", tags: ["a"] });
    expect(azdo).not.toHaveProperty("areaPath");
  });
});

describe("file permissions", () => {
  it("writes settings.json owner-only (temp file created with mode 0600, then renamed)", async () => {
    const open = vi.spyOn(fs, "open");
    try {
      const { settings, dataDir } = await freshSettings();
      await settings.createConnection(anthropicInput);
      const tmpPrefix = path.join(dataDir, "settings.json.tmp-");
      const writes = open.mock.calls.filter(([file]) =>
        String(file).startsWith(tmpPrefix),
      );
      expect(writes).toHaveLength(2);
      for (const call of writes) {
        expect(call[1]).toBe("wx");
        expect(call[2]).toBe(0o600);
      }
      if (process.platform !== "win32") {
        expect(
          (await fs.stat(path.join(dataDir, "settings.json"))).mode & 0o777,
        ).toBe(0o600);
      }
    } finally {
      open.mockRestore();
    }
  });

  it("refuses unsupported native IO before changing old profile files on non-Windows", async () => {
    const { dataDir } = await freshSettings();
    const file = path.join(dataDir, "settings.json"),
      bytes = '{ "connections": [] }';
    await fs.writeFile(file, bytes, { mode: 0o644 });
    const chmod = vi.spyOn(fs, "chmod"),
      platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    try {
      vi.resetModules();
      await expect(
        (await import("./settingsStore")).getSettings(),
      ).rejects.toThrow(/Windows handle protection/);
      expect(chmod).not.toHaveBeenCalled();
      expect(await fs.readFile(file, "utf8")).toBe(bytes);
    } finally {
      Object.defineProperty(process, "platform", platform);
      chmod.mockRestore();
    }
  });
});

describe("figma token", () => {
  it("stores, masks, falls back to SCREENSCRIBE_V2_FIGMA_TOKEN and deletes", async () => {
    const { settings } = await freshSettings({
      SCREENSCRIBE_V2_FIGMA_TOKEN: "figd_env_token_0000",
    });
    expect(await settings.getFigmaToken()).toBe("figd_env_token_0000");
    expect((await settings.getPublicSettings()).figma).toEqual({
      hasToken: true,
      tokenHint: "from SCREENSCRIBE_V2_FIGMA_TOKEN",
    });
    await settings.setFigmaToken("  figd_stored_token_9876 ");
    expect(await settings.getFigmaToken()).toBe("figd_stored_token_9876");
    expect((await settings.getPublicSettings()).figma).toEqual({
      hasToken: true,
      tokenHint: "…9876",
    });
    await settings.deleteFigmaToken();
    delete process.env.SCREENSCRIBE_V2_FIGMA_TOKEN;
    expect(await settings.getFigmaToken()).toBeUndefined();
    expect((await settings.getPublicSettings()).figma).toEqual({
      hasToken: false,
    });
    await expect(settings.setFigmaToken("  ")).rejects.toMatchObject({
      status: 400,
    });
  });
});
