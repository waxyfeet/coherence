/**
 * What uses an AI connection, and moving those uses to another one (owner test notes 1 and 6; tester build WP8).
 * Removing a connection then explains what it affects and offers an explicit move. Nothing ever falls back to
 * another connection silently.
 */
import type { ConnectionUsage, UpdateProjectRequest } from "@shared/api";
import { projectConnectionChoices } from "@shared/generationContext";
import { analysisModelDefaults } from "@shared/analysisDefaults";
import { BadRequestError } from "../errors";
import {
  getProject,
  listProjects,
  loadModel,
  updateProject,
} from "./projectStore";
import { getConnection, getSettings } from "./settingsStore";

type Role = "reading" | "writing";

async function projectsUsing(connectionId: string) {
  const found: {
    id: string;
    name: string;
    uses: { role: Role; modelId?: string }[];
  }[] = [];
  for (const summary of await listProjects()) {
    if (summary.availability === "unavailable") continue;
    try {
      const project = await getProject(summary.id);
      const legacy = (await loadModel(summary.id).catch(() => null))?.options;
      const choices = projectConnectionChoices(project, legacy);
      const uses: { role: Role; modelId?: string }[] = [];
      if (choices.visionConnectionId === connectionId)
        uses.push({ role: "reading", modelId: choices.visionModelId });
      if (choices.textConnectionId === connectionId)
        uses.push({ role: "writing", modelId: choices.textModelId });
      if (uses.length) found.push({ id: project.id, name: project.name, uses });
    } catch {
      // A project that cannot be read is left alone; it shows its own state when opened.
    }
  }
  return found;
}

export async function connectionUsage(
  connectionId: string,
): Promise<ConnectionUsage> {
  const settings = await getSettings();
  const defaults = analysisModelDefaults(
    settings.analysisDefaults,
    settings.connections,
  );
  const projects = await projectsUsing(connectionId);
  const models = new Set<string>();
  if (defaults.visionConnectionId === connectionId && defaults.visionModelId)
    models.add(defaults.visionModelId);
  if (defaults.textConnectionId === connectionId && defaults.textModelId)
    models.add(defaults.textModelId);
  for (const p of projects)
    for (const use of p.uses) if (use.modelId) models.add(use.modelId);
  return {
    readingDefault: defaults.visionConnectionId === connectionId,
    writingDefault: defaults.textConnectionId === connectionId,
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      roles: p.uses.map((u) => u.role),
    })),
    modelIds: [...models].sort(),
  };
}

/**
 * Moves the projects that use `from` to `to`, keeping each exact model ID. A project whose model the target does
 * not list keeps its choice (and asks to choose again), rather than getting a guessed model.
 */
export async function reassignConnection(
  from: string,
  to: string,
): Promise<{ moved: number; kept: number }> {
  if (from === to)
    throw new BadRequestError("Choose a different connection to move to.");
  const target = await getConnection(to);
  let moved = 0,
    kept = 0;
  for (const project of await projectsUsing(from)) {
    const llm: NonNullable<UpdateProjectRequest["llm"]> = {};
    for (const use of project.uses) {
      if (!use.modelId || !target.modelIds.includes(use.modelId)) continue;
      const role = use.role === "reading" ? "vision" : "text";
      llm[`${role}ConnectionId` as const] = to;
      llm[`${role}ModelId` as const] = use.modelId;
    }
    if (Object.keys(llm).length === project.uses.length * 2) {
      await updateProject(project.id, { llm });
      moved++;
    } else kept++;
  }
  return { moved, kept };
}
