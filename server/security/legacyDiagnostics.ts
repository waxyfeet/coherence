import { registryEntries, verifyEntry } from "../storage/projectRegistry";
import fs from "node:fs/promises";
import path from "node:path";
import type { Job } from "@shared/types";
import type { ExportJournal } from "../export/journal";

import { assertV2Path } from "../storage/boundary";
import {
  isNotFound,
  writeJsonAtomic,
  PRIVATE_FILE_MODE,
  readOwnedFile,
} from "../storage/fsUtils";
import {
  JOB_DIAGNOSTICS_VERSION,
  safeJobDiagnostics,
  safeJournalDiagnostics,
} from "./jobDiagnostics";

/** Only app-owned diagnostic records; never walk specification/history/image content or follow links. */
export async function cleanLegacyDiagnostics(): Promise<{
  cleaned: number;
  unreadable: number;
}> {
  const result = { cleaned: 0, unreadable: 0 };
  const ownedRoots: string[] = [];
  for (const entry of registryEntries()) {
    try {
      ownedRoots.push(verifyEntry(entry));
    } catch {
      result.unreadable++;
    }
  }
  for (const root of ownedRoots) {
    for (const kind of ["jobs", "export-journal"] as const) {
      const folder = path.join(root, kind);
      const folderInfo = await fs.lstat(folder).catch((e) => {
        if (isNotFound(e)) return undefined;
        throw e;
      });
      if (!folderInfo) continue;
      if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink()) {
        result.unreadable++;
        continue;
      }
      try {
        assertV2Path(folder);
      } catch {
        result.unreadable++;
        continue;
      }
      const files = await fs
        .readdir(folder, { withFileTypes: true })
        .catch((e) => {
          if (isNotFound(e)) return [];
          throw e;
        });
      for (const file of files.filter(
        (f) =>
          f.isFile() &&
          !f.isSymbolicLink() &&
          /^(?:job|export)_[A-Za-z0-9_-]+\.json$/.test(f.name),
      )) {
        const target = path.join(folder, file.name);
        let record: Job | ExportJournal;
        try {
          assertV2Path(target);
          record = JSON.parse((await readOwnedFile(target)).toString("utf8"));
        } catch {
          result.unreadable++;
          continue;
        }
        // Only older records are sanitised: a newer version's records are left exactly as it wrote them.
        if (
          !record ||
          typeof record !== "object" ||
          (typeof record.diagnosticsVersion === "number" &&
            record.diagnosticsVersion >= JOB_DIAGNOSTICS_VERSION)
        )
          continue;
        // Leave unrecognised records untouched and unavailable as certified diagnostics.
        if (
          kind === "jobs"
            ? !Array.isArray((record as Job).logs) ||
              !(record as Job).progress ||
              typeof (record as Job).progress !== "object" ||
              !(record as Job).usage ||
              typeof (record as Job).usage !== "object"
            : !Array.isArray((record as ExportJournal).operations) ||
              !(record as ExportJournal).operations.every(
                (o) => o && typeof o === "object",
              )
        ) {
          result.unreadable++;
          continue;
        }
        const safe =
          kind === "jobs"
            ? safeJobDiagnostics(record as Job)
            : safeJournalDiagnostics(record as ExportJournal);
        await writeJsonAtomic(target, safe, PRIVATE_FILE_MODE);
        result.cleaned++;
      }
    }
  }
  return result;
}
