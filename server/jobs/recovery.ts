import fs from "node:fs/promises";
import path from "node:path";
import type { Job } from "@shared/types";
import { paths } from "../config";
import { writeJsonAtomic } from "../storage/fsUtils";
import { safeJobDiagnostics } from "../security/jobDiagnostics";
import { listProjectIds } from "../storage/projectStore";
export async function recoverInterruptedJobs(): Promise<number> {
  let count = 0;
  for (const projectId of await listProjectIds()) {
    const dir = paths.jobsDir(projectId);
    for (const file of (await fs.readdir(dir).catch(() => [])).filter((f) =>
      f.endsWith(".json"),
    )) {
      const target = path.join(dir, file);
      let job: Job;
      try {
        job = JSON.parse(await fs.readFile(target, "utf8"));
      } catch {
        continue;
      }
      if (job.status === "queued" || job.status === "running") {
        job = safeJobDiagnostics(job);
        job.status = "failed";
        job.finishedAt = new Date().toISOString();
        job.error =
          "Interrupted by an application shutdown. Review saved outputs and explicitly retry; no model or tracker request was replayed.";
        await writeJsonAtomic(target, safeJobDiagnostics(job));
        count++;
      }
    }
  }
  return count;
}
