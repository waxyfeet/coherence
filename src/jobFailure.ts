import type { Job } from "../shared/types";

/** What to tell the BA about a failed job: the plain message when the server gave one, else the older text. */
export function failureText(
  job: Pick<Job, "error" | "failure">,
): string | undefined {
  return job.failure?.message ?? job.error;
}
