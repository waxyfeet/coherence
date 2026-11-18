import { CancelledError } from "../errors";
import { CapacityError } from "../llm/capacity";
import { isCapacityFailure } from "./adaptiveReading";

/** Semantic units only: never substring prompts/JSON or discard owner context. Shared job guards still apply. */
export async function capacityBatches<T, R>(
  items: readonly T[],
  run: (items: readonly T[]) => Promise<R>,
  signal: AbortSignal,
  inform: (message: string) => void,
): Promise<R[]> {
  let tasks = 0;
  async function visit(part: readonly T[]): Promise<R[]> {
    if (signal.aborted) throw new CancelledError();
    if (++tasks > 31)
      throw new CapacityError(
        "input",
        "This task could not be completed within bounded automatic sizing. Completed readings are retained; choose another model explicitly.",
      );
    try {
      return [await run(part)];
    } catch (e) {
      if (signal.aborted || !isCapacityFailure(e) || part.length < 2) throw e;
      inform(
        "Adapting this stage into smaller batches. Each batch retains the full owner context; cross-batch conclusions require review.",
      );
      const mid = Math.ceil(part.length / 2);
      return [
        ...(await visit(part.slice(0, mid))),
        ...(await visit(part.slice(mid))),
      ];
    }
  }
  return visit(items);
}
