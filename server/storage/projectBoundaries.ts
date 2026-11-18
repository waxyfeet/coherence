import fs from "node:fs";
import path from "node:path";
import { ConflictError } from "../errors";
import { inside, pathKey, regularPath } from "./pathSafety";

const conflict = () =>
  new ConflictError(
    "Project folders cannot contain or be inside another project. Keep both folders intact and separate them before reopening.",
  );

function readMarker(
  folder: string,
  name: string,
): Record<string, unknown> | undefined {
  const marker = path.join(folder, name);
  let listed: fs.BigIntStats;
  try {
    listed = fs.lstatSync(marker, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw conflict();
  }
  let fd: number | undefined;
  try {
    // Callers validate directory ancestry at the boundary/IO entry point.
    // Verify this one marker handle rather than repeating the whole ancestor
    // walk twice per marker. Never cache its contents or follow marker links.
    if (
      !listed.isFile() ||
      listed.nlink !== 1n ||
      listed.size > 16n * 1024n * 1024n
    )
      throw conflict();
    fd = fs.openSync(marker, "r");
    const opened = fs.fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.ino !== listed.ino ||
      opened.dev !== listed.dev
    )
      throw conflict();
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(marker, { bigint: true });
    if (
      current.ino !== opened.ino ||
      current.dev !== opened.dev ||
      current.nlink !== 1n ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      current.size !== after.size ||
      current.mtimeNs !== after.mtimeNs ||
      current.ctimeNs !== after.ctimeNs
    )
      throw conflict();
    const raw = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
    return raw && typeof raw === "object" ? raw : undefined;
  } catch {
    throw conflict();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
/**
 * Recognise occupied folders, including unsupported old records, without granting access. A damaged marker is always
 * a boundary. Inside a tree that Coherence may change or clean up, any id-bearing manifest also counts, so foreign
 * content is never removed. Above a folder (`ancestor`), well-formed JSON counts only as a Coherence manifest
 * (`storage`) or in the ScreenScribe manifest shape: a project.json written by another tool somewhere above the
 * profile or workspace must not block start-up or project creation (installer finding ST-10).
 */
function hasProjectBoundary(folder: string, ancestor = false): boolean {
  const raw = readMarker(folder, "project.json");
  if (!raw) return false;
  if (Object.hasOwn(raw, "storage")) return true;
  const named =
    typeof raw.id === "string" && /^[a-z0-9][a-z0-9-]{0,99}$/.test(raw.id);
  if (!ancestor) return named;
  return (
    named &&
    typeof raw.formatId === "string" &&
    typeof raw.outputDir === "string" &&
    Array.isArray(raw.screens)
  );
}
/** A specs folder claimed by a project: `.coherence.json`, or `.screenscribe.json` from before the visible rename. */
function hasRequirementsBoundary(folder: string): boolean {
  return [".coherence.json", ".screenscribe.json"].some((name) => {
    const output = readMarker(folder, name);
    return !!output && Object.hasOwn(output, "projectId");
  });
}

/** Include the selected folder: a workspace is never a project or its child. */
export function assertOutsideProjects(folder: string): void {
  regularPath(folder);
  let at = path.resolve(folder);
  while (true) {
    if (hasProjectBoundary(at, true)) throw conflict();
    // A marked requirements folder is also unsuitable as a new workspace. This
    // marker is not a nested project during normal IO of its owning specs.
    if (hasRequirementsBoundary(at)) throw conflict();
    const parent = path.dirname(at);
    if (parent === at) return;
    at = parent;
  }
}

/** Recheck on every access, including when a foreign project was added later.
 * Only the nominated root's own marker is allowed. No registry is consulted. */
export function assertProjectPath(root: string, target: string): void {
  assertOutsideProjects(path.dirname(root));
  assertNoNestedProjectPath(root, target);
}
/** Inventory of an internal cache/output may start below its own project root. */
export function assertNoNestedProjectPath(root: string, target: string): void {
  if (!inside(root, target)) throw conflict();
  regularPath(target);
  let at = path.resolve(target);
  // A file's containing directory, or an existing directory itself, can be a boundary.
  if (!fs.existsSync(at) || !fs.lstatSync(at).isDirectory())
    at = path.dirname(at);
  while (inside(root, at) && pathKey(root) !== pathKey(at)) {
    if (hasProjectBoundary(at)) throw conflict();
    at = path.dirname(at);
  }
}

/** Opening/moving/copying/deleting a whole project requires a complete tree check.
 * Never follow links or accept a partial scan as proof of ownership. */
export function assertNoNestedProjects(root: string): void {
  scanTree(root, false);
}
function scanTree(root: string, includeRequirements: boolean): void {
  regularPath(root, false);
  let count = 0;
  const visit = (folder: string) => {
    regularPath(folder, false);
    if (++count > 50000)
      throw new ConflictError(
        "The project exceeds the safe boundary scan limit. No partial scan was accepted.",
      );
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      regularPath(file, false);
      if (item.isDirectory()) {
        if (
          hasProjectBoundary(file) ||
          (includeRequirements && hasRequirementsBoundary(file))
        )
          throw conflict();
        visit(file);
      }
    }
  };
  visit(root);
}

export function assertStandaloneProject(root: string): void {
  assertOutsideProjects(path.dirname(root));
  assertNoNestedProjects(root);
}

/** Housekeeping owns no project or marked requirements container, including at the cleanup target
 * itself. Its ancestors may include the legitimate owning project.
 * Whole-project lifecycle keeps its separate root semantics. */
export function assertProjectFreeTree(root: string): void {
  regularPath(root, false);
  if (hasProjectBoundary(root) || hasRequirementsBoundary(root))
    throw conflict();
  scanTree(root, true);
}
