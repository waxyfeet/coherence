import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler, toApiError } from "../middleware/errorHandler";
import type { Request, Response, NextFunction } from "express";
import {
  formatHttpError,
  RemoteServiceError,
  requestJson,
} from "../export/http";
import { instantiateProvider, testConnection } from "../llm/registry";
import { rememberSecret, redactDiagnostic } from "./diagnostics";
import { removeDir, useTempDataDir } from "../storage/testUtils";

const secret = "synthetic-key-DO-NOT-EXPOSE-88219";
const project = "CONFIDENTIAL-PROJECT-ECHO-551";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("S05 safe diagnostic boundaries", () => {
  it.each(["no", "yes"] as const)(
    "withholds successful provider response excerpts and unexpected model metadata in %s-vision connection diagnostics",
    async (vision) => {
      vi.stubGlobal("fetch", async () =>
        Response.json({
          id: "synthetic-fixture",
          object: "chat.completion",
          created: 1,
          model: project,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: `${secret} ${project}`,
                refusal: null,
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      );
      const result = await testConnection({
        id: "fixture",
        name: "Fixture",
        provider: "openai",
        model: "fixture-model",
        apiKey: secret,
        baseUrl: "https://fixture.invalid/v1",
        vision,
        concurrency: 1,
        requestTimeoutSec: 5,
        structuredOutput: "native",
        refusalFallback: false,
        createdAt: "",
        updatedAt: "",
      });
      expect(result.ok).toBe(true);
      if (vision === "yes") expect(result.visionOk).toBe(false);
      for (const marker of [secret, project])
        expect(JSON.stringify(result)).not.toContain(marker);
      expect(result.model).toBeUndefined();
    },
  );
  it("does not accept arbitrary TLS-shaped error codes as public diagnostic facts", async () => {
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new Error("transport"), {
        cause: { code: `UNABLE_TO_${project}_${secret}` },
      });
    });
    const error = await requestJson(
      { label: "Fixture", extractMessage: () => "" },
      "https://fixture.invalid",
      { retries: 0 },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(RemoteServiceError);
    expect(error.message).not.toContain(project);
    expect(error.message).not.toContain(secret);
  });
  it("redacts registered credentials, authorization and URL authentication", () => {
    rememberSecret(secret);
    const text = redactDiagnostic(
      `${secret} Basic YTpiY2Q= Bearer test-secret https://user:password@host.invalid/path?custom=${secret} api_key=unknown-marker`,
    );
    for (const marker of [
      secret,
      "YTpiY2Q=",
      "test-secret",
      "user:password",
      "unknown-marker",
    ])
      expect(text).not.toContain(marker);
    expect(text).toContain("host.invalid/path");
  });
  it("does not expose or log unexpected errors, nested request objects, project excerpts or URL queries", () => {
    const error = Object.assign(new Error(`${secret} ${project}`), {
      request: { headers: { Authorization: secret }, body: project },
    });
    const formatted = toApiError(error);
    expect(formatted.status).toBe(500);
    expect(formatted.body.error).toContain("Reference");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    errorHandler(
      error,
      {
        method: "POST",
        originalUrl: `/api/fixture?token=${secret}`,
      } as Request,
      res as unknown as Response,
      vi.fn() as NextFunction,
    );
    for (const marker of [secret, project])
      expect(
        JSON.stringify({
          formatted,
          console: log.mock.calls,
          response: res.json.mock.calls,
        }),
      ).not.toContain(marker);
  });
  it("drops tracker bodies and retains only safe field recovery facts", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            message: `${secret} ${project}`,
            errors: { customfield_123: `${secret} ${project}` },
            request: { headers: { Authorization: secret } },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const service = {
      label: "Jira",
      extractMessage: (body: unknown) => JSON.stringify(body),
    };
    const error = await requestJson(service, "https://fixture.invalid/api", {
      headers: { Authorization: `Bearer ${secret}` },
      retries: 0,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(RemoteServiceError);
    expect(error.body).toEqual({
      errors: { customfield_123: "Field rejected by service" },
    });
    for (const marker of [secret, project]) {
      expect(JSON.stringify(error)).not.toContain(marker);
      expect(
        formatHttpError(service, 400, "Bad Request", { message: marker }),
      ).not.toContain(marker);
    }
  });
  it.each([
    "openai",
    "anthropic",
    "gemini",
    "ollama",
    "openai-compatible",
  ] as const)("does not echo external %s error bodies", async (provider) => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            error: { message: `${secret} ${project}` },
            message: `${secret} ${project}`,
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );
    const adapter = instantiateProvider({
      id: "fixture",
      name: "Fixture",
      provider,
      model: "fixture",
      baseUrl: "https://fixture.invalid",
      apiKey: secret,
      requestTimeoutSec: 5,
      concurrency: 1,
      vision: "no",
      structuredOutput: "native",
      refusalFallback: false,
      createdAt: "",
      updatedAt: "",
    });
    const error = await adapter
      .complete({ system: project, messages: [], purpose: "fixture" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    for (const marker of [secret, project])
      expect(JSON.stringify({ message: error.message, error })).not.toContain(
        marker,
      );
  });
  it("sanitizes job events, console, snapshots and persisted job files", async () => {
    const dir = await useTempDataDir("safe-diagnostics");
    vi.resetModules();
    try {
      const diagnostics = await import("./diagnostics");
      diagnostics.rememberSecret(secret);
      const store = await import("../storage/projectStore");
      await store.ensureDataDirs();
      const jobs = await import("../jobs/jobManager");
      const cfg = await import("../config");
      const p = await store.createProject({
        name: "Synthetic diagnostic fixture",
        description: "",
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const events: unknown[] = [];
      const job = await jobs.startJob("generate", p.id, async (ctx) => {
        ctx.info(`credential ${secret}`);
        throw Object.assign(new Error(`${secret} ${project}`), {
          request: { headers: { Authorization: secret }, body: project },
        });
      });
      const unsubscribe = jobs.subscribe(job.id, (e) => events.push(e));
      const done = await jobs.waitForJob(job.id);
      unsubscribe();
      expect(done?.status).toBe("failed");
      const bytes = await fs.readFile(
        path.join(cfg.paths.jobsDir(p.id), `${job.id}.json`),
        "utf8",
      );
      for (const marker of [secret, project])
        expect(
          JSON.stringify({ done, events, console: log.mock.calls, bytes }),
        ).not.toContain(marker);
    } finally {
      await removeDir(dir);
    }
  });
});
