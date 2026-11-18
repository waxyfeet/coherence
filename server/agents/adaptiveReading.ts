import { CapacityError } from "../llm/capacity";
import { ProviderError } from "../llm/errors";
import { CancelledError, LLMError } from "../errors";
import { ScreenReadingSchema } from "./readerContract";
import { keySlug } from "./text";
import {
  ScreenAnalysisOutputSchema,
  type ScreenAnalysisOutput,
} from "./schemas";

export interface ReadingCore {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ReadingParts {
  version: 1;
  split: string[];
  completed: { path: string; output: ScreenAnalysisOutput }[];
}
export const emptyReadingParts = (): ReadingParts => ({
  version: 1,
  split: [],
  completed: [],
});
const MAX_DEPTH = 3; // Finite task/latency guard, independent of any model name or reported limit.
export function coreFor(
  path: string,
  width: number,
  height: number,
): ReadingCore {
  let c = { x: 0, y: 0, width: 100, height: 100 };
  for (const bit of path) {
    if (width * c.width >= height * c.height)
      c = {
        ...c,
        x: c.x + (bit === "1" ? c.width / 2 : 0),
        width: c.width / 2,
      };
    else
      c = {
        ...c,
        y: c.y + (bit === "1" ? c.height / 2 : 0),
        height: c.height / 2,
      };
  }
  return c;
}
/** Optional cache input is untrusted; retain the schema's canonical values, including expanded defaults. */
export function parseReadingParts(value: unknown): ReadingParts | undefined {
  const v = value as ReadingParts | undefined;
  if (
    !v ||
    v.version !== 1 ||
    !Array.isArray(v.split) ||
    !Array.isArray(v.completed) ||
    v.split.length > 7 ||
    v.completed.length > 8
  )
    return;
  const validPath = (p: unknown) =>
    typeof p === "string" && /^[01]{0,3}$/.test(p);
  const names = [...v.split, ...v.completed.map((p) => p?.path)];
  if (!names.every(validPath) || new Set(names).size !== names.length) return;
  if (
    v.split.some((p) => p.length >= MAX_DEPTH) ||
    !names.every((p) => !p || v.split.includes(p.slice(0, -1)))
  )
    return;
  const completed: ReadingParts["completed"] = [];
  for (const part of v.completed) {
    const parsed = ScreenReadingSchema.safeParse(part.output);
    if (!parsed.success) return;
    completed.push({ path: part.path, output: parsed.data });
  }
  return { version: 1, split: [...v.split], completed };
}
export const validReadingParts = (value: unknown): boolean =>
  parseReadingParts(value) !== undefined;
export const isCapacityFailure = (e: unknown): boolean =>
  e instanceof CapacityError ||
  (e instanceof ProviderError && e.failure === "too_large");

function belongs(output: ScreenAnalysisOutput, core: ReadingCore): boolean {
  return output.elements.every((e) => {
    const b = e.bounds,
      x = b.x + b.width / 2,
      y = b.y + b.height / 2;
    return (
      [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
      b.x >= 0 &&
      b.y >= 0 &&
      b.width > 0 &&
      b.height > 0 &&
      b.x + b.width <= 100.1 &&
      b.y + b.height <= 100.1 &&
      x >= core.x &&
      y >= core.y &&
      (x < core.x + core.width || (core.x + core.width === 100 && x <= 100)) &&
      (y < core.y + core.height || (core.y + core.height === 100 && y <= 100))
    );
  });
}

/** Keep unambiguous prior element identities across whole-screen versus partitioned readings. */
export function reuseReadingKeys(
  output: ScreenAnalysisOutput,
  previous?: ScreenAnalysisOutput,
): ScreenAnalysisOutput {
  if (!previous) return output;
  const identity = (e: ScreenAnalysisOutput["elements"][number]) =>
    JSON.stringify([e.type, e.label.trim()]);
  // First establish every unambiguous match, then reserve its ID before allocating other keys.
  // An uncontested provider key can still represent an intentional label change, as before.
  const taken = new Set<string>();
  const allocate = (base: string): string => {
    let key = base,
      n = 1;
    while (taken.has(key)) {
      const suffix = `_${++n}`;
      key = base.slice(0, 40 - suffix.length).replace(/_+$/g, "") + suffix;
    }
    taken.add(key);
    return key;
  };
  const matches = output.elements.map((e) => {
    if (
      !e.label.trim() ||
      output.elements.filter((n) => identity(n) === identity(e)).length !== 1
    )
      return undefined;
    const prior = previous.elements.filter((p) => identity(p) === identity(e));
    const key = prior.length === 1 ? prior[0].key : "";
    return key &&
      keySlug(key) === key &&
      previous.elements.filter((p) => keySlug(p.key) === key).length === 1
      ? key
      : undefined;
  });
  for (const key of matches) if (key) taken.add(key);
  const result = {
    ...output,
    elements: output.elements.map((e, index) => ({
      ...e,
      key:
        matches[index] ??
        allocate(
          keySlug(e.key) || keySlug(e.label) || keySlug(e.type) || "element",
        ),
    })),
  };
  const keys = result.elements.map((e) => keySlug(e.key));
  if (keys.some((k) => !k) || new Set(keys).size !== keys.length)
    throw new LLMError(
      "The reading contained ambiguous element identities. No conflicting inventory was accepted.",
    );
  return ScreenReadingSchema.parse(result);
}

/** Complete, disjoint owned cores. Missing/ambiguous bounds are a failure, never a reason to drop evidence. */
export function ownSection(
  output: ScreenAnalysisOutput,
  core: ReadingCore,
  crop: ReadingCore,
): ScreenAnalysisOutput {
  const elements = output.elements
    .map((e) => {
      const b = e.bounds;
      if (
        ![b.x, b.y, b.width, b.height].every(Number.isFinite) ||
        b.x < 0 ||
        b.y < 0 ||
        b.width <= 0 ||
        b.height <= 0 ||
        b.x + b.width > 100.1 ||
        b.y + b.height > 100.1
      )
        throw new LLMError(
          "An automatically sized screen section returned uncertain coordinates. Coherence retained completed sections but did not publish an incomplete reading.",
        );
      return {
        ...e,
        bounds: {
          x: crop.x + (b.x * crop.width) / 100,
          y: crop.y + (b.y * crop.height) / 100,
          width: (b.width * crop.width) / 100,
          height: (b.height * crop.height) / 100,
        },
      };
    })
    .filter((e) => {
      const x = e.bounds.x + e.bounds.width / 2,
        y = e.bounds.y + e.bounds.height / 2;
      return (
        x >= core.x &&
        y >= core.y &&
        (x < core.x + core.width ||
          (core.x + core.width === 100 && x <= 100)) &&
        (y < core.y + core.height || (core.y + core.height === 100 && y <= 100))
      );
    });
  const regionKeys = new Set(output.regions.map((r) => r.key));
  if (elements.some((e) => !regionKeys.has(e.regionKey)))
    throw new LLMError(
      "A screen section referred to an unknown region. Completed sections are retained for recovery.",
    );
  return { ...output, elements };
}

export function mergeReadingParts(parts: ReadingParts): ScreenAnalysisOutput {
  const parsed = parseReadingParts(parts);
  const complete = (p: string): boolean =>
    parsed!.completed.some((x) => x.path === p) ||
    (parsed!.split.includes(p) && complete(p + "0") && complete(p + "1"));
  if (!parsed || !complete(""))
    throw new LLMError(
      "Not every screen section is complete. Coherence did not accept a partial inventory.",
    );
  const outputs = [...parsed.completed].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  if (outputs.length === 1 && outputs[0].path === "") return outputs[0].output;
  const all = outputs.map((p) => p.output);
  const unique = (v: string[]) => [...new Set(v)];
  const regions = outputs.flatMap((p) =>
    p.output.regions.map((r) => ({ ...r, key: `p${p.path}_${r.key}` })),
  );
  const elements = outputs.flatMap((p) =>
    p.output.elements.map((e) => ({
      ...e,
      key: `p${p.path}_${e.key}`,
      regionKey: `p${p.path}_${e.regionKey}`,
    })),
  );
  for (let i = 0; i < elements.length; i++)
    for (let j = i + 1; j < elements.length; j++) {
      const a = elements[i],
        b = elements[j];
      if (a.key.split("_")[0] === b.key.split("_")[0] || a.type !== b.type)
        continue;
      const near =
        Math.abs(a.bounds.x - b.bounds.x) < 1 &&
        Math.abs(a.bounds.y - b.bounds.y) < 1 &&
        Math.abs(a.bounds.width - b.bounds.width) < 1 &&
        Math.abs(a.bounds.height - b.bounds.height) < 1;
      if (near)
        throw new LLMError(
          "Screen sections returned ambiguous duplicate evidence at a seam. Completed sections are retained; Coherence did not silently merge or omit it.",
        );
    }
  if (new Set(elements.map((e) => e.key)).size !== elements.length)
    throw new LLMError(
      "A screen section returned duplicate element identities; no partial inventory was accepted.",
    );
  return ScreenAnalysisOutputSchema.parse({
    ...all[0],
    purpose: unique(all.map((o) => o.purpose)).join(" "),
    personas: unique(all.flatMap((o) => o.personas)),
    regions,
    elements,
    dataEntities: unique(all.flatMap((o) => o.dataEntities)),
    openQuestions: unique(all.flatMap((o) => o.openQuestions)),
  });
}

export async function adaptiveReading(args: {
  width: number;
  height: number;
  signal: AbortSignal;
  state?: unknown;
  read: (path: string, core: ReadingCore) => Promise<ScreenAnalysisOutput>;
  save?: (state: ReadingParts) => Promise<void>;
  inform: (message: string) => void;
}): Promise<{ output: ScreenAnalysisOutput; parts: number }> {
  const parsed = parseReadingParts(args.state);
  const validState =
    parsed &&
    parsed.completed.every(
      (p) =>
        !p.path || belongs(p.output, coreFor(p.path, args.width, args.height)),
    );
  const state = validState ? parsed! : emptyReadingParts();
  const save = async () => args.save?.(structuredClone(state));
  const visit = async (path: string): Promise<void> => {
    if (args.signal.aborted) throw new CancelledError();
    if (state.completed.some((p) => p.path === path)) {
      args.inform("Reused a completed screen section.");
      return;
    }
    if (!state.split.includes(path)) {
      try {
        const output = ScreenReadingSchema.parse(
          await args.read(path, coreFor(path, args.width, args.height)),
        );
        if (path && !belongs(output, coreFor(path, args.width, args.height)))
          throw new LLMError(
            "A screen section returned evidence outside its assigned area. Coherence did not accept a partial or ambiguous reading.",
          );
        state.completed.push({ path, output });
        await save();
        return;
      } catch (e) {
        if (args.signal.aborted || !isCapacityFailure(e)) throw e;
        if (path.length >= MAX_DEPTH)
          throw new CapacityError(
            "output",
            "Coherence could not safely complete even a small screen section for this model. Completed readings are retained. Choose another image-capable model explicitly; Coherence did not omit content or change providers.",
          );
        state.split.push(path);
        await save();
        args.inform(
          "Adapting this reading into smaller screen sections; the original image is unchanged.",
        );
      }
    }
    await visit(path + "0");
    await visit(path + "1");
  };
  await visit("");
  return { output: mergeReadingParts(state), parts: state.completed.length };
}
