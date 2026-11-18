/**
 * The format contract for durable records (installer finding ST-06, report §5.4): every record family carries a
 * format number; data written by a newer Coherence is refused — clearly, and without ever being written by this
 * version — instead of being treated as damaged or absent and then overwritten.
 *
 * | Record | Field | Where |
 * | --- | --- | --- |
 * | settings.json | `version` | settingsStore.ts (refused at start-up, DATA_NEWER) |
 * | DPAPI key envelope | `_protectedSecrets.version` | settingsStore.ts (refused at start-up) |
 * | projects-index.json | `version` | projectRegistry.ts (refused at start-up) |
 * | .coherence-global.json | `version` | globalOwnership.ts (refused at start-up) |
 * | project.json | `storage.version` | projectRegistry.ts `readPortableManifest` (project refused) |
 * | model.json | `schemaVersion` | projectStore.ts `loadModel` / `saveModel` |
 * | delivery mapping profiles | `schemaVersion` | delivery/profiles.ts |
 * | delivery plans | `schemaVersion` | delivery/service.ts |
 * | job records | `diagnosticsVersion` | jobDiagnostics.ts (newer records left untouched) |
 *
 * areas.json is a bare list: a future format must become an object, which this version already refuses without
 * writing ("damaged"). Regenerable caches (model catalogues, capability tests, destination discovery) are rebuilt.
 */
import { HttpError } from "../errors";

export const MODEL_SCHEMA_VERSION = 1;
export const DELIVERY_SCHEMA_VERSION = 1;

/** True only for a number greater than the version this build writes. */
export function isNewerFormat(value: unknown, current: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > current;
}

/** 409 DATA_NEWER. `what` starts the sentence, e.g. "This project's model". */
export class NewerDataError extends HttpError {
  constructor(what: string) {
    super(
      409,
      `${what} was saved by a newer version of Coherence. Install that version or a later one to use it; nothing was changed.`,
      "DATA_NEWER",
    );
  }
}
