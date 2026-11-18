import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { httpDefaults } from "../export/http";
import { mockFetch } from "../export/testUtils";
import {
  clearFigmaCache,
  exportFigmaFrames,
  listFigmaFrames,
  parseFigmaFileKey,
  sanitiseFileName,
  testFigmaToken,
} from "./figma";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

beforeEach(() => {
  httpDefaults.baseDelayMs = 0;
  clearFigmaCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  httpDefaults.baseDelayMs = 800;
});

describe("parseFigmaFileKey", () => {
  it.each([
    "https://user:synthetic-secret@figma.com/design/AbC123xyz0/App",
    "https://figma.com/design/AbC123xyz0/App?api_key=synthetic-secret",
    "https://figma.com/design/AbC123xyz0/App#synthetic-secret",
  ])("rejects credential-bearing links without echoing them: %s", (value) => {
    let error: unknown;
    try {
      parseFigmaFileKey(value);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("synthetic-secret");
  });

  it.each([
    [
      "https://www.figma.com/design/AbC123xyz0/My-app?node-id=1-2",
      "AbC123xyz0",
    ],
    ["https://www.figma.com/file/AbC123xyz0/My-app", "AbC123xyz0"],
    ["figma.com/proto/AbC123xyz0/Flow", "AbC123xyz0"],
    [
      "https://www.figma.com/design/MainKey1234/branch/BranchKey99/My-app",
      "BranchKey99",
    ],
    ["AbC123xyz0", "AbC123xyz0"],
  ])("reads %s", (url, key) => {
    expect(parseFigmaFileKey(url)).toBe(key);
  });

  it.each([
    [""],
    ["https://example.com/design/AbC123xyz0/x"],
    ["https://www.figma.com/community/plugin/123"],
    ["not a url at all"],
  ])("rejects %j with a readable message", (url) => {
    expect(() => parseFigmaFileKey(url)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});

describe("sanitiseFileName", () => {
  it("removes path separators and reserved names", () => {
    expect(sanitiseFileName("Login / Sign in: v2*")).toBe(
      "Login - Sign in- v2",
    );
    expect(sanitiseFileName("../..")).toBe("Figma frame");
    expect(sanitiseFileName("CON")).toBe("CON frame");
  });
});

describe("Figma API", () => {
  it("lists top-level frames, opening sections, with thumbnails", async () => {
    const { calls } = mockFetch([
      [
        /GET https:\/\/api\.figma\.com\/v1\/files\/KEY1234567\?depth=2$/,
        {
          json: {
            name: "Acme app",
            document: {
              id: "0:0",
              name: "Document",
              type: "DOCUMENT",
              children: [
                {
                  id: "0:1",
                  name: "Screens",
                  type: "CANVAS",
                  children: [
                    {
                      id: "1:1",
                      name: "Login",
                      type: "FRAME",
                      absoluteBoundingBox: {
                        x: 0,
                        y: 0,
                        width: 1440,
                        height: 900.4,
                      },
                    },
                    {
                      id: "1:2",
                      name: "Hidden",
                      type: "FRAME",
                      visible: false,
                    },
                    { id: "1:3", name: "Flows", type: "SECTION" },
                    { id: "1:4", name: "A note", type: "TEXT" },
                  ],
                },
                {
                  id: "0:2",
                  name: "Not a canvas",
                  type: "OTHER",
                  children: [{ id: "9:9", name: "X", type: "FRAME" }],
                },
              ],
            },
          },
        },
      ],
      [
        /GET https:\/\/api\.figma\.com\/v1\/files\/KEY1234567\/nodes\?ids=1%3A3&depth=1$/,
        {
          json: {
            nodes: {
              "1:3": {
                document: {
                  id: "1:3",
                  name: "Flows",
                  type: "SECTION",
                  children: [
                    {
                      id: "2:1",
                      name: "Dashboard",
                      type: "FRAME",
                      absoluteBoundingBox: {
                        x: 0,
                        y: 0,
                        width: 1280,
                        height: 2000,
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      ],
      [
        /GET https:\/\/api\.figma\.com\/v1\/images\/KEY1234567\?ids=1%3A1%2C2%3A1&format=png&scale=0\.25$/,
        {
          json: {
            err: null,
            images: {
              "1:1": "https://s3-alpha-sig.figma.com/1.png",
              "2:1": null,
            },
          },
        },
      ],
    ]);
    const result = await listFigmaFrames(
      "figd_token",
      "https://www.figma.com/design/KEY1234567/Acme",
    );
    expect(result).toEqual({
      fileKey: "KEY1234567",
      fileName: "Acme app",
      frames: [
        {
          id: "1:1",
          name: "Login",
          page: "Screens",
          width: 1440,
          height: 900,
          thumbnailUrl: "/api/figma/thumbnail/KEY1234567/1%3A1",
        },
        {
          id: "2:1",
          name: "Dashboard",
          page: "Screens",
          width: 1280,
          height: 2000,
        },
      ],
    });
    expect(
      calls.every((c) => c.headers["X-Figma-Token"] === "figd_token"),
    ).toBe(true);
  });

  it("renders selected frames to PNG with unique file names", async () => {
    const { calls } = mockFetch([
      [
        /\/v1\/files\/KEY1234567\/nodes\?ids=1%3A1%2C1%3A2&depth=1$/,
        {
          json: {
            nodes: {
              "1:1": { document: { id: "1:1", name: "Login", type: "FRAME" } },
              "1:2": { document: { id: "1:2", name: "Login", type: "FRAME" } },
            },
          },
        },
      ],
      [
        /\/v1\/images\/KEY1234567\?ids=1%3A1%2C1%3A2&format=png&scale=2$/,
        {
          json: {
            images: {
              "1:1": "https://s3-alpha-sig.figma.com/a.png",
              "1:2": "https://s3-alpha-sig.figma.com/b.png",
            },
          },
        },
      ],
      [
        /GET https:\/\/s3-alpha-sig\.figma\.com\/[ab]\.png$/,
        { body: PNG, headers: { "content-type": "image/png" } },
      ],
    ]);
    const images = await exportFigmaFrames(
      "figd_token",
      "KEY1234567",
      ["1:1", "1:2", "1:1"],
      2,
    );
    expect(images.map((i) => i.originalName)).toEqual([
      "Login.png",
      "Login (2).png",
    ]);
    expect(
      images.every((i) => i.mimeType === "image/png" && i.buffer.equals(PNG)),
    ).toBe(true);
    // The signed CDN URL must not receive the token.
    expect(
      calls
        .filter((c) => c.url.startsWith("https://s3-alpha-sig.figma.com"))
        .every((c) => !c.headers["X-Figma-Token"]),
    ).toBe(true);
  });

  it("explains frames Figma cannot render and missing frames", async () => {
    mockFetch([
      [
        /\/nodes\?/,
        {
          json: {
            nodes: {
              "1:1": { document: { id: "1:1", name: "Empty", type: "FRAME" } },
              "1:2": null,
            },
          },
        },
      ],
    ]);
    await expect(
      exportFigmaFrames("t", "KEY1234567", ["1:1", "1:2"], 1),
    ).rejects.toThrow(/Frame 1:2 no longer exists/);

    mockFetch([
      [
        /\/nodes\?/,
        {
          json: {
            nodes: {
              "1:1": { document: { id: "1:1", name: "Empty", type: "FRAME" } },
            },
          },
        },
      ],
      [/\/v1\/images\//, { json: { images: { "1:1": null } } }],
    ]);
    await expect(
      exportFigmaFrames("t", "KEY1234567", ["1:1"], 1),
    ).rejects.toThrow(/could not render the frame "Empty"/);
  });

  describe("Tier-1 quota", () => {
    const page = (count: number) => ({
      name: "Big file",
      document: {
        id: "0:0",
        name: "Document",
        type: "DOCUMENT",
        children: [
          {
            id: "0:1",
            name: "Screens",
            type: "CANVAS",
            children: Array.from({ length: count }, (_, i) => ({
              id: `1:${i + 1}`,
              name: `Screen ${i + 1}`,
              type: "FRAME",
            })),
          },
        ],
      },
    });

    it("renders thumbnails for the first 50 frames only, and only once per file", async () => {
      const { calls } = mockFetch([
        [/\/v1\/files\/KEY1234567\?depth=2$/, { json: page(180) }],
        [
          /\/v1\/images\/KEY1234567\?/,
          (call) => {
            const ids = decodeURIComponent(
              /ids=([^&]+)/.exec(call.url)![1],
            ).split(",");
            return {
              json: {
                images: Object.fromEntries(
                  ids.map((id) => [
                    id,
                    `https://s3-alpha-sig.figma.com/${id}.png`,
                  ]),
                ),
              },
            };
          },
        ],
      ]);
      const first = await listFigmaFrames("t", "KEY1234567");
      expect(first.frames).toHaveLength(180);
      expect(first.frames.filter((f) => f.thumbnailUrl)).toHaveLength(50);
      const images = calls.filter((c) => c.url.includes("/v1/images/"));
      expect(images).toHaveLength(1);

      calls.length = 0;
      const again = await listFigmaFrames("t", "KEY1234567");
      expect(again.frames[0].thumbnailUrl).toBe(
        "/api/figma/thumbnail/KEY1234567/1%3A1",
      );
      expect(calls.map((c) => c.url)).toEqual([
        "https://api.figma.com/v1/files/KEY1234567?depth=2",
      ]);
    });

    it("imports listed frames without fetching their names again", async () => {
      const { calls } = mockFetch([
        [/\/v1\/files\/KEY1234567\?depth=2$/, { json: page(2) }],
        [/\/v1\/images\/KEY1234567\?.*scale=0\.25$/, { json: { images: {} } }],
        [
          /\/v1\/images\/KEY1234567\?ids=1%3A2&format=png&scale=2$/,
          {
            json: { images: { "1:2": "https://s3-alpha-sig.figma.com/b.png" } },
          },
        ],
        [/GET https:\/\/s3-alpha-sig\.figma\.com\/b\.png$/, { body: PNG }],
      ]);
      await listFigmaFrames("t", "KEY1234567");
      calls.length = 0;
      const images = await exportFigmaFrames("t", "KEY1234567", ["1:2"], 2);
      expect(images.map((i) => i.originalName)).toEqual(["Screen 2.png"]);
      expect(calls.some((c) => c.url.includes("/nodes?"))).toBe(false);
    });

    it("explains Figma's monthly allowance for View and Collab seats", async () => {
      mockFetch([
        [
          /\/v1\/files\//,
          {
            status: 429,
            headers: {
              "retry-after": String(12 * 24 * 3600),
              "x-figma-rate-limit-type": "low",
            },
          },
        ],
      ]);
      await expect(listFigmaFrames("t", "KEY1234567")).rejects.toThrow(
        /Figma is rate limiting requests \(HTTP 429\)\. This token belongs to a View or Collab seat.*Try again in about 12 days\./,
      );
    });
  });

  it("tests a token without throwing", async () => {
    mockFetch([[/\/v1\/me$/, { json: { handle: "jane" } }]]);
    expect(await testFigmaToken("t")).toMatchObject({
      ok: true,
      message: "Connected to Figma as jane.",
    });
    mockFetch([
      [
        /\/v1\/me$/,
        { status: 403, json: { status: 403, err: "Invalid token" } },
      ],
    ]);
    const bad = await testFigmaToken("t");
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/Figma/);
    expect(await testFigmaToken("")).toMatchObject({ ok: false });
  });
});
