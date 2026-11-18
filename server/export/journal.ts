import { readOwnedFile } from "../storage/fsUtils";
import { errorMessage } from "../errors";
import {
  JOB_DIAGNOSTICS_VERSION,
  safeJournalDiagnostics,
} from "../security/jobDiagnostics";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import { paths } from "../config";
import { ConflictError } from "../errors";
import { pathExists, writeJsonAtomic } from "../storage/fsUtils";
export interface ExportOperation {
  key: string;
  kind: "parent" | "item" | "links";
  /**
   * refused: the tracker answered that it did not carry the request out (nothing to reconcile, safe to retry);
   * uncertain / in-flight: the outcome is unknown and blocks the key until it is checked.
   */
  state: "in-flight" | "complete" | "uncertain" | "refused";
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
  /** How a check settled an unknown outcome: adopted (found, recorded) or not-found (cleared for a new attempt). */
  resolution?: "adopted" | "not-found";
}

/** Operations whose outcome is unknown block their key: no automatic repeat may create a duplicate. */
export function isUnsettled(op: ExportOperation): boolean {
  return op.state === "in-flight" || op.state === "uncertain";
}
export interface ExportJournal {
  diagnosticsVersion?: number;
  id: string;
  projectId: string;
  jobId: string;
  target: string;
  targetFingerprint: string;
  createdAt: string;
  operations: ExportOperation[];
}
function folder(pid: string) {
  return path.join(paths.projectDir(pid), "export-journal");
}
export async function listExportJournals(
  pid: string,
): Promise<ExportJournal[]> {
  const dir = folder(pid);
  const records: ExportJournal[] = [];
  for (const name of (await fs.readdir(dir).catch(() => [])).filter((n) =>
    /^export_[A-Za-z0-9_-]+\.json$/.test(n),
  )) {
    try {
      records.push(
        safeJournalDiagnostics(
          JSON.parse(
            (await readOwnedFile(path.join(dir, name))).toString("utf8"),
          ),
        ),
      );
    } catch {}
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/** Durable intent precedes every remote side effect; uncertain operations cannot be automatically repeated. */
export async function createExportJournal(
  pid: string,
  jobId: string,
  target: string,
  targetIdentity: unknown,
) {
  // Pure adapter unit fixtures have no on-disk project. HTTP exports always have one.
  if (!(await pathExists(paths.projectFile(pid)))) return undefined;
  const record: ExportJournal = {
    diagnosticsVersion: JOB_DIAGNOSTICS_VERSION,
    id: "export_" + nanoid(12),
    projectId: pid,
    jobId,
    target,
    targetFingerprint: createHash("sha256")
      .update(JSON.stringify(targetIdentity))
      .digest("hex"),
    createdAt: new Date().toISOString(),
    operations: [],
  };
  const file = path.join(folder(pid), record.id + ".json");
  await writeJsonAtomic(file, record);
  async function completed(key: string) {
    const journals = await listExportJournals(pid);
    return journals
      .filter((j) => j.targetFingerprint === record.targetFingerprint)
      .flatMap((j) => j.operations)
      .find((o) => o.key === key && o.state === "complete")?.result;
  }
  async function operation<T>(
    key: string,
    kind: ExportOperation["kind"],
    run: () => Promise<T>,
    /** Which failures prove nothing was carried out; every other failure is recorded as uncertain. */
    refused?: (error: unknown) => boolean,
  ): Promise<T> {
    const previous = await listExportJournals(pid);
    if (
      previous.some(
        (j) =>
          j.targetFingerprint === record.targetFingerprint &&
          j.operations.some((o) => o.key === key && isUnsettled(o)),
      )
    )
      throw new ConflictError(
        "A previous tracker operation has an uncertain outcome. Reconcile its export journal before retrying; no duplicate request was sent.",
      );
    const intent: ExportOperation = {
      key,
      kind,
      state: "in-flight",
      startedAt: new Date().toISOString(),
    };
    record.operations.push(intent);
    await writeJsonAtomic(file, safeJournalDiagnostics(record));
    try {
      const result = await run();
      intent.state = "complete";
      intent.result = result;
      intent.finishedAt = new Date().toISOString();
      await writeJsonAtomic(file, safeJournalDiagnostics(record));
      return result;
    } catch (error) {
      intent.state = refused?.(error) ? "refused" : "uncertain";
      intent.error = errorMessage(error);
      intent.finishedAt = new Date().toISOString();
      await writeJsonAtomic(file, safeJournalDiagnostics(record));
      throw error;
    }
  }
  return { operation, record, completed };
}

/**
 * Settle an unknown outcome after a read-only check: "adopted" marks it complete with the work item that was found,
 * "not-found" clears it so the next publish may try again. The original journal file is rewritten in place.
 */
export async function settleOperation(
  pid: string,
  journalId: string,
  key: string,
  outcome:
    { resolution: "adopted"; result: unknown } | { resolution: "not-found" },
): Promise<void> {
  if (!/^export_[A-Za-z0-9_-]+$/.test(journalId))
    throw new ConflictError("That export journal does not exist.");
  const file = path.join(folder(pid), `${journalId}.json`);
  const journal = safeJournalDiagnostics(
    JSON.parse((await readOwnedFile(file)).toString("utf8")) as ExportJournal,
  );
  for (const op of journal.operations)
    if (op.key === key && isUnsettled(op)) {
      op.resolution = outcome.resolution;
      op.finishedAt ??= new Date().toISOString();
      if (outcome.resolution === "adopted") {
        op.state = "complete";
        op.result = outcome.result;
      } else op.state = "refused";
    }
  await writeJsonAtomic(file, safeJournalDiagnostics(journal));
}
