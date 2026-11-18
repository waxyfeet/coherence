import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDataDir, removeDir } from "../storage/testUtils";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await removeDir(dir);
});
async function fixture(protectedFile = false) {
  const dir = await useTempDataDir("legacy-security");
  dirs.push(dir);
  vi.resetModules();
  for (const name of ["OPENAI", "ANTHROPIC", "GEMINI"])
    vi.stubEnv(`SCREENSCRIBE_V2_${name}_API_KEY`, "");
  const protection = await import("../storage/protectedSecrets");
  const url =
    "https://synthetic-user:synthetic-url-password@gateway.invalid/v1?token=synthetic-query-credential#synthetic-fragment";
  const settings = {
    version: 1,
    defaultConnectionId: "existing-local",
    connections: [
      {
        id: "existing-local",
        provider: "ollama",
        name: "Local",
        model: "fixture",
        baseUrl: "http://127.0.0.1:11434",
      },
      {
        id: "existing-cloud",
        provider: "openai",
        name: "Gateway",
        model: "fixture",
        baseUrl: url,
        apiKey: "synthetic-named-key-preserved",
      },
    ],
    integrations: {
      github: { apiBaseUrl: url, token: "synthetic-github-key" },
    },
  };
  await fs.writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify(
      protectedFile ? await protection.protectSettings(settings) : settings,
    ),
  );
  return {
    dir,
    file: path.join(dir, "settings.json"),
    settings,
    url,
    protection,
    store: await import("../storage/settingsStore"),
  };
}
describe("S04 legacy endpoint recovery", () => {
  it("preserves non-UTF8 damaged backup bytes under DPAPI rather than rewriting a decoded approximation", async () => {
    const f = await fixture();
    const original = Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x3f, 0x80]);
    const file = path.join(f.dir, "settings.json.bak-encoding");
    await fs.writeFile(file, original);
    await f.store.getSettings();
    const recovery = await f.protection.unprotectSettings(
      JSON.parse(await fs.readFile(file, "utf8")),
    );
    expect(Buffer.from(recovery.token, "base64")).toEqual(original);
  });
  it("does not serialize unknown legacy credential/response fields into public connection metadata", async () => {
    const f = await fixture();
    const connection = {
      ...(await f.store.getSettings()).connections[0],
      token: "synthetic-extra-secret",
      headers: { Authorization: "synthetic-header-secret" },
      response: "synthetic-response-echo",
    };
    const safe = JSON.stringify(f.store.toPublicConnection(connection));
    for (const marker of [
      "synthetic-extra-secret",
      "synthetic-header-secret",
      "synthetic-response-echo",
    ])
      expect(safe).not.toContain(marker);
    expect(JSON.parse(safe).provider).toBe("ollama");
  });
  it.each([false, true])(
    "protects URL secrets before disabling unsafe endpoints (protected=%s)",
    async (protectedFile) => {
      const f = await fixture(protectedFile);
      const saved = await f.store.getSettings();
      expect(saved.defaultConnectionId).toBe("existing-local");
      expect(saved.connections[0].baseUrl).toBe("http://127.0.0.1:11434");
      expect(saved.connections[1]).toMatchObject({
        id: "existing-cloud",
        provider: "openai",
        model: "fixture",
        apiKey: "synthetic-named-key-preserved",
      });
      expect(saved.connections[1].baseUrl).toContain("re-enter in Settings");
      const publicValue = JSON.stringify(await f.store.getPublicSettings());
      const disk = await fs.readFile(f.file, "utf8");
      const recoveryText = await fs.readFile(
        path.join(f.dir, "settings-url-recovery.json"),
        "utf8",
      );
      for (const marker of [
        "synthetic-url-password",
        "synthetic-query-credential",
        "synthetic-fragment",
        "synthetic-named-key-preserved",
        "synthetic-github-key",
      ]) {
        expect(disk).not.toContain(marker);
        expect(publicValue).not.toContain(marker);
        expect(recoveryText).not.toContain(marker);
      }
      const recovery = await f.protection.unprotectSettings(
        JSON.parse(recoveryText),
      );
      expect(recovery.entries).toHaveLength(2);
      expect(recovery.entries[0].token).toBe(f.url);
      const { instantiateProvider } = await import("../llm/registry");
      expect(() =>
        instantiateProvider({
          ...saved.connections[1],
          model: "synthetic-endpoint-validation",
        }),
      ).toThrow();
      vi.resetModules();
      await (await import("../storage/settingsStore")).getSettings();
      expect(
        await fs.readFile(
          path.join(f.dir, "settings-url-recovery.json"),
          "utf8",
        ),
      ).toBe(recoveryText);
    },
  );
  it("encrypts both JSON and malformed legacy backups without losing their original bytes", async () => {
    const f = await fixture();
    const text = '{"broken":"synthetic-retired-secret"';
    for (const [name, original] of [
      ["settings.json.bak-2026-10-01", JSON.stringify(f.settings)],
      ["settings.json.bak-damaged", text],
    ]) {
      await fs.writeFile(path.join(f.dir, name), original);
    }
    await f.store.getSettings();
    for (const [name, original] of [
      ["settings.json.bak-2026-10-01", JSON.stringify(f.settings)],
      ["settings.json.bak-damaged", text],
    ]) {
      const bytes = await fs.readFile(path.join(f.dir, name), "utf8");
      expect(bytes).not.toContain("synthetic-");
      const recovery = await f.protection.unprotectSettings(JSON.parse(bytes));
      expect(recovery.encoding).toBe("base64");
      expect(Buffer.from(recovery.token, "base64").toString("utf8")).toBe(
        original,
      );
    }
  });
  it("fails closed if credential protection fails; valid settings cannot be reset or re-routed", async () => {
    const f = await fixture();
    const before = await fs.readFile(f.file, "utf8");
    vi.spyOn(f.protection, "protectSettings").mockRejectedValue(
      new Error("Synthetic protection failure"),
    );
    await expect(f.store.getPublicSettings()).rejects.toThrow(
      /protection failure/,
    );
    expect(await fs.readFile(f.file, "utf8")).toBe(before);
    expect(await fs.readdir(f.dir)).toEqual(["settings.json"]);
  });
  it("retains valid settings if the atomic replacement fails after protected preservation", async () => {
    const f = await fixture();
    const before = await fs.readFile(f.file, "utf8");
    const utils = await import("../storage/fsUtils");
    const write = utils.writeJsonAtomic;
    vi.spyOn(utils, "writeJsonAtomic").mockImplementation(
      async (file, value, mode) => {
        if (file === f.file) throw new Error("Synthetic write failure");
        return write(file, value, mode);
      },
    );
    await expect(f.store.getPublicSettings()).rejects.toThrow(/write failure/);
    expect(await fs.readFile(f.file, "utf8")).toBe(before);
    expect(
      await fs.readFile(path.join(f.dir, "settings-url-recovery.json"), "utf8"),
    ).not.toContain("synthetic-url-password");
  });
});
