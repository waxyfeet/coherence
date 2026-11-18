import { expect, it } from "vitest";
import { textDiff } from "./textDiff";

it.each([
  ["", ""],
  ["old", "new"],
  ["a\nb\nc\n", "a\nadded\nb\nchanged\n"],
  ["x\r\ny\n", "x\ny"],
  [
    "retained\n".repeat(800) + "REMOVE LATE\nMODIFY LATE\n",
    "retained\n".repeat(800) + "MODIFIED LATE\nADD LATE\n",
  ],
  [
    Array.from({ length: 1100 }, (_, i) => `old ${i}\n`).join(""),
    Array.from({ length: 1100 }, (_, i) => `new ${i}\n`).join(""),
  ],
])(
  "retains every byte of both documents in the complete diff",
  (before, after) => {
    const diff = textDiff(before, after);
    expect(
      diff.lines
        .filter((l) => l.kind !== "added")
        .map((l) => l.text)
        .join(""),
    ).toBe(before);
    expect(
      diff.lines
        .filter((l) => l.kind !== "removed")
        .map((l) => l.text)
        .join(""),
    ).toBe(after);
  },
);
it("marks late removals/additions and modifications beyond character 4000", () => {
  const same = "retained\n".repeat(800);
  const diff = textDiff(
    same + "DELETE LATE\nCHANGE OLD\n",
    same + "CHANGE NEW\nADD LATE\n",
  );
  expect(
    diff.lines.filter((l) => l.kind === "removed").map((l) => l.text),
  ).toEqual(["DELETE LATE\n", "CHANGE OLD\n"]);
  expect(
    diff.lines.filter((l) => l.kind === "added").map((l) => l.text),
  ).toEqual(["CHANGE NEW\n", "ADD LATE\n"]);
});
