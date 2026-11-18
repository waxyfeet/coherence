import { readOwnedFile } from "../storage/fsUtils";
import { ensureDir } from "../storage/fsUtils";
import { renameOwnedDirectory } from "../storage/windowsStorageGuard";
/**
 * OWNER: formats builder.
 * Reads/writes the .md spec files in project.outputDir and keeps the SolutionModel in sync with them.
 * Every path coming from the API goes through resolveSpecPath (no traversal outside outputDir, no symlink escape).
 * Functions documented as "persists" save the model themselves via projectStore (inside withProjectLock).
 */
import { randomBytes, createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  RerenderResult,
  SaveSpecFileRequest,
  SaveSpecFileResponse,
  SpecFileContent,
  SyncResult,
} from "@shared/api";
import {
  DEFAULT_FORMAT_ID,
  type Project,
  type Screen,
  type SolutionModel,
  type SpecFileKind,
  type SpecFileNode,
  type UseCase,
  type UseCaseDiff,
  type UseCaseStatus,
} from "@shared/types";
import { paths } from "../config";
import { BadRequestError, ConflictError, NotFoundError } from "../errors";
import {
  carryFrontMatter,
  mergeFrontMatter,
  readFrontMatter,
  splitFrontMatter,
} from "../formats/frontMatter";
import {
  FEATURES_DIR,
  SCREEN_IMAGES_DIR,
  SCREENS_DIR,
  USE_CASES_DIR,
  screenImageRelPath,
} from "../formats/layout";
import { getFormat, hasFormat } from "../formats/registry";
import type { OutputFormat, RenderContext } from "../formats/types";
import { isGeneratedContent } from "../formats/use-case-bdd/shared";
import {
  getProject,
  loadModel,
  saveModel,
  screenImagePath,
  withProjectLock,
} from "../storage/projectStore";
import {
  GHERKIN_EXTS,
  IMAGE_MIME,
  MARKDOWN_EXTS,
  extOf,
  isInside,
  isMissing,
  readTextOrNull,
  removeIfExists,
  statOrNull,
  walk,
  writeFileAtomic,
  writeIfChanged,
} from "./files";
import { applyMerge, mergeParsedUseCase, type MergeOutcome } from "./merge";
import { assertV2Path } from "../storage/boundary";

export interface WriteSpecsOptions {
  /** Skip use case files whose model status is 'edited' or 'approved' AND whose file exists. */
  preserveEdited: boolean;
  embedScreenImages: boolean;
  /** Only (re)write these use case files (support files are always rewritten). Default: all. */
  useCaseIds?: string[];
  /**
   * Refresh the generated parts (front matter, summary links) of preserved edited/approved files, content
   * sections untouched. Set after a generation, where the other use cases may have been renumbered.
   */
  refreshPreserved?: boolean;
}

export interface WriteSpecsResult {
  /** POSIX paths relative to outputDir. */
  written: string[];
  preserved: string[];
  /**
   * BA-readable notes about files that were left alone: files Coherence did not write where it would write a
   * derived file, use case files whose id is not in the model, and files moved out of the folder.
   */
  warnings: string[];
}

/** rerenderSpecs' answer: the RerenderResult contract plus the write warnings. */
export interface RerenderOutcome extends RerenderResult {
  warnings: string[];
}

/** Marks an output folder as written by one project, so a second project cannot overwrite it. */
export const FOLDER_OWNER_FILE = ".coherence.json";
/**
 * The same marker before the visible rename (installer Stage 7). It is still read, and a folder it already claims for
 * this project is left as it is; it is never written again.
 */
export const LEGACY_FOLDER_OWNER_FILE = ".screenscribe.json";

/** Use case files Coherence takes out of the folder go here (in the project's data folder), newest batches kept. */
export const REMOVED_FILES_DIR = "removed-files";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatFor(
  project: Project,
  model: SolutionModel | null,
): OutputFormat {
  return getFormat(model?.formatId || project.formatId || DEFAULT_FORMAT_ID);
}

function outputRoot(project: Project): string {
  {
    const root = paths.defaultSpecsDir(project.id);
    if (!sameFolder(project.outputDir, root))
      throw new ConflictError(
        "Portable project requirements cannot be redirected outside their project.",
      );
    return assertV2Path(root);
  }
}

function abs(project: Project, rel: string): string {
  return resolveSpecPath(project, rel);
}

function renderCtx(
  project: Project,
  model: SolutionModel,
  embedScreenImages?: boolean,
): RenderContext {
  return {
    project,
    model,
    embedScreenImages:
      embedScreenImages ?? model.options?.embedScreenImages ?? true,
  };
}

function now(): string {
  return new Date().toISOString();
}

/** Front matter id/format of a markdown file (null when it has none). */
function useCaseHeader(
  markdown: string,
): { id?: string; format?: string; status?: string } | null {
  const fm = readFrontMatter(markdown);
  if (!fm.data) return null;
  const str = (v: unknown) =>
    typeof v === "string" || typeof v === "number"
      ? String(v).trim()
      : undefined;
  return {
    id: str(fm.data.id),
    format: str(fm.data.format),
    status: str(fm.data.status),
  };
}

function isUseCaseRel(rel: string): boolean {
  return rel.startsWith(`${USE_CASES_DIR}/`) && MARKDOWN_EXTS.has(extOf(rel));
}

function useCaseIdFromName(name: string): string | undefined {
  return /^(UC-\d{3,})(?:[-_.\s]|$)/i.exec(name)?.[1]?.toUpperCase();
}

async function exists(project: Project, rel: string): Promise<boolean> {
  return (await statOrNull(abs(project, rel)))?.isFile() ?? false;
}

/** A recorded filePath is trusted only when it is a plain relative path inside the folder. */
function safeRecordedPath(rel: string | undefined): string | undefined {
  if (
    !rel ||
    rel.includes("\0") ||
    rel.includes(":") ||
    rel.startsWith("/") ||
    rel.includes("\\")
  )
    return undefined;
  if (rel.split("/").some((seg) => seg === ".." || seg === ""))
    return undefined;
  return rel;
}

function ownedFrontMatterKeys(format: OutputFormat): readonly string[] {
  return format.frontMatterKeys ?? [];
}

/* ------------------------------------------------------------------ */
/* Output folder ownership                                             */
/* ------------------------------------------------------------------ */

function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) =>
    process.platform === "win32"
      ? path.resolve(p).toLowerCase()
      : path.resolve(p);
  return norm(a) === norm(b);
}

async function folderOwner(root: string): Promise<string | null> {
  const read = (name: string) =>
    readTextOrNull(path.join(root, name)).catch(() => null);
  // The current marker wins; a folder claimed before the rename has only the old one.
  const raw =
    (await read(FOLDER_OWNER_FILE)) ?? (await read(LEGACY_FOLDER_OWNER_FILE));
  if (!raw) return null;
  try {
    const id = (JSON.parse(raw) as { projectId?: unknown }).projectId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Two projects writing to one folder overwrite and delete each other's use case files. The first project to
 * write claims the folder (FOLDER_OWNER_FILE); any other project is refused while the claiming project still
 * exists and still writes there. @throws ConflictError
 */
export async function assertOutputFolderAvailable(
  project: Project,
): Promise<void> {
  const root = outputRoot(project);
  const owner = await folderOwner(root);
  if (!owner || owner === project.id) return;
  const other = await getProject(owner).catch(() => null);
  if (!other || !other.outputDir || !sameFolder(other.outputDir, root)) return; // gone, or writes elsewhere now
  throw new ConflictError(
    `The output folder ${root} already holds the specs of the project "${other.name}". Two projects cannot share an output folder — their files would overwrite each other. Choose another folder on the Overview page.`,
    { outputDir: root, projectId: other.id },
  );
}

async function claimOutputFolder(
  project: Project,
  root: string,
): Promise<void> {
  await assertOutputFolderAvailable(project);
  if ((await folderOwner(root)) === project.id) return;
  const marker = {
    generator: "Coherence",
    projectId: project.id,
    note: "This folder holds the specs of one Coherence project. Another project will not write here while that project uses it.",
  };
  await writeFileAtomic(
    path.join(root, FOLDER_OWNER_FILE),
    `${JSON.stringify(marker, null, 2)}\n`,
  );
}

/* ------------------------------------------------------------------ */
/* Retiring use case files                                             */
/* ------------------------------------------------------------------ */

/**
 * Use case files are never deleted outright: one may hold BA edits that were never synced (an edit made in
 * another editor does not change its status). They are moved to <project data folder>/removed-files/<time>/,
 * one batch per write; retained history is not automatically pruned.
 */
interface FileRetirer {
  retire(rel: string): Promise<void>;
  /** Paths taken out so far. */
  moved: string[];
}

function fileRetirer(project: Project): FileRetirer {
  const batch = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const moved: string[] = [];
  const retire = async (rel: string): Promise<void> => {
    const projectDir = paths.projectDir(project.id);
    if (!(await statOrNull(projectDir))?.isDirectory()) return; // the project was deleted: leave the file
    const source = abs(project, rel);
    const target = path.join(
      projectDir,
      REMOVED_FILES_DIR,
      batch,
      ...rel.split("/"),
    );
    await ensureDir(path.dirname(target));
    {
      const identity = (await fs.stat(source, { bigint: true })).ino.toString();
      await renameOwnedDirectory(source, target, identity);
      moved.push(rel);
      return;
    }
  };
  return { retire, moved };
}

/* ------------------------------------------------------------------ */
/* writeSpecs                                                          */
/* ------------------------------------------------------------------ */

/**
 * Render and write all spec files for the model: use-cases/*.md, README.md, screens/*.md, REVIEW.md,
 * CHANGELOG.md, and copy current screen images to screens/images/<screenKey>.<ext>.
 * Takes out (see fileRetirer) the use case files this project wrote for use cases the model no longer has —
 * judged against the model saved on disk, so call it before saving the new model. Files it did not write
 * (unknown ids, hand-written derived files) are left alone and reported in `warnings`.
 * MUTATES model.useCases[*].filePath (the caller saves the model). Does not persist.
 * @throws ConflictError when another project writes to the same output folder.
 */
export async function writeSpecs(
  project: Project,
  model: SolutionModel,
  opts: WriteSpecsOptions,
): Promise<WriteSpecsResult> {
  const format = formatFor(project, model);
  const root = outputRoot(project);
  await fs.mkdir(path.join(root, USE_CASES_DIR), { recursive: true });
  await claimOutputFolder(project, root);
  const written: string[] = [];
  const preserved: string[] = [];
  const warnings: string[] = [];
  const only = opts.useCaseIds ? new Set(opts.useCaseIds) : null;
  const retirer = fileRetirer(project);

  // 1. Decide where every use case lives before rendering, so cross-links point at the right files.
  const toWrite: { uc: UseCase; target: string; previous?: string }[] = [];
  const toRefresh: UseCase[] = [];
  for (const uc of model.useCases) {
    const target = format.useCasePath(uc);
    const recorded = safeRecordedPath(uc.filePath);
    if (only && !only.has(uc.id)) {
      uc.filePath =
        recorded && (await exists(project, recorded)) ? recorded : target;
      continue;
    }
    if (
      opts.preserveEdited &&
      (uc.status === "edited" || uc.status === "approved")
    ) {
      const existing =
        recorded && (await exists(project, recorded))
          ? recorded
          : (await exists(project, target))
            ? target
            : undefined;
      if (existing) {
        uc.filePath = existing;
        preserved.push(existing);
        if (opts.refreshPreserved) toRefresh.push(uc);
        continue;
      }
    }
    toWrite.push({
      uc,
      target,
      previous: recorded && recorded !== target ? recorded : undefined,
    });
    uc.filePath = target;
  }

  // 2. Screen images (always copied: screen documents embed them).
  written.push(...(await copyScreenImages(project, model, root)));

  // 3. Use case files. Front-matter keys the BA added to the file being replaced are carried over.
  const ctx = renderCtx(project, model, opts.embedScreenImages);
  const owned = ownedFrontMatterKeys(format);
  for (const { uc, target, previous } of toWrite) {
    let content = format.renderUseCase(uc, ctx);
    for (const rel of previous ? [target, previous] : [target]) {
      const existing = await readTextOrNull(abs(project, rel));
      if (existing !== null && useCaseHeader(existing)?.id === uc.id) {
        content = carryFrontMatter(existing, content, owned);
        break;
      }
    }
    await writeIfChanged(abs(project, target), content);
    written.push(target);
    if (previous)
      await removeRenamedUseCase(
        project,
        previous,
        uc.id,
        format.info.id,
        retirer,
      );
  }
  for (const uc of toRefresh)
    await refreshPreservedFile(project, format, ctx, uc);

  // 4. Use case files this project wrote whose use case left the model. A partial write (useCaseIds) never
  //    removes anything: the model it got is not a new generation.
  if (!only) {
    const previousModel = await loadModel(project.id).catch(() => null);
    warnings.push(
      ...(await removeStaleUseCaseFiles(
        project,
        model,
        previousModel,
        format,
        new Set(toWrite.map((w) => w.uc.id)),
        retirer,
      )),
    );
  }
  if (retirer.moved.length) {
    const n = retirer.moved.length;
    warnings.push(
      `Moved ${n} old use case file${n === 1 ? "" : "s"} out of the folder (into the project's ${REMOVED_FILES_DIR} folder in the Coherence data folder): ${retirer.moved.join(", ")}.`,
    );
  }

  // 5. Derived files (README, screens, reports, Gherkin) — always rewritten, unless a file Coherence did not
  //    write is in the way.
  const support = await writeSupport(project, model, format, ctx);
  written.push(...support.written);
  warnings.push(...support.warnings);
  return { written, preserved, warnings };
}

/** A kept BA-owned file: new front matter + summary links from the model, every content line as it is. */
async function refreshPreservedFile(
  project: Project,
  format: OutputFormat,
  ctx: RenderContext,
  uc: UseCase,
): Promise<void> {
  const rel = uc.filePath;
  if (!rel) return;
  const current = await readTextOrNull(abs(project, rel));
  // Only a file that is still unmistakably this use case; anything else is left alone.
  if (current === null || useCaseHeader(current)?.id !== uc.id) return;
  const next = format.refreshGeneratedParts
    ? format.refreshGeneratedParts(current, uc, ctx)
    : mergeFrontMatter(
        current,
        `---\n${splitFrontMatter(format.renderUseCase(uc, ctx)).yaml}\n---`,
        ownedFrontMatterKeys(format),
      );
  await writeIfChanged(abs(project, rel), next);
}

/** The old-name copy of a use case that was just written under a new name. True when it was taken out. */
async function removeRenamedUseCase(
  project: Project,
  rel: string,
  id: string,
  formatId: string,
  retirer: FileRetirer,
): Promise<void> {
  const content = await readTextOrNull(abs(project, rel));
  if (content === null) return;
  const header = useCaseHeader(content);
  // Only the same generated use case; an edited, approved or stale copy stays where the BA left it.
  if (
    header?.id === id &&
    header.format === formatId &&
    !isBaOwnedStatus(header.status)
  )
    await retirer.retire(rel);
}

function isBaOwnedStatus(status: string | undefined): boolean {
  return status === "edited" || status === "approved" || status === "stale";
}

/**
 * Takes out the use case files this project wrote for use cases that are no longer in the model: the id was in
 * the model saved on disk (`previousModel`) and the file is the one recorded for it. Any other file of the
 * format whose id the model does not know — written by hand, pulled from git, another project's — is left
 * alone and reported. Returns BA-readable warnings.
 */
async function removeStaleUseCaseFiles(
  project: Project,
  model: SolutionModel,
  previousModel: SolutionModel | null,
  format: OutputFormat,
  rewritten: Set<string>,
  retirer: FileRetirer,
): Promise<string[]> {
  const dir = abs(project, USE_CASES_DIR);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const byId = new Map(model.useCases.map((uc) => [uc.id, uc]));
  // The file this project last wrote for each use case of the saved model.
  const ownFile = new Map(
    (previousModel?.useCases ?? []).map((uc) => [
      uc.id,
      safeRecordedPath(uc.filePath) ?? format.useCasePath(uc),
    ]),
  );
  const warnings: string[] = [];
  for (const name of names.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  )) {
    if (!MARKDOWN_EXTS.has(extOf(name)) || name.startsWith(".")) continue;
    const rel = `${USE_CASES_DIR}/${name}`;
    const content = await readTextOrNull(path.join(dir, name));
    if (content === null) continue;
    const header = useCaseHeader(content);
    if (!header?.id || header.format !== format.info.id) continue;
    const uc = byId.get(header.id);
    const ours = ownFile.get(header.id) === rel;
    if (!uc) {
      if (ours) await retirer.retire(rel);
      else
        warnings.push(
          `${rel} (${header.id}) is not in the solution model and was left as it is — use "Sync from disk" to add it as a use case.`,
        );
      continue;
    }
    // A leftover generated copy of a use case that was just rewritten under another name.
    if (
      uc.filePath !== rel &&
      rewritten.has(uc.id) &&
      ours &&
      !isBaOwnedStatus(header.status)
    )
      await retirer.retire(rel);
  }
  return warnings;
}

async function copyScreenImages(
  project: Project,
  model: SolutionModel,
  root: string,
): Promise<string[]> {
  const written: string[] = [];
  const current = new Map<string, { name: string; screen: Screen }>(); // screenKey → file name
  for (const analysis of model.screens) {
    const screen = project.screens.find((s) => s.id === analysis.screenId);
    if (!screen) continue;
    const rel = screenImageRelPath(analysis.screenKey, screen);
    current.set(analysis.screenKey, { name: path.posix.basename(rel), screen });
    let source: string;
    try {
      source = screenImagePath(project.id, screen);
    } catch {
      continue;
    }
    const src = await readOwnedFile(source).catch((err: unknown) => {
      if (isMissing(err)) return null;
      throw err;
    });
    if (!src) continue;
    const dest = resolveSpecPath(project, rel);
    const existing = await readOwnedFile(dest).catch(() => null);
    if (!existing || !existing.equals(src)) await writeFileAtomic(dest, src);
    written.push(rel);
  }
  // A replaced screen may change format (login.png → login.jpg): drop the other-extension copy — only when it
  // is a copy of one of that screen's images, never an image the BA put there.
  const dir = path.join(root, ...SCREEN_IMAGES_DIR.split("/"));
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const ext = extOf(name);
    if (!IMAGE_MIME[ext]) continue;
    const keep = current.get(name.slice(0, -ext.length));
    if (
      keep &&
      keep.name !== name &&
      (await isCopyOfScreen(project, keep.screen, path.join(dir, name)))
    ) {
      await removeIfExists(path.join(dir, name));
    }
  }
  return written;
}

/** True when `file` holds the same bytes as one of the stored versions of `screen`. */
async function isCopyOfScreen(
  project: Project,
  screen: Screen,
  file: string,
): Promise<boolean> {
  const bytes = await readOwnedFile(file).catch(() => null);
  if (!bytes) return false;
  for (let version = screen.version; version >= 1; version--) {
    let source: string;
    try {
      source = screenImagePath(project.id, screen, version);
    } catch {
      continue;
    }
    const stored = await readOwnedFile(source).catch(() => null);
    if (stored?.equals(bytes)) return true;
  }
  return false;
}

/**
 * Writes the format's derived files and removes derived screen docs / feature files that no longer apply.
 * A file at a derived path that Coherence did not write (no generated-file marker — e.g. the team's own
 * README.md in a folder the BA pointed the output at) is left untouched and reported.
 */
async function writeSupport(
  project: Project,
  model: SolutionModel,
  format: OutputFormat,
  ctx: RenderContext,
): Promise<{ written: string[]; warnings: string[] }> {
  const files = format.renderSupportFiles(ctx);
  const written: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const rel = safeRecordedPath(file.path);
    if (!rel) continue;
    const existing = await readTextOrNull(abs(project, rel));
    if (
      existing !== null &&
      existing !== file.content &&
      !isGeneratedContent(existing)
    ) {
      skipped.push(rel);
      continue;
    }
    await writeIfChanged(abs(project, rel), file.content);
    written.push(rel);
  }
  const current = new Set([...written, ...skipped]);
  for (const dir of [FEATURES_DIR, SCREENS_DIR]) {
    const names = await fs
      .readdir(abs(project, dir))
      .catch(() => [] as string[]);
    for (const name of names) {
      const rel = `${dir}/${name}`;
      const ext = extOf(name);
      if (
        current.has(rel) ||
        !(GHERKIN_EXTS.has(ext) || MARKDOWN_EXTS.has(ext))
      )
        continue;
      const content = await readTextOrNull(abs(project, rel));
      if (content !== null && isGeneratedContent(content))
        await removeIfExists(abs(project, rel));
    }
  }
  const warnings = skipped.map(
    (rel) =>
      `${rel} already exists and was not written by Coherence — it was left untouched and not updated. Rename or move it to let Coherence write its own ${rel}.`,
  );
  return { written, warnings };
}

/**
 * Re-render only the derived files (README, reports, screen docs, Gherkin) from the model — used after
 * a BA edit or a status change so indexes and feature files stay in sync. Does not persist.
 * Files in the way that Coherence did not write are skipped (see writeSupport).
 */
export async function refreshDerivedFiles(
  project: Project,
  model: SolutionModel,
): Promise<string[]> {
  await assertOutputFolderAvailable(project);
  const format = formatFor(project, model);
  return (await writeSupport(project, model, format, renderCtx(project, model)))
    .written;
}

/**
 * Rewrites only the front matter of the given use cases' files from the model (body untouched, byte for
 * byte; front-matter keys the BA added are kept). Files that do not exist yet are rendered in full. Useful after
 * status/external-link changes (impact analysis marking stale, export recording links). MUTATES filePath when it
 * was unset. Does not persist.
 */
export async function rewriteUseCaseFrontMatter(
  project: Project,
  model: SolutionModel,
  useCaseIds: string[],
): Promise<string[]> {
  await assertOutputFolderAvailable(project);
  const format = formatFor(project, model);
  const ctx = renderCtx(project, model);
  const owned = ownedFrontMatterKeys(format);
  const written: string[] = [];
  for (const id of useCaseIds) {
    const uc = model.useCases.find((x) => x.id === id);
    if (!uc) continue;
    const rel = safeRecordedPath(uc.filePath) ?? format.useCasePath(uc);
    uc.filePath = rel;
    const rendered = format.renderUseCase(uc, ctx);
    const current = await readTextOrNull(abs(project, rel));
    if (current === null) {
      await writeFileAtomic(abs(project, rel), rendered);
    } else {
      const fresh = splitFrontMatter(rendered);
      const block = `---\n${fresh.yaml}\n---`;
      await writeIfChanged(
        abs(project, rel),
        mergeFrontMatter(current, block, owned),
      );
    }
    written.push(rel);
  }
  return written;
}

/* ------------------------------------------------------------------ */
/* Tree, read, raw                                                     */
/* ------------------------------------------------------------------ */

const ROOT_ORDER = [
  "README.md",
  "BUILD-PLAN.md",
  USE_CASES_DIR,
  SCREENS_DIR,
  "QUESTIONS.md",
  "TRACEABILITY.md",
  "DATA-DICTIONARY.md",
  "REVIEW.md",
  "CHANGELOG.md",
  FEATURES_DIR,
];

function kindFor(rel: string): SpecFileKind {
  const ext = extOf(rel);
  if (IMAGE_MIME[ext]) return "image";
  if (GHERKIN_EXTS.has(ext)) return "gherkin";
  const upper = rel.toUpperCase();
  if (upper === "README.MD") return "index";
  if (upper === "CHANGELOG.MD") return "changelog";
  if (upper === "REVIEW.MD") return "review";
  if (
    [
      "QUESTIONS.MD",
      "TRACEABILITY.MD",
      "DATA-DICTIONARY.MD",
      "BUILD-PLAN.MD",
    ].includes(upper)
  )
    return "report";
  if (isUseCaseRel(rel)) return "use-case";
  if (
    rel.startsWith(`${SCREENS_DIR}/`) &&
    !rel.slice(SCREENS_DIR.length + 1).includes("/")
  )
    return "screen";
  return "other";
}

/** Root dir node of outputDir (markdown + images only; hidden files skipped). Empty root if outputDir missing. */
export async function listSpecTree(
  project: Project,
  model: SolutionModel | null,
): Promise<SpecFileNode> {
  const root = outputRoot(project);
  const rootNode: SpecFileNode = {
    name: path.basename(root) || root,
    path: "",
    type: "dir",
    children: [],
  };
  const st = await statOrNull(root);
  if (!st?.isDirectory()) return rootNode;

  const entries = await walk(root);
  const dirs = new Map<string, SpecFileNode>([["", rootNode]]);
  const ensureDir = (rel: string): SpecFileNode => {
    const existing = dirs.get(rel);
    if (existing) return existing;
    const parentRel = rel.includes("/")
      ? rel.slice(0, rel.lastIndexOf("/"))
      : "";
    const parent = ensureDir(parentRel);
    const node: SpecFileNode = {
      name: rel.split("/").pop() ?? rel,
      path: rel,
      type: "dir",
      children: [],
    };
    parent.children!.push(node);
    dirs.set(rel, node);
    return node;
  };
  const ucOrder = new Map(
    (model?.useCases ?? []).map((uc) => [uc.id, uc.order]),
  );
  const ucByPath = new Map(
    (model?.useCases ?? [])
      .filter((uc) => uc.filePath)
      .map((uc) => [uc.filePath!, uc.id]),
  );
  const screenOrder = new Map<string, number>();
  if (model) {
    const projectOrder = new Map(project.screens.map((s) => [s.id, s.order]));
    model.screens.forEach((a, i) =>
      screenOrder.set(
        `${SCREENS_DIR}/${a.screenKey}.md`,
        projectOrder.get(a.screenId) ?? 1000 + i,
      ),
    );
  }

  for (const entry of entries) {
    if (entry.isDir) continue;
    const ext = extOf(entry.rel);
    if (!MARKDOWN_EXTS.has(ext) && !GHERKIN_EXTS.has(ext) && !IMAGE_MIME[ext])
      continue;
    const kind = kindFor(entry.rel);
    const node: SpecFileNode = {
      name: path.posix.basename(entry.rel),
      path: entry.rel,
      type: "file",
      kind,
      mtimeMs: entry.mtimeMs,
    };
    if (kind === "use-case") {
      let id = ucByPath.get(entry.rel) ?? useCaseIdFromName(node.name);
      if (!id) {
        const content = await readTextOrNull(entry.abs);
        id = content ? useCaseHeader(content)?.id : undefined;
      }
      if (id) node.useCaseId = id;
    }
    const parentRel = entry.rel.includes("/")
      ? entry.rel.slice(0, entry.rel.lastIndexOf("/"))
      : "";
    ensureDir(parentRel).children!.push(node);
  }

  const sortChildren = (node: SpecFileNode): void => {
    if (!node.children) return;
    node.children = node.children.filter(
      (c) => c.type === "file" || (c.children?.length ?? 0) > 0,
    );
    const rank = (c: SpecFileNode): [number, number, string] => {
      if (node.path === "") {
        const i = ROOT_ORDER.indexOf(c.name);
        return [
          i >= 0 ? i : ROOT_ORDER.length + (c.type === "dir" ? 1 : 0),
          0,
          c.name.toLowerCase(),
        ];
      }
      if (c.type === "dir") return [2, 0, c.name.toLowerCase()];
      if (c.useCaseId)
        return [
          0,
          ucOrder.get(c.useCaseId) ?? Number.MAX_SAFE_INTEGER,
          c.name.toLowerCase(),
        ];
      if (screenOrder.has(c.path))
        return [0, screenOrder.get(c.path)!, c.name.toLowerCase()];
      return [1, 0, c.name.toLowerCase()];
    };
    node.children.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      return (
        ra[0] - rb[0] ||
        ra[1] - rb[1] ||
        ra[2].localeCompare(rb[2], undefined, { numeric: true })
      );
    });
    node.children.forEach(sortChildren);
  };
  for (let pass = 0; pass < 2; pass++) sortChildren(rootNode); // second pass prunes dirs emptied by the first
  return rootNode;
}

/** @throws NotFoundError | BadRequestError (non-markdown / traversal) */
export async function readSpecFile(
  project: Project,
  relPath: string,
): Promise<SpecFileContent> {
  const file = resolveSpecPath(project, relPath);
  const rel = toRel(project, file);
  const ext = extOf(file);
  if (!MARKDOWN_EXTS.has(ext) && !GHERKIN_EXTS.has(ext)) {
    throw new BadRequestError(
      `Only markdown (.md) and Gherkin (.feature) files can be opened here — "${rel}" is neither.`,
    );
  }
  const st = await statOrNull(file);
  if (!st)
    throw new NotFoundError(
      `The file "${rel}" does not exist (it may have been moved or deleted). Use "Sync from disk" or "Re-render" to refresh.`,
    );
  if (!st.isFile())
    throw new BadRequestError(`"${rel}" is a folder, not a file.`);
  const content = (await readOwnedFile(file)).toString("utf8");
  const result: SpecFileContent = {
    path: rel,
    content,
    mtimeMs: st.mtimeMs,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
  const id = useCaseIdOf(rel, content);
  if (id) result.useCaseId = id;
  return result;
}

function useCaseIdOf(rel: string, content: string): string | undefined {
  if (!MARKDOWN_EXTS.has(extOf(rel))) return undefined;
  const header = useCaseHeader(content);
  if (
    header?.id &&
    (isUseCaseRel(rel) || (header.format && hasFormat(header.format)))
  )
    return header.id;
  return isUseCaseRel(rel)
    ? useCaseIdFromName(path.posix.basename(rel))
    : undefined;
}

/** Raw bytes for images referenced by markdown (png/jpg/jpeg/gif/webp/svg only). */
export async function readSpecRaw(
  project: Project,
  relPath: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const file = resolveSpecPath(project, relPath);
  const rel = toRel(project, file);
  const mimeType = IMAGE_MIME[extOf(file)];
  if (!mimeType)
    throw new BadRequestError(
      `Only images (png, jpg, gif, webp, svg) can be fetched — "${rel}" is not an image.`,
    );
  try {
    return { buffer: await readOwnedFile(file), mimeType };
  } catch (err) {
    if (isMissing(err))
      throw new NotFoundError(`The image "${rel}" does not exist.`);
    if ((err as NodeJS.ErrnoException).code === "EISDIR")
      throw new BadRequestError(`"${rel}" is a folder, not an image.`);
    throw err;
  }
}

function toRel(project: Project, file: string): string {
  return path.relative(outputRoot(project), file).split(path.sep).join("/");
}

/* ------------------------------------------------------------------ */
/* Save / sync / rerender / status                                     */
/* ------------------------------------------------------------------ */

/**
 * Save an edited .md file. 409 ConflictError when req.baseMtimeMs is older than the file on disk.
 * If it is a use case file: parse it, merge into the model (status → 'edited' unless front matter says
 * 'approved'; revision+1 when content changed), compute a UseCaseDiff, append a changeLog entry. Persists.
 */
export async function saveSpecFile(
  project: Project,
  req: SaveSpecFileRequest,
  options: { reviewedRevision?: number; reviewedUseCaseId?: string } = {},
): Promise<SaveSpecFileResponse> {
  if (typeof req.content !== "string")
    throw new BadRequestError("The file content is missing.");
  const file = resolveSpecPath(project, req.path);
  const rel = toRel(project, file);
  const ext = extOf(file);
  if (GHERKIN_EXTS.has(ext)) {
    throw new BadRequestError(
      "Gherkin .feature files are generated from the use case .md files — edit the use case instead and the feature file will follow.",
    );
  }
  if (!MARKDOWN_EXTS.has(ext))
    throw new BadRequestError(
      `Only markdown (.md) files can be saved — "${rel}" is not one.`,
    );

  return withProjectLock(project.id, async () => {
    await assertOutputFolderAvailable(project);
    const st = await statOrNull(file);
    if (st && !st.isFile())
      throw new BadRequestError(`"${rel}" is a folder, not a file.`);
    if (
      req.baseHash &&
      (!st ||
        createHash("sha256")
          .update(await readOwnedFile(file))
          .digest("hex") !== req.baseHash)
    ) {
      throw new ConflictError(
        `"${rel}" changed on disk. Reload the current version before saving. Your draft has been kept.`,
      );
    }
    if (
      st &&
      typeof req.baseMtimeMs === "number" &&
      st.mtimeMs - req.baseMtimeMs > 1
    ) {
      throw new ConflictError(
        `"${rel}" was changed on disk after you opened it. Reload it to see the latest version, then re-apply your edits.`,
        { mtimeMs: st.mtimeMs },
      );
    }
    // Reviewed proposals already display their next revision. Do not silently advance it again on apply.
    if (options.reviewedRevision !== undefined) {
      const model = await loadModel(project.id);
      if (!model)
        throw new ConflictError(
          "The specification model is missing. Review again before applying.",
        );
      const parsed = formatFor(project, model).parseUseCase(req.content);
      const current = model.useCases.find((u) => u.id === parsed.useCase.id);
      if (
        parsed.errors.length ||
        !current ||
        parsed.useCase.id !== options.reviewedUseCaseId ||
        current.revision + 1 !== options.reviewedRevision ||
        parsed.useCase.revision !== options.reviewedRevision ||
        parsed.useCase.status !== "edited"
      )
        throw new ConflictError(
          "This proposal cannot be applied exactly as reviewed. Request a fresh proposal.",
        );
      const merge = mergeParsedUseCase(model, parsed, rel, now());
      if (!merge.useCase || merge.errors.length)
        throw new ConflictError(
          "The reviewed proposal conflicts with the specification model. Request a fresh proposal.",
        );
    }
    await writeFileAtomic(file, req.content);
    const mtimeMs = (await fs.stat(file)).mtimeMs;
    const response: SaveSpecFileResponse = {
      path: rel,
      mtimeMs,
      parsed: false,
      parseErrors: [],
    };

    const header = useCaseHeader(req.content);
    const looksLikeUseCase =
      isUseCaseRel(rel) || !!(header?.format && hasFormat(header.format));
    if (!looksLikeUseCase) {
      if (isGeneratedContent(req.content)) {
        response.parseErrors.push(
          `${rel} is generated by Coherence and will be replaced the next time the specs are written. Put lasting notes in a use case's Notes section instead.`,
        );
      }
      return response;
    }

    const model = await loadModel(project.id);
    if (!model) {
      response.parseErrors.push(
        "The specs have not been generated yet, so this file was saved but is not linked to a use case.",
      );
      if (header?.id) response.useCaseId = header.id;
      return response;
    }
    const format = formatFor(project, model);
    const parsed = format.parseUseCase(req.content);
    if (parsed.useCase.id) response.useCaseId = parsed.useCase.id;

    const duplicate = await duplicateFileProblem(
      project,
      model,
      parsed.useCase.id,
      rel,
    );
    if (duplicate) {
      response.parseErrors.push(...parsed.errors, duplicate);
      return response;
    }
    const outcome = mergeParsedUseCase(model, parsed, rel, now());
    if (outcome.useCase && options.reviewedRevision !== undefined)
      outcome.useCase.revision = options.reviewedRevision;
    response.parseErrors.push(...outcome.errors, ...outcome.warnings);
    if (!outcome.useCase) return response;

    response.parsed = true;
    const changed = recordMerge(model, outcome, "edited", rel);
    if (!changed && options.reviewedRevision !== undefined)
      applyMerge(model, outcome);
    if (changed || options.reviewedRevision !== undefined) {
      await saveModel(project.id, model);
      // Bring the file's front matter in step with the model (status, revision, updated) so a later sync
      // or re-render does not read the old values back. The body stays exactly as the BA saved it.
      if (frontMatterOutOfDate(parsed.useCase, outcome.useCase)) {
        await rewriteUseCaseFrontMatter(project, model, [outcome.useCase.id]);
        response.mtimeMs = (await fs.stat(file)).mtimeMs;
      }
      await refreshDerivedFiles(project, model);
    } else if (
      outcome.useCase.filePath !==
      model.useCases.find((u) => u.id === outcome.useCase!.id)?.filePath
    ) {
      await saveModel(project.id, model);
    }
    if (outcome.diff && (outcome.isNew || outcome.contentChanged))
      response.diff = outcome.diff;
    return response;
  });
}

/** Another existing file already holds this use case id → the save is not merged (avoids two files fighting). */
async function duplicateFileProblem(
  project: Project,
  model: SolutionModel,
  id: string,
  rel: string,
): Promise<string | null> {
  if (!id) return null;
  const uc = model.useCases.find((x) => x.id === id);
  const recorded = safeRecordedPath(uc?.filePath);
  if (!uc || !recorded || recorded === rel) return null;
  const other = await readTextOrNull(abs(project, recorded));
  if (other === null || useCaseHeader(other)?.id !== id) return null; // old file gone or renumbered: this file takes over
  return `${id} already lives in ${recorded}. Give this file a new id (for example ${nextFreeId(model)}) to add it as a new use case, or edit ${recorded} instead.`;
}

/** True when the file's front matter no longer states what the model now records for the use case. */
function frontMatterOutOfDate(
  fromFile: Partial<UseCase>,
  merged: UseCase,
): boolean {
  return (
    fromFile.status !== merged.status ||
    fromFile.revision !== merged.revision ||
    (fromFile.staleReason ?? "") !==
      (merged.status === "stale" ? (merged.staleReason ?? "") : "")
  );
}

function nextFreeId(model: SolutionModel): string {
  const max = model.useCases.reduce(
    (m, uc) => Math.max(m, Number(/^UC-(\d+)$/.exec(uc.id)?.[1] ?? 0)),
    0,
  );
  return `UC-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Applies a merge outcome to the model and appends a changelog entry when something changed.
 * Returns true when the model changed in a way worth persisting.
 */
function recordMerge(
  model: SolutionModel,
  outcome: MergeOutcome,
  kind: "edited" | "synced",
  rel: string,
): boolean {
  const uc = outcome.useCase;
  if (!uc) return false;
  const before = model.useCases.find((x) => x.id === uc.id);
  const statusChanged = !!before && before.status !== uc.status;
  const pathChanged = !!before && before.filePath !== uc.filePath;
  const changed =
    outcome.isNew || outcome.contentChanged || statusChanged || pathChanged;
  if (!changed) return false;
  applyMerge(model, outcome);
  if (
    kind === "edited" &&
    (outcome.isNew || outcome.contentChanged || statusChanged)
  ) {
    const what = outcome.isNew
      ? `${uc.id} added from ${rel}`
      : outcome.contentChanged
        ? `${uc.id} edited in ${rel}: ${outcome.diff?.summary ?? "content changed"}`
        : `${uc.id} marked ${uc.status} in ${rel}`;
    model.changeLog.push({
      at: now(),
      kind: "edited",
      summary: what,
      useCaseIds: [uc.id],
    });
  }
  return true;
}

/** Re-read every use case .md from disk and merge changes into the model. Persists. */
export async function syncFromDisk(
  project: Project,
  options: { requireComplete?: boolean } = {},
): Promise<SyncResult> {
  return withProjectLock(project.id, async () => {
    const result: SyncResult = {
      changed: [],
      parseErrors: [],
      missingFiles: [],
    };
    const model = await loadModel(project.id);
    if (!model) {
      if (
        options.requireComplete &&
        (await walk(outputRoot(project))).some(
          (e) =>
            !e.isDir &&
            (MARKDOWN_EXTS.has(extOf(e.rel)) || GHERKIN_EXTS.has(extOf(e.rel))),
        )
      ) {
        throw new ConflictError(
          "Specification files exist but their model is missing. Restore the model before preserving edits can be verified.",
        );
      }
      return result;
    }
    // Another project's files must not be read into this model.
    await assertOutputFolderAvailable(project);
    const format = formatFor(project, model);
    const root = outputRoot(project);

    // Candidate files: recorded paths plus every markdown file under use-cases/.
    const files = new Map<string, string>(); // rel → content
    const dirEntries = await fs
      .readdir(path.join(root, USE_CASES_DIR))
      .catch((err: unknown) => {
        if (options.requireComplete && !isMissing(err)) throw err;
        return [] as string[];
      });
    for (const name of dirEntries.sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    )) {
      if (name.startsWith(".") || !MARKDOWN_EXTS.has(extOf(name))) continue;
      const rel = `${USE_CASES_DIR}/${name}`;
      const content = await readTextOrNull(abs(project, rel));
      if (content !== null) files.set(rel, content);
    }
    for (const uc of model.useCases) {
      const rel = safeRecordedPath(uc.filePath);
      if (!rel || files.has(rel)) continue;
      const content = await readTextOrNull(abs(project, rel));
      if (content !== null) files.set(rel, content);
    }

    // One file per id: the recorded path wins, then the first file (by name) carrying the id.
    const claimed = new Map<string, string>(); // id → rel
    const parsedByRel = new Map<
      string,
      ReturnType<OutputFormat["parseUseCase"]>
    >();
    for (const [rel, content] of files) {
      const header = useCaseHeader(content);
      if (
        header &&
        header.format &&
        !hasFormat(header.format) &&
        !isUseCaseRel(rel)
      )
        continue;
      const parsed = format.parseUseCase(content);
      parsedByRel.set(rel, parsed);
      if (parsed.errors.length) {
        result.parseErrors.push({
          path: rel,
          errors: [...parsed.errors, ...parsed.warnings],
        });
        continue;
      }
      const id = parsed.useCase.id;
      const uc = model.useCases.find((x) => x.id === id);
      const current = claimed.get(id);
      if (!current) claimed.set(id, rel);
      else if (uc && safeRecordedPath(uc.filePath) === rel)
        claimed.set(id, rel);
    }
    for (const [rel, parsed] of parsedByRel) {
      const id = parsed.useCase.id;
      if (parsed.errors.length || claimed.get(id) === rel) continue;
      result.parseErrors.push({
        path: rel,
        errors: [
          `${id} is also defined in ${claimed.get(id)}; this copy was ignored. Give it a new id to add it as a new use case.`,
        ],
      });
    }

    let changedAny = false;
    const changedIds: string[] = [];
    const outdatedFrontMatter: string[] = [];
    for (const [id, rel] of claimed) {
      const parsed = parsedByRel.get(rel)!;
      const outcome = mergeParsedUseCase(model, parsed, rel, now());
      if (outcome.errors.length || outcome.warnings.length) {
        result.parseErrors.push({
          path: rel,
          errors: [...outcome.errors, ...outcome.warnings],
        });
      }
      if (!outcome.useCase) continue;
      if (recordMerge(model, outcome, "synced", rel)) {
        changedAny = true;
        if (frontMatterOutOfDate(parsed.useCase, outcome.useCase))
          outdatedFrontMatter.push(id);
      }
      if (
        outcome.diff &&
        (outcome.isNew ||
          outcome.contentChanged ||
          outcome.diff.changedSections.includes("status"))
      ) {
        result.changed.push(outcome.diff);
        changedIds.push(id);
      }
    }

    for (const uc of model.useCases) {
      if (claimed.has(uc.id)) continue;
      result.missingFiles.push({
        useCaseId: uc.id,
        path: safeRecordedPath(uc.filePath) ?? format.useCasePath(uc),
      });
    }

    if (
      options.requireComplete &&
      (result.parseErrors.length || result.missingFiles.length)
    ) {
      throw new ConflictError(
        "Preserving edits could not be verified: some specification files are missing, duplicated or cannot be parsed. Repair or restore the files and sync them before retrying. No generated replacement was written.",
        {
          parseErrors: result.parseErrors.map((p) => ({ path: p.path })),
          missingFiles: result.missingFiles,
        },
      );
    }
    if (changedIds.length) {
      model.changeLog.push({
        at: now(),
        kind: "synced",
        summary:
          `Synced ${changedIds.length} use case${changedIds.length === 1 ? "" : "s"} from the .md files: ${result.changed.map((d) => `${d.useCaseId} (${d.summary})`).join("; ")}`.slice(
            0,
            1000,
          ),
        useCaseIds: changedIds,
      });
    }
    if (changedAny) {
      await saveModel(project.id, model);
      // Same as on save: the files must carry the status/revision the model now has (bodies untouched).
      if (outdatedFrontMatter.length)
        await rewriteUseCaseFrontMatter(project, model, outdatedFrontMatter);
      await refreshDerivedFiles(project, model);
    }
    return result;
  });
}

/**
 * Re-render .md from the model (force=true ignores preserveEdited). Persists filePath updates.
 * Without force, edits made to the files outside the app are synced into the model first, so they count as
 * edits (and are kept) instead of being overwritten; with force the BA asked to replace them.
 */
export async function rerenderSpecs(
  project: Project,
  force: boolean,
): Promise<RerenderOutcome> {
  const warnings: string[] = [];
  if (!force && (await loadModel(project.id))) {
    const sync = await syncFromDisk(project, { requireComplete: true });
    const unreadable = sync.parseErrors
      .filter((p) => p.errors.length)
      .map((p) => p.path);
    if (unreadable.length) {
      warnings.push(
        `Some use case files have problems (${unreadable.join(", ")}) — use "Sync from disk" to see them.`,
      );
    }
  }
  return withProjectLock(project.id, async () => {
    const model = await loadModel(project.id);
    if (!model)
      throw new BadRequestError(
        "There are no specs to re-render yet — generate the specs first.",
      );
    const result = await writeSpecs(project, model, {
      preserveEdited: force ? false : (model.options?.preserveEdited ?? true),
      embedScreenImages: model.options?.embedScreenImages ?? true,
    });
    warnings.push(...result.warnings);
    const rewritten = model.useCases
      .filter((uc) => !result.preserved.includes(uc.filePath ?? ""))
      .map((uc) => uc.id);
    model.changeLog.push({
      at: now(),
      kind: "rerendered",
      summary: `Re-rendered ${result.written.length} files from the model${force ? " (including edited and approved use cases)" : ""}${result.preserved.length ? `; kept ${result.preserved.length} edited/approved use case files as they are` : ""}.`,
      useCaseIds: rewritten,
    });
    await saveModel(project.id, model);
    // The change log entry above is part of CHANGELOG.md — refresh it.
    await refreshDerivedFiles(project, model);
    return {
      fileCount: result.written.length,
      preservedFiles: result.preserved,
      warnings,
    };
  });
}

/** Update a use case's status in the model and its .md front matter. Persists. */
export async function setUseCaseStatus(
  project: Project,
  useCaseId: string,
  status: UseCaseStatus,
): Promise<UseCase> {
  return withProjectLock(project.id, async () => {
    const model = await loadModel(project.id);
    if (!model)
      throw new NotFoundError(
        "There are no specs for this project yet — generate them first.",
      );
    const uc = model.useCases.find((x) => x.id === useCaseId);
    if (!uc) throw new NotFoundError(`Use case ${useCaseId} was not found.`);
    const previous = uc.status;
    uc.status = status;
    if (status !== "stale") delete uc.staleReason;
    if (previous !== status) {
      model.changeLog.push({
        at: now(),
        kind: "edited",
        summary: `${uc.id} marked ${status} (was ${previous}).`,
        useCaseIds: [uc.id],
      });
    }
    await rewriteUseCaseFrontMatter(project, model, [uc.id]);
    await saveModel(project.id, model);
    await refreshDerivedFiles(project, model);
    return uc;
  });
}

/* ------------------------------------------------------------------ */
/* Path safety                                                         */
/* ------------------------------------------------------------------ */

/** Absolute path inside project.outputDir. @throws BadRequestError on traversal or absolute input. */
export function resolveSpecPath(project: Project, relPath: string): string {
  if (typeof relPath !== "string" || relPath.trim() === "")
    throw new BadRequestError("A file path is required.");
  if (relPath.includes("\0"))
    throw new BadRequestError("The file path contains an invalid character.");
  const normalised = relPath.replace(/\\/g, "/");
  if (
    normalised.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalised) ||
    path.isAbsolute(relPath)
  ) {
    throw new BadRequestError(
      'Use a path relative to the output folder (for example "use-cases/UC-001-sign-in.md").',
    );
  }
  // ':' would let "C:foo" escape on Windows (drive-relative paths) and is never valid in our file names.
  if (normalised.includes(":"))
    throw new BadRequestError(
      'The file path contains an invalid character (":").',
    );
  const segments = normalised.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === ".."))
    throw new BadRequestError(
      'The file path may not leave the output folder ("..").',
    );
  if (!segments.length) throw new BadRequestError("A file path is required.");

  const root = outputRoot(project);
  const target = path.resolve(root, ...segments);
  if (!isInside(root, target) || target === root) {
    throw new BadRequestError(
      "The file path must point inside the output folder.",
    );
  }
  // Symlinks: the real location of the target (or of its closest existing parent) must stay inside the real root.
  let realRoot: string;
  try {
    realRoot = fsSync.realpathSync.native(root);
  } catch {
    return assertV2Path(target);
  }
  let probe = target;
  for (;;) {
    try {
      const real = fsSync.realpathSync.native(probe);
      if (!isInside(realRoot, real))
        throw new BadRequestError(
          "The file path points outside the output folder.",
        );
      break;
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe || !isInside(root, parent)) break;
      probe = parent;
    }
  }

  return assertV2Path(target);
}

/** Re-exported for callers that only need the diff type alongside the store. */
export type { UseCaseDiff };
