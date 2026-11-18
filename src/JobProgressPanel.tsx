import { LoaderCircle } from "lucide-react";
import type { Job, JobLiveCall } from "../shared/types";

const LIVE_LABELS: [prefix: string, label: string][] = [
  ["screen-analysis", "Reading"],
  ["screen-inspection", "Checking"],
  ["use-case-writer", "Writing"],
  ["use-case-plan-coverage", "Placing uncovered elements"],
  ["use-case-plan", "Planning use cases"],
  ["journey-map", "Mapping journeys"],
  ["review", "Reviewing"],
];

/** "use-case-writer:UC-007" → "Writing UC-007"; an unknown purpose is shown as it is. */
export function liveLabel(purpose: string): string {
  const [kind, ...rest] = purpose.split(":");
  const subject = rest.join(":").trim();
  const known = LIVE_LABELS.find(([prefix]) => kind === prefix);
  return known ? (subject ? `${known[1]} ${subject}` : known[1]) : purpose;
}

/** Counts describe work received, never time. */
export function liveState(call: JobLiveCall): string {
  return call.phase === "writing"
    ? `${call.received.toLocaleString()} characters so far`
    : call.phase === "thinking"
      ? "thinking…"
      : "waiting for the answer…";
}

/** Shared by the workbench and the dialog covering it. Counts describe work, never elapsed time. */
export function JobProgressPanel({
  job,
}: {
  job: Pick<Job, "status" | "progress" | "live">;
}) {
  const { progress, status } = job;
  const active = status === "queued" || status === "running";
  const total = Math.max(0, progress.total);
  const current = Math.max(
    0,
    Math.min(progress.current, total || progress.current),
  );
  const count = Math.max(0, progress.stageCount);
  const index = Math.min(
    Math.max(0, progress.stageIndex),
    Math.max(0, count - 1),
  );
  const unit =
    progress.stage === "Reading screens"
      ? "screens"
      : progress.stage === "Writing use cases"
        ? "use cases"
        : "items";
  const stage = progress.stage || "Waiting to start";
  const detail = total
    ? `${current} of ${total} ${unit} complete in this step`
    : active
      ? "Work in progress · duration unknown"
      : "No item total reported";
  return (
    <section
      className={`job-progress-panel ${active ? "is-working" : ""}`}
      aria-label="Operation progress"
    >
      <div
        className="job-progress-heading"
        aria-live="polite"
        aria-atomic="true"
      >
        <div>
          <span className="section-kicker">
            {count ? `Step ${index + 1} of ${count}` : "Current step"}
          </span>
          <strong>{stage}</strong>
        </div>
        <span className={`job-progress-state ${status}`}>
          {active && (
            <LoaderCircle className="spin" size={14} aria-hidden="true" />
          )}
          {active
            ? "Working"
            : status === "succeeded"
              ? "Complete"
              : status === "failed"
                ? "Stopped · failed"
                : "Cancelled"}
        </span>
      </div>
      {count > 1 && (
        <div
          className="job-progress-steps"
          aria-hidden="true"
          title="Completed and current steps; steps have different durations."
        >
          {Array.from({ length: count }, (_, i) => (
            <span
              key={i}
              className={
                i < index || status === "succeeded"
                  ? "complete"
                  : i === index
                    ? "current"
                    : ""
              }
            />
          ))}
        </div>
      )}
      <div className="job-progress-count" aria-live="polite">
        {detail}
      </div>
      <div
        className="job-progress-track"
        role="progressbar"
        aria-label={`${stage}: completed items`}
        aria-valuemin={0}
        aria-valuemax={total || undefined}
        aria-valuenow={total ? current : undefined}
        aria-valuetext={detail}
      >
        <span style={{ width: `${total ? (current / total) * 100 : 0}%` }} />
      </div>
      {active && !!job.live?.length && (
        <ul className="job-live" aria-label="AI requests in progress">
          {job.live.map((call) => (
            <li key={call.id} title={call.model}>
              <span>{liveLabel(call.purpose)}</span>
              <span>{liveState(call)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="job-progress-note">
        {progress.label ? `Latest update: ${progress.label}. ` : ""}
        {active
          ? "The indicator advances when work completes; model responses can take time."
          : "Progress retained from the saved operation."}
      </p>
    </section>
  );
}
