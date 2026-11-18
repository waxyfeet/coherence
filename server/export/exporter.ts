import { readOwnedFile } from "../storage/fsUtils";
import { writeFileAtomic as durableWrite } from "../storage/fsUtils";
/**
 * OWNER: export builder.
 * Pushes reviewed use cases to Jira / Azure DevOps / GitHub. Content is read from the .md files on disk
 * (the BA's reviewed version) via the project's OutputFormat parser, falling back to the model.
 */
import fs from "node:fs/promises";
import { nanoid } from "nanoid";
import type { TestConnectionResponse } from "@shared/api";
import { EXTERNAL_SYSTEM_LABEL } from "@shared/api";
import type {
  AzdoSettings,
  ExportItemResult,
  ExportPreview,
  ExportRequest,
  ExportResult,
  ExternalLink,
  ExternalSystem,
  GitHubSettings,
  JiraSettings,
  Project,
  SolutionModel,
  UseCase,
} from "@shared/types";
import {
  BadRequestError,
  CancelledError,
  NotFoundError,
  errorMessage,
} from "../errors";
import { getFormat } from "../formats/registry";
import type { OutputFormat, RenderContext } from "../formats/types";
import type { JobContext } from "../jobs/jobManager";
import {
  getProject,
  loadModel,
  saveModel,
  withProjectLock,
} from "../storage/projectStore";
import { getIntegration } from "../storage/settingsStore";
import { resolveSpecPath, writeSpecs } from "../specs/specStore";
import { AzdoClient, previewAzdo, testAzdo } from "./azdo";
import { existingLink, loadExportContent, type ExportContent } from "./content";
import { patchFrontMatterExternal } from "./frontMatter";
import { GitHubClient, previewGitHub, testGitHub } from "./github";
import { JiraClient, previewJira, testJira } from "./jira";
import { linkBelongsToTarget, targetBase } from "./target";
import type {
  ExportOptions,
  RemoteRef,
  TrackerClient,
  TrackerEnv,
} from "./types";
import { createExportJournal } from "./journal";

export const EXPORT_STAGES = [
  "Preparing",
  "Creating feature parents",
  "Exporting use cases",
  "Linking dependencies",
  "Saving links",
] as const;

type TrackerSettings = JiraSettings | AzdoSettings | GitHubSettings;

/** @throws BadRequestError when the tracker has not been set up. */
export async function requireIntegration(
  target: ExternalSystem,
): Promise<TrackerSettings> {
  const settings = await getIntegration(target);
  if (!settings) {
    throw new BadRequestError(
      `${EXTERNAL_SYSTEM_LABEL[target]} is not configured — add it under Settings → Integrations first.`,
    );
  }
  return settings as TrackerSettings;
}

export function createTrackerClient(
  target: ExternalSystem,
  settings: TrackerSettings,
  env: TrackerEnv,
): TrackerClient {
  switch (target) {
    case "jira":
      return new JiraClient(settings as JiraSettings, env);
    case "azdo":
      return new AzdoClient(settings as AzdoSettings, env);
    case "github":
      return new GitHubClient(settings as GitHubSettings, env);
    default:
      throw new BadRequestError(`Unknown export target "${String(target)}".`);
  }
}

export function buildPreview(
  target: ExternalSystem,
  settings: TrackerSettings,
  content: ExportContent,
  existing?: ExternalLink,
): ExportPreview {
  switch (target) {
    case "jira":
      return previewJira(content, settings as JiraSettings, existing);
    case "azdo":
      return previewAzdo(content, settings as AzdoSettings, existing);
    case "github":
      return previewGitHub(content, settings as GitHubSettings, existing);
    default:
      throw new BadRequestError(`Unknown export target "${String(target)}".`);
  }
}

function formatFor(project: Project, model: SolutionModel): OutputFormat {
  return getFormat(model.formatId || project.formatId);
}

/**
 * The use case's link for this tracker, but only when it points into the configured site/org/repo —
 * a link left over from another target must never be updated or linked to (its key means another item here).
 */
function currentLink(
  uc: UseCase,
  target: ExternalSystem,
  settings: TrackerSettings,
): ExternalLink | undefined {
  const link = existingLink(uc, target);
  return link && linkBelongsToTarget(target, settings, link) ? link : undefined;
}

interface ExportedItem {
  content: ExportContent;
  ref: RemoteRef;
  preExisting: boolean;
}

/**
 * Creates/updates work items, feature parents and dependency links. Records ExternalLink on each use case
 * (model + .md front matter), appends a changeLog entry. Persists. Per-item failures do not abort the run.
 */
export async function runExport(
  ctx: JobContext,
  projectId: string,
  req: ExportRequest,
): Promise<ExportResult> {
  ctx.setStages([...EXPORT_STAGES]);
  const label = EXTERNAL_SYSTEM_LABEL[req.target] ?? req.target;
  const result: ExportResult = {
    target: req.target,
    dryRun: req.dryRun,
    items: [],
    parents: [],
    links: [],
  };
  const options: ExportOptions = {
    createFeatureParents: req.createFeatureParents,
    linkDependencies: req.linkDependencies,
    updateExisting: req.updateExisting,
    includeStoryPoints: req.includeStoryPoints,
  };

  /* ── Preparing ── */
  const requested = [...new Set(req.useCaseIds)];
  ctx.stage("Preparing", requested.length);
  const project = await getProject(projectId);
  const model = await loadModel(projectId);
  if (!model || !model.useCases.length) {
    throw new BadRequestError(
      "This project has no use cases yet — generate the specs before exporting.",
    );
  }
  if (!requested.length)
    throw new BadRequestError("Select at least one use case to export.");
  const settings = await requireIntegration(req.target);
  const format = formatFor(project, model);

  const wanted = new Set(requested);
  const selected = model.useCases.filter((uc) => wanted.has(uc.id)); // build order
  const unknown = requested.filter(
    (id) => !model.useCases.some((uc) => uc.id === id),
  );
  if (!selected.length)
    throw new BadRequestError(
      `None of the selected use cases exist in this project (${unknown.join(", ")}).`,
    );

  const contents: ExportContent[] = [];
  for (const uc of selected) {
    ctx.throwIfCancelled();
    const content = await loadExportContent(project, model, uc, format);
    for (const w of content.warnings) ctx.warn(w);
    contents.push(content);
    ctx.tick(uc.id);
  }
  ctx.info(
    `${req.dryRun ? "Dry run: " : ""}exporting ${contents.length} use case(s) to ${label}.`,
  );

  // Constructing the client validates the settings (missing token, bad URL …) — also for a dry run —
  // so the BA gets one clear error instead of one per item. A dry run never calls it.
  const drySettings =
    req.target === "jira"
      ? { ...settings, apiToken: "dry-run-placeholder" }
      : req.target === "azdo"
        ? { ...settings, pat: "dry-run-placeholder" }
        : { ...settings, token: "dry-run-placeholder" };
  const trackerClient = createTrackerClient(
    req.target,
    req.dryRun ? (drySettings as TrackerSettings) : settings,
    { signal: ctx.signal, log: ctx },
  );
  const client = req.dryRun ? undefined : trackerClient;
  const journal = req.dryRun
    ? undefined
    : await createExportJournal(projectId, ctx.jobId, req.target, {
        base: targetBase(req.target, settings),
        project:
          req.target === "jira"
            ? (settings as JiraSettings).projectKey
            : req.target === "azdo"
              ? (settings as AzdoSettings).project
              : (settings as GitHubSettings).repo,
      });
  const remote = <T>(
    key: string,
    kind: "parent" | "item" | "links",
    run: () => Promise<T>,
  ) => (journal ? journal.operation(key, kind, run) : run());

  const exported = new Map<string, ExportedItem>();
  let cancelled: unknown;
  try {
    /* ── Creating feature parents ── */
    const featureIds = req.createFeatureParents
      ? [...new Set(contents.map((c) => c.useCase.featureId).filter(Boolean))]
      : [];
    ctx.stage("Creating feature parents", featureIds.length);
    const parentRefs = new Map<string, RemoteRef>();
    for (const featureId of featureIds) {
      ctx.throwIfCancelled();
      const feature = model.features.find((f) => f.id === featureId);
      if (!feature) {
        result.parents.push({
          featureId,
          name: featureId,
          action: "failed",
          error: `Feature group ${featureId} is not in the model.`,
        });
        ctx.tick(featureId);
        continue;
      }
      if (!client) {
        result.parents.push({
          featureId,
          name: feature.name,
          action: "would-create",
        });
      } else {
        try {
          const r = await remote("parent:" + feature.id, "parent", () =>
            client.ensureParent(feature),
          );
          parentRefs.set(featureId, r.ref);
          result.parents.push({
            featureId,
            name: feature.name,
            action: r.action,
            key: r.ref.key,
            url: r.ref.url,
          });
          ctx.info(
            `${feature.name}: ${r.action === "created" ? "created" : "reusing"} ${r.ref.key}`,
          );
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          result.parents.push({
            featureId,
            name: feature.name,
            action: "failed",
            error: errorMessage(err),
          });
          ctx.warn(
            `Feature parent "${feature.name}" failed: ${errorMessage(err)}`,
          );
        }
      }
      ctx.tick(feature.name);
    }

    /* ── Exporting use cases ── */
    ctx.stage("Exporting use cases", contents.length);
    for (const content of contents) {
      ctx.throwIfCancelled();
      const uc = content.useCase;
      const stored = existingLink(uc, req.target);
      let previous = currentLink(uc, req.target, settings);
      if (!previous && req.updateExisting && journal) {
        const recovered = (await journal.completed("item:" + uc.id)) as
          { ref?: RemoteRef } | undefined;
        if (
          recovered?.ref &&
          linkBelongsToTarget(req.target, settings, {
            system: req.target,
            ...recovered.ref,
            exportedAt: "",
            revision: 0,
          })
        ) {
          previous = {
            system: req.target,
            ...recovered.ref,
            exportedAt: "",
            revision: 0,
          };
          ctx.info(
            `${uc.id}: recovered ${recovered.ref.key} from its durable export journal; updating that item instead of creating a duplicate.`,
          );
        }
      }
      if (stored && !previous) {
        ctx.warn(
          `${uc.id} was exported to ${stored.url} (${stored.key}), which is not the ${label} target configured now (${targetBase(req.target, settings) ?? "see Settings → Integrations"}); a new item will be created instead.`,
        );
      }
      const item: ExportItemResult = {
        useCaseId: uc.id,
        title: uc.title,
        action: "failed",
      };
      if (!client) {
        try {
          buildPreview(req.target, settings, content, previous);
          const willUpdate = !!previous && req.updateExisting;
          Object.assign(item, {
            action: willUpdate ? "would-update" : "would-create",
            key: willUpdate ? previous!.key : undefined,
            url: willUpdate ? previous!.url : undefined,
          });
        } catch (err) {
          item.error = errorMessage(err);
        }
      } else {
        if (previous && !req.updateExisting) {
          ctx.info(
            `${uc.id} was exported before as ${previous.key}; creating a new item because "Update existing" is off.`,
          );
        }
        try {
          const r = await remote("item:" + uc.id, "item", () =>
            client.upsert({
              content,
              options,
              parent: req.createFeatureParents
                ? parentRefs.get(uc.featureId)
                : undefined,
              existing: req.updateExisting ? previous : undefined,
            }),
          );
          Object.assign(item, {
            action: r.action,
            key: r.ref.key,
            url: r.ref.url,
          });
          exported.set(uc.id, {
            content,
            ref: r.ref,
            preExisting: r.action === "updated",
          });
          ctx.info(`${uc.id} → ${r.ref.key} (${r.action}) ${r.ref.url}`);
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          item.error = errorMessage(err);
          ctx.warn(`${uc.id} failed: ${item.error}`);
        }
      }
      result.items.push(item);
      ctx.tick(uc.id);
    }

    /* ── Linking dependencies ── */
    const withDeps = req.linkDependencies
      ? contents.filter((c) => c.useCase.dependsOn.length)
      : [];
    ctx.stage("Linking dependencies", withDeps.length);
    const failedIds = new Set(
      result.items.filter((i) => i.action === "failed").map((i) => i.useCaseId),
    );
    for (const content of withDeps) {
      ctx.throwIfCancelled();
      const uc = content.useCase;
      const self = exported.get(uc.id);
      if (failedIds.has(uc.id) || (client && !self)) {
        // The item itself failed — nothing to link from.
        for (const depId of uc.dependsOn) {
          result.links.push({
            fromUseCaseId: uc.id,
            toUseCaseId: depId,
            ok: false,
            error: `${uc.id} was not exported.`,
          });
        }
        ctx.tick(uc.id);
        continue;
      }
      const resolvable: { useCaseId: string; ref: RemoteRef }[] = [];
      for (const depId of uc.dependsOn) {
        // Created/updated in this run, else exported earlier (also outside this selection).
        const ref =
          exported.get(depId)?.ref ??
          remoteRefOf(model, depId, req.target, settings);
        const willExist =
          !!ref || (!client && wanted.has(depId) && !failedIds.has(depId));
        if (ref && client) {
          resolvable.push({ useCaseId: depId, ref });
        } else if (willExist) {
          result.links.push({
            fromUseCaseId: uc.id,
            toUseCaseId: depId,
            ok: true,
          });
        } else {
          result.links.push({
            fromUseCaseId: uc.id,
            toUseCaseId: depId,
            ok: false,
            error: failedIds.has(depId)
              ? `${depId} failed to export, so it could not be linked.`
              : `${depId} is not in ${label} yet — include it in the export to link it.`,
          });
        }
      }
      if (client && self && resolvable.length) {
        const outcomes = await remote("links:" + uc.id, "links", () =>
          client.linkDependencies({
            content,
            options,
            ref: self.ref,
            preExisting: self.preExisting,
            dependencies: resolvable,
          }),
        );
        for (const o of outcomes) {
          result.links.push({
            fromUseCaseId: uc.id,
            toUseCaseId: o.toUseCaseId,
            ok: o.ok,
            error: o.error,
          });
          if (!o.ok)
            ctx.warn(`Link ${uc.id} → ${o.toUseCaseId} failed: ${o.error}`);
        }
      }
      ctx.tick(uc.id);
    }
  } catch (err) {
    if (!(err instanceof CancelledError)) throw err;
    // Still record what was created, otherwise the next export would duplicate those items.
    cancelled = err;
  }

  /* ── Saving links ── */
  ctx.stage("Saving links", exported.size);
  if (req.dryRun) {
    ctx.info("Dry run — nothing was sent and nothing was saved.");
  } else if (exported.size) {
    await saveExportLinks(ctx, projectId, req.target, exported, result);
  }
  if (unknown.length) {
    for (const id of unknown)
      result.items.push({
        useCaseId: id,
        title: "",
        action: "skipped",
        error: "This use case no longer exists in the project.",
      });
  }
  if (cancelled) throw cancelled;

  const failed = result.items.filter((i) => i.action === "failed").length;
  if (failed)
    ctx.warn(
      `${failed} of ${contents.length} use case(s) failed — see the results table for the reasons.`,
    );
  return result;
}

/** Previously exported key of a use case (in the configured target), for linking to items outside this run's selection. */
function remoteRefOf(
  model: SolutionModel,
  useCaseId: string,
  target: ExternalSystem,
  settings: TrackerSettings,
): RemoteRef | undefined {
  const uc = model.useCases.find((u) => u.id === useCaseId);
  const link = uc && currentLink(uc, target, settings);
  return link ? { key: link.key, url: link.url } : undefined;
}

function sameText(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
  return norm(a) === norm(b);
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  await durableWrite(file, content);
}

/**
 * Record ExternalLinks on the model and in the .md front matter, without losing BA edits:
 * a file identical to what the model renders is re-rendered via writeSpecs; any other file gets only
 * its front matter `external` block patched.
 */
async function saveExportLinks(
  ctx: JobContext,
  projectId: string,
  target: ExternalSystem,
  exported: Map<string, ExportedItem>,
  result: ExportResult,
): Promise<void> {
  const label = EXTERNAL_SYSTEM_LABEL[target] ?? target;
  const created = result.items.filter((i) => i.action === "created").length;
  const updated = result.items.filter((i) => i.action === "updated").length;
  await recordTrackerLinks(
    ctx,
    projectId,
    target,
    [...exported].map(([useCaseId, item]) => ({
      useCaseId,
      key: item.ref.key,
      url: item.ref.url,
      revision: item.content.useCase.revision,
    })),
    `Exported ${exported.size} use case(s) to ${label} (${created} created, ${updated} updated).`,
  );
}

/**
 * Record tracker links on the model and in the .md front matter, without losing BA edits (the classic export and
 * delivery publishing share this). `revision` is the use case revision that was sent.
 */
export async function recordTrackerLinks(
  ctx: JobContext,
  projectId: string,
  target: ExternalSystem,
  links: { useCaseId: string; key: string; url: string; revision: number }[],
  summary: string,
): Promise<void> {
  const label = EXTERNAL_SYSTEM_LABEL[target] ?? target;
  const exported = new Map(
    links.map((l) => [
      l.useCaseId,
      { ref: { key: l.key, url: l.url }, revision: l.revision },
    ]),
  );
  await withProjectLock(projectId, async () => {
    const project = await getProject(projectId);
    const model = await loadModel(projectId);
    if (!model)
      throw new NotFoundError(
        "The project model disappeared while exporting — the created items are listed in the job log.",
      );
    const format = formatFor(project, model);
    const renderCtx: RenderContext = {
      project,
      model,
      embedScreenImages: model.options.embedScreenImages,
    };
    const now = new Date().toISOString();
    const rerender: string[] = [];

    for (const [useCaseId, item] of exported) {
      const uc = model.useCases.find((u) => u.id === useCaseId);
      if (!uc) {
        ctx.warn(
          `${useCaseId} was removed from the model during the export; its link ${item.ref.key} was not saved.`,
        );
        ctx.tick(useCaseId);
        continue;
      }
      let renderedBefore: string | undefined;
      try {
        renderedBefore = format.renderUseCase(uc, renderCtx);
      } catch {
        renderedBefore = undefined;
      }
      // The revision that was sent, not the model's current one: a save during the export must still
      // show as "changed since export".
      const sent = item.revision;
      if (uc.revision > sent) {
        ctx.info(
          `${useCaseId} was edited while it was being exported — export it again to send the latest version.`,
        );
      }
      const link: ExternalLink = {
        system: target,
        key: item.ref.key,
        url: item.ref.url,
        revision: Math.min(sent, uc.revision),
        exportedAt: now,
      };
      uc.external = [...uc.external.filter((l) => l.system !== target), link];
      await updateSpecFile(ctx, project, format, uc, renderedBefore, rerender);
      ctx.tick(useCaseId);
    }

    if (rerender.length) {
      try {
        await writeSpecs(project, model, {
          useCaseIds: rerender,
          preserveEdited: false,
          embedScreenImages: model.options.embedScreenImages,
        });
      } catch (err) {
        ctx.warn(
          `The ${label} links are saved in the project, but the spec files could not be rewritten (${errorMessage(err)}). Use "Re-render" on the Specs page to refresh them.`,
        );
      }
    }

    model.changeLog.push({
      at: now,
      kind: "exported",
      summary,
      useCaseIds: [...exported.keys()],
    });
    await saveModel(projectId, model);
  });
}

async function updateSpecFile(
  ctx: JobContext,
  project: Project,
  format: OutputFormat,
  uc: UseCase,
  renderedBefore: string | undefined,
  rerender: string[],
): Promise<void> {
  let relPath: string;
  let abs: string;
  try {
    relPath = uc.filePath ?? format.useCasePath(uc);
    abs = resolveSpecPath(project, relPath);
  } catch (err) {
    ctx.warn(
      `${uc.id}: the export link is saved in the project, but its spec file path is not usable (${errorMessage(err)}).`,
    );
    return;
  }
  let disk: string | null;
  try {
    disk = (await readOwnedFile(abs)).toString("utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      ctx.warn(
        `${uc.id}: could not read ${relPath} to record the export link (${errorMessage(err)}).`,
      );
      return;
    }
    disk = null;
  }
  if (
    disk === null ||
    (renderedBefore !== undefined && sameText(disk, renderedBefore))
  ) {
    rerender.push(uc.id);
    return;
  }
  const patched = patchFrontMatterExternal(disk, uc.external);
  if (patched === undefined) {
    ctx.warn(
      `${uc.id}: ${relPath} has no readable front matter, so the export link was saved in the project only. Use "Re-render" to refresh the file.`,
    );
    return;
  }
  if (patched === disk) return;
  try {
    await writeFileAtomic(abs, patched);
  } catch (err) {
    ctx.warn(
      `${uc.id}: could not update ${relPath} (${errorMessage(err)}); the export link is saved in the project.`,
    );
  }
}

/** Exactly what would be sent for one use case. @throws BadRequestError when the target is not configured. */
export async function previewExport(
  projectId: string,
  target: ExternalSystem,
  useCaseId: string,
): Promise<ExportPreview> {
  const project = await getProject(projectId);
  const model = await loadModel(projectId);
  if (!model)
    throw new BadRequestError(
      "This project has no use cases yet — generate the specs first.",
    );
  const uc = model.useCases.find((u) => u.id === useCaseId);
  if (!uc)
    throw new NotFoundError(
      `Use case ${useCaseId} was not found in this project.`,
    );
  const settings = await requireIntegration(target);
  const content = await loadExportContent(
    project,
    model,
    uc,
    formatFor(project, model),
  );
  return buildPreview(
    target,
    settings,
    content,
    currentLink(uc, target, settings),
  );
}

/** Authenticated read-only call (Jira: /myself + project; AzDO: project + work item type; GitHub: repo). Never throws. */
export async function testIntegration(
  system: ExternalSystem,
  settings: JiraSettings | AzdoSettings | GitHubSettings,
): Promise<TestConnectionResponse> {
  try {
    switch (system) {
      case "jira":
        return await testJira(settings as JiraSettings);
      case "azdo":
        return await testAzdo(settings as AzdoSettings);
      case "github":
        return await testGitHub(settings as GitHubSettings);
      default:
        return {
          ok: false,
          message: `Unknown integration "${String(system)}".`,
        };
    }
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}
