export type OdysseusTheme =
  "ocean" | "cyberpunk" | "retrowave" | "terminal" | "forest" | "cute";
export interface SourcePalette {
  bg: string;
  fg: string;
  panel: string;
  border: string;
  red: string;
}
export const ODYSSEUS_PALETTES: Record<OdysseusTheme, SourcePalette>;
export function deriveSyntaxColors(
  colors: SourcePalette,
): Record<string, string>;
export function computeAdvancedDefaults(
  colors: SourcePalette,
): Record<string, string>;
