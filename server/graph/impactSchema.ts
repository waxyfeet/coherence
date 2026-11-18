/**
 * OWNER: graph builder.
 * Structured output of the Impact Analyst agent. JSON-Schema-friendly for every provider: no optional
 * properties (empty string / empty array instead), no numeric constraints, no records, enums via z.enum.
 */
import { z } from "zod";
import type { ImpactSeverity, UseCaseSection } from "@shared/types";

export const USE_CASE_SECTIONS = [
  "title",
  "story",
  "scope",
  "preconditions",
  "postconditions",
  "rules",
  "scenarios",
  "assumptions",
  "openQuestions",
  "notes",
  "dependencies",
  "elements",
  "status",
] as const satisfies readonly UseCaseSection[];

// Compile-time guard: the list above must name every UseCaseSection.
type MissingSection = Exclude<
  UseCaseSection,
  (typeof USE_CASE_SECTIONS)[number]
>;
const sectionsComplete: MissingSection extends never ? true : false = true;
void sectionsComplete;

export const IMPACT_SEVERITIES = [
  "high",
  "medium",
  "low",
  "none",
] as const satisfies readonly ImpactSeverity[];

export const impactAnalystItemSchema = z.object({
  useCaseId: z
    .string()
    .describe(
      'Id of an impacted use case exactly as given in the input, e.g. "UC-004".',
    ),
  severity: z
    .enum(IMPACT_SEVERITIES)
    .describe(
      "high = now wrong, must be rewritten; medium = some sections must change; low = worth a check; none = not affected.",
    ),
  reason: z
    .string()
    .describe(
      "One or two plain-language sentences: what breaks in this use case and why.",
    ),
  suggestedChanges: z
    .array(z.string())
    .describe(
      'Concrete edits, each starting with the id or section it touches, e.g. "BR-02: change the minimum length from 8 to 12 characters".',
    ),
  affectedSections: z
    .array(z.enum(USE_CASE_SECTIONS))
    .describe("Sections of this use case that must change."),
  affectedRuleIds: z
    .array(z.string())
    .describe(
      'Existing business rule ids of THIS use case that must change, e.g. "BR-02".',
    ),
  affectedScenarioIds: z
    .array(z.string())
    .describe(
      'Existing scenario ids of THIS use case that must change, e.g. "SC-03".',
    ),
});

export const suggestedUseCaseSchema = z.object({
  title: z.string().describe("Verb-first title of the missing use case."),
  reason: z
    .string()
    .describe(
      "Why the change needs a new use case rather than an edit of an existing one.",
    ),
  screenIds: z
    .array(z.string())
    .describe(
      "Screen ids (from the screen list) the new use case would cover.",
    ),
});

export const impactAnalystSchema = z.object({
  summary: z
    .string()
    .describe(
      "2–4 sentences: what changes, how many use cases are affected and which need the most work.",
    ),
  items: z.array(impactAnalystItemSchema),
  risks: z
    .array(z.string())
    .describe("Specific delivery/quality risks for the product owner (max 6)."),
  suggestedNewUseCases: z.array(suggestedUseCaseSchema),
});

export type ImpactAnalystItem = z.infer<typeof impactAnalystItemSchema>;
export type ImpactAnalystOutput = z.infer<typeof impactAnalystSchema>;
