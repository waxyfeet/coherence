/**
 * Structured-output schemas for every agent call.
 * They must convert to JSON Schema that ALL providers accept (Anthropic / OpenAI strict / Gemini / Ollama):
 * no recursion, no numeric min/max, no dynamic-key records, no object unions, every property required
 * ("" / [] / -1 stand for "absent"), enums via z.enum. The LLM returns *keys*; code composes and validates ids.
 */
import { z } from "zod";
import { ELEMENT_TYPES, SCREEN_TYPES } from "@shared/types";

/* ── Screen Analyst / Inspector ─────────────────────────────────────── */

/** Percent of the FULL screen image; all four -1 = unknown. */
export const BoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const RequiredFlagSchema = z.enum(["yes", "no", "unknown"]);

export const AnalysedElementSchema = z.object({
  key: z.string(),
  regionKey: z.string(),
  type: z.enum(ELEMENT_TYPES),
  label: z.string(),
  description: z.string(),
  placeholder: z.string(),
  defaultValue: z.string(),
  helperText: z.string(),
  options: z.array(z.string()),
  required: RequiredFlagSchema,
  validation: z.array(z.string()),
  states: z.array(z.string()),
  behavior: z.string(),
  navigatesToScreenId: z.string(),
  navigatesToHint: z.string(),
  dataBinding: z.string(),
  inferred: z.array(z.string()),
  bounds: BoundsSchema,
});

export const AnalysedRegionSchema = z.object({
  key: z.string(),
  name: z.string(),
  purpose: z.string(),
  layout: z.string(),
});

export const ScreenAnalysisOutputSchema = z.object({
  title: z.string(),
  purpose: z.string(),
  screenType: z.enum(SCREEN_TYPES),
  personas: z.array(z.string()),
  regions: z.array(AnalysedRegionSchema),
  elements: z.array(AnalysedElementSchema),
  dataEntities: z.array(z.string()),
  openQuestions: z.array(z.string()),
});

export const InspectorOutputSchema = ScreenAnalysisOutputSchema.extend({
  // Regions/elements contain complete added/changed records only; omissions preserve the first pass.
  boundsCorrections: z
    .array(z.object({ key: z.string(), bounds: BoundsSchema }))
    .default([]),
  labelCorrections: z
    .array(z.object({ key: z.string(), label: z.string() }))
    .default([]),
  /** What the inspector added or corrected, for the job log. */
  corrections: z.array(z.string()),
});

export type AnalysedElement = z.infer<typeof AnalysedElementSchema>;
export type AnalysedRegion = z.infer<typeof AnalysedRegionSchema>;
export type ScreenAnalysisOutput = z.infer<typeof ScreenAnalysisOutputSchema>;
export type InspectorOutput = z.infer<typeof InspectorOutputSchema>;

/* ── Journey Mapper ─────────────────────────────────────────────────── */

export const JourneyOutputSchema = z.object({
  summary: z.string(),
  personas: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      goals: z.array(z.string()),
    }),
  ),
  flows: z.array(
    z.object({
      fromScreenId: z.string(),
      toScreenId: z.string(),
      trigger: z.string(),
      /** Exact element id from the inventory, or "". */
      elementId: z.string(),
      condition: z.string(),
    }),
  ),
  dataEntities: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      fields: z.array(z.string()),
      screenIds: z.array(z.string()),
    }),
  ),
  /** Every screen id, in the order a user typically meets them. */
  journeyOrder: z.array(z.string()),
});

export type JourneyOutput = z.infer<typeof JourneyOutputSchema>;

/* ── Use Case Planner ───────────────────────────────────────────────── */

export const UseCaseSizeSchema = z.enum(["S", "M", "L"]);

export const PlannedUseCaseSchema = z.object({
  /** Plan-local kebab key used by dependsOn ("sign-in"). */
  key: z.string(),
  title: z.string(),
  featureKey: z.string(),
  personaName: z.string(),
  screenIds: z.array(z.string()),
  regionIds: z.array(z.string()),
  elementIds: z.array(z.string()),
  /** Keys of other planned use cases, or ids (UC-007) of already-specified use cases. */
  dependsOn: z.array(z.string()),
  size: UseCaseSizeSchema,
  scope: z.string(),
  preconditions: z.array(z.string()),
  postconditions: z.array(z.string()),
});

export const PlanFeatureSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
});

export const PlanOutputSchema = z.object({
  features: z.array(PlanFeatureSchema),
  useCases: z.array(PlannedUseCaseSchema),
});

export const CoverageRepairOutputSchema = z.object({
  /** Uncovered element → existing planned use case key. */
  assignments: z.array(
    z.object({
      elementId: z.string(),
      useCaseKey: z.string(),
    }),
  ),
  /** New use cases for elements that form their own user goal (may use new feature keys). */
  newFeatures: z.array(PlanFeatureSchema),
  newUseCases: z.array(PlannedUseCaseSchema),
});

export type PlannedUseCase = z.infer<typeof PlannedUseCaseSchema>;
export type PlanFeature = z.infer<typeof PlanFeatureSchema>;
export type PlanOutput = z.infer<typeof PlanOutputSchema>;
export type CoverageRepairOutput = z.infer<typeof CoverageRepairOutputSchema>;

/* ── Use Case Writer ────────────────────────────────────────────────── */

export const RULE_ELEMENT_TYPES = [
  ...ELEMENT_TYPES,
  "screen",
  "general",
] as const;

export const WrittenRuleSchema = z.object({
  /** "BR-01"; keep existing ids when revising. */
  id: z.string(),
  /** Exact element id from the use case's element list, or "" for screen/general rules. */
  elementId: z.string(),
  element: z.string(),
  elementType: z.enum(RULE_ELEMENT_TYPES),
  description: z.string(),
  rules: z.array(z.string()),
});

export const WrittenScenarioSchema = z.object({
  /** "SC-01"; keep existing ids when revising. */
  id: z.string(),
  title: z.string(),
  type: z.enum(["happy", "alternate", "negative", "edge"]),
  given: z.array(z.string()),
  when: z.array(z.string()),
  then: z.array(z.string()),
  elementIds: z.array(z.string()),
});

export const WriterOutputSchema = z.object({
  title: z.string(),
  scope: z.string(),
  story: z.object({
    asA: z.string(),
    iWant: z.string(),
    soThat: z.string(),
  }),
  preconditions: z.array(z.string()),
  postconditions: z.array(z.string()),
  businessRules: z.array(WrittenRuleSchema),
  scenarios: z.array(WrittenScenarioSchema),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
});

export type WrittenRule = z.infer<typeof WrittenRuleSchema>;
export type WrittenScenario = z.infer<typeof WrittenScenarioSchema>;
export type WriterOutput = z.infer<typeof WriterOutputSchema>;

/* ── Reviewer ───────────────────────────────────────────────────────── */

export const ReviewerOutputSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(["error", "warning", "info"]),
      category: z.enum([
        "chain",
        "coverage",
        "consistency",
        "size",
        "ambiguity",
        "other",
      ]),
      useCaseIds: z.array(z.string()),
      message: z.string(),
      suggestion: z.string(),
    }),
  ),
});

export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;
