// Loaded with --import by verify-staged.mjs: records every module URL the packaged app resolves,
// for both import and require, so loads from outside the install folder can be detected.
import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";

const log = process.env.COHERENCE_VERIFY_RESOLVE_LOG;
if (log)
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      appendFileSync(log, `${result.url}\n`);
      return result;
    },
  });
