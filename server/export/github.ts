/**
 * GitHub Issues client (REST, API version 2022-11-28; github.com or GitHub Enterprise via apiBaseUrl).
 * Body = the reviewed spec markdown without front matter (relative images/links rewritten, footer added).
 * Feature groups become milestones (found by title or created) or "feature: <name>" labels.
 * Dependencies are a "**Depends on:** #12 (UC-001), …" line written in the second pass, once every
 * issue number is known.
 */
import type { TestConnectionResponse } from "@shared/api";
import type {
  ExportPreview,
  ExternalLink,
  FeatureGroup,
  GitHubSettings,
} from "@shared/types";
import { IntegrationError, errorMessage } from "../errors";
import {
  githubErrorMessage,
  normaliseBaseUrl,
  RemoteServiceError,
  requestJson,
  type ServiceInfo,
} from "./http";
import {
  exportTitle,
  footerLine,
  truncate,
  uniqueLabels,
  type ExportContent,
} from "./content";
import { removeLeadingH1, rewriteRelativeReferences } from "./markdown";
import { OWN_LABEL } from "./identity";
import type {
  LinkInput,
  LinkOutcome,
  RemoteRef,
  TrackerClient,
  TrackerEnv,
  UpsertInput,
  UpsertResult,
} from "./types";

export const GITHUB_SERVICE: ServiceInfo = {
  label: "GitHub",
  extractMessage: githubErrorMessage,
  authHint:
    "Check the GitHub token in Settings → Integrations (it needs read & write access to Issues on the repository).",
};

/** GitHub rejects bodies over 65,536 characters. */
const BODY_LIMIT = 65_000;
const TRUNCATION_NOTE =
  "\n\n_(Truncated — the full use case is in the Coherence spec file.)_";
const LABEL_MAX = 50;
const FEATURE_LABEL_COLOR = "5319e7";

export function validateGitHubSettings(s: GitHubSettings): { apiBase: string } {
  const missing: string[] = [];
  if (!s.owner?.trim()) missing.push("owner");
  if (!s.repo?.trim()) missing.push("repository");
  if (!s.token?.trim()) missing.push("token");
  if (missing.length)
    throw new IntegrationError(
      `GitHub settings are incomplete: missing ${missing.join(", ")}.`,
    );
  return {
    apiBase: normaliseBaseUrl(
      s.apiBaseUrl?.trim() || "https://api.github.com",
      "The GitHub API URL",
    ),
  };
}

export function githubHeaders(s: GitHubSettings): Record<string, string> {
  return {
    Authorization: `Bearer ${s.token.trim()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Coherence",
  };
}

export function repoPath(s: GitHubSettings): string {
  return `/repos/${encodeURIComponent(s.owner.trim())}/${encodeURIComponent(s.repo.trim())}`;
}

/** Web URL root for links we build ourselves (labels): api.github.com → github.com, GHE /api/v3 → host. */
export function githubWebBase(apiBase: string): string {
  const url = new URL(apiBase);
  if (url.hostname === "api.github.com") return "https://github.com";
  return `${url.origin}${url.pathname.replace(/\/api\/v3\/?$/, "").replace(/\/+$/, "")}`;
}

export function parseIssueNumber(key: string): number | undefined {
  const m = /^#?(\d+)$/.exec(key.trim());
  return m ? Number(m[1]) : undefined;
}

export function featureLabelName(name: string): string {
  return truncate(`feature: ${name.trim()}`, LABEL_MAX, "");
}

export function dependsOnLine(
  deps: { useCaseId: string; ref: RemoteRef }[],
): string {
  return `**Depends on:** ${deps.map((d) => `${d.ref.key} (${d.useCaseId})`).join(", ")}`;
}

/** Spec body for GitHub: no H1 (the title has it), no local images/links, footer, optional depends line. */
export function buildGitHubBody(
  content: ExportContent,
  dependsLine?: string,
): string {
  const body = rewriteRelativeReferences(
    removeLeadingH1(content.markdownBody),
  ).trim();
  const head = dependsLine ? `${dependsLine}\n\n` : "";
  const footer = `\n\n---\n\n${footerLine(content.useCase)}`;
  const full = `${head}${body}${footer}`;
  if (full.length <= BODY_LIMIT) return full;
  return `${head}${truncate(body, BODY_LIMIT - head.length - footer.length - TRUNCATION_NOTE.length, "")}${TRUNCATION_NOTE}${footer}`;
}

export function buildGitHubLabels(
  s: GitHubSettings,
  content: ExportContent,
  opts: { includeStoryPoints: boolean; featureLabel?: string },
): string[] {
  const labels = [...(s.labels ?? []), OWN_LABEL];
  if (opts.includeStoryPoints) labels.push(`size: ${content.useCase.size}`);
  if (opts.featureLabel) labels.push(opts.featureLabel);
  return uniqueLabels(
    labels.map((l) => truncate(l.trim(), LABEL_MAX, "")),
    false,
  );
}

/** Keep labels added on GitHub, but replace our own size/feature labels when they changed. */
export function mergeGitHubLabels(
  existing: string[],
  ours: string[],
): string[] {
  const oursLower = new Set(ours.map((l) => l.toLowerCase()));
  const replacesSize = ours.some((l) => /^size: /i.test(l));
  const replacesFeature = ours.some((l) => /^feature: /i.test(l));
  const kept = existing.filter((l) => {
    if (oursLower.has(l.toLowerCase())) return false;
    if (replacesSize && /^size: /i.test(l)) return false;
    if (replacesFeature && /^feature: /i.test(l)) return false;
    return true;
  });
  return [...kept, ...ours];
}

export function previewGitHub(
  content: ExportContent,
  s: GitHubSettings,
  existing?: ExternalLink,
): ExportPreview {
  const uc = content.useCase;
  const labels = buildGitHubLabels(s, content, { includeStoryPoints: false });
  const fields: Record<string, string> = {
    Repository: `${s.owner}/${s.repo}`,
    Title: exportTitle(uc),
    Labels: labels.join(", "),
    "Story points": `label "size: ${uc.size}" when "Include story points" is on`,
    Feature: content.featureName
      ? s.useMilestonesForFeatures
        ? `milestone "${content.featureName}" — found or created when "Create feature parents" is on`
        : `label "${featureLabelName(content.featureName)}" when "Create feature parents" is on`
      : "None (the use case has no feature group)",
    Dependencies: uc.dependsOn.length
      ? `"Depends on" line listing the issues of ${uc.dependsOn.join(", ")} (when "Link dependencies" is on)`
      : "None",
    "Existing issue": existing
      ? `${existing.key} — updated when "Update existing" is on`
      : "None — a new issue will be created",
  };
  return {
    target: "github",
    useCaseId: uc.id,
    title: exportTitle(uc),
    bodyFormat: "markdown",
    description: buildGitHubBody(content),
    acceptanceCriteria: "",
    fields,
  };
}

interface Milestone {
  number: number;
  title: string;
  html_url: string;
}

interface Issue {
  number: number;
  html_url: string;
  labels?: (string | { name?: string })[];
}

export class GitHubClient implements TrackerClient {
  readonly system = "github" as const;
  readonly label = "GitHub";
  private readonly apiBase: string;
  private readonly headers: Record<string, string>;
  private milestones?: Promise<Map<string, Milestone>>;

  constructor(
    private readonly settings: GitHubSettings,
    private readonly env: TrackerEnv,
  ) {
    this.apiBase = validateGitHubSettings(settings).apiBase;
    this.headers = githubHeaders(settings);
  }

  /** `idempotent`: safe to resend after a 5xx (PATCH sets fields; a repeated label/milestone create answers 422). */
  private request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    json?: unknown,
    allow?: number[],
    idempotent?: boolean,
  ) {
    return requestJson<T>(
      GITHUB_SERVICE,
      `${this.apiBase}${repoPath(this.settings)}${path}`,
      {
        method,
        json,
        headers: this.headers,
        signal: this.env.signal,
        allowStatuses: allow,
        idempotent,
      },
    );
  }

  private loadMilestones(): Promise<Map<string, Milestone>> {
    this.milestones ??= (async () => {
      const map = new Map<string, Milestone>();
      for (let page = 1; page <= 10; page++) {
        const { data } = await this.request<Milestone[]>(
          "GET",
          `/milestones?state=all&per_page=100&page=${page}`,
        );
        const list = Array.isArray(data) ? data : [];
        for (const m of list)
          if (!map.has(m.title.trim().toLowerCase()))
            map.set(m.title.trim().toLowerCase(), m);
        if (list.length < 100) break;
      }
      return map;
    })();
    return this.milestones;
  }

  async ensureParent(
    feature: FeatureGroup,
  ): Promise<{ action: "created" | "skipped"; ref: RemoteRef }> {
    if (this.settings.useMilestonesForFeatures) {
      const title = feature.name.trim();
      const known = await this.loadMilestones();
      const found = known.get(title.toLowerCase());
      if (found)
        return {
          action: "skipped",
          ref: { key: String(found.number), url: found.html_url },
        };
      const res = await this.request<Milestone>(
        "POST",
        "/milestones",
        {
          title,
          description: truncate(
            `${feature.description.trim()}\n\nFeature group ${feature.id} generated by Coherence.`.trim(),
            1000,
          ),
        },
        [422],
        true,
      );
      if (res.status === 422) {
        // Someone created it meanwhile (or it differs only by case) — re-read and reuse.
        this.milestones = undefined;
        const again = (await this.loadMilestones()).get(title.toLowerCase());
        if (again)
          return {
            action: "skipped",
            ref: { key: String(again.number), url: again.html_url },
          };
        throw new RemoteServiceError(
          `GitHub refused to create milestone "${title}": ${githubErrorMessage(res.data) || "validation failed"}.`,
          "GitHub",
          422,
          res.data,
        );
      }
      known.set(title.toLowerCase(), res.data);
      return {
        action: "created",
        ref: { key: String(res.data.number), url: res.data.html_url },
      };
    }

    const name = featureLabelName(feature.name);
    const url = `${githubWebBase(this.apiBase)}/${this.settings.owner.trim()}/${this.settings.repo.trim()}/labels/${encodeURIComponent(name)}`;
    const res = await this.request<unknown>(
      "POST",
      "/labels",
      {
        name,
        color: FEATURE_LABEL_COLOR,
        description: truncate(
          feature.description.trim() || `Feature group ${feature.id}`,
          100,
        ),
      },
      [422],
      true,
    );
    if (res.status === 422) {
      const exists = JSON.stringify(res.data ?? "").includes("already_exists");
      if (!exists)
        throw new RemoteServiceError(
          `GitHub refused to create label "${name}": ${githubErrorMessage(res.data) || "validation failed"}.`,
          "GitHub",
          422,
          res.data,
        );
      return { action: "skipped", ref: { key: name, url } };
    }
    return { action: "created", ref: { key: name, url } };
  }

  private featureFields(input: UpsertInput): {
    milestone?: number;
    featureLabel?: string;
  } {
    if (!input.parent) return {};
    if (this.settings.useMilestonesForFeatures) {
      const n = Number(input.parent.key);
      return Number.isFinite(n) ? { milestone: n } : {};
    }
    return { featureLabel: input.parent.key };
  }

  async upsert(input: UpsertInput): Promise<UpsertResult> {
    const { content } = input;
    const uc = content.useCase;
    const { milestone, featureLabel } = this.featureFields(input);
    const labels = buildGitHubLabels(this.settings, content, {
      includeStoryPoints: input.options.includeStoryPoints,
      featureLabel,
    });
    const payload: Record<string, unknown> = {
      title: exportTitle(uc),
      body: buildGitHubBody(content),
      labels,
    };
    if (milestone !== undefined) payload.milestone = milestone;

    if (input.existing) {
      const number = parseIssueNumber(input.existing.key);
      if (number !== undefined) {
        // 404 = deleted, 410 = deleted / issues disabled.
        const current = await this.request<Issue>(
          "GET",
          `/issues/${number}`,
          undefined,
          [404, 410],
        );
        if (current.status < 300) {
          const existingLabels = (current.data.labels ?? [])
            .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
            .filter(Boolean);
          const res = await this.request<Issue>(
            "PATCH",
            `/issues/${number}`,
            { ...payload, labels: mergeGitHubLabels(existingLabels, labels) },
            undefined,
            true,
          );
          return {
            action: "updated",
            ref: {
              key: `#${res.data.number ?? number}`,
              url: res.data.html_url ?? current.data.html_url,
            },
          };
        }
      }
      this.env.log.warn(
        `${uc.id}: issue ${input.existing.key} no longer exists on GitHub — creating a new issue.`,
      );
    }

    const { data } = await this.request<Issue>("POST", "/issues", payload);
    if (!data?.number)
      throw new IntegrationError(
        `GitHub created the issue for ${uc.id} but did not return its number.`,
      );
    return {
      action: "created",
      ref: { key: `#${data.number}`, url: data.html_url },
    };
  }

  async linkDependencies(input: LinkInput): Promise<LinkOutcome[]> {
    if (!input.dependencies.length) return [];
    const number = parseIssueNumber(input.ref.key);
    if (number === undefined) {
      return input.dependencies.map((d) => ({
        toUseCaseId: d.useCaseId,
        ok: false,
        error: `"${input.ref.key}" is not a GitHub issue number.`,
      }));
    }
    try {
      await this.request(
        "PATCH",
        `/issues/${number}`,
        {
          body: buildGitHubBody(
            input.content,
            dependsOnLine(input.dependencies),
          ),
        },
        undefined,
        true,
      );
      return input.dependencies.map((d) => ({
        toUseCaseId: d.useCaseId,
        ok: true,
      }));
    } catch (err) {
      return input.dependencies.map((d) => ({
        toUseCaseId: d.useCaseId,
        ok: false,
        error: errorMessage(err),
      }));
    }
  }
}

export async function testGitHub(
  settings: GitHubSettings,
): Promise<TestConnectionResponse> {
  const started = Date.now();
  try {
    const { apiBase } = validateGitHubSettings(settings);
    const res = await requestJson<{
      full_name?: string;
      has_issues?: boolean;
      permissions?: { push?: boolean; triage?: boolean };
    }>(GITHUB_SERVICE, `${apiBase}${repoPath(settings)}`, {
      headers: githubHeaders(settings),
      allowStatuses: [404],
    });
    const name = `${settings.owner.trim()}/${settings.repo.trim()}`;
    if (res.status === 404) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Repository ${name} was not found, or the token cannot access it.`,
      };
    }
    if (res.data?.has_issues === false) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Issues are disabled for ${res.data.full_name ?? name} — enable them in the repository settings.`,
      };
    }
    const canTriage = res.data?.permissions
      ? !!(res.data.permissions.push || res.data.permissions.triage)
      : true;
    return {
      ok: true,
      latencyMs: Date.now() - started,
      message: canTriage
        ? `Connected to GitHub repository ${res.data?.full_name ?? name}.`
        : `Connected to ${res.data?.full_name ?? name}, but this account has read-only access: GitHub ignores labels and milestones set without triage or write access.`,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: errorMessage(err),
    };
  }
}
