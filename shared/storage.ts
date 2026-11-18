export interface StorageInfo {
  layout: "portable";
  workspace: string;
  globalData: string;
  /** Why the default workspace is not in Documents (OneDrive or a network location; decision D8). */
  workspaceNote?: string;
}

/** A project folder found by "Find projects" (POST /api/storage/find). */
export interface FoundProject {
  path: string;
  /** Absent when the folder is not a project this version can open (see `problem`). */
  id?: string;
  name: string;
  updatedAt?: string;
  /** Found inside the folder's Coherence Trash. */
  inTrash: boolean;
  /** Whether the library already lists this project: at this folder, at another folder, or not at all. */
  library: "here" | "elsewhere" | "absent";
  problem?: string;
}
