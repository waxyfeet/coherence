/**
 * The one way into sharp (libvips). It loads on first use instead of at start-up (installer report RT-05, R14), so a
 * missing or blocked native library — antivirus quarantine, Smart App Control, a damaged install — disables image
 * features with a plain message while the rest of Coherence keeps working. A failed load is retried on the next use.
 */
import type sharpModule from "sharp";
import { HttpError } from "../errors";
import { safeCause } from "../startupErrors";

export type SharpFactory = typeof sharpModule;

let loading: Promise<SharpFactory> | undefined;

export function loadSharp(): Promise<SharpFactory> {
  loading ??= import("sharp").then(
    (module) => module.default,
    (error: unknown) => {
      loading = undefined;
      console.error(
        `[images] The image library could not load: ${safeCause(error)}`,
      );
      throw new HttpError(
        503,
        "Image processing is not available on this computer because Coherence's image library could not load. Reinstall Coherence, or ask your IT team to allow its files, then try again.",
        "IMAGES_UNAVAILABLE",
      );
    },
  );
  return loading;
}
