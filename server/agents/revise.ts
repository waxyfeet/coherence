/**
 * OWNER: agents builder.
 * "Revise with AI": the BA gives free-text instructions for ONE use case; the Use Case Writer rewrites it
 * (revisionNotes = instructions), the result is diffed, revision+1, status 'edited' (it is now a BA-directed
 * version), the .md is re-rendered, a changelog entry is added. Persists. The UI then offers a knock-on
 * impact analysis using the returned diff.
 */
import type { ReviseUseCaseRequest, ReviseUseCaseResult } from "@shared/api";
import type { UseCase } from "@shared/types";
import {
  BadRequestError,
  CancelledError,
  NotFoundError,
  errorMessage,
} from "../errors";
import { getFormat } from "../formats/registry";
import type { JobContext } from "../jobs/jobManager";
import { connectionLabel, connectionSupportsVision } from "../llm/registry";
import { diffUseCases, hasContentChanges } from "../specs/useCaseDiff";
import { syncFromDisk, writeSpecs, readSpecFile } from "../specs/specStore";
import { createRevisionProposal } from "../specs/revisionProposals";
import {
  getProject,
  loadModel,
  saveModel,
  withProjectLock,
} from "../storage/projectStore";
import { resolveJobConnection, savedProjectConnections } from "./connections";
import { settleInterruptedCommit } from "./runState";
import { oneLine } from "./text";
import { writeUseCaseContent } from "./writer";

export const REVISE_STAGES = [
  "Preparing",
  "Revising use case",
  "Writing files",
] as const;

/** Long enough for detailed instructions, short enough to stay an instruction rather than a document. */
const MAX_INSTRUCTIONS = 8000;

export async function runReviseUseCase(
  ctx: JobContext,
  projectId: string,
  useCaseId: string,
  req: ReviseUseCaseRequest,
): Promise<ReviseUseCaseResult> {
  ctx.setStages([...REVISE_STAGES]);
  ctx.stage("Preparing", 1);
  const instructions = (req.instructions ?? "").trim();
  if (!instructions)
    throw new BadRequestError(
      "Describe what should change in the use case before revising it with AI.",
    );
  if (instructions.length > MAX_INSTRUCTIONS) {
    throw new BadRequestError(
      `The instructions are too long (${instructions.length} characters, max ${MAX_INSTRUCTIONS}). Shorten them or revise in smaller steps.`,
    );
  }

  let project = await getProject(projectId);
  if (!(await loadModel(projectId)))
    throw new NotFoundError(
      "There are no specs for this project yet — generate them first.",
    );
  // Pick up edits the BA made to the .md files outside the app, so the revision starts from what they see
  // (files an interrupted generation left behind are not edits).
  try {
    const { syncSafe } = await settleInterruptedCommit(projectId, (message) =>
      ctx.warn(message),
    );
    if (!syncSafe)
      throw new BadRequestError(
        "Recover the interrupted generation before revising.",
      );
    const sync = await syncFromDisk(project, { requireComplete: true });
    if (sync?.changed.length)
      ctx.info(
        `Picked up edits made outside the app first: ${sync.changed.map((d) => d.useCaseId).join(", ")}.`,
      );
  } catch (err) {
    if (err instanceof CancelledError || ctx.signal.aborted) throw err;
    throw new BadRequestError(
      "Revision stopped because human edits could not be synchronized safely. Repair or restore the specification files and sync before retrying.",
    );
  }

  const model = await loadModel(projectId);
  if (!model)
    throw new NotFoundError(
      "The specs of this project were removed while revising.",
    );
  const before = model.useCases.find((u) => u.id === useCaseId);
  if (!before)
    throw new NotFoundError(
      `Use case ${useCaseId} was not found. It may have been removed by a later generation.`,
    );

  const savedChoices = await savedProjectConnections(project);
  const { connection } = await resolveJobConnection(
    project,
    req.connectionId,
    [
      {
        id: savedChoices.textConnectionId,
        modelId: savedChoices.textModelId,
        use: "writing the specs",
      },
    ],
    undefined,
    {
      modelId: req.modelId,
      refreshMetadata: !!ctx.resources,
      signal: ctx.signal,
    },
  );
  const format = getFormat(model.formatId || project.formatId);
  const baseline = req.proposalOnly
    ? await readSpecFile(project, before.filePath ?? format.useCasePath(before))
    : undefined;
  ctx.tick();
  ctx.info(
    `Revising ${useCaseId} "${oneLine(before.title, 70)}" with ${connectionLabel(connection)}.`,
  );

  ctx.stage("Revising use case", 1);
  const next = await writeUseCaseContent({
    ctx,
    project,
    model,
    useCase: before,
    connection,
    format,
    revisionNotes: [
      "The business analyst asked for these changes to this use case:",
      instructions,
      "Apply them precisely. If they change a postcondition that later use cases depend on, change it only as far as the instructions require.",
    ].join("\n"),
    includeImages: connectionSupportsVision(connection),
  });
  ctx.tick(useCaseId);

  const diff = diffUseCases(before, next);
  const changed = hasContentChanges(diff);
  if (req.proposalOnly) {
    const proposal = await createRevisionProposal(
      project,
      model,
      before,
      next,
      baseline!.contentHash!,
    );
    ctx.info(
      "Revision proposal saved for review. The use case file has not been changed.",
    );
    return {
      useCase: next,
      diff,
      writtenFiles: [],
      proposalId: proposal.id,
      baselineMarkdown: proposal.baselineMarkdown,
      proposedMarkdown: proposal.proposedMarkdown,
    };
  }
  if (!changed)
    ctx.warn(
      `The AI made no changes to ${useCaseId}. Try more specific instructions.`,
    );

  ctx.stage("Writing files", 1);
  ctx.throwIfCancelled();
  const outcome = await withProjectLock(projectId, async () => {
    project = await getProject(projectId);
    const fresh = await loadModel(projectId);
    if (!fresh)
      throw new NotFoundError(
        "The specs of this project were removed while revising.",
      );
    const index = fresh.useCases.findIndex((u) => u.id === useCaseId);
    if (index < 0)
      throw new NotFoundError(
        `Use case ${useCaseId} was removed while it was being revised.`,
      );
    const current = fresh.useCases[index];
    if (!changed) return { useCase: current, writtenFiles: [] as string[] };

    const now = new Date().toISOString();
    // A BA-directed revision is no longer stale; structural fields stay as they are now (an export may
    // have added a link meanwhile).
    const { staleReason: _resolved, ...content } = next;
    const updated: UseCase = {
      ...content,
      external: current.external,
      filePath: current.filePath,
      revision: current.revision + 1,
      status: "edited",
      updatedAt: now,
    };
    fresh.useCases[index] = updated;
    fresh.changeLog.push({
      at: now,
      kind: "edited",
      summary: `${useCaseId} revised with AI (${connectionLabel(connection)}): ${diff.summary || "content updated"}. Instructions: "${oneLine(instructions, 160)}"`,
      useCaseIds: [useCaseId],
    });
    const files = await writeSpecs(project, fresh, {
      preserveEdited: false,
      embedScreenImages: fresh.options?.embedScreenImages ?? true,
      useCaseIds: [useCaseId],
    });
    for (const warning of files.warnings ?? []) ctx.warn(warning);
    await saveModel(projectId, fresh, { snapshot: true });
    return { useCase: fresh.useCases[index], writtenFiles: files.written };
  });
  ctx.tick(useCaseId);
  if (changed) ctx.info(`${useCaseId} revised: ${diff.summary}`);

  return { useCase: outcome.useCase, diff, writtenFiles: outcome.writtenFiles };
}
