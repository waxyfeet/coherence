/**
 * Data migrations (installer report §5.4.3). They run in the server, never in the installer: ordered, idempotent
 * steps under the profile lock. Before a step runs, every file it may touch is copied to `backups/<id>-<time>/` and
 * the journal records the step as running. A step that fails is undone from that copy and start-up stops with
 * MIGRATION_FAILED; a step interrupted by a crash or power cut is undone on the next start and then run again. A
 * completed step is recorded and never runs twice.
 *
 * No migration exists yet: the first format change (see ./formats.ts) adds its step to PROFILE_MIGRATIONS. With
 * nothing to do, nothing is written.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  PRIVATE_FILE_MODE,
  fileTimestamp,
  isNotFound,
  readJsonIfExists,
  writeFileAtomic,
  writeJsonAtomic,
} from "./fsUtils";
import { removeReviewedPath } from "./windowsStorageGuard";
import { isNewerFormat } from "./formats";
import { StartupError, safeCause } from "../startupErrors";

export interface Migration {
  /** Permanent: the journal records it, so it is never renamed or reused. */
  id: string;
  /** Files, relative to the folder being migrated, that this step may create, change or delete. */
  files: string[];
  /** False when the data already has the new shape (the step then counts as done without running). */
  needed(root: string): Promise<boolean>;
  run(root: string): Promise<void>;
}

/** The global profile's migrations, oldest first. */
export const PROFILE_MIGRATIONS: Migration[] = [];

interface Running {
  id: string;
  backup: string;
  files: string[];
  /** Files that did not exist before the step: undoing it removes them. */
  absent: string[];
  startedAt: string;
}
interface Journal {
  format: 1;
  applied: { id: string; at: string; backup?: string }[];
  running?: Running;
}

const JOURNAL = "migrations.json";
const BACKUPS = "backups";

async function readOptional(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** Puts every file the step may have touched back as it was before the step started. */
async function undo(root: string, running: Running): Promise<void> {
  for (const file of running.files) {
    const target = path.join(root, file);
    if (running.absent.includes(file)) {
      const created = await readOptional(target);
      if (created === undefined) continue;
      const stat = await fs.lstat(target, { bigint: true });
      await removeReviewedPath(
        target,
        stat.ino.toString(),
        createHash("sha256").update(created).digest("hex"),
        false,
      );
    } else
      await writeFileAtomic(
        target,
        await fs.readFile(path.join(root, running.backup, file)),
        PRIVATE_FILE_MODE,
      );
  }
}

/** Runs the steps that have not run yet. Returns the ids of the steps that ran. */
export async function runMigrations(
  root: string,
  migrations: Migration[],
): Promise<string[]> {
  const journalFile = path.join(root, JOURNAL);
  const stored = await readJsonIfExists<Journal>(journalFile);
  if (stored && isNewerFormat(stored.format, 1))
    throw new StartupError(
      "DATA_NEWER",
      "Your data was updated by a newer version of Coherence. Install that version or a later one; nothing was changed.",
    );
  const journal: Journal = stored ?? { format: 1, applied: [] };
  const save = () => writeJsonAtomic(journalFile, journal, PRIVATE_FILE_MODE);

  if (journal.running) {
    await undo(root, journal.running);
    console.warn(
      `[migrations] "${journal.running.id}" was interrupted earlier; its changes were undone and it runs again now.`,
    );
    journal.running = undefined;
    await save();
  }

  const ran: string[] = [];
  for (const migration of migrations) {
    if (journal.applied.some((done) => done.id === migration.id)) continue;
    const at = new Date().toISOString();
    if (!(await migration.needed(root))) {
      journal.applied.push({ id: migration.id, at });
      await save();
      continue;
    }
    const backup = path.join(BACKUPS, `${migration.id}-${fileTimestamp()}`);
    const absent: string[] = [];
    for (const file of migration.files) {
      const bytes = await readOptional(path.join(root, file));
      if (bytes === undefined) absent.push(file);
      else
        await writeFileAtomic(
          path.join(root, backup, file),
          bytes,
          PRIVATE_FILE_MODE,
        );
    }
    journal.running = {
      id: migration.id,
      backup,
      files: migration.files,
      absent,
      startedAt: at,
    };
    await save();
    try {
      await migration.run(root);
    } catch (error) {
      await undo(root, journal.running);
      journal.running = undefined;
      await save();
      console.error(
        `[migrations] "${migration.id}" failed (${safeCause(error)}); everything it changed was put back.`,
      );
      throw new StartupError(
        "MIGRATION_FAILED",
        "Coherence could not update your saved data for this version. Everything was put back as it was; nothing was lost.",
      );
    }
    journal.applied.push({ id: migration.id, at, backup });
    journal.running = undefined;
    await save();
    ran.push(migration.id);
  }
  return ran;
}
