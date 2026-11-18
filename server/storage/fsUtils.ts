/**
 * OWNER: server-core builder.
 * Small filesystem helpers shared by the stores: atomic JSON writes, tolerant reads, and rename retries
 * (Windows briefly locks files that antivirus / indexers / open readers touch, so renames can fail with EPERM).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { assertV2Path } from "./boundary";
import {
  accessDeniedError,
  withDirectoryGuard,
  verifyRegularFile,
  replaceOwnedFile,
} from "./windowsStorageGuard";

import { withProjectNamespace } from "./projectNamespace";
import { assertNoNestedProjects } from "./projectBoundaries";

const RETRYABLE_FS_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);

export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).code === "string"
  );
}

export function isNotFound(err: unknown): boolean {
  return isErrnoException(err) && err.code === "ENOENT";
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** fs.rename with a few short retries for transient Windows locks. */
export async function renameWithRetry(
  from: string,
  to: string,
  attempts = 6,
): Promise<void> {
  const rename = () =>
    withDirectoryGuard(path.dirname(from), () =>
      withDirectoryGuard(path.dirname(to), () =>
        renameUncheckedWithRetry(from, to, attempts),
      ),
    );
  // File publication keeps its existing path/hash checks. Directory moves need
  // the same structural gate as project creation for the supported format.
  return (await fs.lstat(from)).isDirectory()
    ? withProjectNamespace(rename)
    : rename();
}
async function renameUncheckedWithRetry(
  from: string,
  to: string,
  attempts = 6,
): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      assertV2Path(from);
      assertV2Path(to);
      if ((await fs.lstat(from)).isDirectory()) assertNoNestedProjects(from);
      await fs.rename(from, to);
      return;
    } catch (err) {
      if (
        i >= attempts - 1 ||
        !isErrnoException(err) ||
        !RETRYABLE_FS_CODES.has(err.code ?? "")
      )
        throw err;
      await delay(40 * (i + 1));
    }
  }
}

/**
 * Owner-only permissions for secrets (credential material is held separately in protected storage) and the data folder.
 * Only POSIX honours them; on Windows the user-profile ACLs already keep other users out.
 */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

/** `mode` only applies to directories this call creates. */
export async function ensureDir(dir: string, mode?: number): Promise<void> {
  assertV2Path(dir);
  await withDirectoryGuard(dir, async () => {
    assertV2Path(dir);
    await fs.mkdir(dir, { recursive: true, mode });
    assertV2Path(dir);
  });
}

export async function pathExists(p: string): Promise<boolean> {
  assertV2Path(p);
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write bytes/text to `<file>.tmp-<rand>` then rename over the target, so readers never see half a file.
 * `mode` (e.g. PRIVATE_FILE_MODE) is applied when the temp file is created, so the target never exists with
 * wider permissions, not even briefly.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Buffer,
  mode?: number,
): Promise<void> {
  assertV2Path(file);
  await ensureDir(path.dirname(file));
  return withDirectoryGuard(path.dirname(file), () =>
    writeFileAtomicUnlocked(file, data, mode),
  );
}
async function writeFileAtomicUnlocked(
  file: string,
  data: string | Buffer,
  mode?: number,
): Promise<void> {
  assertV2Path(file);
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    const handle = await fs
      .open(tmp, "wx", mode ?? PRIVATE_FILE_MODE)
      .catch((error: unknown) => {
        // Windows reports ERROR_ACCESS_DENIED as EPERM; creating a new file is refused like this by Controlled Folder
        // Access, so say how to allow Coherence rather than showing a raw error.
        throw process.platform === "win32" &&
          isErrnoException(error) &&
          error.code === "EPERM"
          ? accessDeniedError()
          : error;
      });
    let identity: string;
    try {
      await handle.writeFile(data);
      await handle.sync();
      identity = (await handle.stat({ bigint: true })).ino.toString();
    } finally {
      await handle.close();
    }
    assertV2Path(file);
    {
      for (let attempt = 0; ; attempt++)
        try {
          await replaceOwnedFile(tmp, file, identity!);
          break;
        } catch (error) {
          if (attempt === 3) throw error;
          await delay(50 * (attempt + 1));
        }
    }
  } catch (err) {
    throw err;
  }
}

export async function writeJsonAtomic(
  file: string,
  value: unknown,
  mode?: number,
): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** Parsed JSON, or undefined when the file does not exist. Throws on unreadable / invalid JSON. */
export async function readJsonIfExists<T>(
  file: string,
): Promise<T | undefined> {
  let text: string;
  try {
    assertV2Path(file);
    text = (await readOwnedFile(file)).toString("utf8");
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  // Strip a UTF-8 BOM in case the BA edited the file in an editor that adds one.
  return JSON.parse(text.replace(/^﻿/, "")) as T;
}

/** Read one verified file handle while directory handles prevent ancestor swaps. */
export async function readOwnedFile(file: string): Promise<Buffer> {
  assertV2Path(file);
  return withDirectoryGuard(path.dirname(file), async () => {
    assertV2Path(file);
    const handle = await fs.open(file, "r");
    try {
      const opened = await handle.stat({ bigint: true });
      await verifyRegularFile(file, opened.ino.toString());
      assertV2Path(file);
      const current = await fs.lstat(file, { bigint: true });
      if (
        !opened.isFile() ||
        opened.nlink > 1n ||
        opened.ino !== current.ino ||
        opened.dev !== current.dev
      )
        throw Error("File identity changed before reading.");
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  });
}

/** File-system-safe timestamp: 2026-10-14T10-00-00-000Z */
export function fileTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
