import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMConnection, ProviderKind } from "@shared/types";
import {
  instantiateProvider,
  listModelsFor,
  testConnection,
} from "../llm/registry";
import { resolveApiKey } from "../llm/providers/common";
import {
  mayUseEnvironmentKey,
  publicEndpoint,
  validateEndpoint,
} from "./endpointPolicy";
import { requestJson } from "../export/http";

const key = "synthetic-credential-never-real-3901";
const connection = (
  provider: ProviderKind,
  baseUrl?: string,
  apiKey?: string,
): LLMConnection => ({
  id: "security-fixture",
  name: "Synthetic fixture",
  provider,
  model: "fixture",
  baseUrl,
  apiKey,
  vision: "yes",
  structuredOutput: "native",
  requestTimeoutSec: 5,
  concurrency: 1,
  refusalFallback: false,
  createdAt: "",
  updatedAt: "",
});
const servers: http.Server[] = [];
async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("S01 ambient credential destination binding", () => {
  it.each([
    ["openai", "SCREENSCRIBE_V2_OPENAI_API_KEY", "https://api.openai.com/v1"],
    [
      "anthropic",
      "SCREENSCRIBE_V2_ANTHROPIC_API_KEY",
      "https://api.anthropic.com",
    ],
    [
      "gemini",
      "SCREENSCRIBE_V2_GEMINI_API_KEY",
      "https://generativelanguage.googleapis.com",
    ],
  ] as const)(
    "binds %s credentials to the exact approved endpoint",
    (provider, variable, approved) => {
      vi.stubEnv(variable, key);
      expect(resolveApiKey(connection(provider))).toBe(key);
      expect(resolveApiKey(connection(provider, approved + "/"))).toBe(key);
      for (const endpoint of [
        "https://unintended.invalid/v1",
        approved + ".unintended.invalid",
        approved + "/proxy",
        "http://127.0.0.1:4511",
      ]) {
        expect(resolveApiKey(connection(provider, endpoint))).toBeUndefined();
      }
      expect(
        resolveApiKey(
          connection(provider, "https://explicit-gateway.invalid/v1", key),
        ),
      ).toBe(key);
    },
  );
  it("requires an explicit matching Azure resource for environment credentials", () => {
    vi.stubEnv("SCREENSCRIBE_V2_AZURE_OPENAI_API_KEY", key);
    const first = connection("azure-openai", "https://first.openai.azure.com");
    expect(resolveApiKey(first)).toBeUndefined();
    vi.stubEnv("SCREENSCRIBE_V2_AZURE_OPENAI_ENDPOINT", first.baseUrl!);
    expect(resolveApiKey(first)).toBe(key);
    expect(
      resolveApiKey(
        connection("azure-openai", "https://second.openai.azure.com"),
      ),
    ).toBeUndefined();
    expect(
      resolveApiKey(
        connection("azure-openai", "https://second.openai.azure.com", key),
      ),
    ).toBe(key);
  });
  it.each(["openai", "openai-compatible", "anthropic", "gemini"] as const)(
    "retains explicit BYOK model discovery at the intended %s gateway",
    async (provider) => {
      let supplied: string | undefined;
      const url = await serve((req, res) => {
        supplied = String(
          req.headers.authorization ??
            req.headers["x-api-key"] ??
            req.headers["x-goog-api-key"] ??
            "",
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            provider === "gemini"
              ? { models: [] }
              : { data: [], has_more: false },
          ),
        );
      });
      expect(
        await instantiateProvider(connection(provider, url, key)).listModels(),
      ).toEqual([]);
      expect(supplied).toContain(key);
    },
  );
  it.each(["openai", "anthropic", "gemini"] as const)(
    "test, discovery and generation cannot send the ambient %s key to a gateway",
    async (provider) => {
      vi.stubEnv(`SCREENSCRIBE_V2_${provider.toUpperCase()}_API_KEY`, key);
      let requests = 0;
      const url = await serve((_req, res) => {
        requests++;
        res.end("{}");
      });
      const c = connection(provider, url);
      expect((await testConnection(c)).ok).toBe(false);
      expect((await listModelsFor({ provider, baseUrl: url })).models).toEqual(
        [],
      );
      await expect(
        instantiateProvider(c).complete({
          system: "Synthetic test",
          messages: [],
          purpose: "security-fixture",
        }),
      ).rejects.toThrow(/API key/);
      expect(requests).toBe(0);
    },
  );
});

describe("SDK ambient environment isolation", () => {
  it.each(["openai", "anthropic", "gemini"] as const)(
    "ignores unscoped SDK tokens, headers, debug logging and alternate routes for %s",
    async (provider) => {
      const ambient = "synthetic-ambient-token-must-never-leave";
      vi.stubEnv("ANTHROPIC_AUTH_TOKEN", ambient);
      vi.stubEnv(
        "ANTHROPIC_CUSTOM_HEADERS",
        `X-Unintended-Key: ${ambient}\nAuthorization: Bearer ${ambient}`,
      );
      vi.stubEnv(
        "OPENAI_CUSTOM_HEADERS",
        `X-Unintended-Key: ${ambient}\nAuthorization: Bearer ${ambient}`,
      );
      vi.stubEnv("ANTHROPIC_LOG", "debug");
      vi.stubEnv("OPENAI_LOG", "debug");
      vi.stubEnv("GOOGLE_GENAI_USE_VERTEXAI", "true");
      vi.stubEnv("GOOGLE_GEMINI_BASE_URL", "https://unintended.invalid");
      let headers: http.IncomingHttpHeaders | undefined;
      const url = await serve((req, res) => {
        headers = req.headers;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            provider === "gemini"
              ? { models: [] }
              : { data: [], has_more: false },
          ),
        );
      });
      await instantiateProvider(connection(provider, url, key)).listModels();
      expect(JSON.stringify(headers)).toContain(key);
      expect(JSON.stringify(headers)).not.toContain(ambient);
      expect(headers).not.toHaveProperty("x-unintended-key");
    },
  );
});

describe("S03/S04 transport and URL metadata", () => {
  it.each([
    "https://user:password@host.invalid/v1",
    "https://host.invalid/v1?api_key=secret",
    "https://host.invalid/v1?access_token=secret",
    "https://host.invalid/v1#secret",
    "https://host.invalid/v1?ordinary=parameter",
    "file:///private",
    "http://remote.invalid/v1",
    "http://10.attacker.invalid/v1",
    "http://192.168.1.4:11434",
  ])("rejects unsafe configured endpoint %s without echoing it", (value) => {
    expect(() => validateEndpoint(value, { credentialed: true })).toThrow();
    expect(publicEndpoint(value)).not.toContain("secret");
  });
  it("retains deliberate loopback and uncredentialed LAN model endpoints and secure compatible gateways", () => {
    for (const url of [
      "http://localhost:11434",
      "http://127.0.0.1:1234/v1",
      "http://[::1]:11434",
      "http://gpu-box:11434",
      "http://192.168.1.40:11434",
    ])
      expect(() => validateEndpoint(url, { localModel: true })).not.toThrow();
    expect(() =>
      validateEndpoint("http://gpu-box:11434", {
        localModel: true,
        credentialed: true,
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      instantiateProvider(
        connection("openai-compatible", "https://gateway.invalid/v1", key),
      ),
    ).not.toThrow();
    expect(
      mayUseEnvironmentKey(
        connection("openai-compatible", "https://api.openai.com/v1"),
      ),
    ).toBe(false);
  });
  it.each([
    "openai",
    "azure-openai",
    "openai-compatible",
    "anthropic",
    "gemini",
    "ollama",
  ] as const)(
    "%s refuses redirects before contacting a second origin",
    async (provider) => {
      let received = 0,
        redirected = 0;
      const target = await serve((_req, res) => {
        redirected++;
        res.end("{}");
      });
      const url = await serve((req, res) => {
        received++;
        req.resume();
        res.writeHead(307, { Location: target });
        res.end();
      });
      const c = connection(provider, url, key);
      await expect(
        instantiateProvider(c).complete({
          system: "Synthetic prompt",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Synthetic project" }],
            },
          ],
          purpose: "redirect-fixture",
          maxOutputTokens: 16,
        }),
      ).rejects.toThrow();
      expect(received).toBeGreaterThan(0);
      expect(redirected).toBe(0);
    },
  );
  it("tracker requests also refuse redirects", async () => {
    let redirected = 0;
    const target = await serve((_req, res) => {
      redirected++;
      res.end("{}");
    });
    const url = await serve((_req, res) => {
      res.writeHead(302, { Location: target });
      res.end();
    });
    await expect(
      requestJson({ label: "Fixture", extractMessage: () => "" }, url, {
        headers: { Authorization: `Bearer ${key}` },
        retries: 0,
      }),
    ).rejects.toThrow();
    expect(redirected).toBe(0);
  });
});
