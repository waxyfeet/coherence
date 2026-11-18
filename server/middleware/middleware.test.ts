import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  BadRequestError,
  ConflictError,
  LLMError,
  NotFoundError,
} from "../errors";
import { toApiError } from "./errorHandler";
import {
  csrfGuard,
  hostGuard,
  hostnameOf,
  isAllowedHost,
  isAllowedOrigin,
} from "./security";
import { parseWith } from "./validate";

interface FakeRes {
  statusCode: number;
  body: unknown;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
}

function fakeRes(): FakeRes {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function fakeReq(opts: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
}): Request {
  const headers = Object.fromEntries(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    method: opts.method ?? "GET",
    path: opts.path ?? "/api/projects",
    headers,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function run(
  mw: (req: Request, res: Response, next: NextFunction) => void,
  req: Request,
) {
  const res = fakeRes();
  const next = vi.fn();
  mw(req, res as unknown as Response, next);
  return { res, next };
}

describe("host check", () => {
  it("parses Host headers", () => {
    expect(hostnameOf("localhost:4317")).toBe("localhost");
    expect(hostnameOf("127.0.0.1")).toBe("127.0.0.1");
    expect(hostnameOf("[::1]:4317")).toBe("[::1]");
    expect(hostnameOf("LOCALHOST:5317")).toBe("localhost");
    expect(hostnameOf(undefined)).toBeUndefined();
  });

  it("accepts loopback names only", () => {
    for (const ok of [
      "localhost:4317",
      "127.0.0.1:4317",
      "[::1]:4317",
      "localhost",
    ])
      expect(isAllowedHost(ok)).toBe(true);
    for (const bad of [
      "evil.com",
      "evil.com:4317",
      "localhost.evil.com",
      "127.0.0.2:4317",
      "",
      undefined,
    ])
      expect(isAllowedHost(bad)).toBe(false);
  });

  it("rejects rebinding attempts with 403 JSON and lets local requests through", () => {
    const rejected = run(
      hostGuard,
      fakeReq({ headers: { host: "attacker.example:4317" } }),
    );
    expect(rejected.next).not.toHaveBeenCalled();
    expect(rejected.res.statusCode).toBe(403);
    expect(rejected.res.body).toMatchObject({ code: "FORBIDDEN_HOST" });

    const allowed = run(
      hostGuard,
      fakeReq({ headers: { host: "localhost:4317" } }),
    );
    expect(allowed.next).toHaveBeenCalledOnce();
  });
});

describe("csrf check", () => {
  it("lets GET/HEAD through without the header", () => {
    expect(run(csrfGuard, fakeReq({ method: "GET" })).next).toHaveBeenCalled();
    expect(run(csrfGuard, fakeReq({ method: "HEAD" })).next).toHaveBeenCalled();
    expect(
      run(csrfGuard, fakeReq({ method: "GET", path: "/projects/x" })).next,
    ).toHaveBeenCalled();
  });

  it("checks mutating requests whatever the path, so /API/… cannot slip past", () => {
    for (const path of [
      "/API/projects/demo",
      "/Api/projects/demo",
      "/not-api",
      "/",
    ]) {
      const { res, next } = run(csrfGuard, fakeReq({ method: "POST", path }));
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    }
    const foreign = run(
      csrfGuard,
      fakeReq({
        method: "POST",
        path: "/API/projects/demo",
        headers: { "X-ScreenScribe": "1", Origin: "https://evil.example" },
      }),
    );
    expect(foreign.next).not.toHaveBeenCalled();
  });

  it("requires X-ScreenScribe: 1 on mutating API requests", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const { res, next } = run(csrfGuard, fakeReq({ method }));
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatchObject({ code: "CSRF" });
    }
    expect(
      run(
        csrfGuard,
        fakeReq({ method: "POST", headers: { "X-ScreenScribe": "0" } }),
      ).next,
    ).not.toHaveBeenCalled();
    expect(
      run(
        csrfGuard,
        fakeReq({ method: "POST", headers: { "X-ScreenScribe": "1" } }),
      ).next,
    ).toHaveBeenCalled();
  });

  it("rejects foreign origins even with the header", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("http://localhost:5317")).toBe(true);
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin("null")).toBe(false);
    const { res, next } = run(
      csrfGuard,
      fakeReq({
        method: "DELETE",
        headers: { "X-ScreenScribe": "1", Origin: "https://evil.example" },
      }),
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});

describe("validation & error mapping", () => {
  const schema = z.object({
    name: z.string().min(1),
    screenIds: z.array(z.string()),
  });

  it("parses valid bodies and treats a missing body as {}", () => {
    expect(parseWith(schema, { name: "x", screenIds: ["a"] })).toEqual({
      name: "x",
      screenIds: ["a"],
    });
    expect(() =>
      parseWith(z.object({ force: z.boolean().optional() }), undefined),
    ).not.toThrow();
  });

  it("throws BadRequestError naming the offending fields", () => {
    try {
      parseWith(schema, { name: "", screenIds: ["a", 3] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestError);
      expect((err as Error).message).toMatch(/name:/);
      expect((err as Error).message).toMatch(/screenIds\[1\]/);
    }
  });

  it("maps errors to ApiError bodies", () => {
    expect(toApiError(new NotFoundError('Project "x" was not found.'))).toEqual(
      {
        status: 404,
        body: { error: 'Project "x" was not found.', code: "NOT_FOUND" },
      },
    );
    expect(
      toApiError(new ConflictError("busy", { activeJobId: "job_1" })),
    ).toEqual({
      status: 409,
      body: {
        error: "busy",
        code: "CONFLICT",
        details: { activeJobId: "job_1" },
      },
    });
    expect(toApiError(new LLMError("Rate limited", true)).status).toBe(502);
    expect(
      toApiError(new multer.MulterError("LIMIT_FILE_SIZE", "files")).status,
    ).toBe(413);
    expect(
      toApiError(new multer.MulterError("LIMIT_FILE_COUNT")).body.error,
    ).toMatch(/at most 50/);
    const parseError = Object.assign(new SyntaxError("Unexpected token"), {
      status: 400,
      type: "entity.parse.failed",
    });
    expect(toApiError(parseError)).toEqual({
      status: 400,
      body: {
        error: "The request body is not valid JSON.",
        code: "VALIDATION",
      },
    });
    const tooLarge = Object.assign(new Error("too large"), {
      status: 413,
      type: "entity.too.large",
    });
    expect(toApiError(tooLarge).status).toBe(413);
    expect(toApiError(new TypeError("x is undefined"))).toEqual({
      status: 500,
      body: { error: expect.stringContaining("Reference"), code: "INTERNAL" },
    });
  });
});
