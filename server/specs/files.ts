/**
 * OWNER: formats builder.
 * Small filesystem helpers for the spec folder: atomic writes, safe stats, recursive listing.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertV2Path } from "../storage/boundary";

import { removeReviewedPath } from "../storage/windowsStorageGuard";
import {
  writeFileAtomic as durableWrite,
  readOwnedFile,
} from "../storage/fsUtils";

export const MARKDOWN_EXTS = new Set([".md", ".markdown"]);
export const GHERKIN_EXTS = new Set([".feature"]);
export const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export function extOf(p: string): string {
  return path.extname(p).toLowerCase();
}

export function isTextSpec(p: string): boolean {
  const ext = extOf(p);
  return MARKDOWN_EXTS.has(ext) || GHERKIN_EXTS.has(ext);
}

export async function statOrNull(
  p: string,
): Promise<import("node:fs").Stats | null> {
  try {
    assertV2Path(p);
    return await fs.stat(p);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

export function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export async function readTextOrNull(p: string): Promise<string | null> {
  try {
    assertV2Path(p);
    return (await readOwnedFile(p)).toString("utf8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * Write via a flushed temporary file and atomic rename. A locked destination fails
 * safely; it is never replaced with a direct, potentially partial write.
 */
export async function writeFileAtomic(
  target: string,
  content: string | Buffer,
): Promise<void> {
  await durableWrite(target, content);
}

/** Write only when the content differs — keeps mtimes stable so open editors don't see false conflicts. */
export async function writeIfChanged(
  target: string,
  content: string,
): Promise<boolean> {
  const current = await readTextOrNull(target);
  if (current === content) return false;
  await writeFileAtomic(target, content);
  return true;
}

export async function removeIfExists(p: string): Promise<boolean> {
  try {
    assertV2Path(p);
    {
      const stat = await fs.lstat(p, { bigint: true });
      const bytes = await readOwnedFile(p);
      await removeReviewedPath(
        p,
        stat.ino.toString(),
        createHash("sha256").update(bytes).digest("hex"),
        false,
      );
    }
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

export interface WalkEntry {
  /** POSIX path relative to the root. */
  rel: string;
  abs: string;
  isDir: boolean;
  mtimeMs: number;
}

/** Recursive listing (hidden entries and symlinks leaving the root are skipped). */
export async function walk(
  root: string,
  maxEntries = 5000,
): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  assertV2Path(root);
  const visit = async (
    dir: string,
    relDir: string,
    depth: number,
  ): Promise<void> => {
    if (depth > 12 || out.length >= maxEntries) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        /\.tmp-[0-9a-f]+$/.test(entry.name)
      )
        continue;
      const abs = path.join(dir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        // Never follow a project link, including one pointing to a sibling project.
        continue;
      }
      assertV2Path(abs);
      if (isDir) {
        const st = await fs.stat(abs).catch(() => null);
        out.push({ rel, abs, isDir: true, mtimeMs: st?.mtimeMs ?? 0 });
        await visit(abs, rel, depth + 1);
      } else if (isFile) {
        const st = await fs.stat(abs).catch(() => null);
        if (st) out.push({ rel, abs, isDir: false, mtimeMs: st.mtimeMs });
      }
    }
  };
  await visit(root, "", 0);
  return out;
}

/** True when `child` is `parent` or inside it (both absolute, already resolved). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

/** POSIX form of a relative path. */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
