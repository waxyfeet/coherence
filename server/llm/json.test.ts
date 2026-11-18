import { describe, expect, it } from "vitest";
import { extractJson, findBalancedEnd, repairJson } from "./json";

function value(text: string): unknown {
  const result = extractJson(text);
  if (!result.ok) throw new Error(`expected JSON, got error: ${result.error}`);
  return result.value;
}

describe("extractJson", () => {
  it("parses clean JSON", () => {
    expect(value('{"a":1,"b":[true,null]}')).toEqual({ a: 1, b: [true, null] });
  });

  it("strips ```json fences and surrounding prose", () => {
    const text =
      'Sure! Here is the analysis:\n\n```json\n{"screen": "Login", "elements": []}\n```\n\nLet me know if you need more.';
    expect(value(text)).toEqual({ screen: "Login", elements: [] });
  });

  it("handles an unterminated fence", () => {
    expect(value('```json\n{"ok": true}\n')).toEqual({ ok: true });
  });

  it("finds the outermost object inside prose, ignoring braces inside strings", () => {
    const text =
      'Result: {"label": "Use {curly} braces", "nested": {"x": "}"}} -- done';
    expect(value(text)).toEqual({
      label: "Use {curly} braces",
      nested: { x: "}" },
    });
  });

  it("skips a non-JSON brace pair in prose before the real object", () => {
    const text = 'I used {placeholders} here. {"title": "Orders"}';
    expect(value(text)).toEqual({ title: "Orders" });
  });

  it("tolerates trailing commas", () => {
    expect(value('{"a": [1, 2, 3,], "b": {"c": 1,},}')).toEqual({
      a: [1, 2, 3],
      b: { c: 1 },
    });
  });

  it("removes comments and Python literals outside strings", () => {
    const text =
      '{\n  // the flag\n  "flag": True, /* block */ "none": None, "text": "True // not a comment"\n}';
    expect(value(text)).toEqual({
      flag: true,
      none: null,
      text: "True // not a comment",
    });
  });

  it("escapes raw newlines and tabs inside strings", () => {
    const text = '{"description": "line one\nline two\tTabbed"}';
    expect(value(text)).toEqual({ description: "line one\nline two\tTabbed" });
  });

  it("repairs invalid escapes inside strings", () => {
    expect(value('{"path": "C:\\Users\\me"}')).toEqual({
      path: "C:\\Users\\me",
    });
  });

  it("drops <think> blocks from reasoning models", () => {
    const text =
      '<think>The user wants {"wrong": 1} maybe</think>\n{"right": 2}';
    expect(value(text)).toEqual({ right: 2 });
  });

  it("unwraps a JSON-encoded string that contains an object", () => {
    expect(value(JSON.stringify(JSON.stringify({ a: 1 })))).toEqual({ a: 1 });
  });

  it("prefers objects (every agent schema has an object root) and falls back to an array", () => {
    expect(value('Items: [{"id": 1}, {"id": 2}]')).toEqual({ id: 1 });
    expect(value('Items: ["a", "b"] — done')).toEqual(["a", "b"]);
    expect(value('[{"id": 1}, {"id": 2}]')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("reports empty and non-JSON answers", () => {
    expect(extractJson("   ").ok).toBe(false);
    expect(extractJson("I cannot help with that.").ok).toBe(false);
    expect(extractJson("OK").ok).toBe(false);
  });

  it("does not accept a truncated object", () => {
    expect(extractJson('{"a": "unfinished').ok).toBe(false);
    expect(extractJson('{"a": [1, 2').ok).toBe(false);
  });
});

describe("findBalancedEnd", () => {
  it("matches nested brackets and ignores escaped quotes", () => {
    const text = '{"a": "x\\"}", "b": [1, {"c": 2}]} tail';
    expect(text.slice(0, findBalancedEnd(text, 0) + 1)).toBe(
      '{"a": "x\\"}", "b": [1, {"c": 2}]}',
    );
  });

  it("returns -1 when unbalanced", () => {
    expect(findBalancedEnd('{"a": [1, 2}', 0)).toBe(-1);
    expect(findBalancedEnd('{"a": 1', 0)).toBe(-1);
  });
});

describe("repairJson", () => {
  it("leaves valid JSON untouched", () => {
    const json = '{"a":"b","c":[1,2,{"d":null}]}';
    expect(repairJson(json)).toBe(json);
  });

  it("is linear on large inputs", () => {
    const big = `{"items": [${Array.from({ length: 20000 }, (_, i) => `{"id": ${i}, "v": [1,2,],}`).join(",")},]}`;
    const started = Date.now();
    const repaired = repairJson(big);
    expect(Date.now() - started).toBeLessThan(2000);
    expect((JSON.parse(repaired) as { items: unknown[] }).items).toHaveLength(
      20000,
    );
  });
});
