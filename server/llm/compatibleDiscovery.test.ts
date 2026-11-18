/**
 * Owner test notes 2 and 3 (tester build WP7): finding models on an OpenAI-compatible service. Synthetic loopback
 * servers and a stubbed fetch only; no model is ever run.
 */
import http from "node:http";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { ProviderConnection } from "@shared/types";
import { removeDir, useTempDataDir } from "../storage/testUtils";

let dir: string, base: string, server: http.Server;
let handler: (url: URL, res: http.ServerResponse) => void;
const paths: string[] = [];
let registry: typeof import("./registry"),
  catalogue: typeof import("./catalogue");
const key = "synthetic-compatible-discovery-key";
const json = (res: http.ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const models = { object: "list", data: [{ id: "vendor/model-a" }] };

beforeAll(async () => {
  dir = await useTempDataDir("compatible-discovery");
  vi.resetModules();
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    paths.push(url.pathname);
    handler(url, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  registry = await import("./registry");
  catalogue = await import("./catalogue");
});
afterEach(() => {
  paths.length = 0;
  vi.unstubAllGlobals();
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await removeDir(dir);
});

const list = (baseUrl: string, apiKey?: string, savedKey = false) =>
  registry.listModelsFor(
    { provider: "openai-compatible", baseUrl, apiKey },
    { savedKey },
  );

it("finds the API at /v1 on the same server when the entered address is not it", async () => {
  handler = (url, res) =>
    url.pathname === "/v1/models" ? json(res, models) : json(res, {}, 404);
  const result = await list(base, key);
  expect(result.error).toBeUndefined();
  expect(result.baseUrl).toBe(`${base}/v1`);
  expect(result.models.map((m) => m.id)).toEqual(["vendor/model-a"]);
  expect(paths).toEqual(["/models", "/v1/models"]);
});

it("treats a web page instead of the API the same way", async () => {
  handler = (url, res) => {
    if (url.pathname === "/v1/models") return json(res, models);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><title>Welcome</title>");
  };
  const result = await list(`${base}/`, undefined);
  expect(result.baseUrl).toBe(`${base}/v1`);
  expect(result.models).toHaveLength(1);
});

it("never sends a saved key to a different address; it suggests one instead", async () => {
  handler = (url, res) =>
    url.pathname === "/v1/models" ? json(res, models) : json(res, {}, 404);
  const result = await list(base, key, true);
  expect(paths).toEqual(["/models"]);
  expect(result.baseUrl).toBeUndefined();
  expect(result.error).toBe(
    `This address isn't the service's API: it didn't answer with a model list. API addresses usually end in /v1. Try ${base}/v1.`,
  );
});

it("says plainly when neither address is the API", async () => {
  handler = (_url, res) => json(res, {}, 404);
  const result = await list(base, key);
  expect(result.error).toBe(
    `This address isn't the service's API, and neither is ${base}/v1. Check the service's documentation for its API address; it usually ends in /v1.`,
  );
});

it("does not try another address when the entered one already ends in /v1", async () => {
  handler = (_url, res) => json(res, {}, 404);
  const result = await list(`${base}/v1`, key);
  expect(paths).toEqual(["/v1/models"]);
  expect(result.error).toMatch(/for example https:\/\/openrouter\.ai\/api\/v1/);
});

it("tells a refused key from a missing one", async () => {
  handler = (_url, res) => json(res, { error: { message: "nope" } }, 401);
  expect((await list(`${base}/v1`, key)).error).toBe(
    "The service refused the API key. Check the key, then find models again.",
  );
  expect((await list(`${base}/v1`, undefined)).error).toBe(
    "The service needs an API key. Enter it, then find models again.",
  );
});

it("checks a key with a service's documented key request, without inference", async () => {
  const connection: ProviderConnection = {
    id: "conn_key_check",
    name: "Key check",
    provider: "openai-compatible",
    modelIds: [],
    baseUrl: `${base}/v1`,
    apiKey: key,
    concurrency: 1,
    requestTimeoutSec: 30,
    structuredOutput: "auto",
    vision: "auto",
    refusalFallback: false,
    createdAt: "",
    updatedAt: "",
  };
  let status = 200;
  handler = (url, res) =>
    url.pathname === "/v1/key"
      ? json(res, { data: {} }, status)
      : json(res, {}, 404);
  expect(await catalogue.checkServiceKey(connection, "/key")).toBe("accepted");
  status = 401;
  expect(await catalogue.checkServiceKey(connection, "/key")).toBe("refused");
  status = 500;
  expect(await catalogue.checkServiceKey(connection, "/key")).toBeUndefined();
});

it("runs the key check for a recognised service, and says when no key was given", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url === "https://openrouter.ai/api/v1/models")
        return Response.json(models);
      if (url === "https://openrouter.ai/api/v1/key")
        return Response.json({ data: { label: "synthetic" } });
      return new Response("{}", { status: 404 });
    },
  );
  const withKey = await list("https://openrouter.ai/api/v1", key);
  expect(withKey.error).toBeUndefined();
  expect(withKey.keyCheck).toBe("accepted");
  expect(seen.map((s) => s.url)).toEqual([
    "https://openrouter.ai/api/v1/models",
    "https://openrouter.ai/api/v1/key",
  ]);
  expect(seen.every((s) => s.auth === `Bearer ${key}`)).toBe(true);
  seen.length = 0;
  const noKey = await list("https://openrouter.ai/api/v1", undefined);
  expect(noKey.keyCheck).toBe("missing");
  expect(seen.map((s) => s.url)).toEqual([
    "https://openrouter.ai/api/v1/models",
  ]);
});
