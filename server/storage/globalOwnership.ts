import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { directoryIdentity, readRegularFileSync } from "./pathSafety";
import { withDirectoryGuard } from "./windowsStorageGuard";
import { StartupError } from "../startupErrors";

/**
 * A restored backup, a copy or a move to another disk or computer gives the profile folder a new identity. It is
 * adopted only when the user chose to (the launcher asks; developers pass the flag), after the same checks as any
 * profile: a regular local folder holding a valid record of this format (installer finding ST-03, decision D9).
 */
const adoptRestored = process.argv.includes("--adopt-restored-profile");

/** Called only while holding the accepted kernel global-instance exclusion. */
export async function claimGlobalDirectory() {
  await withDirectoryGuard(config.dataDir, async () => {
    const identity = directoryIdentity(config.dataDir);
    const file = path.join(config.dataDir, ".coherence-global.json");
    const entries = await fs.readdir(config.dataDir);
    // A first claim interrupted before its rename leaves only its own temporary record and lock files.
    const temp = `${file}.tmp`;
    const onlyClaimFiles = (names: string[]) =>
      names.every(
        (name) =>
          name === ".instance-lock.json" ||
          name === path.basename(temp) ||
          /^\.instance-lock\.json\.[0-9a-f-]{36}\.tmp$/.test(name),
      );
    let adoptedFrom: string | undefined;
    if (entries.includes(".coherence-global.json")) {
      const replaced = new StartupError(
        "PROFILE_INVALID",
        "The global Coherence profile was replaced or has an unsupported ownership record. Existing data was not changed.",
      );
      let bytes: Buffer;
      try {
        bytes = readRegularFileSync(file);
      } catch {
        throw replaced;
      }
      // Earlier versions wrote the record in place: a crash during the very first claim left it empty in an
      // otherwise empty profile. Only that exact state is claimed again; anything else is refused unchanged.
      const torn =
        bytes.length === 0 &&
        onlyClaimFiles(entries.filter((name) => name !== path.basename(file)));
      if (!torn) {
        let owner: { format?: unknown; version?: unknown; identity?: unknown };
        try {
          owner = JSON.parse(bytes.toString());
        } catch {
          throw replaced;
        }
        if (owner?.format !== "screenscribe-v2-global") throw replaced;
        if (typeof owner.version === "number" && owner.version > 1)
          throw new StartupError(
            "DATA_NEWER",
            "This Coherence data folder was set up by a newer version of Coherence. Install that version or a later one; nothing was changed.",
          );
        if (owner.version !== 1 || typeof owner.identity !== "string")
          throw replaced;
        if (owner.identity === identity) return;
        if (!adoptRestored)
          throw new StartupError(
            "PROFILE_RESTORED",
            "This Coherence data folder was restored or copied from somewhere else, so it was not opened. Nothing was changed. Start Coherence with --adopt-restored-profile to use it.",
          );
        adoptedFrom = owner.identity;
        console.warn(
          `[profile] Using a restored or copied data folder, as chosen (previous identity ${owner.identity}).`,
        );
      }
    } else if (!onlyClaimFiles(entries))
      throw new StartupError(
        "PROFILE_NOT_EMPTY",
        "The global data folder contains unrecognised existing files. Choose a separate empty profile; no automatic global-data migration is allowed.",
      );
    await fs.rm(temp, { force: true });
    // Written atomically, so a crash can never leave an empty ownership record behind.
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({
          format: "screenscribe-v2-global",
          version: 1,
          identity,
          ...(adoptedFrom
            ? { adoptedFrom, adoptedAt: new Date().toISOString() }
            : {}),
        }) + "\n",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
  });
}
