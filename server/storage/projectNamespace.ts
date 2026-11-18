import { AsyncLocalStorage } from "node:async_hooks";
import { kernelLease } from "./kernelLease";
import { ConflictError } from "../errors";

// Serialize physical namespace changes across profiles. No shared registry or
// stale lock files: the kernel releases this short-lived gate on process exit.
const context = new AsyncLocalStorage<{ active: boolean }>();
let tail: Promise<unknown> = Promise.resolve();
export async function withProjectNamespace<T>(
  action: () => Promise<T>,
): Promise<T> {
  if (context.getStore()?.active) return action();
  const result = tail.then(async () => {
    let release: () => Promise<void>;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          release = await kernelLease(
            "portable-project-tree-v1",
            "coherence-namespace-",
          );
          break;
        } catch (error) {
          if (attempt === 99) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    } catch {
      throw new ConflictError(
        "Another Coherence process is changing project locations. Retry when it has finished; no folder was adopted.",
      );
    }
    const scope = { active: true };
    try {
      return await context.run(scope, action);
    } finally {
      scope.active = false;
      await release();
    }
  });
  tail = result.catch(() => {});
  return result;
}
