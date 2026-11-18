import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  collectKeywords,
  dialectFor,
  inlineRefs,
  safeSchemaName,
  sanitizeSchema,
  schemaFor,
  zodToJsonSchema,
  type JsonSchema,
} from "./schema";

/** Representative agent-style schema with every construct the sanitiser must handle. */
const Element = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z_]+$/),
  type: z.enum(["button", "text_input", "dropdown"]),
  label: z.string(),
  options: z.array(z.string()).min(2).max(50),
  required: z.boolean(),
  count: z.number().int().min(0).max(100).multipleOf(1),
  email: z.string().email(),
  website: z.string().url(),
  kind: z.literal("element"),
  note: z.string().nullable(),
  hint: z.string().optional(),
  extra: z.string().default(""),
});
const Analysis = z.object({
  title: z.string().describe("Screen title"),
  elements: z.array(Element),
  regions: z.array(
    z.object({ name: z.string(), elementKeys: z.array(z.string()) }),
  ),
  meta: z.intersection(
    z.object({ a: z.string() }),
    z.object({ b: z.number() }),
  ),
  choice: z.union([z.object({ x: z.string() }), z.object({ y: z.number() })]),
});

const NUMERIC_AND_STRING = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
];

/** Visit every schema node that describes an object. */
function objectNodes(schema: unknown, out: JsonSchema[] = []): JsonSchema[] {
  if (Array.isArray(schema)) schema.forEach((s) => objectNodes(s, out));
  else if (schema && typeof schema === "object") {
    const node = schema as JsonSchema;
    if (
      node.type === "object" ||
      (node.properties && typeof node.properties === "object")
    )
      out.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" || key === "$defs")
        Object.values(value as JsonSchema).forEach((v) => objectNodes(v, out));
      else if (key !== "enum" && key !== "const" && key !== "required")
        objectNodes(value, out);
    }
  }
  return out;
}

function allFormats(schema: unknown, out: string[] = []): string[] {
  if (Array.isArray(schema)) schema.forEach((s) => allFormats(s, out));
  else if (schema && typeof schema === "object") {
    for (const [key, value] of Object.entries(schema)) {
      if (key === "format" && typeof value === "string") out.push(value);
      else allFormats(value, out);
    }
  }
  return out;
}

describe("zodToJsonSchema", () => {
  it("produces a draft 2020-12 object schema", () => {
    const json = zodToJsonSchema(Analysis);
    expect(json.type).toBe("object");
    expect(json.$schema).toContain("2020-12");
  });
});

describe("sanitizeSchema — anthropic", () => {
  const schema = schemaFor(Analysis, "anthropic");
  const keywords = collectKeywords(schema);

  it("strips $schema and unsupported numeric/string constraints", () => {
    expect(keywords.has("$schema")).toBe(false);
    for (const kw of NUMERIC_AND_STRING)
      expect(keywords.has(kw), kw).toBe(false);
    expect(keywords.has("maxItems")).toBe(false);
    expect(keywords.has("oneOf")).toBe(false);
  });

  it("sets additionalProperties:false on every object", () => {
    const objects = objectNodes(schema);
    expect(objects.length).toBeGreaterThan(4);
    for (const node of objects) expect(node.additionalProperties).toBe(false);
  });

  it("keeps enums, const, supported formats and minItems ≤ 1 only", () => {
    const element = ((schema.properties as JsonSchema).elements as JsonSchema)
      .items as JsonSchema;
    const props = element.properties as Record<string, JsonSchema>;
    expect(props.type.enum).toEqual(["button", "text_input", "dropdown"]);
    expect(props.kind.const).toBe("element");
    expect(props.email.format).toBe("email");
    expect(props.options.minItems).toBeUndefined();
    expect(String(props.options.description)).toContain("minItems: 2");
    expect(String(props.key.description)).toContain("minLength: 1");
    for (const format of allFormats(schema)) {
      expect([
        "date-time",
        "time",
        "date",
        "duration",
        "email",
        "hostname",
        "uri",
        "ipv4",
        "ipv6",
        "uuid",
      ]).toContain(format);
    }
  });

  it("drops the ±MAX_SAFE_INTEGER bounds zod adds to integers without leaving a hint", () => {
    const json = sanitizeSchema(
      zodToJsonSchema(z.object({ n: z.number().int() })),
      "anthropic",
    );
    expect((json.properties as Record<string, JsonSchema>).n).toEqual({
      type: "integer",
    });
  });
});

describe("sanitizeSchema — openai strict", () => {
  const schema = schemaFor(Analysis, "openai");
  const keywords = collectKeywords(schema);

  it("makes every property required and every object closed", () => {
    for (const node of objectNodes(schema)) {
      expect(node.additionalProperties).toBe(false);
      expect([...(node.required as string[])].sort()).toEqual(
        Object.keys(node.properties as object).sort(),
      );
    }
  });

  it("turns optional properties into nullable ones", () => {
    const element = ((schema.properties as JsonSchema).elements as JsonSchema)
      .items as JsonSchema;
    const props = element.properties as Record<string, JsonSchema>;
    expect(props.hint.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
    expect(props.extra.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
    // Already nullable stays as is.
    expect(props.note.type).toEqual(["string", "null"]);
  });

  it("strips unsupported keywords, flattens allOf, and converts const to enum", () => {
    for (const kw of [
      ...NUMERIC_AND_STRING,
      "minItems",
      "maxItems",
      "default",
      "allOf",
      "oneOf",
      "const",
      "$schema",
    ]) {
      expect(keywords.has(kw), kw).toBe(false);
    }
    const meta = (schema.properties as Record<string, JsonSchema>).meta;
    expect(Object.keys(meta.properties as object).sort()).toEqual(["a", "b"]);
    const element = ((schema.properties as JsonSchema).elements as JsonSchema)
      .items as JsonSchema;
    expect(
      (element.properties as Record<string, JsonSchema>).kind.enum,
    ).toEqual(["element"]);
    expect(allFormats(schema)).not.toContain("uri");
  });
});

describe("sanitizeSchema — gemini", () => {
  const schema = schemaFor(Analysis, "gemini");
  const keywords = collectKeywords(schema);

  it("removes additionalProperties, $schema and unsupported keywords", () => {
    for (const kw of [
      "additionalProperties",
      "$schema",
      "pattern",
      "minLength",
      "maxLength",
      "multipleOf",
      "const",
      "default",
      "allOf",
    ]) {
      expect(keywords.has(kw), kw).toBe(false);
    }
  });

  it("keeps what Gemini supports", () => {
    const element = ((schema.properties as JsonSchema).elements as JsonSchema)
      .items as JsonSchema;
    const props = element.properties as Record<string, JsonSchema>;
    expect(props.options.minItems).toBe(2);
    expect(props.options.maxItems).toBe(50);
    expect(props.count.minimum).toBe(0);
    expect(props.type.enum).toEqual(["button", "text_input", "dropdown"]);
  });
});

describe("sanitizeSchema — ollama / prompt", () => {
  it("only removes $schema (llama.cpp grammars understand the rest)", () => {
    const plain = zodToJsonSchema(Analysis);
    const ollama = sanitizeSchema(plain, "ollama");
    expect(ollama.$schema).toBeUndefined();
    const element = ((ollama.properties as JsonSchema).elements as JsonSchema)
      .items as JsonSchema;
    expect(
      (element.properties as Record<string, JsonSchema>).key.minLength,
    ).toBe(1);
  });

  it("does not mutate the input schema", () => {
    const plain = zodToJsonSchema(Analysis);
    const before = JSON.stringify(plain);
    sanitizeSchema(plain, "openai");
    sanitizeSchema(plain, "anthropic");
    sanitizeSchema(plain, "gemini");
    expect(JSON.stringify(plain)).toBe(before);
  });
});

describe("refs and helpers", () => {
  it("keeps $defs/$ref (sanitised) for recursive schemas and inlines them for Gemini legacy", () => {
    interface Node {
      name: string;
      children: Node[];
    }
    const Tree: z.ZodType<Node> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(Tree) }),
    );
    const json = sanitizeSchema(
      zodToJsonSchema(z.object({ root: Tree })),
      "anthropic",
    );
    expect(JSON.stringify(json)).toContain("$ref");
    const inlined = inlineRefs(json);
    expect(JSON.stringify(inlined)).not.toContain("$ref");
    expect(JSON.stringify(inlined)).not.toContain("$defs");
  });

  it("replaces untyped schemas with a primitive union for strict dialects", () => {
    const json = sanitizeSchema(
      zodToJsonSchema(z.object({ anything: z.any() })),
      "openai",
    );
    expect(
      (json.properties as Record<string, JsonSchema>).anything.anyOf,
    ).toBeDefined();
  });

  it("maps providers to dialects and cleans schema names", () => {
    expect(dialectFor("azure-openai")).toBe("openai");
    expect(dialectFor("openai-compatible")).toBe("openai");
    expect(dialectFor("mock")).toBe("ollama");
    expect(safeSchemaName("screen analysis: Login!")).toBe(
      "screen_analysis_Login",
    );
    expect(safeSchemaName("x".repeat(100))).toHaveLength(64);
    expect(safeSchemaName("!!!")).toBe("response");
  });

  it("memoises per zod schema and dialect", () => {
    expect(schemaFor(Analysis, "openai")).toBe(schemaFor(Analysis, "openai"));
    expect(schemaFor(Analysis, "openai")).not.toBe(
      schemaFor(Analysis, "anthropic"),
    );
  });
});
