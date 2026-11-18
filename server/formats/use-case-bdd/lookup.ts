/**
 * OWNER: formats builder.
 * Read-only indexes over a RenderContext (names, keys, file paths, coverage) shared by every renderer.
 * Built per render call: cheap (linear in model size) and never stale when callers mutate the model.
 */
import {
  slugify,
  type FeatureGroup,
  type Persona,
  type Screen,
  type ScreenAnalysis,
  type ScreenRegion,
  type UIElement,
  type UseCase,
} from "@shared/types";
import { USE_CASES_DIR, screenImageRelPath } from "../layout";
import type { RenderContext } from "../types";

export interface Lookup {
  ctx: RenderContext;
  projectScreens: Map<string, Screen>;
  analyses: Map<string, ScreenAnalysis>;
  /** Analyses in project screen order (unknown screens last, in model order). */
  orderedAnalyses: ScreenAnalysis[];
  elements: Map<string, UIElement>;
  regions: Map<string, ScreenRegion>;
  features: Map<string, FeatureGroup>;
  personas: Map<string, Persona>;
  useCases: Map<string, UseCase>;
  /** Use cases ordered by build order. */
  orderedUseCases: UseCase[];
  /** elementId → use case ids covering it (build order). */
  coverage: Map<string, string[]>;
  /** useCaseId → ids of use cases that depend on it (build order). */
  dependents: Map<string, string[]>;
  screenKey(screenId: string): string;
  screenName(screenId: string): string;
  /** "screens/<key>.md" relative to outputDir. */
  screenDocPath(screenId: string): string;
  /** "screens/images/<key>.<ext>" relative to outputDir, or undefined when the screen has no stored image. */
  screenImagePath(screenId: string): string | undefined;
  useCaseFile(uc: UseCase): string;
  featureName(featureId: string): string;
  personaName(personaId: string): string;
}

/** POSIX path of a use case file relative to outputDir: "use-cases/UC-003-<slug>.md". */
export function useCasePathFor(
  uc: Pick<UseCase, "id" | "slug" | "title">,
): string {
  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(uc.slug ?? "")
    ? uc.slug
    : slugify(uc.slug || uc.title || "");
  return `${USE_CASES_DIR}/${uc.id}-${slug}.md`;
}

function isSafeRelativeMd(p: string | undefined): p is string {
  return (
    !!p &&
    /\.md$/i.test(p) &&
    !p.startsWith("/") &&
    !p.includes("\\") &&
    !p.split("/").includes("..") &&
    !p.includes(":")
  );
}

export function buildLookup(ctx: RenderContext): Lookup {
  const { project, model } = ctx;
  const projectScreens = new Map(project.screens.map((s) => [s.id, s]));
  const analyses = new Map(model.screens.map((a) => [a.screenId, a]));
  const screenOrder = new Map(
    [...project.screens]
      .sort((a, b) => a.order - b.order)
      .map((s, i) => [s.id, i]),
  );
  const orderedAnalyses = model.screens
    .map((a, i) => ({ a, i }))
    .sort(
      (x, y) =>
        (screenOrder.get(x.a.screenId) ?? 1e6 + x.i) -
        (screenOrder.get(y.a.screenId) ?? 1e6 + y.i),
    )
    .map((x) => x.a);
  const elements = new Map<string, UIElement>();
  const regions = new Map<string, ScreenRegion>();
  for (const a of model.screens) {
    for (const r of a.regions) regions.set(r.id, r);
    for (const e of a.elements) elements.set(e.id, e);
  }
  const features = new Map(model.features.map((f) => [f.id, f]));
  const personas = new Map(model.personas.map((p) => [p.id, p]));
  const orderedUseCases = model.useCases
    .map((uc, i) => ({ uc, i }))
    .sort((x, y) => (x.uc.order || 0) - (y.uc.order || 0) || x.i - y.i)
    .map((x) => x.uc);
  const useCases = new Map(orderedUseCases.map((uc) => [uc.id, uc]));
  const coverage = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const uc of orderedUseCases) {
    for (const el of uc.elementIds) {
      const list = coverage.get(el) ?? [];
      if (!list.includes(uc.id)) list.push(uc.id);
      coverage.set(el, list);
    }
    for (const dep of uc.dependsOn) {
      const list = dependents.get(dep) ?? [];
      if (!list.includes(uc.id)) list.push(uc.id);
      dependents.set(dep, list);
    }
  }

  // Screen keys come from the analysis; unanalysed screens fall back to a unique slug of their name.
  const keys = new Map<string, string>();
  const usedKeys = new Set(model.screens.map((a) => a.screenKey));
  for (const a of model.screens) keys.set(a.screenId, a.screenKey);
  for (const s of project.screens) {
    if (keys.has(s.id)) continue;
    const base = slugify(s.name, 40);
    let key = base;
    for (let n = 2; usedKeys.has(key); n++) key = `${base}-${n}`;
    usedKeys.add(key);
    keys.set(s.id, key);
  }

  const lookup: Lookup = {
    ctx,
    projectScreens,
    analyses,
    orderedAnalyses,
    elements,
    regions,
    features,
    personas,
    useCases,
    orderedUseCases,
    coverage,
    dependents,
    screenKey: (id) => keys.get(id) ?? slugify(id, 40),
    screenName: (id) =>
      projectScreens.get(id)?.name || analyses.get(id)?.title || id,
    screenDocPath: (id) => `screens/${lookup.screenKey(id)}.md`,
    screenImagePath: (id) => {
      const screen = projectScreens.get(id);
      return screen
        ? screenImageRelPath(lookup.screenKey(id), screen)
        : undefined;
    },
    // The recorded file wins: a preserved (BA-edited) file keeps its name even if the slug changed since.
    useCaseFile: (uc) =>
      isSafeRelativeMd(uc.filePath) ? uc.filePath : useCasePathFor(uc),
    featureName: (id) => features.get(id)?.name || id || "",
    personaName: (id) => personas.get(id)?.name || id || "",
  };
  return lookup;
}

/** Relative link from one outputDir-relative file to another (both POSIX). */
export function relativeLink(fromFile: string, toFile: string): string {
  const from = fromFile.split("/").slice(0, -1);
  const to = toFile.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = from.slice(i).map(() => "..");
  return [...up, ...to.slice(i)].join("/") || toFile;
}
