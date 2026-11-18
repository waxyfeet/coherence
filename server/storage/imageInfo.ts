/**
 * OWNER: server-core builder.
 * Screen image validation: the file type is decided by magic bytes (never by the file name or the
 * browser-supplied MIME type), and dimensions are read with image-size.
 */
import { imageSize } from "image-size";
import { BadRequestError } from "../errors";

export type ScreenImageMime =
  "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface ScreenImageInfo {
  mimeType: ScreenImageMime;
  ext: "png" | "jpg" | "webp" | "gif";
  width: number;
  height: number;
}

/** Longest edge we accept; beyond this the image libraries (and the LLM tiler) start to struggle. */
export const MAX_IMAGE_EDGE_PX = 32_000;

export const EXT_TO_MIME: Record<string, ScreenImageMime> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

/** The image type by magic bytes, or undefined when it is not one of the supported formats. */
export function detectImageType(
  buf: Buffer,
): Pick<ScreenImageInfo, "mimeType" | "ext"> | undefined {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { mimeType: "image/png", ext: "png" };
  if (startsWith(buf, [0xff, 0xd8, 0xff]))
    return { mimeType: "image/jpeg", ext: "jpg" };
  if (
    startsWith(buf, [0x47, 0x49, 0x46, 0x38]) &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return { mimeType: "image/gif", ext: "gif" };
  }
  // RIFF....WEBP
  if (
    startsWith(buf, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return { mimeType: "image/webp", ext: "webp" };
  }
  return undefined;
}

/**
 * Validates an uploaded screen image and returns its type and displayed dimensions.
 * @throws BadRequestError with a BA-readable message naming the file.
 */
export function inspectScreenImage(
  buf: Buffer,
  displayName: string,
): ScreenImageInfo {
  const name = displayName || "The file";
  if (!buf.length) throw new BadRequestError(`"${name}" is empty.`);
  const type = detectImageType(buf);
  if (!type) {
    throw new BadRequestError(
      `"${name}" is not a supported image. Use PNG, JPEG, WebP or GIF screenshots or exports.`,
    );
  }
  let width: number;
  let height: number;
  try {
    const size = imageSize(buf);
    width = size.width;
    height = size.height;
    // EXIF orientations 5–8 rotate the picture by 90°; browsers display it rotated, so swap.
    if (size.orientation && size.orientation >= 5)
      [width, height] = [height, width];
  } catch {
    throw new BadRequestError(
      `Could not read the dimensions of "${name}" — the file may be damaged. Try exporting it again.`,
    );
  }
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new BadRequestError(
      `Could not read the dimensions of "${name}" — the file may be damaged. Try exporting it again.`,
    );
  }
  if (width * height > 40_000_000)
    throw new BadRequestError(
      `"${name}" exceeds the 40 megapixel decode limit. Resize or split it before uploading.`,
    );
  if (width > MAX_IMAGE_EDGE_PX || height > MAX_IMAGE_EDGE_PX) {
    throw new BadRequestError(
      `"${name}" is ${width}×${height} px — images may be at most ${MAX_IMAGE_EDGE_PX.toLocaleString("en-US")} px on each side. Split very long pages into several screens.`,
    );
  }
  return { ...type, width, height };
}
