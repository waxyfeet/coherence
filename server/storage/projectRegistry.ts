import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Project, ProjectSummary, SolutionModel } from "@shared/types";
import { config } from "../config";
import { BadRequestError, ConflictError, NotFoundError } from "../errors";
import { StartupError } from "../startupErrors";
import {
  assertGlobalPath,
  enrollProjectAuthority,
  forgetProjectAuthority,
} from "./boundary";
import {
  directoryIdentity,
  inside,
  pathKey,
  regularPath,
  readRegularFileSync,
  relativeFile,
} from "./pathSafety";
import { kernelLease } from "./kernelLease";
import {
  assertOutsideProjects,
  assertProjectPath,
  assertStandaloneProject,
} from "./projectBoundaries";
import { withProjectNamespace } from "./projectNamespace";
import { writeJsonAtomic } from "./fsUtils";
import { NewerDataError, isNewerFormat } from "./formats";
import { inventoryTree } from "./inventory";
import {
  renameOwnedDirectory,
  pinProjectDirectories,
  createOwnedDirectory,
  withDirectoryGuard,
} from "./windowsStorageGuard";

export interface PortableStorage {
  format: "coherence-project";
  version: 1;
  folderId: string;
  requirements: "specs";
}
export interface RegistryEntry {
  id: string;
  root: string;
  identity: string;
  folderId: string;
  state: "active" | "trash";
  name: string;
  updatedAt: string;
  trashId?: string;
  originalRoot?: string;
  transition?: {
    from: string;
    to: string;
    state: "active" | "trash";
    trashId?: string;
  };
}
interface Registry {
  version: 1;
  workspace: string;
  entries: RegistryEntry[];
}
const entries = new Map<string, RegistryEntry>();
const leases = new Map<string, () => Promise<void>>();
const pins = new Map<string, () => Promise<void>>();
const unavailable = new Map<string, string>();
const creating = new Set<string>();
let workspace = "";
let loading: Promise<void> | undefined;
let writeTail: Promise<unknown> = Promise.resolve();
const registryFile = () =>
  assertGlobalPath(path.join(config.dataDir, "projects-index.json"));

const validId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,99}$/.test(id);
function locationReference(root: string, workspaceParent = false): string {
  if (
    !path.isAbsolute(root) ||
    root.includes("\0") ||
    root.split(/[\\/]/).includes("..")
  )
    throw new BadRequestError("Invalid saved storage location.");
  const resolved = path.resolve(root);
  if (
    [config.installDir, config.dataDir]
      .filter(Boolean)
      .some(
        (p) => inside(p, resolved) || (!workspaceParent && inside(resolved, p)),
      ) ||
    path.parse(resolved).root === resolved
  )
    throw new BadRequestError(
      "A saved storage location overlaps application or global data.",
    );
  return resolved;
}

export function safeWorkspace(root: string, allowMissing = true): string {
  let checked: string;
  try {
    checked = regularPath(root, allowMissing);
  } catch {
    throw new BadRequestError(
      "The workspace is unavailable or unsafe. Use Project files to choose an available local folder; no replacement project was created.",
    );
  }
  if (
    [config.installDir, config.dataDir]
      .filter(Boolean)
      .some((p) => inside(p, checked)) ||
    path.parse(checked).root === checked
  )
    throw new BadRequestError(
      "Choose a project workspace separate from application files, global settings and drive roots.",
    );
  for (const entry of entries.values())
    if (inside(entry.root, checked))
      throw new ConflictError("A workspace cannot be inside another project.");
  assertOutsideProjects(checked);
  return checked;
}
export function readPortableManifest(root: string): Project {
  const raw = JSON.parse(
    readRegularFileSync(path.join(root, "project.json"))
      .toString("utf8")
      .replace(/^\uFEFF/, ""),
  ) as Project;
  // A newer manifest is refused as such, not as "unsupported", and never rewritten by this version.
  if (
    raw?.storage?.format === "coherence-project" &&
    isNewerFormat(raw.storage.version, 1)
  )
    throw new NewerDataError("This project");
  if (
    !raw ||
    !validId(raw.id) ||
    typeof raw.name !== "string" ||
    !raw.name.trim() ||
    !Array.isArray(raw.screens) ||
    !raw.llm ||
    typeof raw.llm !== "object" ||
    raw.storage?.format !== "coherence-project" ||
    raw.storage.version !== 1 ||
    raw.storage.requirements !== "specs" ||
    !/^[0-9a-f-]{36}$/.test(raw.storage.folderId) ||
    raw.outputDir !== "specs" ||
    (raw.outputHistory?.length ?? 0) !== 0
  )
    throw new BadRequestError(
      "This is not a supported complete Coherence project manifest. No files were changed.",
    );
  if (
    !["draft", "generating", "specified", "needs-review"].includes(
      raw.status,
    ) ||
    typeof raw.createdAt !== "string" ||
    typeof raw.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.createdAt)) ||
    !Number.isFinite(Date.parse(raw.updatedAt))
  )
    throw new BadRequestError(
      "The portable project has invalid status or timestamps.",
    );
  assertProjectConnectionReferences(raw);
  if (
    raw.screens.some(
      (s) =>
        !s ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(s.id) ||
        typeof s.fileName !== "string" ||
        !new RegExp(`^${s.id}/v[0-9]+\\.(png|jpe?g|webp|gif)$`, "i").test(
          s.fileName,
        ) ||
        !Number.isSafeInteger(s.version) ||
        s.version < 1,
    )
  )
    throw new BadRequestError(
      "The project contains invalid screenshot identities or version references.",
    );
  return raw;
}
export function assertProjectConnectionReferences(project: Project) {
  const allowed = new Set([
    "visionConnectionId",
    "textConnectionId",
    "visionModelId",
    "textModelId",
    "visionAcknowledged",
  ]);
  if (
    Array.isArray(project.llm) ||
    Object.entries(project.llm).some(
      ([key, value]) =>
        !allowed.has(key) ||
        (value !== undefined &&
          typeof value !==
            (key === "visionAcknowledged" ? "boolean" : "string")),
    )
  )
    throw new BadRequestError(
      "Project model settings must contain connection references only. Review legacy inline provider settings separately; credentials cannot enter a portable project.",
    );
  if (
    project.generationPreferences &&
    Object.entries(project.generationPreferences).some(([key, value]) => {
      if (allowed.has(key))
        return (
          typeof value !== (key === "visionAcknowledged" ? "boolean" : "string")
        );
      if (key === "thoroughness")
        return !["standard", "thorough"].includes(value as string);
      if (key === "granularity")
        return !["fine", "balanced", "coarse"].includes(value as string);
      return (
        ![
          "preserveEdited",
          "embedScreenImages",
          "reuseScreenAnalyses",
        ].includes(key) || typeof value !== "boolean"
      );
    })
  )
    throw new BadRequestError(
      "Project run preferences contain credential fields. Remove the credential fields before opening this project.",
    );
}
async function persist() {
  const action = writeTail.then(() =>
    writeJsonAtomic(
      registryFile(),
      {
        version: 1,
        workspace,
        entries: [...entries.values()],
      } satisfies Registry,
      0o600,
    ),
  );
  writeTail = action.catch(() => {});
  await action;
}
async function enroll(entry: RegistryEntry) {
  assertStandaloneProject(entry.root);
  if (directoryIdentity(entry.root) !== entry.identity)
    throw new ConflictError(
      "The project folder has been replaced. Reopen its real location.",
    );
  const raw = readPortableManifest(entry.root);
  if (raw.id !== entry.id || raw.storage!.folderId !== entry.folderId)
    throw new ConflictError(
      "The folder's project identity changed. Reopen it for review.",
    );
  const acquired = !leases.has(entry.id);
  const pinnedBefore = pins.has(entry.id);
  if (acquired) leases.set(entry.id, await kernelLease(entry.identity));
  try {
    if (!pins.has(entry.id))
      pins.set(entry.id, await pinProjectDirectories(entry.root));
    assertStandaloneProject(entry.root);
  } catch (error) {
    if (!pinnedBefore) await releaseProjectPins(entry.id);
    if (acquired) {
      await leases.get(entry.id)?.();
      leases.delete(entry.id);
    }
    throw error;
  }
  enrollProjectAuthority(entry.id, entry.root, entry.identity);
  unavailable.delete(entry.id);
}
export async function initialiseRegistry(): Promise<void> {
  return (loading ??= withProjectNamespace(async () => {
    assertGlobalPath(config.dataDir);
    await fsp.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    let raw: Registry;
    try {
      raw = JSON.parse(await fsp.readFile(registryFile(), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new BadRequestError(
          "The project discovery index cannot be read. Existing project folders are intact; restore the index before changing it.",
        );
      workspace = config.workspaceDir
        ? locationReference(config.workspaceDir, true)
        : "";
      await persist();
      return;
    }
    if (typeof raw.version === "number" && raw.version > 1)
      throw new StartupError(
        "DATA_NEWER",
        "Your project list was saved by a newer version of Coherence. Install that version or a later one; no project was changed.",
      );
    if (
      raw.version !== 1 ||
      !Array.isArray(raw.entries) ||
      typeof raw.workspace !== "string"
    )
      throw new BadRequestError(
        "Unsupported project index version. No project was changed.",
      );
    workspace = raw.workspace ? locationReference(raw.workspace, true) : "";
    for (const entry of raw.entries) {
      if (
        !validId(entry.id) ||
        typeof entry.root !== "string" ||
        typeof entry.identity !== "string" ||
        typeof entry.folderId !== "string" ||
        !["active", "trash"].includes(entry.state) ||
        entries.has(entry.id)
      )
        throw new BadRequestError(
          "The project index contains conflicting identities. Restore it before continuing.",
        );
      // Registered roots must never overlap one another or either non-project authority.
      locationReference(entry.root);
      if (
        [...entries.values()].some(
          (e) => inside(e.root, entry.root) || inside(entry.root, e.root),
        )
      )
        throw new BadRequestError(
          "Overlapping project roots in the index require recovery.",
        );
      entries.set(entry.id, entry);
      try {
        if (entry.transition) {
          const t = entry.transition;
          const at = [t.from, t.to].filter((p) => {
            try {
              return directoryIdentity(p) === entry.identity;
            } catch {
              return false;
            }
          });
          if (at.length !== 1) throw Error();
          entry.root = at[0];
          if (pathKey(at[0]) === pathKey(t.to)) {
            entry.state = t.state;
            entry.trashId = t.trashId;
          }
          delete entry.transition;
        }
        await enroll(entry);
      } catch {
        unavailable.set(
          entry.id,
          "Folder missing, replaced, disconnected or open in another process. Reconnect its complete project folder.",
        );
      }
    }
    // Recovery changes discovery metadata only, never project content.
    await persist();
  }));
}
export function registryEntries(state?: "active" | "trash"): RegistryEntry[] {
  return [...entries.values()]
    .filter((e) => !state || e.state === state)
    .map((e) => ({ ...e }));
}
export function registryEntry(id: string): RegistryEntry {
  const entry = entries.get(id);
  if (!entry)
    throw new NotFoundError(
      "This project is not registered. Open its complete project folder.",
    );
  return entry;
}
export function verifyEntry(entry: RegistryEntry) {
  if (unavailable.has(entry.id) || !leases.has(entry.id))
    throw new ConflictError(
      unavailable.get(entry.id) ||
        "This project is not exclusively open in this application.",
    );
  if (directoryIdentity(entry.root) !== entry.identity)
    throw new ConflictError(
      "The project folder changed. Reconnect it before continuing.",
    );
  assertProjectPath(entry.root, entry.root);
  if (!creating.has(entry.id)) {
    const raw = readPortableManifest(entry.root);
    if (raw.id !== entry.id || raw.storage!.folderId !== entry.folderId)
      throw new ConflictError(
        "Project identity mismatch. No files were changed.",
      );
  }
  return entry.root;
}
export function registeredProjectRoot(id: string): string {
  const entry = registryEntry(id);
  if (entry.state !== "active" || entry.transition)
    throw new ConflictError(
      "This project is in Trash or is awaiting location recovery.",
    );
  return verifyEntry(entry);
}
export function projectUnavailable(id: string): string | undefined {
  const entry = registryEntry(id);
  try {
    verifyEntry(entry);
    return undefined;
  } catch {
    return (
      unavailable.get(id) ||
      "The project folder is unavailable. Reconnect it to continue."
    );
  }
}
const WORKSPACE_NOTES = {
  onedrive: "is synced by OneDrive",
  network: "is on a network location",
} as const;

export async function workspaceSettings() {
  await initialiseRegistry();
  // Only while the policy's default is in use: a folder the user chose needs no explanation (decision D8).
  const note =
    config.workspaceNote &&
    workspace &&
    config.workspaceDir &&
    pathKey(workspace) === pathKey(config.workspaceDir)
      ? `Your Documents folder ${WORKSPACE_NOTES[config.workspaceNote]}, which Coherence's file protection cannot use safely, so new projects go here instead. You can choose another local folder.`
      : undefined;
  return {
    layout: "portable",
    workspace: workspace,
    globalData: config.dataDir,
    ...(note ? { workspaceNote: note } : {}),
  };
}
export async function changeWorkspace(root: string) {
  await initialiseRegistry();
  return withProjectNamespace(() => changeWorkspaceLocked(root));
}
async function changeWorkspaceLocked(root: string) {
  const next = safeWorkspace(root, false);
  if (!fs.statSync(next).isDirectory())
    throw new BadRequestError("Choose an existing workspace folder.");
  const previous = workspace;
  workspace = next;
  try {
    await persist();
  } catch (error) {
    workspace = previous;
    throw error;
  }
  return workspaceSettings();
}
export async function reserveProjectFolder(
  id: string,
  parent?: string,
): Promise<PortableStorage> {
  await initialiseRegistry();
  if (!validId(id) || entries.has(id))
    throw new ConflictError("Project identity already exists.");
  const base = safeWorkspace(parent || workspace);
  await withDirectoryGuard(base, () => fsp.mkdir(base, { recursive: true }));
  regularPath(base, false);
  const root = path.join(base, id);
  locationReference(root);
  if (
    [...entries.values()].some(
      (e) => inside(e.root, root) || inside(root, e.root),
    )
  )
    throw new ConflictError("Project folders cannot overlap.");
  // Never adopt an existing nonempty OR empty user folder on creation.
  const releaseCreation = await createOwnedDirectory(root);
  try {
    await fsp.mkdir(path.join(root, "jobs"));
    const entry: RegistryEntry = {
      id,
      root,
      identity: directoryIdentity(root),
      folderId: randomUUID(),
      name: id,
      updatedAt: new Date().toISOString(),
      state: "active",
    };
    leases.set(id, await kernelLease(entry.identity));
    try {
      pins.set(id, await pinProjectDirectories(root));
    } catch (error) {
      await leases.get(id)?.();
      leases.delete(id);
      throw error;
    }
    if (
      (await fsp.readdir(root)).some((n) => n !== "jobs") ||
      (await fsp.readdir(path.join(root, "jobs"))).length
    ) {
      await releaseProjectPins(id);
      await leases.get(id)?.();
      leases.delete(id);
      throw new ConflictError(
        "The newly created folder changed before ownership was established. No existing contents will be adopted.",
      );
    }
    entries.set(id, entry);
    creating.add(id);
    enrollProjectAuthority(id, root, entry.identity);
    return {
      format: "coherence-project",
      version: 1,
      folderId: entry.folderId,
      requirements: "specs",
    };
  } finally {
    await releaseCreation();
  }
}

/** Validate current references without rewriting canonical files on reopen. */
export function assertCompleteProject(root: string, raw: Project) {
  for (const screen of raw.screens) {
    const file = relativeFile(path.join(root, "screens"), screen.fileName);
    if (!fs.lstatSync(file).isFile())
      throw new ConflictError(
        "A referenced screenshot is missing or unsafe. Restore the complete folder before reopening it.",
      );
  }
  const modelFile = path.join(root, "model.json");
  if (fs.existsSync(modelFile)) {
    const model = JSON.parse(
      readRegularFileSync(modelFile).toString(),
    ) as SolutionModel;
    if (model.projectId !== raw.id || !Array.isArray(model.useCases))
      throw new ConflictError("The saved model does not match this project.");
    for (const uc of model.useCases)
      if (uc.filePath) {
        const file = relativeFile(path.join(root, "specs"), uc.filePath);
        if (!fs.lstatSync(file).isFile())
          throw new ConflictError(
            "A referenced specification is missing. Restore the complete project folder.",
          );
      }
  }
}
export async function publishProject(project: Project) {
  const entry = registryEntry(project.id);
  entry.name = project.name;
  entry.updatedAt = project.updatedAt;
  creating.delete(project.id);
  await enroll(entry);
  await persist();
}
export function unavailableSummary(entry: RegistryEntry): ProjectSummary {
  return {
    id: entry.id,
    name: entry.name,
    description:
      "Project folder unavailable — reconnect its location to open it.",
    status: "draft",
    screenCount: 0,
    useCaseCount: 0,
    updatedAt: entry.updatedAt,
    projectPath: entry.root,
    availability: "unavailable",
  };
}
export async function openProjectFolder(
  root: string,
  expectedId?: string,
): Promise<Project> {
  await initialiseRegistry();
  return withProjectNamespace(() => openProjectFolderLocked(root, expectedId));
}
async function openProjectFolderLocked(
  root: string,
  expectedId?: string,
): Promise<Project> {
  regularPath(root, false);
  locationReference(root);
  assertStandaloneProject(root);
  if (
    [config.dataDir, config.installDir, workspace]
      .filter(Boolean)
      .some((p) => pathKey(p) === pathKey(root))
  )
    throw new BadRequestError(
      "Select a dedicated project folder, not a workspace or application directory.",
    );
  const raw = readPortableManifest(root);
  assertCompleteProject(root, raw);
  await inventoryTree(root);
  if (expectedId && raw.id !== expectedId)
    throw new ConflictError(
      "The selected folder belongs to a different project.",
    );
  const identity = directoryIdentity(root);
  const previous = entries.get(raw.id);
  if (
    previous &&
    (previous.state !== "active" ||
      previous.transition ||
      previous.folderId !== raw.storage!.folderId)
  )
    throw new ConflictError(
      "This identity belongs to another project, Trash entry or pending move. Use the reviewed Restore or recovery action.",
    );
  if (
    previous &&
    (pathKey(previous.root) !== pathKey(root) || previous.identity !== identity)
  ) {
    if (
      previous.state !== "active" ||
      previous.folderId !== raw.storage!.folderId
    )
      throw new ConflictError(
        "This identity belongs to another project or Trash entry.",
      );
    // A folder restored at the registered path (File History, OneDrive, unzip) *is* the original, now with a new
    // folder identity: re-bind it (installer finding ST-09). Only a live original at another path blocks.
    if (
      pathKey(previous.root) !== pathKey(root) &&
      fs.existsSync(previous.root)
    )
      throw new ConflictError(
        "The original project is still present. Use Duplicate for an independent copy, or move the original before reconnecting.",
      );
    await releaseProjectPins(raw.id);
    await leases.get(raw.id)?.();
    leases.delete(raw.id);
    forgetProjectAuthority(raw.id);
  }
  for (const entry of entries.values())
    if (
      entry.id !== raw.id &&
      (inside(entry.root, root) || inside(root, entry.root))
    )
      throw new ConflictError(
        "This folder overlaps another registered project.",
      );
  const entry: RegistryEntry = {
    id: raw.id,
    root: path.resolve(root),
    identity,
    folderId: raw.storage!.folderId,
    state: "active",
    name: raw.name,
    updatedAt: raw.updatedAt,
  };
  await enroll(entry);
  entries.set(raw.id, entry);
  await persist();
  return raw;
}
/** Journal the rename before touching either location. Source and Trash always share a volume. */
export async function transitionProject(
  id: string,
  to: string,
  state: "active" | "trash",
  trashId?: string,
) {
  return withProjectNamespace(() =>
    transitionProjectLocked(id, to, state, trashId),
  );
}
async function transitionProjectLocked(
  id: string,
  to: string,
  state: "active" | "trash",
  trashId?: string,
) {
  const entry = registryEntry(id);
  verifyEntry(entry);
  assertStandaloneProject(entry.root);
  assertOutsideProjects(to);
  regularPath(to);
  if (fs.existsSync(to))
    throw new ConflictError(
      "The destination already exists. Nothing was overwritten.",
    );
  const from = entry.root;
  entry.transition = { from, to, state, trashId };
  await persist();
  try {
    verifyEntry(entry);
    await releaseProjectPins(id);
    await renameOwnedDirectory(from, to, entry.identity.split(":").at(-1)!);
    if (directoryIdentity(to) !== entry.identity)
      throw new ConflictError(
        "Folder identity changed during the move. Recovery is required; nothing will be deleted.",
      );
    if (state === "trash") entry.originalRoot = from;
    entry.root = to;
    entry.state = state;
    entry.trashId = trashId;
    delete entry.transition;
    enrollProjectAuthority(id, to, entry.identity);
    pins.set(id, await pinProjectDirectories(to));
    await persist();
  } catch (error) {
    // Leave the durable transition for deterministic next-start reconciliation.
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      delete entry.transition;
      if (!pins.has(id)) pins.set(id, await pinProjectDirectories(from));
      await persist();
    }
    throw error;
  }
}
export async function forgetRegistryProject(id: string) {
  const entry = registryEntry(id);
  entries.delete(id);
  await persist();
  forgetProjectAuthority(id);
  await releaseProjectPins(id);
  await leases.get(id)?.();
  leases.delete(id);
  unavailable.delete(id);
  creating.delete(id);
  return entry;
}
export async function releaseProjectLeases() {
  await Promise.all([...pins.keys()].map(releaseProjectPins));
  await Promise.all([...leases.values()].map((release) => release()));
  leases.clear();
}
export async function releaseProjectPins(id: string) {
  const unpin = pins.get(id);
  if (unpin) {
    await unpin();
    pins.delete(id);
  }
}
export async function restoreProjectPins(id: string) {
  const entry = registryEntry(id);
  verifyEntry(entry);
  if (!pins.has(id)) pins.set(id, await pinProjectDirectories(entry.root));
}
