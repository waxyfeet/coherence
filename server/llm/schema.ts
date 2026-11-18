/**
 * zod → JSON Schema, then sanitised for each provider's structured-output dialect.
 * Providers accept different subsets of JSON Schema and reject (HTTP 400) anything outside it, so we
 * only send what each one supports. Constraints a provider cannot enforce are not lost: they are
 * folded into the description as a hint for the model, and zod still validates them afterwards
 * (failures go through the repair turn).
 */
import { z } from "zod";
import type { ProviderKind } from "@shared/types";

export type JsonSchema = Record<string, unknown>;

/** 'prompt' = embedded in the system prompt (any provider): keep everything informative. */
export type SchemaDialect =
  "anthropic" | "openai" | "gemini" | "ollama" | "prompt";

export function dialectFor(provider: ProviderKind): SchemaDialect {
  switch (provider) {
    case "anthropic":
      return "anthropic";
    case "openai":
    case "azure-openai":
    case "openai-compatible":
      return "openai";
    case "gemini":
      return "gemini";
    case "ollama":
    case "mock":
      return "ollama";
  }
}

/** Draft 2020-12 schema of what the model must produce (zod's *input* side: defaults are optional). */
export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
    reused: "inline",
    cycles: "ref",
  }) as JsonSchema;
}

const cache = new WeakMap<object, Map<SchemaDialect, JsonSchema>>();

/** Sanitised schema for a zod schema and dialect (memoised per zod schema object). */
export function schemaFor(
  schema: z.ZodType,
  dialect: SchemaDialect,
): JsonSchema {
  let perDialect = cache.get(schema);
  if (!perDialect) {
    perDialect = new Map();
    cache.set(schema, perDialect);
  }
  let result = perDialect.get(dialect);
  if (!result) {
    result = sanitizeSchema(zodToJsonSchema(schema), dialect);
    perDialect.set(dialect, result);
  }
  return result;
}

/** OpenAI requires [a-zA-Z0-9_-]{1,64}; we apply it everywhere for consistency. */
export function safeSchemaName(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return cleaned || "response";
}

/* ------------------------------------------------------------------ */
/* Dialect rules                                                       */
/* ------------------------------------------------------------------ */

interface DialectRules {
  /** Keywords copied as-is (sub-schema keywords are recursed separately). */
  keep: Set<string>;
  /** Scalar constraints moved into the description when not kept. */
  hint: Set<string>;
  /** Allowed string formats (others become hints); undefined = any format allowed. */
  formats?: Set<string>;
  /** additionalProperties: false on every object. */
  closeObjects: boolean;
  /** Every property listed in `required`; optional ones become nullable (OpenAI strict). */
  allRequired: boolean;
  /** Remove additionalProperties entirely (Gemini). */
  dropAdditionalProperties: boolean;
  oneOfToAnyOf: boolean;
  /** Merge allOf members into the parent (dialects without allOf support). */
  flattenAllOf: boolean;
  constToEnum: boolean;
  /** Anthropic accepts only minItems 0 or 1. */
  maxMinItems?: number;
  /** Strict dialects need a type on every schema: replace `{}` with a primitive union. */
  typeRequired: boolean;
}

const STRUCTURAL = [
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "description",
  "title",
  "$ref",
  "$defs",
];
const NUMERIC = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
];
const STRING = ["minLength", "maxLength", "pattern", "format"];
const ARRAY = ["minItems", "maxItems", "uniqueItems"];
const OBJECT = ["minProperties", "maxProperties"];
const ALL_HINTS = new Set([...NUMERIC, ...STRING, ...ARRAY, ...OBJECT]);

/** String formats the strict dialects accept (Anthropic and OpenAI publish the same list). */
const STRICT_FORMATS = new Set([
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
]);

const RULES: Record<SchemaDialect, DialectRules> = {
  anthropic: {
    keep: new Set([
      ...STRUCTURAL,
      "anyOf",
      "allOf",
      "const",
      "default",
      "format",
      "minItems",
    ]),
    hint: ALL_HINTS,
    formats: STRICT_FORMATS,
    closeObjects: true,
    allRequired: false,
    dropAdditionalProperties: false,
    oneOfToAnyOf: true,
    flattenAllOf: false,
    constToEnum: false,
    maxMinItems: 1,
    typeRequired: true,
  },
  openai: {
    keep: new Set([...STRUCTURAL, "anyOf", "format"]),
    hint: ALL_HINTS,
    formats: new Set([...STRICT_FORMATS].filter((f) => f !== "uri")),
    closeObjects: true,
    allRequired: true,
    dropAdditionalProperties: false,
    oneOfToAnyOf: true,
    flattenAllOf: true,
    constToEnum: true,
    typeRequired: true,
  },
  gemini: {
    keep: new Set([
      ...STRUCTURAL,
      "anyOf",
      "prefixItems",
      "format",
      "minItems",
      "maxItems",
      "minimum",
      "maximum",
    ]),
    hint: ALL_HINTS,
    formats: new Set(["date-time", "date", "time", "enum"]),
    closeObjects: false,
    allRequired: false,
    dropAdditionalProperties: true,
    oneOfToAnyOf: true,
    flattenAllOf: true,
    constToEnum: true,
    typeRequired: false,
  },
  ollama: {
    keep: new Set([
      ...STRUCTURAL,
      "anyOf",
      "oneOf",
      "allOf",
      "const",
      "prefixItems",
      "additionalProperties",
      ...NUMERIC,
      ...STRING,
      ...ARRAY,
      ...OBJECT,
    ]),
    hint: new Set(),
    closeObjects: false,
    allRequired: false,
    dropAdditionalProperties: false,
    oneOfToAnyOf: false,
    flattenAllOf: false,
    constToEnum: false,
    typeRequired: false,
  },
  prompt: {
    keep: new Set([
      ...STRUCTURAL,
      "anyOf",
      "oneOf",
      "allOf",
      "const",
      "default",
      "prefixItems",
      "additionalProperties",
      ...NUMERIC,
      ...STRING,
      ...ARRAY,
      ...OBJECT,
    ]),
    hint: new Set(),
    closeObjects: false,
    allRequired: false,
    dropAdditionalProperties: false,
    oneOfToAnyOf: false,
    flattenAllOf: false,
    constToEnum: false,
    typeRequired: false,
  },
};

const MAP_KEYS = new Set(["properties", "$defs"]);
const ARRAY_KEYS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const ANY_VALUE: JsonSchema = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
};

/** Returns a sanitised deep copy; the input is not modified. */
export function sanitizeSchema(
  schema: JsonSchema,
  dialect: SchemaDialect,
): JsonSchema {
  const rules = RULES[dialect];
  const root = walk(normaliseDefinitions(schema), rules);
  return root;
}

/** draft-07 `definitions` → `$defs` so refs resolve the same way everywhere. */
function normaliseDefinitions(schema: JsonSchema): JsonSchema {
  if (!("definitions" in schema)) return schema;
  const { definitions, ...rest } = schema as JsonSchema & {
    definitions: unknown;
  };
  const json = JSON.stringify({
    ...rest,
    $defs: {
      ...(rest.$defs as object | undefined),
      ...(definitions as object),
    },
  });
  return JSON.parse(
    json.replaceAll("#/definitions/", "#/$defs/"),
  ) as JsonSchema;
}

function isPlainObject(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isObjectSchema(node: JsonSchema): boolean {
  const type = node.type;
  return (
    type === "object" ||
    (Array.isArray(type) && type.includes("object")) ||
    isPlainObject(node.properties)
  );
}

function isNullable(node: JsonSchema): boolean {
  if (node.type === "null") return true;
  if (Array.isArray(node.type) && node.type.includes("null")) return true;
  if (Array.isArray(node.anyOf))
    return node.anyOf.some((v) => isPlainObject(v) && isNullable(v));
  if (Array.isArray(node.enum)) return node.enum.includes(null);
  return false;
}

function makeNullable(node: JsonSchema): JsonSchema {
  if (isNullable(node)) return node;
  if (
    Array.isArray(node.anyOf) &&
    Object.keys(node).every(
      (k) => k === "anyOf" || k === "description" || k === "title",
    )
  ) {
    return { ...node, anyOf: [...node.anyOf, { type: "null" }] };
  }
  const { description, ...inner } = node;
  return description === undefined
    ? { anyOf: [inner, { type: "null" }] }
    : { anyOf: [inner, { type: "null" }], description };
}

function hintText(key: string, value: unknown): string | undefined {
  const json = JSON.stringify(value);
  if (json === undefined || json.length > 80) return undefined;
  return `${key}: ${json}`;
}

/** Merge allOf members into one schema (properties and required are unioned). */
function flattenAllOf(node: JsonSchema): JsonSchema {
  const members = (node.allOf as unknown[]).filter(isPlainObject);
  const { allOf: _ignored, ...base } = node;
  const merged: JsonSchema = { ...base };
  for (const member of members) {
    const flat = Array.isArray(member.allOf) ? flattenAllOf(member) : member;
    for (const [key, value] of Object.entries(flat)) {
      if (key === "properties" && isPlainObject(value)) {
        merged.properties = {
          ...(merged.properties as JsonSchema | undefined),
          ...value,
        };
      } else if (key === "required" && Array.isArray(value)) {
        merged.required = [
          ...new Set([
            ...((merged.required as string[] | undefined) ?? []),
            ...value,
          ]),
        ];
      } else if (key === "description" && merged.description) {
        merged.description = `${String(merged.description)} ${String(value)}`;
      } else if (!(key in merged)) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function walk(input: JsonSchema, rules: DialectRules): JsonSchema {
  const node =
    rules.flattenAllOf && Array.isArray(input.allOf)
      ? flattenAllOf(input)
      : input;
  const out: JsonSchema = {};
  const hints: string[] = [];

  for (const [key, value] of Object.entries(node)) {
    // zod marks every .int() with ±MAX_SAFE_INTEGER bounds — pure noise for a model.
    if (
      (key === "minimum" || key === "maximum") &&
      typeof value === "number" &&
      Math.abs(value) >= Number.MAX_SAFE_INTEGER
    ) {
      continue;
    }
    if (MAP_KEYS.has(key)) {
      if (!isPlainObject(value)) continue;
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [
          name,
          isPlainObject(sub) ? walk(sub, rules) : sub,
        ]),
      );
      continue;
    }
    if (ARRAY_KEYS.has(key)) {
      if (!Array.isArray(value)) continue;
      const target = key === "oneOf" && rules.oneOfToAnyOf ? "anyOf" : key;
      if (!rules.keep.has(target)) continue;
      out[target] = value.map((sub) =>
        isPlainObject(sub) ? walk(sub, rules) : sub,
      );
      continue;
    }
    if (key === "items") {
      if (isPlainObject(value)) out.items = walk(value, rules);
      continue;
    }
    if (key === "additionalProperties") {
      if (rules.dropAdditionalProperties || rules.closeObjects) continue;
      if (rules.keep.has(key))
        out[key] = isPlainObject(value) ? walk(value, rules) : value;
      continue;
    }
    if (key === "const") {
      if (rules.constToEnum) out.enum = [value];
      else if (rules.keep.has("const")) out.const = value;
      continue;
    }
    if (key === "format") {
      if (rules.formats && !rules.formats.has(String(value))) {
        const hint = hintText(key, value);
        if (hint) hints.push(hint);
      } else if (rules.keep.has(key)) {
        out.format = value;
      }
      continue;
    }
    if (
      key === "minItems" &&
      rules.maxMinItems !== undefined &&
      typeof value === "number" &&
      value > rules.maxMinItems
    ) {
      const hint = hintText(key, value);
      if (hint) hints.push(hint);
      continue;
    }
    if (rules.keep.has(key)) {
      out[key] = value;
      continue;
    }
    if (rules.hint.has(key)) {
      const hint = hintText(key, value);
      if (hint) hints.push(hint);
    }
    // Anything else ($schema, $id, examples, not/if/then/else, patternProperties…) is dropped.
  }

  if (isObjectSchema(out)) {
    if (!isPlainObject(out.properties)) out.properties = {};
    if (rules.closeObjects) out.additionalProperties = false;
    if (rules.allRequired) {
      const props = out.properties as JsonSchema;
      const required = new Set(
        Array.isArray(out.required) ? (out.required as string[]) : [],
      );
      for (const [name, sub] of Object.entries(props)) {
        if (!required.has(name) && isPlainObject(sub))
          props[name] = makeNullable(sub);
      }
      out.required = Object.keys(props);
    }
  }

  if (hints.length) {
    const existing =
      typeof out.description === "string" && out.description
        ? `${out.description} `
        : "";
    out.description = `${existing}(${hints.join(", ")})`;
  }

  if (
    rules.typeRequired &&
    !("type" in out) &&
    !("anyOf" in out) &&
    !("allOf" in out) &&
    !("$ref" in out) &&
    !("enum" in out) &&
    !("const" in out)
  ) {
    return {
      ...ANY_VALUE,
      ...(out.description ? { description: out.description } : {}),
    };
  }
  return out;
}

/**
 * Replace local $refs with their definitions (non-recursive schemas only; recursion is cut at depth 8
 * with an unconstrained object). Used for Gemini's legacy responseSchema, which has no $ref support.
 */
export function inlineRefs(schema: JsonSchema): JsonSchema {
  const defs = isPlainObject(schema.$defs)
    ? (schema.$defs as Record<string, JsonSchema>)
    : {};
  const resolve = (node: unknown, depth: number): unknown => {
    if (Array.isArray(node)) return node.map((n) => resolve(n, depth));
    if (!isPlainObject(node)) return node;
    if (typeof node.$ref === "string") {
      const name = node.$ref.replace(/^#\/\$defs\//, "");
      const target = defs[name];
      if (!target || depth > 8) return { type: "object" };
      const { $ref: _ref, ...siblings } = node;
      return resolve({ ...target, ...siblings }, depth + 1);
    }
    const out: JsonSchema = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$defs") continue;
      out[key] = resolve(value, depth);
    }
    return out;
  };
  return resolve(schema, 0) as JsonSchema;
}

/** Every keyword used anywhere in a schema (for tests and diagnostics). */
export function collectKeywords(
  schema: unknown,
  into = new Set<string>(),
): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) collectKeywords(item, into);
  } else if (isPlainObject(schema)) {
    for (const [key, value] of Object.entries(schema)) {
      into.add(key);
      if (key === "properties" || key === "$defs") {
        for (const sub of Object.values(value as JsonSchema))
          collectKeywords(sub, into);
      } else if (
        key !== "enum" &&
        key !== "const" &&
        key !== "default" &&
        key !== "required"
      ) {
        collectKeywords(value, into);
      }
    }
  }
  return into;
}
