/**
 * Generation state kept in the project folder between runs (ARCHITECTURE §6):
 * - analysis-cache/<screenId>.json — the screen analyses of a run that has not been saved yet, so a run that
 *   fails after (or while) reading the screens does not pay for the same vision calls again. Cleared when a
 *   generation is saved (its model then holds the analyses).
 * - analysis-cache/stages/*.json — the journey map, plan and written use cases of that unsaved run (stage
 *   checkpoints), so Try again resumes from the last finished step. Cleared with the screen analyses.
 * - generation-commit.json — present while a generation writes its .md files and saves model.json. A run
 *   that failed or died in between leaves files that do not match the model; they must not be read back as
 *   the BA's edits (syncFromDisk would lock them as "edited" and mix two plans).
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  Project,
  Screen,
  ScreenAnalysis,
  Thoroughness,
} from "@shared/types";
import { paths } from "../config";
import { inventoryTree } from "../storage/inventory";
import { assertProjectFreeTree } from "../storage/projectBoundaries";
import { removeReviewedPath } from "../storage/windowsStorageGuard";
import { assertV2Path } from "../storage/boundary";
import { removeIfExists } from "../specs/files";
import { errorMessage } from "../errors";
import { analysisToOutput } from "./ids";
import { ScreenAnalysisOutputSchema } from "./schemas";
import { parseReadingParts, type ReadingParts } from "./adaptiveReading";
import { READER_CONTRACT_VERSION } from "./readerContract";
import { writeSpecs } from "../specs/specStore";
import {
  pathExists,
  readJsonIfExists,
  writeJsonAtomic,
} from "../storage/fsUtils";
import {
  getProject,
  loadModel,
  saveModel,
  withProjectLock,
} from "../storage/projectStore";

const CACHE_DIR = "analysis-cache";
const COMMIT_FILE = "generation-commit.json";
const SAFE_NAME = /^[A-Za-z0-9_-]{1,100}$/;

/* ── Screen analysis cache ─────────────────────────────────────────── */

export interface CachedAnalysis {
  fingerprint: string;
  analysis: ScreenAnalysis;
  /** Absent means complete; this marker must never satisfy completed-reading reuse. */
  phase?: "first-pass";
}

/** Everything a screen reading depends on: the image version, what the analyst is told, and who reads it how. */
export function analysisFingerprint(
  screen: Pick<Screen, "version" | "name" | "notes">,
  reader: string,
  thoroughness: Thoroughness,
  context = "",
): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        READER_CONTRACT_VERSION,
        screen.version,
        screen.name,
        screen.notes,
        reader,
        thoroughness,
        context,
      ]),
    )
    .digest("hex");
}

function cacheDir(projectId: string): string {
  return path.join(paths.projectDir(projectId), CACHE_DIR);
}

async function checkCacheTree(projectId: string): Promise<void> {
  const folder = assertV2Path(cacheDir(projectId));
  if (await pathExists(folder)) assertProjectFreeTree(folder);
}

interface PartsRecord {
  fingerprint: string;
  state: ReadingParts;
}
function parsePartsRecord(value: unknown): PartsRecord | undefined {
  const r = value as PartsRecord | undefined;
  if (
    !r ||
    typeof r.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(r.fingerprint)
  )
    return;
  const state = parseReadingParts(r.state);
  return state ? { fingerprint: r.fingerprint, state } : undefined;
}
export async function readReadingParts(
  projectId: string,
  screenId: string,
  fingerprint: string,
): Promise<ReadingParts | undefined> {
  if (!SAFE_NAME.test(screenId)) return;
  try {
    await checkCacheTree(projectId);
    const raw = await readJsonIfExists<unknown>(
      path.join(cacheDir(projectId), `${screenId}.parts.json`),
    );
    const record = parsePartsRecord(raw);
    if (record?.fingerprint === fingerprint) return record.state;
  } catch {
    /* Optional cache is never evidence of completion when damaged or inaccessible. */
  }
}
export async function cacheReadingParts(
  projectId: string,
  screenId: string,
  fingerprint: string,
  state: ReadingParts,
): Promise<void> {
  if (!SAFE_NAME.test(screenId)) return;
  const record = parsePartsRecord({ fingerprint, state });
  if (!record) return;
  try {
    if (!(await pathExists(paths.projectFile(projectId)))) return;
    await checkCacheTree(projectId);
    await writeJsonAtomic(
      path.join(cacheDir(projectId), `${screenId}.parts.json`),
      record,
    );
  } catch {
    /* Retain usable results in memory; inability to checkpoint never permits unsafe publication. */
  }
}

/** screenId → cached analysis. Unreadable entries are skipped (the screen is simply read again). */
export async function readCachedAnalyses(
  projectId: string,
): Promise<Map<string, CachedAnalysis>> {
  const out = new Map<string, CachedAnalysis>();
  try {
    await checkCacheTree(projectId);
  } catch {
    // A cache is optional. Never read through another project's requirements
    // or reuse checkpoint-shaped human files from an uncertain marked tree.
    return out;
  }
  const names = await fs
    .readdir(cacheDir(projectId))
    .catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const entry = await readJsonIfExists<CachedAnalysis>(
        path.join(cacheDir(projectId), name),
      );
      if (
        entry &&
        typeof entry.fingerprint === "string" &&
        (entry.phase === undefined || entry.phase === "first-pass") &&
        entry.analysis?.screenId &&
        SAFE_NAME.test(entry.analysis.screenId) &&
        typeof entry.analysis.screenKey === "string" &&
        entry.analysis.screenKey.length > 0 &&
        Number.isInteger(entry.analysis.screenVersion) &&
        entry.analysis.screenVersion > 0 &&
        Array.isArray(entry.analysis.regions) &&
        Array.isArray(entry.analysis.elements) &&
        ScreenAnalysisOutputSchema.safeParse(analysisToOutput(entry.analysis))
          .success &&
        new Set(entry.analysis.elements.map((element) => element.id)).size ===
          entry.analysis.elements.length &&
        new Set(entry.analysis.regions.map((region) => region.id)).size ===
          entry.analysis.regions.length &&
        entry.analysis.regions.every(
          (region) =>
            region.screenId === entry.analysis.screenId &&
            region.id === `${entry.analysis.screenKey}.${region.key}` &&
            Array.isArray(region.elementIds) &&
            region.elementIds.every((id) =>
              entry.analysis.elements.some(
                (element) =>
                  element.id === id && element.regionId === region.id,
              ),
            ),
        ) &&
        entry.analysis.elements.every(
          (element) =>
            element.screenId === entry.analysis.screenId &&
            element.id === `${entry.analysis.screenKey}.${element.key}` &&
            entry.analysis.regions.some(
              (region) =>
                region.id === element.regionId &&
                region.elementIds.includes(element.id),
            ),
        )
      )
        out.set(entry.analysis.screenId, entry);
    } catch {
      /* damaged entry: read the screen again */
    }
  }
  return out;
}

/** Best effort: a cache entry that cannot be written only costs a re-read later. */
export async function cacheAnalysis(
  projectId: string,
  fingerprint: string,
  analysis: ScreenAnalysis,
  phase?: "first-pass",
): Promise<boolean> {
  if (!SAFE_NAME.test(analysis.screenId)) return false;
  try {
    // A project deleted while its screens were read must not come back as a ghost folder.
    if (!(await pathExists(paths.projectFile(projectId)))) return false;
    await checkCacheTree(projectId);
    await writeJsonAtomic(
      path.join(cacheDir(projectId), `${analysis.screenId}.json`),
      {
        fingerprint,
        analysis,
        ...(phase ? { phase } : {}),
      } satisfies CachedAnalysis,
    );
    return true;
  } catch {
    return false;
  }
}

export async function clearAnalysisCache(projectId: string): Promise<void> {
  try {
    const folder = assertV2Path(cacheDir(projectId));
    if (await pathExists(folder)) {
      await checkCacheTree(projectId);
      const reviewed = await inventoryTree(folder);
      const recognised = await readCachedAnalyses(projectId);
      for (const file of reviewed.files) {
        const stage = /^stages\/([A-Za-z0-9_-]+)\.json$/.exec(file.path);
        if (
          stage &&
          STAGE_NAME.test(stage[1]) &&
          parseStageRecord(await readJsonIfExists(path.join(folder, file.path)))
        ) {
          await removeReviewedPath(
            path.join(folder, file.path),
            file.identity,
            file.sha256,
            false,
          );
          continue;
        }
        if (
          /^[A-Za-z0-9_-]{1,100}\.parts\.json$/.test(file.path) &&
          parsePartsRecord(await readJsonIfExists(path.join(folder, file.path)))
        ) {
          await removeReviewedPath(
            path.join(folder, file.path),
            file.identity,
            file.sha256,
            false,
          );
          continue;
        }
        if (
          !file.path.includes("/") &&
          file.path.endsWith(".json") &&
          recognised.has(file.path.slice(0, -5))
        )
          await removeReviewedPath(
            path.join(folder, file.path),
            file.identity,
            file.sha256,
            false,
          );
      }
    }
  } catch {
    /* Optional cache cleanup retains uncertain/changed files, including a foreign root. */
  }
}

/* ── Stage checkpoints ─────────────────────────────────────────────── */

// Tester build WP4 (owner test notes 5 and 7). A record is keyed by a hash of everything its stage depends on,
// so a changed model, setting, screen or reading invalidates exactly the stages it affects.

const STAGE_DIR = "stages";
const STAGE_NAME = /^(?:journey|plan|use-case-[A-Za-z0-9_-]{1,100})$/;
const STAGE_KEY = /^[a-f0-9]{64}$/;

interface StageRecord {
  version: 1;
  key: string;
  value: unknown;
}

/** Hash of everything a stage depends on. */
export function stageKey(...parts: unknown[]): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex");
}

/** Throws for a project that is not registered: callers stay inside their try. */
function stageFile(projectId: string, name: string): string {
  return path.join(cacheDir(projectId), STAGE_DIR, `${name}.json`);
}

function parseStageRecord(value: unknown): StageRecord | undefined {
  const r = value as Partial<StageRecord> | undefined;
  return r &&
    r.version === 1 &&
    typeof r.key === "string" &&
    STAGE_KEY.test(r.key) &&
    "value" in r
    ? (r as StageRecord)
    : undefined;
}

/** The checkpoint `name` when it was saved under `key` and passes `valid`; otherwise undefined, and the stage runs. */
export async function readStage<T>(
  projectId: string,
  name: string,
  key: string,
  valid: (value: unknown) => value is T,
): Promise<T | undefined> {
  if (!STAGE_NAME.test(name)) return;
  try {
    await checkCacheTree(projectId);
    const record = parseStageRecord(
      await readJsonIfExists<unknown>(stageFile(projectId, name)),
    );
    if (record?.key === key && valid(record.value)) return record.value;
  } catch {
    /* An optional checkpoint is never evidence of completion when damaged or inaccessible. */
  }
}

/** Best effort: a checkpoint that cannot be written only costs repeating the stage later. */
export async function writeStage(
  projectId: string,
  name: string,
  key: string,
  value: unknown,
): Promise<void> {
  if (!STAGE_NAME.test(name) || !STAGE_KEY.test(key)) return;
  try {
    // A project deleted during the run must not come back as a ghost folder.
    if (!(await pathExists(paths.projectFile(projectId)))) return;
    await checkCacheTree(projectId);
    await writeJsonAtomic(stageFile(projectId, name), {
      version: 1,
      key,
      value,
    } satisfies StageRecord);
  } catch {
    /* Retain the result in memory; the stage simply runs again next time. */
  }
}

/* ── Commit marker ─────────────────────────────────────────────────── */

export interface CommitMarker {
  /** generatedAt of the model being committed. */
  generatedAt: string;
  /** Epoch ms when writing the files started. */
  startedAt: number;
  /** Epoch ms when writing the files failed; the model was saved anyway. */
  failedAt?: number;
}

function commitFile(projectId: string): string {
  return path.join(paths.projectDir(projectId), COMMIT_FILE);
}

export async function readCommitMarker(
  projectId: string,
): Promise<CommitMarker | undefined> {
  try {
    const marker = await readJsonIfExists<CommitMarker>(commitFile(projectId));
    return marker && typeof marker.generatedAt === "string"
      ? marker
      : undefined;
  } catch {
    return undefined;
  }
}

/** Best effort (a missing marker only loses the protection, never the generation). */
export async function writeCommitMarker(
  projectId: string,
  marker: CommitMarker,
): Promise<void> {
  if (!(await pathExists(paths.projectFile(projectId))))
    throw new Error(
      "The project was removed before its output transaction could start.",
    );
  await writeJsonAtomic(commitFile(projectId), marker);
}

export async function clearCommitMarker(projectId: string): Promise<void> {
  await removeIfExists(commitFile(projectId));
}

function fileOf(project: Project, rel: string | undefined): string | undefined {
  if (
    !rel ||
    !path.isAbsolute(project.outputDir ?? "") ||
    rel.includes("\\") ||
    rel.split("/").some((seg) => seg === ".." || seg === "")
  )
    return undefined;
  return path.join(project.outputDir, ...rel.split("/"));
}

/**
 * Call before reading the .md files back (syncFromDisk). Settles what an interrupted generation left:
 * - its model was saved but writing the files failed: the use case files nobody touched since the failure
 *   are re-rendered from the model (a newer file is a re-render or a BA edit and is left to the sync);
 * - its model was never saved: the files may hold the unsaved plan, so they must not be read back as edits
 *   (`syncSafe: false`; the marker stays until a generation is saved and has rewritten them).
 */
export async function settleInterruptedCommit(
  projectId: string,
  warn: (message: string) => void,
): Promise<{ syncSafe: boolean }> {
  const marker = await readCommitMarker(projectId);
  if (!marker) return { syncSafe: true };
  return withProjectLock(projectId, async () => {
    const unsafe = (why: string): { syncSafe: false } => {
      warn(
        `${why} The .md files were not read back as your edits; edits made to them outside the app since then are not picked up.`,
      );
      return { syncSafe: false };
    };
    const model = await loadModel(projectId).catch(() => null);
    if (!model || model.generatedAt !== marker.generatedAt) {
      return unsafe(
        "The last generation stopped while it was writing the spec files, before it was saved, so some files may hold its unsaved content.",
      );
    }
    if (marker.failedAt !== undefined) {
      const project = await getProject(projectId);
      const leftovers: string[] = [];
      for (const uc of model.useCases) {
        const file = fileOf(project, uc.filePath);
        const stat = file ? await fs.stat(file).catch(() => null) : null;
        if (!stat || stat.mtimeMs <= marker.failedAt) leftovers.push(uc.id);
      }
      if (leftovers.length) {
        try {
          const result = await writeSpecs(project, model, {
            preserveEdited: true,
            embedScreenImages: model.options?.embedScreenImages ?? true,
            useCaseIds: leftovers,
            refreshPreserved: true,
          });
          for (const message of result.warnings ?? []) warn(message);
          await saveModel(projectId, model);
        } catch (err) {
          return unsafe(
            `The spec files of the last generation could not all be written (${errorMessage(err)}).`,
          );
        }
      }
    }
    await clearCommitMarker(projectId);
    return { syncSafe: true };
  });
}
