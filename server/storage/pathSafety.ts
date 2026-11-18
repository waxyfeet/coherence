import fs from "node:fs";
import path from "node:path";

export const pathKey = (p: string) =>
  process.platform === "win32"
    ? path.resolve(p).toLowerCase()
    : path.resolve(p);
export function inside(root: string, target: string): boolean {
  const rel = path.relative(pathKey(root), pathKey(target));
  return (
    rel === "" ||
    (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep))
  );
}
export function regularPath(target: string, allowMissing = true): string {
  if (!path.isAbsolute(target) || target.includes("\0"))
    throw Error("Choose a full local folder path.");
  if (process.platform === "win32" && target.startsWith("\\\\"))
    throw Error(
      "Network and device paths are not supported for writable projects. Choose a local drive folder.",
    );
  if (target.split(/[\\/]/).includes(".."))
    throw Error("Traversal components are not permitted in storage paths.");
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  for (const segment of absolute.slice(parsed.root.length).split(path.sep)) {
    if (
      !segment ||
      /[<>:"|?*\x00-\x1f]/.test(segment) ||
      /[. ]$/.test(segment) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
    )
      throw Error(
        "The folder contains a reserved or ambiguous Windows path component.",
      );
  }
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")
        return absolute;
      throw error;
    }
    if (
      stat.isSymbolicLink() ||
      pathKey(fs.realpathSync(current)) !== pathKey(current)
    )
      throw Error(
        "Coherence refuses symbolic links, junctions and redirected path components. Select their real destination folder.",
      );
    if (stat.isFile() && stat.nlink > 1)
      throw Error(
        "Shared hard-linked files are not supported in owned project storage.",
      );
  }
  return absolute;
}
export function directoryIdentity(root: string): string {
  regularPath(root, false);
  const stat = fs.lstatSync(root, { bigint: true });
  if (!stat.isDirectory())
    throw Error("The selected project location is not a folder.");
  return `${stat.dev}:${stat.ino}`;
}
export function readRegularFileSync(file: string): Buffer {
  regularPath(file, false);
  const fd = fs.openSync(file, "r");
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    regularPath(file, false);
    const current = fs.lstatSync(file, { bigint: true });
    if (
      !opened.isFile() ||
      opened.size > 16n * 1024n * 1024n ||
      opened.nlink !== 1n ||
      opened.ino !== current.ino ||
      opened.dev !== current.dev
    )
      throw Error(
        "File identity or supported metadata size changed before reading.",
      );
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function relativeFile(root: string, rel: string): string {
  if (
    !rel ||
    rel.includes("\\") ||
    rel.includes(":") ||
    rel.startsWith("/") ||
    rel.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw Error("Project paths must be plain project-relative paths.");
  const target = path.join(root, ...rel.split("/"));
  if (!inside(root, target) || pathKey(root) === pathKey(target))
    throw Error("The path leaves this project.");
  return regularPath(target);
}
