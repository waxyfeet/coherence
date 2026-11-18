/**
 * OWNER: server-core builder.
 * Disk persistence for projects, screens, the solution model and impact reports.
 * Layout: see `paths` in ../config.ts. All JSON writes are atomic (write temp + rename).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type {
  CreateProjectRequest,
  UpdateProjectRequest,
  UpdateScreenRequest,
} from "@shared/api";
import type {
  ImpactReport,
  Project,
  ProjectSummary,
  Screen,
  SolutionModel,
} from "@shared/types";
import { DEFAULT_FORMAT_ID, slugify } from "@shared/types";
import { config, paths } from "../config";
import { BadRequestError, HttpError, NotFoundError } from "../errors";
import {
  PRIVATE_DIR_MODE,
  ensureDir,
  fileTimestamp,
  isNotFound,
  pathExists,
  readJsonIfExists,
  writeFileAtomic,
  writeJsonAtomic,
  readOwnedFile,
} from "./fsUtils";
import { inspectScreenImage } from "./imageInfo";

import { analysisModelDefaults } from "@shared/analysisDefaults";
import { loadSharp } from "../llm/sharpLoader";
import {
  initialiseRegistry,
  registryEntries,
  registryEntry,
  projectUnavailable,
  unavailableSummary,
  reserveProjectFolder,
  publishProject,
  transitionProject,
} from "./projectRegistry";
import { regularPath, relativeFile } from "./pathSafety";
import { withProjectNamespace } from "./projectNamespace";
import { removeOrphanedTemporaries } from "./temporaries";
import { PROFILE_MIGRATIONS, runMigrations } from "./migrations";
import { MODEL_SCHEMA_VERSION, NewerDataError, isNewerFormat } from "./formats";
import {
  assertOutsideProjects,
  assertProjectFreeTree,
} from "./projectBoundaries";

export interface UploadedImage {
  originalName: string;
  mimeType: string;
  buffer: Buffer;
}

/** Project history is retained; there is no automatic snapshot pruning. */
const MAX_NAME_LENGTH = 120;
const MAX_SCREEN_NAME_LENGTH = 120;

/* ------------------------------------------------------------------ */
/* Ids & guards                                                        */
/* ------------------------------------------------------------------ */

// IDs are bounded slugs with a random suffix; reject traversal before registry access.
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export function isValidProjectId(projectId: string): boolean {
  return PROJECT_ID_RE.test(projectId);
}

function assertProjectId(projectId: string): void {
  if (!isValidProjectId(projectId))
    throw new NotFoundError(`Project "${projectId}" was not found.`);
}

/** Refuse writes into a project that was deleted (moved to trash) — otherwise a late job write would resurrect a ghost directory. */
async function assertProjectDirExists(projectId: string): Promise<void> {
  assertProjectId(projectId);
  if (!(await pathExists(paths.projectFile(projectId)))) {
    throw new NotFoundError(
      `Project "${projectId}" was not found — it may have been deleted.`,
    );
  }
}

const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

/** Initialise global state and its project-location registry. */
export async function ensureDataDirs(): Promise<void> {
  assertOutsideProjects(config.dataDir);
  // The global profile holds settings metadata; project evidence stays in its own folder.
  await ensureDir(config.dataDir, PRIVATE_DIR_MODE);
  // Data-format updates run before the registry or settings are read (installer report §5.4).
  const migrated = await runMigrations(config.dataDir, PROFILE_MIGRATIONS);
  if (migrated.length)
    console.log(`Updated saved data for this version: ${migrated.join(", ")}`);
  {
    await initialiseRegistry();
    return;
  }
}

/**
 * A crash or restart during generation leaves project.status = 'generating' forever. Reset those to
 * 'specified' (a model exists) or 'draft'. Called once at startup, before any job can run.
 */
export async function recoverInterruptedProjects(): Promise<string[]> {
  const recovered: string[] = [];
  for (const projectId of await listProjectIds()) {
    try {
      await withProjectLock(projectId, async () => {
        // Leftovers of writes cut short by a crash (installer finding ST-14).
        const root = paths.projectDir(projectId);
        for (const folder of [root, path.join(root, "jobs")])
          await removeOrphanedTemporaries(folder);
        const project = await getProject(projectId);
        if (project.status !== "generating") return;
        project.status = (await pathExists(paths.modelFile(projectId)))
          ? "specified"
          : "draft";
        await saveProject(project);
        recovered.push(projectId);
      });
    } catch (err) {
      console.warn(
        `[storage] Could not check project "${projectId}": details withheld; check file access and JSON integrity`,
      );
    }
  }
  return recovered;
}

/* ------------------------------------------------------------------ */
/* Per-project lock                                                    */
/* ------------------------------------------------------------------ */

interface LockToken {
  active: boolean;
}

const lockTails = new Map<string, Promise<void>>();
// Tracks which project locks the current async call chain holds, so nested withProjectLock calls on the
// same project (e.g. a store helper called from inside another module's locked section) do not deadlock.
const heldLocks = new AsyncLocalStorage<Map<string, LockToken>>();

/**
 * Serialise read-modify-write sequences on one project's files (project.json, model.json, reports).
 * Hold it only around the final read-modify-write, never across long LLM calls.
 */
export async function withProjectLock<T>(
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const held = heldLocks.getStore();
  if (held?.get(projectId)?.active) return fn();

  const previous = lockTails.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  lockTails.set(projectId, tail);

  await previous;
  const token: LockToken = { active: true };
  const store = new Map(held ?? []);
  store.set(projectId, token);
  try {
    return await heldLocks.run(store, fn);
  } finally {
    // Async work that leaked out of fn (not awaited) must not keep acting as the lock holder.
    token.active = false;
    release();
    if (lockTails.get(projectId) === tail) lockTails.delete(projectId);
  }
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

export async function listProjectIds(): Promise<string[]> {
  {
    await initialiseRegistry();
    return registryEntries("active")
      .filter((e) => !projectUnavailable(e.id))
      .map((e) => e.id);
  }
}

// useCaseCount needs model.json, which can be large; cache the count per file mtime.
const useCaseCountCache = new Map<
  string,
  { mtimeMs: number; size: number; count: number }
>();

async function readUseCaseCount(projectId: string): Promise<number> {
  const file = paths.modelFile(projectId);
  let stat: fsSync.Stats;
  try {
    stat = await fs.stat(file);
  } catch {
    useCaseCountCache.delete(projectId);
    return 0;
  }
  const cached = useCaseCountCache.get(projectId);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size)
    return cached.count;
  let count = 0;
  try {
    const model = await readJsonIfExists<SolutionModel>(file);
    count = Array.isArray(model?.useCases) ? model.useCases.length : 0;
  } catch {
    count = 0;
  }
  useCaseCountCache.set(projectId, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    count,
  });
  return count;
}

function toSummary(project: Project, useCaseCount: number): ProjectSummary {
  return {
    ...(project.storage
      ? {
          projectPath: paths.projectDir(project.id),
          availability: "available" as const,
        }
      : {}),
    id: project.id,
    name: project.name,
    areaId: project.areaId,
    description: project.description,
    status: project.status,
    screenCount: project.screens.length,
    useCaseCount,
    thumbnailScreenId: project.screens[0]?.id,
    updatedAt: project.updatedAt,
    lastGeneratedAt: project.lastGeneratedAt,
  };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const summaries: ProjectSummary[] = [];
  for (const projectId of await listProjectIds()) {
    try {
      const project = await readProjectFile(projectId);
      if (!project) continue;
      summaries.push(toSummary(project, await readUseCaseCount(projectId)));
    } catch (err) {
      // One damaged project must not hide all the others.
      console.warn(
        `[storage] Skipping project "${projectId}": details withheld; check file access and JSON integrity`,
      );
    }
  }
  for (const entry of registryEntries("active"))
    if (projectUnavailable(entry.id)) summaries.push(unavailableSummary(entry));
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Fills fields that older files may lack and keeps screens in order. */
function normaliseProject(raw: Project): Project {
  const screens = Array.isArray(raw.screens) ? [...raw.screens] : [];
  screens.sort((a, b) => a.order - b.order);
  return {
    ...raw,
    description: raw.description ?? "",
    additionalContext: raw.additionalContext ?? "",
    formatId: raw.formatId || DEFAULT_FORMAT_ID,
    outputDir: paths.defaultSpecsDir(raw.id),
    projectPath: paths.projectDir(raw.id),
    llm: raw.llm ?? {},
    screens: screens.map((s) => ({ ...s, notes: s.notes ?? "" })),
    status: raw.status ?? "draft",
  };
}

async function readProjectFile(
  projectId: string,
): Promise<Project | undefined> {
  // Registry lookup errors (unknown/trashed/unavailable project) retain their
  // meaningful status instead of being mislabeled as corrupt file contents.
  const file = paths.projectFile(projectId);
  let raw: Project | undefined;
  try {
    raw = await readJsonIfExists<Project>(file);
  } catch (err) {
    throw new HttpError(
      500,
      `The project file for "${projectId}" could not be read (details withheld; check file access and JSON integrity). It may have been edited by hand.`,
      "CORRUPT_PROJECT",
    );
  }

  if (raw && raw.id !== projectId)
    throw new BadRequestError(
      "The project identity does not match its registered folder.",
    );
  return raw ? normaliseProject(raw) : undefined;
}

/** @throws NotFoundError */
export async function getProject(projectId: string): Promise<Project> {
  assertProjectId(projectId);
  const project = await readProjectFile(projectId);
  if (!project)
    throw new NotFoundError(`Project "${projectId}" was not found.`);
  return project;
}

function cleanName(
  name: string | undefined,
  what: string,
  max: number,
): string {
  const cleaned = (name ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) throw new BadRequestError(`${what} cannot be empty.`);
  if (cleaned.length > max)
    throw new BadRequestError(`${what} is too long (max ${max} characters).`);
  return cleaned;
}

/** Create a dedicated complete project in the selected workspace. */

export async function createProject(
  req: CreateProjectRequest,
  prepare?: (project: Project) => Promise<void>,
): Promise<Project> {
  await initialiseRegistry();
  // Hold through manifest publication, not just mkdir: another profile must not
  // adopt a workspace inside an as-yet unmarked, partially prepared project.
  return withProjectNamespace(() => createProjectLocked(req, prepare));
}
async function createProjectLocked(
  req: CreateProjectRequest,
  prepare?: (project: Project) => Promise<void>,
): Promise<Project> {
  const name = cleanName(req.name, "The project name", MAX_NAME_LENGTH);
  if (req.outputDir?.trim())
    throw new BadRequestError(
      "Choose a project workspace. Requirements stay inside the complete project folder.",
    );
  // Validate a custom folder before claiming an id, so a bad path leaves nothing behind.

  // Snapshot complete defaults before claiming a folder. Never resolve them again for existing projects.
  const { getSettings } = await import("./settingsStore");
  const settings = await getSettings();
  const initialModels = analysisModelDefaults(
    settings.analysisDefaults,
    settings.connections,
  );
  await ensureDataDirs();

  // Claim a unique slug atomically: a non-recursive mkdir fails with EEXIST if someone else has it.
  const base = `${slugify(name, 60)}-${nanoid(10).toLowerCase().replace(/_/g, "-")}`;
  const projectId = base;
  const storage = await reserveProjectFolder(projectId, req.workspaceDir);

  const timestamp = now();
  const project: Project = {
    storage,
    id: projectId,
    name,
    areaId: req.areaId || undefined,
    description: (req.description ?? "").trim(),
    additionalContext: (req.additionalContext ?? "").trim(),
    formatId: req.formatId?.trim() || DEFAULT_FORMAT_ID,
    outputDir: paths.defaultSpecsDir(projectId),
    llm: initialModels,
    localOnly: req.localOnly ?? false,
    screens: [],
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  try {
    await prepare?.(project);
    await writeProjectRecord(project);
    await publishProject(project);
  } catch (err) {
    // Retain uncertain partial projects for explicit recovery; never recursively
    // remove a nominated user-owned folder after a preparation failure.
    throw err;
  }
  return normaliseProject(project);
}

/** Validated user patch (from the API). */
export async function updateProject(
  projectId: string,
  req: UpdateProjectRequest,
): Promise<Project> {
  return withProjectLock(projectId, async () => {
    const project = await getProject(projectId);
    if (req.name !== undefined)
      project.name = cleanName(req.name, "The project name", MAX_NAME_LENGTH);
    if (req.description !== undefined)
      project.description = req.description.trim();
    if (req.localOnly !== undefined) project.localOnly = req.localOnly;
    if (req.additionalContext !== undefined)
      project.additionalContext = req.additionalContext.trim();
    if (
      req.outputDir !== undefined &&
      req.outputDir !== "" &&
      req.outputDir !== project.outputDir
    )
      throw new BadRequestError(
        "Requirements belong to this Coherence project. Reconnect its complete folder instead of changing only the requirements path.",
      );
    if (req.areaId !== undefined) project.areaId = req.areaId || undefined;
    if (req.formatId !== undefined)
      project.formatId = req.formatId.trim() || DEFAULT_FORMAT_ID;
    if (req.llm) {
      // An explicit project-default edit also replaces the corresponding remembered run choice.
      const prior =
        project.generationPreferences ??
        (await loadModel(projectId).catch(() => null))?.options;
      if (prior) project.generationPreferences = { ...prior };
      const llm = { ...project.llm };
      for (const key of [
        "visionConnectionId",
        "textConnectionId",
        "visionModelId",
        "textModelId",
      ] as const) {
        const value = req.llm[key];
        if (value === undefined) continue;
        if (value === null || value === "") delete llm[key];
        else llm[key] = value;
        if (project.generationPreferences) {
          if (value === null || value === "")
            delete project.generationPreferences[key];
          else project.generationPreferences[key] = value;
        }
      }
      for (const role of ["vision", "text"] as const) {
        const connectionKey = `${role}ConnectionId` as const;
        const modelKey = `${role}ModelId` as const;
        if (
          req.llm[connectionKey] !== undefined &&
          req.llm[modelKey] === undefined
        ) {
          delete llm[modelKey];
          if (project.generationPreferences)
            delete project.generationPreferences[modelKey];
        }
      }
      const readingChanged =
        (req.llm.visionConnectionId !== undefined &&
          req.llm.visionModelId === undefined) ||
        (req.llm.visionConnectionId !== undefined &&
          req.llm.visionConnectionId !== project.llm.visionConnectionId) ||
        (req.llm.visionModelId !== undefined &&
          req.llm.visionModelId !== project.llm.visionModelId);
      if (readingChanged || req.llm.visionAcknowledged !== undefined) {
        if (req.llm.visionAcknowledged !== undefined) {
          llm.visionAcknowledged = req.llm.visionAcknowledged;
          if (project.generationPreferences)
            project.generationPreferences.visionAcknowledged =
              req.llm.visionAcknowledged;
        } else {
          delete llm.visionAcknowledged;
          if (project.generationPreferences)
            delete project.generationPreferences.visionAcknowledged;
        }
      }
      project.llm = llm;
    }
    return saveProject(project);
  });
}

/** Internal full write of a Project record (bumps updatedAt). */
export async function saveProject(project: Project): Promise<Project> {
  await assertProjectDirExists(project.id);
  project.screens.sort((a, b) => a.order - b.order);
  project.updatedAt = now();
  await writeProjectRecord(project);
  return project;
}

async function writeProjectRecord(project: Project) {
  if (!project.storage)
    throw new BadRequestError(
      "Unsupported Coherence project format. No files were changed.",
    );
  const { projectPath: _path, outputHistory: _history, ...record } = project;
  await writeJsonAtomic(paths.projectFile(project.id), {
    ...record,
    outputDir: "specs",
  });
}

/** Move the complete project to same-volume .coherence-trash via the registry journal. */
export async function deleteProject(projectId: string): Promise<void> {
  await withProjectLock(projectId, async () => {
    await getProject(projectId);
    {
      const entry = registryEntry(projectId);
      const parent = path.join(path.dirname(entry.root), ".coherence-trash");
      regularPath(parent);
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      regularPath(parent, false);
      const trashId = `${projectId}-${fileTimestamp()}`;
      await transitionProject(
        projectId,
        path.join(parent, trashId),
        "trash",
        trashId,
      );
      useCaseCountCache.delete(projectId);
      return;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

function newScreenId(): string {
  // Ids end up in paths and element ids; keep them to [A-Za-z0-9_].
  return `scr_${nanoid(10).replace(/-/g, "_")}`;
}

function screenNameFromFile(originalName: string, fallback: string): string {
  const base = path
    .basename(originalName.replace(/\\/g, "/"))
    .replace(/\.[a-z0-9]{1,5}$/i, "");
  const cleaned = base
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SCREEN_NAME_LENGTH)
    .trim();
  return cleaned || fallback;
}

function screenDir(projectId: string, screenId: string): string {
  return path.join(paths.screensDir(projectId), screenId);
}

function findScreen(project: Project, screenId: string): Screen {
  if (!SAFE_ID_RE.test(screenId))
    throw new BadRequestError("Invalid screenshot identity.");
  const screen = project.screens.find((s) => s.id === screenId);
  if (!screen)
    throw new NotFoundError(
      `Screen "${screenId}" was not found in project "${project.name}".`,
    );
  return screen;
}

/** Decodes a small preview so an image that cannot be read is refused before it is stored. */
async function assertDecodable(file: UploadedImage): Promise<void> {
  // Loaded outside the try: an unavailable image library is not a damaged screenshot.
  const sharp = await loadSharp();
  try {
    await sharp(file.buffer, { limitInputPixels: 40_000_000, failOn: "error" })
      .resize({ width: 32, height: 32, fit: "inside" })
      .raw()
      .toBuffer();
  } catch {
    throw new BadRequestError(
      `"${file.originalName}" could not be decoded. Re-export the screenshot and try again.`,
    );
  }
}

/** Validates type (png/jpeg/webp/gif by magic bytes), reads dimensions, stores as screens/<id>/v1.<ext>. */
export async function addScreens(
  projectId: string,
  files: UploadedImage[],
): Promise<Screen[]> {
  if (!files.length)
    throw new BadRequestError("Choose at least one image to upload.");
  // Validate everything before writing anything, so a bad file does not leave half an upload behind.
  const inspected = files.map((file) => ({
    file,
    info: inspectScreenImage(file.buffer, file.originalName),
  }));
  if (
    files.length > 50 ||
    files.some((f) => f.buffer.length > 25 * 1024 * 1024) ||
    files.reduce((sum, f) => sum + f.buffer.length, 0) > 100 * 1024 * 1024
  )
    throw new BadRequestError(
      "Upload at most 50 files, 25 MB per file and 100 MB in total.",
    );
  for (const { file } of inspected) await assertDecodable(file);

  return withProjectLock(projectId, async () => {
    const project = await getProject(projectId);
    let nextOrder =
      project.screens.reduce((max, s) => Math.max(max, s.order), -1) + 1;
    const added: Screen[] = [];
    try {
      for (const { file, info } of inspected) {
        const id = newScreenId();
        const fileName = `${id}/v1.${info.ext}`;
        const dir = screenDir(projectId, id);
        await ensureDir(dir);
        await writeFileAtomic(path.join(dir, `v1.${info.ext}`), file.buffer);
        added.push({
          id,
          name: screenNameFromFile(
            file.originalName,
            `Screen ${nextOrder + 1}`,
          ),
          notes: "",
          order: nextOrder++,
          version: 1,
          fileName,
          originalFileName: path.basename(
            (file.originalName || `screen.${info.ext}`).replace(/\\/g, "/"),
          ),
          mimeType: info.mimeType,
          width: info.width,
          height: info.height,
          sizeBytes: file.buffer.length,
          uploadedAt: now(),
        });
      }
      project.screens.push(...added);
      await saveProject(project);
    } catch (err) {
      throw err;
    }
    return added;
  });
}

export async function updateScreen(
  projectId: string,
  screenId: string,
  req: UpdateScreenRequest,
): Promise<Screen> {
  return withProjectLock(projectId, async () => {
    const project = await getProject(projectId);
    const screen = findScreen(project, screenId);
    if (req.name !== undefined)
      screen.name = cleanName(
        req.name,
        "The screen name",
        MAX_SCREEN_NAME_LENGTH,
      );
    if (req.notes !== undefined) screen.notes = req.notes.trim();
    await saveProject(project);
    return screen;
  });
}

/** Stores the new image as v<version+1>; keeps old versions. */
export async function replaceScreenImage(
  projectId: string,
  screenId: string,
  file: UploadedImage,
): Promise<Screen> {
  const info = inspectScreenImage(file.buffer, file.originalName);
  if (file.buffer.length > 25 * 1024 * 1024)
    throw new BadRequestError("Screenshots may be at most 25 MB each.");
  await assertDecodable(file);
  return withProjectLock(projectId, async () => {
    const project = await getProject(projectId);
    const screen = findScreen(project, screenId);
    let version = screen.version + 1;
    let target = path.join(
      screenDir(projectId, screenId),
      `v${version}.${info.ext}`,
    );
    while (await pathExists(target)) {
      version++;
      target = path.join(
        screenDir(projectId, screenId),
        `v${version}.${info.ext}`,
      );
    }
    await writeFileAtomic(target, file.buffer);
    screen.version = version;
    screen.fileName = `${screenId}/v${version}.${info.ext}`;
    screen.originalFileName = path.basename(
      (file.originalName || `screen.${info.ext}`).replace(/\\/g, "/"),
    );
    screen.mimeType = info.mimeType;
    screen.width = info.width;
    screen.height = info.height;
    screen.sizeBytes = file.buffer.length;
    screen.uploadedAt = now();
    try {
      await saveProject(project);
    } catch (err) {
      throw err;
    }
    return screen;
  });
}

/** screenIds must be a permutation of the project's screen ids. */
export async function reorderScreens(
  projectId: string,
  screenIds: string[],
): Promise<Screen[]> {
  return withProjectLock(projectId, async () => {
    const project = await getProject(projectId);
    const known = new Set(project.screens.map((s) => s.id));
    const given = new Set(screenIds);
    const isPermutation =
      screenIds.length === known.size &&
      given.size === screenIds.length &&
      screenIds.every((id) => known.has(id));
    if (!isPermutation) {
      throw new BadRequestError(
        "The new order must list every screen of the project exactly once. Refresh the page and try again.",
      );
    }
    const position = new Map(screenIds.map((id, i) => [id, i]));
    for (const screen of project.screens)
      screen.order = position.get(screen.id)!;
    await saveProject(project);
    return project.screens;
  });
}

export async function deleteScreen(
  projectId: string,
  screenId: string,
): Promise<void> {
  await withProjectLock(projectId, async () => {
    const project = await getProject(projectId);
    findScreen(project, screenId);
    assertProjectFreeTree(screenDir(projectId, screenId));
    {
      const screen = project.screens.find((s) => s.id === screenId)!;
      await writeJsonAtomic(
        path.join(
          paths.projectDir(projectId),
          "removed-screens",
          `${screenId}.json`,
        ),
        screen,
      );
    }
    project.screens = project.screens
      .filter((s) => s.id !== screenId)
      .map((s, i) => ({ ...s, order: i }));
    await saveProject(project);
    // Portable histories retain removed screen originals/versions and their notes.
  });
}

/** Absolute path of a screen image (current version unless `version` given). */
export function screenImagePath(
  projectId: string,
  screen: Screen,
  version?: number,
): string {
  if (!SAFE_ID_RE.test(screen.id))
    throw new BadRequestError("Invalid screen identity.");
  if (version === undefined || version === screen.version) {
    return relativeFile(paths.screensDir(projectId), screen.fileName);
  }
  const dir = screenDir(projectId, screen.id);
  // Older versions may have a different extension (the BA replaced a PNG with a JPEG).
  try {
    const match = fsSync
      .readdirSync(dir)
      .find((f) => f.startsWith(`v${version}.`));
    if (match) return path.join(dir, match);
  } catch {
    /* fall through to the conventional name; the caller gets ENOENT */
  }
  return path.join(dir, `v${version}${path.extname(screen.fileName)}`);
}

/* ------------------------------------------------------------------ */
/* Solution model                                                      */
/* ------------------------------------------------------------------ */

/** null when the project has never been generated. */
export async function loadModel(
  projectId: string,
): Promise<SolutionModel | null> {
  assertProjectId(projectId);
  let model: SolutionModel | null;
  try {
    model =
      (await readJsonIfExists<SolutionModel>(paths.modelFile(projectId))) ??
      null;
  } catch (err) {
    throw new HttpError(
      500,
      `The solution model (model.json) of "${projectId}" could not be read. Restore a copy from its history folder or generate again.`,
      "CORRUPT_MODEL",
    );
  }
  if (
    isNewerFormat(
      (model as { schemaVersion?: unknown } | null)?.schemaVersion,
      MODEL_SCHEMA_VERSION,
    )
  )
    throw new NewerDataError("This project's model");
  return model;
}

/** Atomic write. With snapshot: true, the previous model.json is first copied to history/. Bumps model.updatedAt. */
export async function saveModel(
  projectId: string,
  model: SolutionModel,
  opts?: { snapshot?: boolean },
): Promise<void> {
  await assertProjectDirExists(projectId);
  // Never replace a model a newer Coherence saved, even from a path that did not read it first (e.g. a new run).
  const existing = await readJsonIfExists<{ schemaVersion?: unknown }>(
    paths.modelFile(projectId),
  ).catch(() => undefined);
  if (isNewerFormat(existing?.schemaVersion, MODEL_SCHEMA_VERSION))
    throw new NewerDataError("This project's model");
  if (opts?.snapshot) await snapshotCurrentModel(projectId);
  model.updatedAt = now();
  await writeJsonAtomic(paths.modelFile(projectId), model);
}

/**
 * Copy the current model.json (if any) to history/model-<ts>.json and prune to the newest snapshots.
 * Returns the snapshot file name, or undefined when there was no model yet.
 */
export async function snapshotCurrentModel(
  projectId: string,
): Promise<string | undefined> {
  const file = paths.modelFile(projectId);
  if (!(await pathExists(file))) return undefined;
  const historyDir = paths.historyDir(projectId);
  await ensureDir(historyDir);
  let name = `model-${fileTimestamp()}.json`;
  // Two snapshots in the same millisecond must not overwrite each other (names must also stay sortable).
  while (await pathExists(path.join(historyDir, name))) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    name = `model-${fileTimestamp()}.json`;
  }
  await writeFileAtomic(path.join(historyDir, name), await readOwnedFile(file));

  return name;
}

/* ------------------------------------------------------------------ */
/* Impact reports                                                      */
/* ------------------------------------------------------------------ */

/** Newest first. */
export async function listImpactReports(
  projectId: string,
): Promise<ImpactReport[]> {
  assertProjectId(projectId);
  const dir = paths.impactDir(projectId);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const reports: ImpactReport[] = [];
  for (const f of files) {
    try {
      const report = await readJsonIfExists<ImpactReport>(path.join(dir, f));
      if (report?.id) reports.push(report);
    } catch (err) {
      console.warn(
        `[storage] Skipping unreadable impact report ${f}: details withheld; check file access and JSON integrity`,
      );
    }
  }
  return reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** @throws NotFoundError */
export async function getImpactReport(
  projectId: string,
  reportId: string,
): Promise<ImpactReport> {
  assertProjectId(projectId);
  if (!SAFE_ID_RE.test(reportId))
    throw new NotFoundError(`Impact report "${reportId}" was not found.`);
  let report: ImpactReport | undefined;
  try {
    report = await readJsonIfExists<ImpactReport>(
      path.join(paths.impactDir(projectId), `${reportId}.json`),
    );
  } catch (err) {
    throw new HttpError(
      500,
      `Impact report "${reportId}" could not be read (details withheld; check file access and JSON integrity).`,
      "CORRUPT_REPORT",
    );
  }
  if (!report)
    throw new NotFoundError(`Impact report "${reportId}" was not found.`);
  return report;
}

export async function saveImpactReport(report: ImpactReport): Promise<void> {
  await assertProjectDirExists(report.projectId);
  if (!SAFE_ID_RE.test(report.id))
    throw new BadRequestError(`Invalid impact report id "${report.id}".`);
  await writeJsonAtomic(
    path.join(paths.impactDir(report.projectId), `${report.id}.json`),
    report,
  );
}
