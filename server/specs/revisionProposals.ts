import path from "node:path";
import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import type {
  RevisionProposal as Proposal,
  RevisionProposalReview,
} from "@shared/api";
import type { Project, UseCase, SolutionModel } from "@shared/types";
import { paths } from "../config";
import { ConflictError, BadRequestError } from "../errors";
import { getFormat } from "../formats/registry";
import {
  getProject,
  loadModel,
  withProjectLock,
} from "../storage/projectStore";
import { readJsonIfExists, writeJsonAtomic } from "../storage/fsUtils";
import { readSpecFile, saveSpecFile } from "./specStore";

function proposalFile(pid: string, id: string) {
  if (!/^proposal_[A-Za-z0-9_-]{8,40}$/.test(id))
    throw new BadRequestError("Invalid revision proposal.");
  return path.join(paths.projectDir(pid), "proposals", id + ".json");
}
export async function createRevisionProposal(
  project: Project,
  model: SolutionModel,
  before: UseCase,
  next: UseCase,
  baselineHash: string,
): Promise<Proposal> {
  const format = getFormat(model.formatId);
  const rel = before.filePath ?? format.useCasePath(before);
  const current = await readSpecFile(project, rel);
  if (current.contentHash !== baselineHash)
    throw new ConflictError(
      "This document changed while the proposal was being prepared. Request another proposal using its current content.",
    );
  const proposal: Proposal = {
    id: "proposal_" + nanoid(12),
    projectId: project.id,
    useCaseId: before.id,
    revision: before.revision,
    path: rel,
    baselineHash,
    baselineMarkdown: current.content,
    proposedMarkdown: format.renderUseCase(
      { ...next, status: "edited", revision: before.revision + 1 },
      { project, model, embedScreenImages: model.options.embedScreenImages },
    ),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(proposalFile(project.id, proposal.id), proposal);
  return proposal;
}
/** Hashes domain artifacts directly; diagnostic redaction must never change approval evidence. */
function reviewToken(
  proposal: Proposal,
  model: SolutionModel,
  project: Project,
  contentHash: string,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        proposal,
        model,
        outputDir: project.outputDir,
        contentHash,
      }),
    )
    .digest("hex");
}

async function reviewState(pid: string, id: string) {
  const proposal = await getRevisionProposal(pid, id);
  if (
    proposal.status !== "pending" ||
    proposal.projectId !== pid ||
    proposal.id !== id
  )
    throw new ConflictError(
      "This proposal is no longer pending. Review a fresh proposal.",
    );
  const project = await getProject(pid);
  const model = await loadModel(pid);
  const current = model?.useCases.find((u) => u.id === proposal.useCaseId);
  if (
    !model ||
    !current ||
    current.revision !== proposal.revision ||
    (current.filePath && current.filePath !== proposal.path)
  )
    throw new ConflictError(
      "The use case changed after this proposal. Request and review a fresh proposal.",
    );
  const file = await readSpecFile(project, proposal.path);
  if (
    file.contentHash !== proposal.baselineHash ||
    file.content !== proposal.baselineMarkdown
  )
    throw new ConflictError(
      "The specification changed after this proposal. Request and review a fresh proposal.",
    );
  return {
    proposal,
    project,
    model,
    token: reviewToken(proposal, model, project, file.contentHash!),
  };
}

export async function reviewRevisionProposal(
  pid: string,
  id: string,
): Promise<RevisionProposalReview> {
  return withProjectLock(pid, async () => {
    const saved = await getRevisionProposal(pid, id);
    if (saved.status !== "pending") return { ...saved, reviewToken: "" };
    const { proposal, token } = await reviewState(pid, id);
    return { ...proposal, reviewToken: token };
  });
}

export async function applyRevisionProposal(
  pid: string,
  id: string,
  reviewedToken: string,
) {
  return withProjectLock(pid, async () => {
    const file = proposalFile(pid, id);
    const { proposal, project, token } = await reviewState(pid, id);
    if (!reviewedToken || reviewedToken !== token)
      throw new ConflictError(
        "The proposal or specification changed since review. Review the complete current proposal again before applying.",
      );
    const result = await saveSpecFile(
      project,
      {
        path: proposal.path,
        content: proposal.proposedMarkdown,
        baseHash: proposal.baselineHash,
      },
      {
        reviewedRevision: proposal.revision + 1,
        reviewedUseCaseId: proposal.useCaseId,
      },
    );
    proposal.status = "applied";
    await writeJsonAtomic(file, proposal);
    return result;
  });
}
export async function getRevisionProposal(pid: string, id: string) {
  await getProject(pid);
  const proposal = await readJsonIfExists<Proposal>(proposalFile(pid, id));
  if (!proposal)
    throw new BadRequestError("This revision proposal was not found.");
  return proposal;
}
export async function discardRevisionProposal(pid: string, id: string) {
  return withProjectLock(pid, async () => {
    const proposal = await getRevisionProposal(pid, id);
    if (proposal.status === "pending") {
      proposal.status = "discarded";
      await writeJsonAtomic(proposalFile(pid, id), proposal);
    }
    return { status: proposal.status };
  });
}
