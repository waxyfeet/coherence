import { useMemo, useState } from "react";
import { textDiff } from "../shared/textDiff";
import { Button } from "./ui";

export function RevisionDiff({
  before,
  after,
}: {
  before: string;
  after: string;
}) {
  const [view, setView] = useState<"diff" | "current" | "proposed">("diff");
  const diff = useMemo(() => textDiff(before, after), [before, after]);
  return (
    <div className="revision-review">
      <div
        className="inline-between revision-review-tools"
        role="group"
        aria-label="Revision review views"
      >
        {(
          [
            ["diff", "Changes"],
            ["current", "Full current"],
            ["proposed", "Full proposed"],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            aria-pressed={view === key}
            onClick={() => setView(key)}
          >
            {label}
          </Button>
        ))}
      </div>
      <p className="field-hint">
        Complete documents · {before.length.toLocaleString()} current /{" "}
        {after.length.toLocaleString()} proposed characters. + Added · − Removed
        · Modifications show the old and new lines. No content is hidden or
        shortened.
      </p>
      {diff.blockReplacement && (
        <p className="field-hint">
          Large changed block: all removed and replacement lines are shown in
          full.
        </p>
      )}
      {view === "diff" ? (
        <div
          className="proposal-diff"
          role="region"
          aria-label="Complete revision diff"
          tabIndex={0}
        >
          {diff.lines.map((line, index) => (
            <div className={`proposal-diff-line ${line.kind}`} key={index}>
              <span className="diff-number" aria-label="Current line">
                {line.before ?? ""}
              </span>
              <span className="diff-number" aria-label="Proposed line">
                {line.after ?? ""}
              </span>
              <span className="diff-sign" aria-label={line.kind}>
                {line.kind === "added"
                  ? "+"
                  : line.kind === "removed"
                    ? "−"
                    : " "}
              </span>
              <pre>
                {line.text}
                {!line.text.endsWith("\n") && (
                  <span className="diff-no-newline"> [No newline at end]</span>
                )}
              </pre>
            </div>
          ))}
        </div>
      ) : (
        <pre
          className="proposal-full-text"
          role="region"
          aria-label={
            view === "current"
              ? "Complete current Markdown"
              : "Complete proposed Markdown"
          }
          tabIndex={0}
        >
          {view === "current" ? before : after}
        </pre>
      )}
    </div>
  );
}
