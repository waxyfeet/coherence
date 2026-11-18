import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { removeDir, useTempDataDir } from "../storage/testUtils";
const fixture = vi.hoisted(() => ({ choose: vi.fn() }));
vi.mock("../platform/outputFolder", () => ({
  windowsFolderDialog: fixture.choose,
}));
let server: http.Server;
let base: string;
let dir: string;
let authenticated: Awaited<
  ReturnType<typeof import("../security/authTestUtils").authenticatedTestApp>
>;
beforeAll(async () => {
  dir = await useTempDataDir("output-folder-api");
  vi.resetModules();
  const { authenticatedTestApp } = await import("../security/authTestUtils");
  authenticated = await authenticatedTestApp();
  server = http.createServer(authenticated.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  authenticated.authenticate(base);
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await removeDir(dir);
});
beforeEach(() => {
  fixture.choose.mockReset().mockResolvedValue(null);
});
const request = (
  headers: Record<string, string> = {},
  body: unknown = {
    purpose: "workspace",
    initialPath: process.env.SCREENSCRIBE_V2_WORKSPACE_DIR,
  },
) => ({
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-ScreenScribe": "1",
    ...headers,
  },
  body: JSON.stringify(body),
});
it("rejects unauthenticated requests before any desktop dialog opens", async () => {
  expect(
    (await fetch(base + "/api/storage/choose-folder", request())).status,
  ).toBe(401);
  expect(fixture.choose).not.toHaveBeenCalled();
});
it("retains CSRF, Origin and Host checks before any desktop dialog opens", async () => {
  const cases: Record<string, string>[] = [
    { "X-ScreenScribe": "" },
    { Origin: "https://unrelated.invalid" },
    { Host: "unrelated.invalid" },
  ];
  for (const headers of cases) {
    // Native HTTP is required: fetch can ignore a caller-supplied Host header.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        base + "/api/storage/choose-folder",
        {
          method: "POST",
          headers: {
            Authorization: authenticated.authorization(base),
            ...request(headers).headers,
          },
        },
        (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode!));
        },
      );
      req.once("error", reject);
      req.end(
        JSON.stringify({
          purpose: "workspace",
          initialPath: process.env.SCREENSCRIBE_V2_WORKSPACE_DIR,
        }),
      );
    });
    expect(status, JSON.stringify(headers)).toBe(403);
  }
  expect(fixture.choose).not.toHaveBeenCalled();
});
it("allows an authenticated selection and distinguishes cancellation without persisting a project", async () => {
  fixture.choose.mockResolvedValueOnce(dir);
  const selected = await authenticated.fetch(
    base + "/api/storage/choose-folder",
    request(),
  );
  expect(selected.status).toBe(200);
  expect(selected.headers.get("cache-control")).toBe("no-store");
  expect(await selected.json()).toEqual({ path: dir });
  expect(
    await (
      await authenticated.fetch(base + "/api/storage/choose-folder", request())
    ).json(),
  ).toEqual({ path: null });
  expect(fixture.choose).toHaveBeenCalledWith(
    process.env.SCREENSCRIBE_V2_WORKSPACE_DIR,
    expect.any(AbortSignal),
    "Choose the parent folder for Coherence projects",
  );
  expect(
    await (await authenticated.fetch(base + "/api/projects")).json(),
  ).toEqual([]);
});
it("rejects malformed requests and does not provide a GET-triggered desktop action", async () => {
  for (const body of [
    null,
    [],
    {},
    { purpose: "workspace", initialPath: 7 },
    { purpose: "workspace", initialPath: "x".repeat(4001) },
  ])
    expect(
      (
        await authenticated.fetch(
          base + "/api/storage/choose-folder",
          request({}, body),
        )
      ).status,
    ).toBe(400);
  expect(
    (await authenticated.fetch(base + "/api/storage/choose-folder")).status,
  ).toBe(404);
  expect(fixture.choose).not.toHaveBeenCalled();
});
it("aborts a pending dialog when its requesting client disconnects", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let signal!: AbortSignal;
  fixture.choose.mockImplementation((_initial: string, input: AbortSignal) => {
    signal = input;
    started();
    return new Promise<null>((resolve) =>
      input.addEventListener("abort", () => resolve(null), { once: true }),
    );
  });
  const controller = new AbortController();
  const pending = authenticated
    .fetch(base + "/api/storage/choose-folder", {
      ...request(),
      signal: controller.signal,
    })
    .catch(() => null);
  await ready;
  controller.abort();
  await pending;
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
});
