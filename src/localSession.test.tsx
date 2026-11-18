import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  SESSION_STORAGE_KEY,
  SESSION_REQUIRED_EVENT,
  SESSION_CHANGED_EVENT,
} from "../shared/localAuth";
import {
  browserSession,
  checkSession,
  sessionFetch,
  SessionEventSource,
} from "./localSession";
const token = "c".repeat(64);
let storage: Map<string, string>;
let dispatch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  storage = new Map([
    [
      SESSION_STORAGE_KEY,
      JSON.stringify({ token, expiresAt: Date.now() + 60000 }),
    ],
  ]);
  const events = new EventTarget();
  dispatch = vi.fn((event: Event) => events.dispatchEvent(event));
  vi.stubGlobal("window", {
    location: { origin: "http://127.0.0.1:5417" },
    dispatchEvent: dispatch,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
it.each([
  "http://localhost:5417",
  "http://[::1]:5417",
  "https://127.0.0.1:5417",
])(
  "does not disclose a stored session during recovery from an unverified origin: %s",
  async (origin) => {
    Object.assign(window.location, { origin });
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    for (const method of ["GET", "POST"])
      await expect(sessionFetch("/api/projects", { method })).rejects.toThrow(
        "verified 127.0.0.1",
      );
    expect(await checkSession()).toBe(false);
    expect(transport).not.toHaveBeenCalled();
    expect(
      dispatch.mock.calls.some(
        ([event]) => event.type === SESSION_REQUIRED_EVENT,
      ),
    ).toBe(true);
  },
);
it("sends authentication only in a header, omits cookies, refuses redirects and never puts it in a URL", async () => {
  const transport = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", transport);
  await sessionFetch("/api/projects");
  const [url, options] = transport.mock.calls[0];
  expect(url).toBe("/api/projects");
  expect(url).not.toContain(token);
  expect(options.headers.get("Authorization")).toBe(`Bearer ${token}`);
  expect(options).toMatchObject({
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
});
it.each([
  "http://localhost:9999/api/projects",
  "https://provider.invalid/api/chat",
  "//evil.invalid/api/projects",
  "/assets/image.png",
  "/api/../private",
])("never forwards authentication to another endpoint: %s", async (url) => {
  const transport = vi.fn();
  vi.stubGlobal("fetch", transport);
  await expect(sessionFetch(url)).rejects.toThrow("Only local");
  expect(transport).not.toHaveBeenCalled();
});
it("blocks missing, expired, malformed and disabled-storage sessions before any mutation", async () => {
  const transport = vi.fn();
  vi.stubGlobal("fetch", transport);
  for (const record of [
    null,
    "invalid",
    JSON.stringify({ token, expiresAt: Date.now() - 1 }),
    JSON.stringify({ token: "bad", expiresAt: Date.now() + 1000 }),
  ]) {
    storage.clear();
    if (record) storage.set(SESSION_STORAGE_KEY, record);
    expect(browserSession()).toBeUndefined();
    await expect(
      sessionFetch("/api/projects", { method: "POST" }),
    ).rejects.toThrow("Reopen");
  }
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw Error("Disabled");
    },
  });
  expect(browserSession()).toBeUndefined();
  expect(transport).not.toHaveBeenCalled();
  expect(
    dispatch.mock.calls.some(([e]) => e.type === SESSION_REQUIRED_EVENT),
  ).toBe(true);
});
it("signals invalidated sessions without automatically retrying a write", async () => {
  const transport = vi
    .fn()
    .mockResolvedValue(
      Response.json({ code: "SESSION_REQUIRED" }, { status: 401 }),
    );
  vi.stubGlobal("fetch", transport);
  const response = await sessionFetch("/api/projects", { method: "POST" });
  expect(response.status).toBe(401);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0][0].type).toBe(SESSION_REQUIRED_EVENT);
  expect(await checkSession()).toBe(false);
});
it("does not let an old in-flight unauthorized reply invalidate a newly launched session", async () => {
  let complete!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    () =>
      new Promise<Response>((r) => {
        complete = r;
      }),
  );
  const pending = sessionFetch("/api/projects");
  storage.set(
    SESSION_STORAGE_KEY,
    JSON.stringify({ token: "d".repeat(64), expiresAt: Date.now() + 60000 }),
  );
  complete(new Response(null, { status: 401 }));
  expect((await pending).status).toBe(401);
  expect(dispatch).not.toHaveBeenCalled();
});
it("pauses an invalidated job stream and resumes the same read after a fresh local session", async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(
      new Response('data: {"status":"succeeded"}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
  vi.stubGlobal("fetch", transport);
  const events = new SessionEventSource("/api/jobs/job_fixture/events");
  let status = "";
  events.onmessage = (e) => {
    status = JSON.parse(e.data).status;
    events.close();
  };
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
  expect(transport).toHaveBeenCalledTimes(1);
  storage.set(
    SESSION_STORAGE_KEY,
    JSON.stringify({ token: "d".repeat(64), expiresAt: Date.now() + 60000 }),
  );
  window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
  await vi.waitFor(() => expect(status).toBe("succeeded"));
  expect(transport.mock.calls[1][1].headers.get("Authorization")).toBe(
    `Bearer ${"d".repeat(64)}`,
  );
  expect(transport.mock.calls.map((call) => call[0])).toEqual([
    "/api/jobs/job_fixture/events",
    "/api/jobs/job_fixture/events",
  ]);
});
it("streams complete SSE data through authenticated fetch and does not forward a secret in its URL", async () => {
  const late = "important-late-change-" + "x".repeat(9000);
  const encoded = new TextEncoder().encode(
    `retry: 5000\n\ndata: ${JSON.stringify({ result: late })}\n\n`,
  );
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoded.slice(0, 103));
      controller.enqueue(encoded.slice(103));
      controller.close();
    },
  });
  const transport = vi
    .fn()
    .mockResolvedValue(
      new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    );
  vi.stubGlobal("fetch", transport);
  const events = new SessionEventSource("/api/jobs/job_fixture/events");
  let received = "";
  events.onmessage = (e) => {
    received = JSON.parse(e.data).result;
    events.close();
  };
  await vi.waitFor(() => expect(received).toBe(late));
  expect(transport.mock.calls[0][0]).toBe("/api/jobs/job_fixture/events");
  expect(transport.mock.calls[0][1].headers.get("Authorization")).toBe(
    `Bearer ${token}`,
  );
});
