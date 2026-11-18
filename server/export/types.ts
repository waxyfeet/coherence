/**
 * The common shape of a tracker client, so the exporter orchestrates Jira, Azure DevOps and GitHub
 * the same way: feature parents → items → dependency links (second pass, after every item exists).
 */
import type {
  ExportPreview,
  ExportRequest,
  ExternalLink,
  ExternalSystem,
  FeatureGroup,
} from "@shared/types";
import type { ExportContent } from "./content";

export interface ExportLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface TrackerEnv {
  signal?: AbortSignal;
  log: ExportLogger;
}

/** A work item / issue / epic / milestone in the tracker. */
export interface RemoteRef {
  /** What the BA sees: "ABC-12", "4711", "#42" (milestones: their number, labels: the label name). */
  key: string;
  url: string;
}

export type ExportOptions = Pick<
  ExportRequest,
  | "createFeatureParents"
  | "linkDependencies"
  | "updateExisting"
  | "includeStoryPoints"
>;

export interface UpsertInput {
  content: ExportContent;
  options: ExportOptions;
  /** Feature parent (epic / feature / milestone / label) when createFeatureParents is on. */
  parent?: RemoteRef;
  /** Previous export to this tracker — given only when updateExisting is on. */
  existing?: ExternalLink;
}

export interface UpsertResult {
  action: "created" | "updated";
  ref: RemoteRef;
}

export interface LinkInput {
  content: ExportContent;
  options: ExportOptions;
  ref: RemoteRef;
  /** The item existed before this run (it may already carry some of these links). */
  preExisting: boolean;
  /** Prerequisite use cases (this one depends on them) that exist in the tracker. */
  dependencies: { useCaseId: string; ref: RemoteRef }[];
}

export interface LinkOutcome {
  toUseCaseId: string;
  ok: boolean;
  error?: string;
}

export interface TrackerClient {
  readonly system: ExternalSystem;
  readonly label: string;
  /** Find or create the parent for a feature group. 'skipped' = an existing parent was reused. */
  ensureParent(
    feature: FeatureGroup,
  ): Promise<{ action: "created" | "skipped"; ref: RemoteRef }>;
  upsert(input: UpsertInput): Promise<UpsertResult>;
  linkDependencies(input: LinkInput): Promise<LinkOutcome[]>;
}

/** Pure payload preview for one use case (also used to validate payloads during a dry run). */
export type PreviewBuilder = (
  content: ExportContent,
  existing?: ExternalLink,
) => ExportPreview;
