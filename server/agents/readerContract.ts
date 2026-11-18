import { z } from "zod";
import { AnalysedElementSchema, ScreenAnalysisOutputSchema } from "./schemas";

export const READER_CONTRACT_VERSION = 2;
/** Same semantic output. Only absent optional detail may be omitted on the wire; validation expands defaults. */
export const ScreenReadingSchema = ScreenAnalysisOutputSchema.extend({
  elements: z.array(
    AnalysedElementSchema.extend({
      description: z.string().default(""),
      placeholder: z.string().default(""),
      defaultValue: z.string().default(""),
      helperText: z.string().default(""),
      options: z.array(z.string()).default([]),
      required: z.enum(["yes", "no", "unknown"]).default("unknown"),
      validation: z.array(z.string()).default([]),
      states: z.array(z.string()).default([]),
      behavior: z.string().default(""),
      navigatesToScreenId: z.string().default(""),
      navigatesToHint: z.string().default(""),
      dataBinding: z.string().default(""),
      inferred: z.array(z.string()).default([]),
    }),
  ),
}).superRefine((output, ctx) => {
  for (const [kind, records] of [
    ["regions", output.regions],
    ["elements", output.elements],
  ] as const) {
    const seen = new Set<string>();
    records.forEach((record, index) => {
      if (!record.key.trim() || seen.has(record.key))
        ctx.addIssue({
          code: "custom",
          path: [kind, index, "key"],
          message:
            "Record keys must be nonempty and unique within this screen section.",
        });
      seen.add(record.key);
    });
  }
  const regions = new Set(output.regions.map((r) => r.key));
  output.elements.forEach((e, index) => {
    if (!regions.has(e.regionKey))
      ctx.addIssue({
        code: "custom",
        path: ["elements", index, "regionKey"],
        message: "Every element must reference a returned region key.",
      });
  });
});

export const READER_DETAIL_INSTRUCTIONS =
  "Keep every visible element, exact label, option, value, helper/error text, validation evidence and owner note. Include detail fields when present; omit empty detail fields where the response format permits. Be concise; do not invent repeated generic descriptions, states or business rules. Put assumptions in inferred, not observed facts. Bounds and core identity fields are required.";
