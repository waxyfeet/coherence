import { expect, it } from "vitest";
import { SAMPLE_SCREENS } from "./mock/sampleScreens";
import { mockScreenAnalysis } from "./mock/screenMock";
import { project, screen } from "./testFixtures";
import { ScreenReadingSchema } from "./readerContract";
import { schemaFor } from "../llm/schema";
it.each(SAMPLE_SCREENS)(
  "preserves all fixture fields, exact labels and options for $file",
  (sample) => {
    const s = screen("scr_fixture", sample.title, 0),
      full = mockScreenAnalysis(project([s]), s, sample.sha256);
    const sparse = {
      ...full,
      elements: full.elements.map((e) =>
        Object.fromEntries(
          Object.entries(e).filter(
            ([k, v]) =>
              ["key", "regionKey", "type", "label", "bounds"].includes(k) ||
              (v !== "" &&
                !(Array.isArray(v) && v.length === 0) &&
                !(k === "required" && v === "unknown")),
          ),
        ),
      ),
    };
    expect(ScreenReadingSchema.parse(sparse)).toEqual(full);
    expect(Buffer.byteLength(JSON.stringify(sparse))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(full)),
    );
  },
);
it.each(["openai", "gemini", "anthropic", "ollama", "prompt"] as const)(
  "generates a usable %s schema and retains geometry and identity",
  (dialect) => {
    const schema = schemaFor(ScreenReadingSchema, dialect);
    expect(schema.type).toBe("object");
    expect(JSON.stringify(schema)).toContain('"bounds"');
    expect(JSON.stringify(schema)).toContain('"regionKey"');
  },
);
