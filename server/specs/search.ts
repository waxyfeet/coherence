import { readOwnedFile } from "../storage/fsUtils";
/**
 * OWNER: formats builder.
 * Case-insensitive full-text search over the .md and .feature files in project.outputDir.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { SearchHit } from "@shared/api";
import type { Project } from "@shared/types";
import { BadRequestError } from "../errors";
import { splitFrontMatter } from "../formats/frontMatter";
import { FEATURES_DIR, SCREENS_DIR, USE_CASES_DIR } from "../formats/layout";
import {
  GHERKIN_EXTS,
  MARKDOWN_EXTS,
  extOf,
  isMissing,
  isTextSpec,
  statOrNull,
  walk,
} from "./files";

export const MAX_SEARCH_HITS = 100;
export const MIN_QUERY_LENGTH = 2;
const PREVIEW_MAX = 200;
/** Spec files are small; anything bigger is not something the BA wrote or we generated. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const ROOT_FILE_RANK = ["README.md", "BUILD-PLAN.md"];

/**
 * Files are searched in the order the BA reads them: index, use cases (by id), screens, reports, Gherkin,
 * then anything else — so the 100-hit cap keeps the most useful matches.
 */
function fileRank(rel: string): number {
  const top = ROOT_FILE_RANK.indexOf(rel);
  if (top >= 0) return top;
  if (rel.startsWith(`${USE_CASES_DIR}/`)) return 10;
  if (rel.startsWith(`${SCREENS_DIR}/`)) return 20;
  if (!rel.includes("/") && MARKDOWN_EXTS.has(extOf(rel))) return 30;
  if (rel.startsWith(`${FEATURES_DIR}/`)) return 40;
  return 50;
}

function useCaseIdFromName(rel: string): string | undefined {
  return /^(UC-\d{3,})(?:[-_.\s]|$)/i
    .exec(path.posix.basename(rel))?.[1]
    ?.toUpperCase();
}

/** Front matter `id` of a use case file, read without a YAML parser (tolerates broken front matter). */
function frontMatterId(content: string): string | undefined {
  const fm = splitFrontMatter(content);
  if (!fm.found) return undefined;
  const m = /^id:\s*["']?(UC-\d{3,})["']?\s*(?:#.*)?$/im.exec(fm.yaml);
  return m?.[1]?.toUpperCase();
}

/** H1 of a markdown file (outside fences and front matter), "Feature:" name of a Gherkin file, else the file name. */
export function fileTitle(rel: string, content: string): string {
  const name = path.posix.basename(rel);
  if (GHERKIN_EXTS.has(extOf(rel))) {
    const feature = /^\s*Feature:\s*(.+?)\s*$/im.exec(content);
    return feature?.[1] || name;
  }
  const body = splitFrontMatter(content).body;
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = null;
      continue;
    }
    if (fence) continue;
    const h1 = /^ {0,3}#(?!#)[ \t]+(.+?)[ \t#]*$/.exec(line);
    if (h1?.[1]) return h1[1].trim();
  }
  return name;
}

/** The matching line, trimmed; long lines are cut to a window around the first match. */
export function previewLine(
  line: string,
  matchIndex: number,
  queryLength: number,
): string {
  const text = line.replace(/\t/g, " ");
  const trimmedStart = text.length - text.trimStart().length;
  const trimmed = text.trim();
  if (trimmed.length <= PREVIEW_MAX) return trimmed;
  const at = Math.max(0, matchIndex - trimmedStart);
  const context = Math.max(0, Math.floor((PREVIEW_MAX - queryLength) / 2));
  let start = Math.max(0, at - context);
  const end = Math.min(trimmed.length, start + PREVIEW_MAX);
  start = Math.max(0, end - PREVIEW_MAX);
  return `${start > 0 ? "…" : ""}${trimmed.slice(start, end).trim()}${end < trimmed.length ? "…" : ""}`;
}

/** Max 100 hits; empty array for queries shorter than 2 characters. */
export async function searchSpecs(
  project: Project,
  query: string,
): Promise<SearchHit[]> {
  const needle = (query ?? "").trim();
  if (needle.length < MIN_QUERY_LENGTH) return [];
  if (!project.outputDir || !path.isAbsolute(project.outputDir)) {
    throw new BadRequestError(
      "The project has no valid output folder. Set an absolute folder path on the Overview page.",
    );
  }
  const root = path.resolve(project.outputDir);
  const st = await statOrNull(root);
  if (!st?.isDirectory()) return [];

  const lowerNeedle = needle.toLowerCase();
  const files = (await walk(root))
    .filter((entry) => !entry.isDir && isTextSpec(entry.rel))
    .sort(
      (a, b) =>
        fileRank(a.rel) - fileRank(b.rel) ||
        a.rel.localeCompare(b.rel, undefined, { numeric: true }),
    );

  const hits: SearchHit[] = [];
  for (const file of files) {
    if (hits.length >= MAX_SEARCH_HITS) break;
    let content: string;
    try {
      const info = await fs.stat(file.abs);
      if (info.size > MAX_FILE_BYTES) continue;
      content = (await readOwnedFile(file.abs)).toString("utf8");
    } catch (err) {
      if (isMissing(err)) continue; // deleted between listing and reading
      throw err;
    }
    content = content.replace(/^﻿/, "");
    if (!content.toLowerCase().includes(lowerNeedle)) continue;

    const title = fileTitle(file.rel, content);
    const isUseCase =
      file.rel.startsWith(`${USE_CASES_DIR}/`) &&
      MARKDOWN_EXTS.has(extOf(file.rel));
    const useCaseId = isUseCase
      ? (frontMatterId(content) ?? useCaseIdFromName(file.rel))
      : file.rel.startsWith(`${FEATURES_DIR}/`)
        ? useCaseIdFromName(file.rel)
        : undefined;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
      const index = lines[i].toLowerCase().indexOf(lowerNeedle);
      if (index < 0) continue;
      const hit: SearchHit = {
        path: file.rel,
        title,
        line: i + 1,
        preview: previewLine(lines[i], index, needle.length),
      };
      if (useCaseId) hit.useCaseId = useCaseId;
      hits.push(hit);
    }
  }
  return hits;
}
