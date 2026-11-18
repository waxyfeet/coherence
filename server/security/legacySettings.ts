import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "../config";
import { publicEndpoint } from "./endpointPolicy";
import {
  protectSettings,
  unprotectSettings,
} from "../storage/protectedSecrets";
import {
  PRIVATE_FILE_MODE,
  readJsonIfExists,
  writeJsonAtomic,
} from "../storage/fsUtils";
import { assertV2Path } from "../storage/boundary";

const ARCHIVE = "legacy-settings-recovery-v1";
const INVALID = "[invalid endpoint — re-enter in Settings]";

/** Preserve the original privately, never as a new plaintext backup or an automatically usable endpoint. */
export async function archiveSettingsRecovery(
  file: string,
  bytes: Buffer,
): Promise<void> {
  assertV2Path(file);
  await writeJsonAtomic(
    file,
    await protectSettings({
      archive: ARCHIVE,
      encoding: "base64",
      token: bytes.toString("base64"),
    }),
    PRIVATE_FILE_MODE,
  );
}

export async function protectLegacySettingsBackups(): Promise<number> {
  const file = paths.settingsFile();
  const dir = path.dirname(file);
  let changed = 0;
  for (const name of await fs.readdir(dir)) {
    if (!/^settings\.json\.bak-[A-Za-z0-9_.-]+$/.test(name)) continue;
    const target = assertV2Path(path.join(dir, name));
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(
        "Legacy settings recovery requires a regular private file.",
      );
    const bytes = await fs.readFile(target);
    try {
      const value = JSON.parse(bytes.toString("utf8"));
      if (value.archive === ARCHIVE && value._protectedSecrets) continue;
    } catch {
      /* Damaged legacy settings still need private preservation. */
    }
    await archiveSettingsRecovery(target, bytes);
    changed++;
  }
  return changed;
}

/**
 * Keep connection IDs/providers and named keys intact; disable ambiguous URLs until explicitly repaired. With
 * `persist` false (saved keys locked, nothing may be written) the URLs are disabled in memory only; the unchanged
 * settings file still holds them.
 */
export async function migrateLegacyEndpoints<T extends object>(
  settings: T,
  persist = true,
): Promise<{ value: T; changed: boolean }> {
  const value = structuredClone(settings);
  const entries: { field: string; token: string }[] = [];
  function visit(obj: Record<string, unknown>, prefix: string[]) {
    for (const [key, item] of Object.entries(obj)) {
      if (
        ["baseUrl", "orgUrl", "apiBaseUrl"].includes(key) &&
        typeof item === "string" &&
        item &&
        item !== INVALID &&
        publicEndpoint(item) !== item
      ) {
        entries.push({ field: [...prefix, key].join("."), token: item });
        obj[key] = INVALID;
      } else if (item && typeof item === "object")
        visit(item as Record<string, unknown>, [...prefix, key]);
    }
  }
  visit(value as Record<string, unknown>, []);
  if (!entries.length) return { value, changed: false };
  if (!persist) return { value, changed: true };
  const file = assertV2Path(
    path.join(path.dirname(paths.settingsFile()), "settings-url-recovery.json"),
  );
  const saved = await readJsonIfExists<{
    entries: { field: string; token: string }[];
  }>(file);
  const previous = saved ? (await unprotectSettings(saved)).entries : [];
  // A crash after recovery preservation but before settings replacement can safely retry.
  for (const entry of entries)
    if (
      !previous.some((p) => p.field === entry.field && p.token === entry.token)
    )
      previous.push(entry);
  await writeJsonAtomic(
    file,
    await protectSettings({ entries: previous }),
    PRIVATE_FILE_MODE,
  );
  return { value, changed: true };
}
