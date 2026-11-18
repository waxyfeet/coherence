import path from "node:path";
import { nanoid } from "nanoid";
import type { ProjectArea } from "@shared/types";
import { config } from "../config";
import { BadRequestError, ConflictError, NotFoundError } from "../errors";
import { readJsonIfExists, writeJsonAtomic } from "./fsUtils";
import { listProjects, updateProject, withProjectLock } from "./projectStore";

/** Serialize membership changes and area removal; the reserved lock key cannot be a project ID. */
export const withLibraryLock = <T>(action: () => Promise<T>) =>
  withProjectLock("$library", action);
const file = () => path.join(config.dataDir, "areas.json");
export async function listAreas(): Promise<ProjectArea[]> {
  const areas = (await readJsonIfExists<ProjectArea[]>(file())) ?? [];
  if (!Array.isArray(areas))
    throw new BadRequestError(
      "The areas file is damaged. Restore it before changing areas.",
    );
  return areas.sort((a, b) => a.name.localeCompare(b.name));
}
export async function assertArea(areaId?: string | null): Promise<void> {
  if (areaId && !(await listAreas()).some((a) => a.id === areaId))
    throw new NotFoundError(
      "That area no longer exists. Choose another area or Unassigned.",
    );
}
export async function saveArea(
  name: string,
  id?: string,
): Promise<ProjectArea> {
  return withLibraryLock(async () => {
    const cleaned = name.replace(/\s+/g, " ").trim();
    if (!cleaned || cleaned.length > 80)
      throw new BadRequestError(
        "Enter an area name between 1 and 80 characters.",
      );
    const areas = await listAreas();
    if (
      areas.some(
        (a) => a.id !== id && a.name.toLowerCase() === cleaned.toLowerCase(),
      )
    )
      throw new ConflictError("An area with that name already exists.");
    const existing = id ? areas.find((a) => a.id === id) : undefined;
    if (id && !existing) throw new NotFoundError("That area was not found.");
    const timestamp = new Date().toISOString();
    const area = {
      ...existing,
      id: existing?.id ?? `area_${nanoid(12)}`,
      name: cleaned,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await writeJsonAtomic(file(), [
      ...areas.filter((a) => a.id !== area.id),
      area,
    ]);
    return area;
  });
}
export async function removeArea(id: string): Promise<void> {
  return withLibraryLock(async () => {
    const areas = await listAreas();
    if (!areas.some((a) => a.id === id))
      throw new NotFoundError("That area was not found.");
    // Membership is cleared before removing the group; an I/O failure leaves a usable group to retry.
    for (const project of await listProjects()) {
      if (project.areaId === id)
        await updateProject(project.id, { areaId: null });
    }
    await writeJsonAtomic(
      file(),
      areas.filter((a) => a.id !== id),
    );
  });
}
