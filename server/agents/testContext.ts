/**
 * Test-only JobContext that records logs, warnings, stages and usage in memory.
 */
import type { LLMUsage, LogLevel } from "@shared/types";
import { CancelledError } from "../errors";
import type { JobContext } from "../jobs/jobManager";

export interface RecordingContext extends JobContext {
  logs: { level: LogLevel; message: string }[];
  stages: string[];
  entered: string[];
  ticks: string[];
  usage: LLMUsage;
  cancel(): void;
}

export function recordingContext(projectId = "test-project"): RecordingContext {
  const controller = new AbortController();
  const ctx: RecordingContext = {
    jobId: "job_test",
    projectId,
    signal: controller.signal,
    logs: [],
    stages: [],
    entered: [],
    ticks: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    log(level, message) {
      ctx.logs.push({ level, message });
    },
    info(message) {
      ctx.logs.push({ level: "info", message });
    },
    warn(message) {
      ctx.logs.push({ level: "warn", message });
    },
    setStages(stages) {
      ctx.stages = [...stages];
    },
    stage(name) {
      ctx.entered.push(name);
    },
    progress() {},
    tick(label) {
      ctx.ticks.push(label ?? "");
    },
    addUsage(usage: Partial<LLMUsage>) {
      ctx.usage.calls += usage.calls ?? 1;
      ctx.usage.inputTokens += usage.inputTokens ?? 0;
      ctx.usage.outputTokens += usage.outputTokens ?? 0;
      if (usage.costUsd !== undefined)
        ctx.usage.costUsd = (ctx.usage.costUsd ?? 0) + usage.costUsd;
    },
    throwIfCancelled() {
      if (controller.signal.aborted) throw new CancelledError();
    },
    cancel() {
      controller.abort(new CancelledError());
    },
  };
  return ctx;
}
