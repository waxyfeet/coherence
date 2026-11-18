/**
 * Robust JSON extraction from model output. Models (especially local ones in prompt mode) wrap JSON
 * in prose or code fences, emit <think> blocks, trailing commas, comments, Python literals or raw
 * newlines inside strings. We try the cheap exact parse first and only then progressively repair.
 */

export type JsonExtraction =
  { ok: true; value: unknown } | { ok: false; error: string };

/** Max start positions probed per bracket kind — keeps worst-case cost bounded on huge outputs. */
const MAX_START_PROBES = 60;

export function extractJson(text: string): JsonExtraction {
  const cleaned = stripReasoning(text.replace(/^﻿/, "")).trim();
  if (!cleaned) return { ok: false, error: "the answer was empty" };

  let firstError: string | undefined;
  for (const candidate of candidates(cleaned)) {
    const parsed = tryParse(candidate);
    if (parsed.ok) return parsed;
    firstError ??= parsed.error;
  }
  return {
    ok: false,
    error: firstError ?? "no JSON object found in the answer",
  };
}

/** Remove <think>…</think> / <thinking>…</thinking> blocks that reasoning models put in the content. */
function stripReasoning(text: string): string {
  return text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "");
}

function* candidates(text: string): Generator<string> {
  yield text;

  // Fenced code blocks (```json … ``` or ``` … ```); an unterminated final fence counts too.
  const fence = /```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)(?:```|$)/g;
  for (const match of text.matchAll(fence)) {
    const body = match[1]?.trim();
    if (body) yield body;
  }

  // Balanced {...} segments, outermost first; then [...] as a last resort.
  for (const open of ["{", "["] as const) {
    let probes = 0;
    let from = 0;
    while (probes < MAX_START_PROBES) {
      const start = text.indexOf(open, from);
      if (start < 0) break;
      probes += 1;
      const end = findBalancedEnd(text, start);
      if (end > start) {
        yield text.slice(start, end + 1);
        // Nested objects are part of the segment we just tried — continue after it.
        from = end + 1;
      } else {
        yield text.slice(start);
        from = start + 1;
      }
    }
  }
}

function tryParse(candidate: string): JsonExtraction {
  const direct = parseStructured(candidate);
  if (direct.ok) return direct;
  const repaired = repairJson(candidate);
  if (repaired !== candidate) {
    const second = parseStructured(repaired);
    if (second.ok) return second;
  }
  return direct;
}

/** JSON.parse that only accepts objects/arrays (and unwraps a JSON-encoded string containing JSON). */
function parseStructured(text: string): JsonExtraction {
  try {
    let value: unknown = JSON.parse(text);
    if (typeof value === "string") {
      const inner = value.trim();
      if (
        (inner.startsWith("{") && inner.endsWith("}")) ||
        (inner.startsWith("[") && inner.endsWith("]"))
      ) {
        value = JSON.parse(inner);
      }
    }
    if (value !== null && typeof value === "object") return { ok: true, value };
    return { ok: false, error: "the answer was not a JSON object" };
  } catch (err) {
    return {
      ok: false,
      error: "The response contains invalid JSON syntax",
    };
  }
}

/** Index of the bracket closing the one at `start`, string-aware; -1 when unbalanced (truncated). */
export function findBalancedEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

const VALID_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
const LITERALS: Record<string, string> = {
  True: "true",
  False: "false",
  None: "null",
  NaN: "null",
  undefined: "null",
};

/**
 * Fix the common ways models break JSON, in one string-aware pass:
 * trailing commas, line and block comments, raw control characters and invalid escapes inside
 * strings, and Python/JS literals (True/False/None/NaN/undefined) outside strings.
 */
export function repairJson(input: string): string {
  // Array builder: trailing-comma removal looks back over a few entries instead of re-scanning a string.
  const out: string[] = [];
  let inString = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (inString) {
      if (ch === "\\") {
        const next = input[i + 1];
        if (next !== undefined && VALID_ESCAPES.has(next)) {
          out.push(ch + next);
          i += 2;
        } else {
          out.push("\\\\");
          i += 1;
        }
        continue;
      }
      if (ch === '"') {
        inString = false;
        out.push(ch);
      } else if (ch === "\n") out.push("\\n");
      else if (ch === "\r") out.push("\\r");
      else if (ch === "\t") out.push("\\t");
      else if (ch < " ")
        out.push(`\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
      else out.push(ch);
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === "/" && input[i + 1] === "/") {
      const nl = input.indexOf("\n", i);
      i = nl < 0 ? input.length : nl;
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      const close = input.indexOf("*/", i + 2);
      i = close < 0 ? input.length : close + 2;
      continue;
    }
    if (ch === "}" || ch === "]") {
      dropTrailingComma(out);
      out.push(ch);
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      const word = input.slice(i, j);
      out.push(LITERALS[word] ?? word);
      i = j;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

function dropTrailingComma(out: string[]): void {
  let k = out.length - 1;
  while (k >= 0 && /^\s+$/.test(out[k])) k -= 1;
  if (k >= 0 && out[k] === ",") out.splice(k, 1);
}
