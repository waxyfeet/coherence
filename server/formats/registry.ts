/**
 * OWNER: formats builder.
 * Output format registry. A new format = a new OutputFormat object added to FORMATS; nothing else changes.
 */
import { DEFAULT_FORMAT_ID, type OutputFormatInfo } from "@shared/types";
import { BadRequestError } from "../errors";
import type { OutputFormat } from "./types";
import { useCaseBddFormat } from "./use-case-bdd";

const FORMATS: readonly OutputFormat[] = [useCaseBddFormat];

/** @throws BadRequestError for unknown ids. */
export function getFormat(formatId: string): OutputFormat {
  const id = formatId || DEFAULT_FORMAT_ID;
  const format = FORMATS.find((f) => f.info.id === id);
  if (!format) {
    const known = FORMATS.map((f) => `"${f.info.id}"`).join(", ");
    throw new BadRequestError(
      `Unknown output format "${formatId}". Available formats: ${known}.`,
    );
  }
  return format;
}

export function listFormats(): OutputFormatInfo[] {
  return FORMATS.map((f) => ({ ...f.info }));
}

/** True when `formatId` is registered. */
export function hasFormat(formatId: string): boolean {
  return FORMATS.some((f) => f.info.id === formatId);
}
