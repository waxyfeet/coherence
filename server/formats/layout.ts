/**
 * OWNER: formats builder.
 * Folder layout of the spec output (ARCHITECTURE §4/§12) — shared by every format and the spec store.
 */
import type { Screen } from "@shared/types";

export const USE_CASES_DIR = "use-cases";
export const SCREENS_DIR = "screens";
export const SCREEN_IMAGES_DIR = "screens/images";
export const FEATURES_DIR = "features";

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** File extension (no dot) of a stored screen image. */
export function screenImageExt(
  screen: Pick<Screen, "fileName" | "mimeType">,
): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(screen.fileName.replace(/\\/g, "/"));
  if (m) return m[1].toLowerCase();
  return MIME_EXT[screen.mimeType] ?? "png";
}

/** "screens/images/<screenKey>.<ext>" relative to the output folder. */
export function screenImageRelPath(
  screenKey: string,
  screen: Pick<Screen, "fileName" | "mimeType">,
): string {
  return `${SCREEN_IMAGES_DIR}/${screenKey}.${screenImageExt(screen)}`;
}
