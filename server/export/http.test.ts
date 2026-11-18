import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CancelledError } from "../errors";
import {
  formatHttpError,
  githubErrorMessage,
  httpDefaults,
  jiraErrorMessage,
  RemoteServiceError,
  requestJson,
  requestBuffer,
  retryAfterMs,
  type ServiceInfo,
} from "./http";
import { mockFetch } from "./testUtils";

const JIRA: ServiceInfo = {
  label: "Jira",
  extractMessage: jiraErrorMessage,
  authHint: "Check the token.",
};

it("bounds binary bodies even without a Content-Length header", async () => {
  let cancelled = false;
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(12));
            controller.enqueue(new Uint8Array(12));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await expect(
    requestBuffer(JIRA, "https://fixture.invalid/image", { maxBytes: 20 }),
  ).rejects.toThrow("exceeds");
  expect(cancelled).toBe(true);
});

beforeEach(() => {
  httpDefaults.baseDelayMs = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  httpDefaults.baseDelayMs = 800;
});

describe("requestJson", () => {
  it("retries 5xx twice and then succeeds", async () => {
    let n = 0;
    const { calls } = mockFetch([
      [
        /GET/,
        () => (++n < 3 ? { status: 503, text: "busy" } : { json: { ok: 1 } }),
      ],
    ]);
    const res = await requestJson<{ ok: number }>(JIRA, "https://x.test/a");
    expect(res.data.ok).toBe(1);
    expect(calls).toHaveLength(3);
  });

  it("gives up after 2 retries with a readable message", async () => {
    const { calls } = mockFetch([
      [/GET/, { status: 500, json: { errorMessages: ["Internal hiccup"] } }],
    ]);
    await expect(requestJson(JIRA, "https://x.test/a")).rejects.toThrow(
      "Jira returned HTTP 500 Internal Server Error.",
    );
    expect(calls).toHaveLength(3);
  });

  it("honours Retry-After on 429", async () => {
    let n = 0;
    mockFetch([
      [
        /GET/,
        () =>
          ++n === 1
            ? { status: 429, headers: { "retry-after": "0" } }
            : { json: [] },
      ],
    ]);
    await expect(requestJson(JIRA, "https://x.test/a")).resolves.toMatchObject({
      status: 200,
    });
    expect(n).toBe(2);
  });

  it("does not resend a create after a 5xx (it may have been created) and says so", async () => {
    let n = 0;
    const { calls } = mockFetch([
      [
        /POST/,
        () =>
          ++n === 1
            ? { status: 502, text: "Bad gateway" }
            : { status: 201, json: { key: "ABC-141" } },
      ],
    ]);
    const err = await requestJson(JIRA, "https://x.test/rest/api/2/issue", {
      method: "POST",
      json: {},
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RemoteServiceError);
    expect(err.remoteStatus).toBe(502);
    expect(err.message).toMatch(
      /^Jira returned HTTP 502 Bad Gateway\. The request was not repeated because Jira may have carried it out anyway/,
    );
    expect(calls).toHaveLength(1);

    n = 0;
    const patch = mockFetch([
      [/PATCH/, () => (++n === 1 ? { status: 504, text: "" } : { json: {} })],
    ]);
    await expect(
      requestJson(JIRA, "https://x.test/a", { method: "PATCH", json: [] }),
    ).rejects.toThrow(/may have carried it out anyway/);
    expect(patch.calls).toHaveLength(1);
  });

  it("retries a create that was rate limited, and a POST/PATCH marked idempotent after a 5xx", async () => {
    let n = 0;
    const limited = mockFetch([
      [
        /POST/,
        () =>
          ++n === 1
            ? { status: 429, headers: { "retry-after": "0" } }
            : { status: 201, json: { id: 1 } },
      ],
    ]);
    await expect(
      requestJson(JIRA, "https://x.test/a", { method: "POST", json: {} }),
    ).resolves.toMatchObject({ status: 201 });
    expect(limited.calls).toHaveLength(2);

    n = 0;
    const query = mockFetch([
      [
        /POST/,
        () =>
          ++n === 1 ? { status: 503, text: "" } : { json: { workItems: [] } },
      ],
    ]);
    await expect(
      requestJson(JIRA, "https://x.test/wiql", {
        method: "POST",
        json: {},
        idempotent: true,
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(query.calls).toHaveLength(2);

    n = 0;
    const put = mockFetch([
      [/PUT/, () => (++n === 1 ? { status: 500, text: "" } : { status: 204 })],
    ]);
    await expect(
      requestJson(JIRA, "https://x.test/issue/ABC-1", {
        method: "PUT",
        json: {},
      }),
    ).resolves.toMatchObject({ status: 204 });
    expect(put.calls).toHaveLength(2);
  });

  it("adds the service rate-limit hint and states long waits in days", async () => {
    const figma: ServiceInfo = {
      label: "Figma",
      extractMessage: () => "",
      rateLimitHint: (h) =>
        h.get("x-figma-rate-limit-type") === "low"
          ? "View seats get few calls."
          : undefined,
    };
    const { calls } = mockFetch([
      [
        /GET/,
        {
          status: 429,
          headers: {
            "retry-after": String(3 * 24 * 3600),
            "x-figma-rate-limit-type": "low",
          },
        },
      ],
    ]);
    await expect(
      requestJson(figma, "https://x.test/v1/files/K"),
    ).rejects.toThrow(
      "Figma is rate limiting requests (HTTP 429). View seats get few calls. Try again in about 3 days.",
    );
    expect(calls).toHaveLength(1);
  });

  it("does not wait out a very long Retry-After", async () => {
    const { calls } = mockFetch([
      [/GET/, { status: 429, headers: { "retry-after": "3600" } }],
    ]);
    await expect(requestJson(JIRA, "https://x.test/a")).rejects.toThrow(
      /rate limiting requests \(HTTP 429\)\. Try again in about 60 minute/,
    );
    expect(calls).toHaveLength(1);
  });

  it("does not retry client errors and retains only safe protocol facts", async () => {
    const { calls } = mockFetch([
      [
        /POST/,
        {
          status: 400,
          json: {
            errorMessages: [],
            errors: { summary: "Summary is required." },
          },
        },
      ],
    ]);
    const err = await requestJson(JIRA, "https://x.test/a", {
      method: "POST",
      json: {},
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RemoteServiceError);
    expect(err.remoteStatus).toBe(400);
    expect(err.message).toBe("Jira returned HTTP 400 Bad Request.");
    expect(calls).toHaveLength(1);
  });

  it("returns allowed statuses instead of throwing", async () => {
    mockFetch([
      [
        /GET/,
        { status: 404, json: { errorMessages: ["Issue does not exist"] } },
      ],
    ]);
    const res = await requestJson(JIRA, "https://x.test/a", {
      allowStatuses: [404],
    });
    expect(res.status).toBe(404);
  });

  it("explains 401 with the auth hint", async () => {
    mockFetch([[/GET/, { status: 401, text: "" }]]);
    await expect(requestJson(JIRA, "https://x.test/a")).rejects.toThrow(
      "Jira rejected the credentials (HTTP 401). Check the token.",
    );
  });

  it("treats an HTML sign-in page on a 2xx as an auth failure (Azure DevOps 203)", async () => {
    mockFetch([
      [
        /GET/,
        {
          status: 203,
          text: "<html>Sign in</html>",
          headers: { "content-type": "text/html" },
        },
      ],
    ]);
    await expect(requestJson(JIRA, "https://x.test/a")).rejects.toThrow(
      /sign-in page/,
    );
  });

  it("reports network failures without retrying a POST", async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ENOTFOUND" },
      });
    });
    vi.stubGlobal("fetch", fn);
    await expect(
      requestJson(JIRA, "https://nowhere.test/rest", {
        method: "POST",
        json: {},
      }),
    ).rejects.toThrow(
      "Could not reach Jira at https://nowhere.test: the host name could not be resolved (check the URL).",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reports a timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    await expect(
      requestJson(JIRA, "https://x.test/slow", {
        method: "POST",
        json: {},
        timeoutMs: 20,
      }),
    ).rejects.toThrow("Jira did not respond within 0 seconds (POST /slow).");
  });

  it("throws CancelledError when the job is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    mockFetch([[/GET/, { json: {} }]]);
    await expect(
      requestJson(JIRA, "https://x.test/a", { signal: controller.signal }),
    ).rejects.toBeInstanceOf(CancelledError);
  });
});

describe("error helpers", () => {
  it("extracts GitHub validation errors", () => {
    expect(
      githubErrorMessage({
        message: "Validation Failed",
        errors: [{ resource: "Label", field: "name", code: "already_exists" }],
      }),
    ).toBe("Validation Failed — Label name already_exists");
  });

  it("formats 403 with a permission hint, but GitHub rate limits as rate limits", () => {
    const svc: ServiceInfo = {
      label: "GitHub",
      extractMessage: githubErrorMessage,
    };
    expect(
      formatHttpError(svc, 403, "Forbidden", {
        message: "Resource not accessible by integration",
      }),
    ).toBe(
      "GitHub returned HTTP 403 Forbidden. The account behind the token is not allowed to do this — check its permissions.",
    );
    const headers = new Headers({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120),
    });
    expect(formatHttpError(svc, 403, "Forbidden", {}, headers)).toMatch(
      /rate limiting requests \(HTTP 403\)\. Try again in about [23] minute/,
    );
  });

  it("parses Retry-After seconds and dates", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "5" }))).toBe(5000);
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    expect(
      retryAfterMs(new Headers({ "retry-after": inTenSeconds })),
    ).toBeGreaterThan(8000);
    expect(retryAfterMs(new Headers())).toBeUndefined();
  });
});
