import type { FigmaImportRequest } from "@shared/api";
import type { JobContext } from "../jobs/jobManager";
import { addScreens } from "../storage/projectStore";
import { exportFigmaFrames } from "./figma";

/** Downloads are cancellable. The final validated local save completes as one batch once begun. */
export async function runFigmaImport(
  ctx: JobContext,
  projectId: string,
  token: string,
  request: FigmaImportRequest,
) {
  ctx.setStages(["Downloading Figma frames", "Saving screenshots"]);
  ctx.stage("Downloading Figma frames", new Set(request.frameIds).size);
  const images = await exportFigmaFrames(
    token,
    request.fileUrl,
    request.frameIds,
    request.scale ?? 2,
    { signal: ctx.signal, onDownloaded: (name) => ctx.tick(name) },
  );
  ctx.throwIfCancelled();
  ctx.stage("Saving screenshots", images.length);
  ctx.info(
    "All downloads complete. Committing the validated local batch; cancellation after this point keeps saved screenshots.",
  );
  const screens = await addScreens(projectId, images);
  ctx.progress(images.length, images.length);
  ctx.info(
    `Imported ${images.length} Figma frames. Original PNG bytes are saved locally.`,
  );
  return { screenCount: images.length, screenIds: screens.map((s) => s.id) };
}
