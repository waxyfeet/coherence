import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config";
import { inside, regularPath } from "./pathSafety";
import { assertProjectPath, assertOutsideProjects } from "./projectBoundaries";
import { StartupError } from "../startupErrors";

const projectAuthorities = new Map<
  string,
  { root: string; identity: string }
>();
export function enrollProjectAuthority(
  key: string,
  root: string,
  identity: string,
) {
  projectAuthorities.set(key, { root, identity });
}
export function forgetProjectAuthority(key: string) {
  projectAuthorities.delete(key);
}
export function assertGlobalPath(target: string): string {
  assertOutsideProjects(config.dataDir);
  if (
    inside(config.installDir, config.dataDir) ||
    inside(config.dataDir, config.installDir)
  )
    throw new StartupError(
      "DATA_INSIDE_INSTALL",
      "Global Coherence data must be separate from application installation files.",
    );
  if (!inside(config.dataDir, target))
    throw Error("The path is outside global Coherence data.");
  return regularPath(path.resolve(target));
}

export const V2_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
/** Check lexical and existing physical ancestors, including junctions/symlinks. */
export function assertV2Path(target: string): string {
  const absolute = path.resolve(target);
  {
    if (inside(config.dataDir, absolute)) return assertGlobalPath(absolute);
    for (const authority of projectAuthorities.values()) {
      if (!inside(authority.root, absolute)) continue;
      const stat = fs.lstatSync(regularPath(authority.root, false), {
        bigint: true,
      });
      if (`${stat.dev}:${stat.ino}` !== authority.identity)
        throw Error("The project folder changed. Reopen it before continuing.");
      assertProjectPath(authority.root, absolute);
      return absolute; // assertProjectPath validates the complete path before marker reads.
    }
    throw Error(
      "The path is not an enrolled Coherence project or global data path.",
    );
  }
}
