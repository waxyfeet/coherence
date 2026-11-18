import http from "node:http";
import dns from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  figmaImageUrl,
  guardedLookup,
  outboundDispatcher,
  permitsAddress,
} from "./outboundPolicy";
import { requestBuffer } from "../export/http";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("S03 connection-time destination checks", () => {
  it.each([
    "0.0.0.0",
    "169.254.169.254",
    "100.100.100.200",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "fe80::1",
    "ff02::1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "2002:a9fe:a9fe::1",
  ])("blocks metadata/special address %s", (address) => {
    for (const policy of ["configured", "public", "loopback", "lan"] as const)
      expect(permitsAddress(address, policy)).toBe(false);
  });
  it("preserves deliberately configured LAN/loopback and TLS gateways, but not as public CDN targets", () => {
    for (const address of [
      "10.1.2.3",
      "172.16.0.2",
      "192.168.2.5",
      "fd12::4",
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(permitsAddress(address, "configured")).toBe(true);
      expect(permitsAddress(address, "lan")).toBe(true);
      expect(permitsAddress(address, "public")).toBe(false);
    }
    expect(permitsAddress("93.184.216.34", "public")).toBe(true);
    expect(permitsAddress("93.184.216.34", "lan")).toBe(false);
    expect(() =>
      outboundDispatcher(
        new URL("https://[::ffff:169.254.169.254]"),
        "configured",
      ),
    ).toThrow(/not allowed/);
  });
  it("rejects mixed DNS results instead of selecting an apparently safe address", async () => {
    const lookup = guardedLookup("public", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const callback = vi.fn();
    lookup("synthetic.figma.invalid", { all: true }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalled());
    expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(JSON.stringify(callback.mock.calls)).not.toContain("93.184");
  });
  it("returns only the actual validated DNS results to the socket connector", async () => {
    const resolve = vi.fn(async () => [{ address: "192.168.1.30", family: 4 }]);
    const callback = vi.fn();
    guardedLookup("lan", resolve)("gpu-box", { all: true }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalled());
    expect(callback).toHaveBeenCalledWith(null, [
      { address: "192.168.1.30", family: 4 },
    ]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it("blocks a rebound hostname inside the real connector before sending credentials or payload", async () => {
    let received = 0;
    const server = http.createServer((req, res) => {
      received++;
      req.resume();
      res.setHeader("Connection", "close");
      res.end("fixture");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const url = new URL(
      `http://localhost:${(server.address() as import("node:net").AddressInfo).port}`,
    );
    const resolver = vi
      .spyOn(dns, "lookup")
      .mockImplementation(
        async () => [{ address: "127.0.0.1", family: 4 }] as never,
      );
    const init = {
      method: "POST",
      body: "synthetic-project",
      headers: { Authorization: "Bearer synthetic-credential-only" },
      dispatcher: outboundDispatcher(url, "loopback"),
    } as RequestInit;
    try {
      expect(await (await fetch(url, init)).text()).toBe("fixture");
      resolver.mockImplementation(
        async () => [{ address: "169.254.169.254", family: 4 }] as never,
      );
      await expect(fetch(url, init)).rejects.toThrow();
      expect(received).toBe(1);
      expect(resolver).toHaveBeenCalledTimes(2);
      resolver.mockImplementation(
        async () => [{ address: "127.0.0.1", family: 4 }] as never,
      );
      await expect(
        fetch(url, {
          ...init,
          dispatcher: outboundDispatcher(url, "public"),
        } as RequestInit),
      ).rejects.toThrow();
      expect(received).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("S03 Figma download authority", () => {
  it.each([
    "http://s3-alpha-sig.figma.com/img/a",
    "https://s3-alpha-sig.figma.com.evil.invalid/a",
    "https://evil.invalid/a",
    "https://127.0.0.1/a",
    "https://169.254.169.254/a",
    "https://figma-alpha-api.evil.s3.amazonaws.com/a",
    "https://user:synthetic-secret@s3-alpha-sig.figma.com/a",
    "https://s3-alpha-sig.figma.com:444/a",
    "https://s3-alpha-sig.figma.com/a#secret",
  ])("rejects %s before fetch", async (url) => {
    const send = vi.fn();
    vi.stubGlobal("fetch", send);
    await expect(
      requestBuffer({ label: "Figma", extractMessage: () => "" }, url, {
        destination: "figma-image",
      }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("allows signed CDN/S3 URLs, sends no Figma token, and retains redirect refusal", async () => {
    const url =
      "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/fixture?X-Amz-Signature=synthetic-signed-capability";
    expect(figmaImageUrl(url).href).toBe(url);
    const send = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(new Uint8Array([1, 2, 3])),
    );
    vi.stubGlobal("fetch", send);
    await requestBuffer({ label: "Figma", extractMessage: () => "" }, url, {
      destination: "figma-image",
      headers: { Accept: "image/png" },
      maxBytes: 10,
    });
    const options = send.mock.calls[0][1] as RequestInit;
    expect(options.redirect).toBe("error");
    expect(new Headers(options.headers).has("X-Figma-Token")).toBe(false);
    await expect(
      requestBuffer({ label: "Figma", extractMessage: () => "" }, url, {
        destination: "figma-image",
        headers: { Authorization: "Bearer synthetic-key" },
      }),
    ).rejects.toThrow(/cannot include/);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
