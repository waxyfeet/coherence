import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundError } from "../errors";
import {
  clearImageCache,
  planTiles,
  prepareImageForLLM,
  thumbnailForLLM,
} from "./images";

let dir: string;

/** RGB image whose red channel encodes the row (y) so tile offsets can be checked from pixels. */
async function gradientPng(
  width: number,
  height: number,
  file: string,
): Promise<string> {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const v = Math.floor((y / height) * 255);
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      data[i] = v;
      data[i + 1] = Math.floor((x / width) * 255);
      data[i + 2] = 40;
    }
  }
  const out = path.join(dir, file);
  await sharp(data, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(out);
  return out;
}

async function solid(
  width: number,
  height: number,
  file: string,
  format: "png" | "jpeg" | "webp" | "gif",
): Promise<string> {
  const out = path.join(dir, file);
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 30, g: 120, b: 200 },
    },
  })
    .toFormat(format)
    .toFile(out);
  return out;
}

async function dims(
  base64: string,
): Promise<{ width: number; height: number; format?: string }> {
  const meta = await sharp(Buffer.from(base64, "base64")).metadata();
  return { width: meta.width, height: meta.height, format: meta.format };
}

async function pixel(base64: string, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(Buffer.from(base64, "base64"))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

beforeAll(async () => {
  // The setup-owned disposable profile is already bound by static imports.
  dir = await fs.mkdtemp(
    path.join(process.env.SCREENSCRIBE_V2_DATA_DIR!, "image-fixture-"),
  );
});
afterAll(async () => {
  clearImageCache();
  await (
    await import("../storage/windowsStorageGuard")
  ).releaseFilesystemGuard();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("planTiles", () => {
  it("keeps normal screens whole and caps the long edge", () => {
    expect(planTiles(1440, 900)).toEqual([
      {
        left: 0,
        top: 0,
        width: 1440,
        height: 900,
        outWidth: 1440,
        outHeight: 900,
        index: 1,
        count: 1,
        axis: "none",
      },
    ]);
    const [big] = planTiles(2880, 1800);
    expect([big.outWidth, big.outHeight]).toEqual([1568, 980]);
  });

  it("tiles a tall capture into overlapping vertical tiles that cover it completely", () => {
    const tiles = planTiles(1200, 5000);
    expect(tiles).toHaveLength(4);
    expect(tiles[0].top).toBe(0);
    expect(tiles.at(-1)!.top + tiles.at(-1)!.height).toBe(5000);
    for (const tile of tiles) {
      expect(tile.axis).toBe("vertical");
      expect(tile.outWidth).toBeLessThanOrEqual(1568);
      expect(tile.outHeight).toBeLessThanOrEqual(1568);
    }
    for (let i = 1; i < tiles.length; i += 1) {
      const overlap = tiles[i - 1].top + tiles[i - 1].height - tiles[i].top;
      expect(overlap).toBeGreaterThanOrEqual(0.1 * tiles[i].height - 1);
    }
  });

  it("shrinks the image when more than maxTiles would be needed", () => {
    const tiles = planTiles(1000, 20000, 1568, 6);
    expect(tiles).toHaveLength(6);
    expect(tiles.at(-1)!.top + tiles.at(-1)!.height).toBe(20000);
    for (const tile of tiles) expect(tile.outHeight).toBeLessThanOrEqual(1568);
    expect(tiles[0].outWidth).toBeLessThan(1000);
  });

  it("does not tile a tall image that already fits", () => {
    expect(planTiles(300, 900)).toHaveLength(1);
  });

  it("tiles very wide screens horizontally", () => {
    const tiles = planTiles(6000, 1000);
    expect(tiles.length).toBeGreaterThan(1);
    expect(
      tiles.every(
        (t) => t.axis === "horizontal" && t.top === 0 && t.height === 1000,
      ),
    ).toBe(true);
    expect(tiles.at(-1)!.left + tiles.at(-1)!.width).toBe(6000);
  });
});

describe("prepareImageForLLM", () => {
  it("splits a 1200×5000 PNG into labelled tiles with full-image coverage ranges", async () => {
    const file = await gradientPng(1200, 5000, "orders.png");
    const images = await prepareImageForLLM(file, { name: "Orders" });
    expect(images).toHaveLength(4);
    expect(images[1].label).toMatch(
      /^Orders — part 2 of 4, top→bottom \(covers \d+%–\d+% of the screen height\)$/,
    );
    expect(images[0].region).toMatchObject({
      index: 1,
      count: 4,
      topPct: 0,
      leftPct: 0,
      rightPct: 100,
    });
    expect(images[3].region?.bottomPct).toBe(100);
    for (const image of images) {
      expect(image.mimeType).toBe("image/png");
      expect(image.base64).not.toMatch(/\s|^data:/);
      const size = await dims(image.base64);
      expect(size.width).toBe(1200);
      expect(size.height).toBeLessThanOrEqual(1568);
    }
    // The first row of each tile carries the gradient value of its top offset.
    for (const image of images) {
      const expected = Math.floor(
        (((image.region!.topPct / 100) * 5000) / 5000) * 255,
      );
      const [red] = await pixel(image.base64, 10, 0);
      expect(Math.abs(red - expected)).toBeLessThanOrEqual(3);
    }
  });

  it("returns the cached result for the same file and options", async () => {
    const file = await solid(800, 600, "cached.png", "png");
    const first = await prepareImageForLLM(file, { name: "Cached" });
    const second = await prepareImageForLLM(file, { name: "Cached" });
    expect(second).toBe(first);
    const otherName = await prepareImageForLLM(file, { name: "Renamed" });
    expect(otherName).not.toBe(first);
    expect(otherName[0].label).toBe("Renamed");
  });

  it("keeps JPEG as JPEG and converts WebP/GIF to PNG", async () => {
    const jpg = await prepareImageForLLM(
      await solid(2000, 1500, "photo.jpg", "jpeg"),
      { name: "Photo" },
    );
    expect(jpg[0].mimeType).toBe("image/jpeg");
    expect(await dims(jpg[0].base64)).toMatchObject({
      width: 1568,
      height: 1176,
      format: "jpeg",
    });
    const webp = await prepareImageForLLM(
      await solid(400, 300, "shot.webp", "webp"),
      { name: "Shot" },
    );
    expect(webp[0].mimeType).toBe("image/png");
    const gif = await prepareImageForLLM(
      await solid(400, 300, "anim.gif", "gif"),
      { name: "Anim" },
    );
    expect(gif[0].mimeType).toBe("image/png");
  });

  it("applies EXIF orientation before measuring", async () => {
    const file = path.join(dir, "rotated.jpg");
    await sharp({
      create: { width: 400, height: 200, channels: 3, background: "#336699" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(file);
    const [image] = await prepareImageForLLM(file, { name: "Rotated" });
    expect(await dims(image.base64)).toMatchObject({ width: 200, height: 400 });
  });

  it("respects maxEdge and maxTiles options", async () => {
    const file = await gradientPng(600, 4000, "narrow.png");
    const images = await prepareImageForLLM(file, {
      name: "Narrow",
      maxEdge: 800,
      maxTiles: 3,
    });
    expect(images).toHaveLength(3);
    for (const image of images) {
      const size = await dims(image.base64);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(800);
    }
  });

  it("reports a missing file readably", async () => {
    await expect(
      prepareImageForLLM(path.join(dir, "missing.png"), { name: "Gone" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("thumbnailForLLM", () => {
  it("produces one small image with the screen name as label", async () => {
    const file = await gradientPng(1200, 5000, "thumb-source.png");
    const thumb = await thumbnailForLLM(file, "Orders");
    expect(thumb.label).toBe("Orders");
    const size = await dims(thumb.base64);
    expect(Math.max(size.width, size.height)).toBe(768);
  });
});
