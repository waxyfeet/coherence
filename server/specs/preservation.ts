import { readOwnedFile } from "../storage/fsUtils";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { paths } from "../config";
import { ConflictError } from "../errors";
import type { Project } from "@shared/types";
import { isMissing, isTextSpec, walk } from "./files";

/** Detect app/external edits made while generation is running, before any replacement writes. */
export async function specificationState(project: Project): Promise<string> {
  const hash = createHash("sha256").update(project.outputDir);
  const entries = await walk(project.outputDir);
  if (entries.length >= 5000)
    throw new ConflictError(
      "The specification folder is too large to verify preservation safely.",
    );
  for (const entry of entries) {
    if (entry.isDir || !isTextSpec(entry.rel)) continue;
    hash.update(entry.rel).update(await readOwnedFile(entry.abs));
  }
  try {
    hash.update(await readOwnedFile(paths.modelFile(project.id)));
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  return hash.digest("hex");
}
