/**
 * GitHub issues for publishing (docs/ARCHITECTURE.md, "Publishing"). Every request it can make is here:
 * Coherence's issues (its label), milestones, issue reads, creates, field updates and label additions. It never
 * deletes, closes, assigns or comments, and never repeats a write automatically (server/export/http.ts). Writes are
 * spaced at least a second apart, as GitHub asks for content-creating requests, and ignore the job's cancel signal
 * (Stop takes effect between writes).
 */
import type { GitHubSettings } from "@shared/types";
import { IntegrationError } from "../errors";
import { httpDefaults, RemoteServiceError, requestJson } from "../export/http";
import { OWN_LABEL } from "../export/identity";
import {
  GITHUB_SERVICE,
  githubHeaders,
  githubWebBase,
  repoPath,
  validateGitHubSettings,
} from "../export/github";
import type { GitHubRequest, GitHubTarget } from "./githubRequests";

/** Mutable so tests can drop the spacing; production code never changes it. */
export const githubDefaults = { writeSpacingMs: 1000 };

const MAX_PAGES = 50;

export interface GitHubIssue {
  number: number;
  id: number;
  title?: string;
  body?: string | null;
  labels?: (string | { name?: string })[];
  milestone?: { number?: number; title?: string } | null;
  updated_at?: string;
  pull_request?: unknown;
}

const labelNames = (issue: GitHubIssue) =>
  (issue.labels ?? [])
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter(Boolean);

export class GitHubIssues {
  readonly site: GitHubTarget;
  private readonly web: string;
  private readonly headers: Record<string, string>;
  private lastWrite = 0;
  requests = 0;

  constructor(
    private readonly settings: GitHubSettings,
    private readonly signal?: AbortSignal,
  ) {
    const { apiBase } = validateGitHubSettings(settings);
    this.site = { apiBase, repoPath: repoPath(settings) };
    this.web = `${githubWebBase(apiBase)}/${settings.owner.trim()}/${settings.repo.trim()}`;
    this.headers = githubHeaders(settings);
  }

  private get<T>(path: string, allow?: number[]) {
    this.requests++;
    return requestJson<T>(
      GITHUB_SERVICE,
      `${this.site.apiBase}${this.site.repoPath}${path}`,
      { headers: this.headers, signal: this.signal, allowStatuses: allow },
    );
  }

  private async pages<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data } = await this.get<T[]>(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const list = Array.isArray(data) ? data : [];
      out.push(...list);
      if (list.length < 100) return out;
    }
    throw new IntegrationError(
      "GitHub returned more results than Coherence reads in one search, so it couldn't check them all. Nothing was sent.",
    );
  }

  /** Issues (never pull requests) carrying Coherence's label, open or closed. */
  async coherenceIssues(): Promise<GitHubIssue[]> {
    return (
      await this.pages<GitHubIssue>(
        `/issues?labels=${encodeURIComponent(OWN_LABEL)}&state=all`,
      )
    ).filter((i) => !i.pull_request && Number.isInteger(i.number));
  }

  /** Milestone numbers by lower-cased title. */
  async milestones(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    for (const m of await this.pages<{ number?: number; title?: string }>(
      "/milestones?state=all",
    ))
      if (m.title && Number.isInteger(m.number))
        map.set(m.title.trim().toLowerCase(), m.number!);
    return map;
  }

  async issue(number: string): Promise<GitHubIssue | undefined> {
    const res = await this.get<GitHubIssue>(
      `/issues/${encodeURIComponent(number)}`,
      [404, 410],
    );
    return res.status < 300 && !res.data?.pull_request ? res.data : undefined;
  }

  /** Current values and last-updated time of existing issues ("#12" keys). */
  async readCurrent(
    keys: string[],
  ): Promise<Map<string, { rev: number; fields: Record<string, unknown> }>> {
    const out = new Map<
      string,
      { rev: number; fields: Record<string, unknown> }
    >();
    for (const key of keys) {
      const number = key.replace(/^#/, "");
      if (!/^\d+$/.test(number)) continue;
      const issue = await this.issue(number);
      const rev = Date.parse(String(issue?.updated_at ?? ""));
      if (issue && Number.isFinite(rev))
        out.set(key, {
          rev,
          fields: {
            title: issue.title ?? "",
            body: issue.body ?? "",
            labels: labelNames(issue),
            milestone: issue.milestone?.number ?? null,
          },
        });
    }
    return out;
  }

  private async write<T>(request: GitHubRequest, allow?: number[]) {
    if (!request.url.startsWith(`${this.site.apiBase}${this.site.repoPath}/`))
      throw new IntegrationError(
        "Internal error: a publishing write left the configured repository.",
      );
    const wait = this.lastWrite + githubDefaults.writeSpacingMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.requests++;
    try {
      return await requestJson<T>(GITHUB_SERVICE, request.url, {
        method: request.method,
        json: request.body,
        headers: this.headers,
        timeoutMs: httpDefaults.writeTimeoutMs,
        idempotent: false,
        allowStatuses: allow,
      });
    } finally {
      this.lastWrite = Date.now();
    }
  }

  /**
   * Creates an issue; returns "#<number>" and a note when GitHub silently left out labels or the milestone (it
   * does that for tokens without triage access).
   */
  async createIssue(
    request: GitHubRequest,
  ): Promise<{ key: string; note?: string }> {
    const { data } = await this.write<GitHubIssue>(request);
    if (!Number.isInteger(data?.number))
      throw new IntegrationError(
        "GitHub answered without the new issue's number, so the outcome is unknown.",
      );
    const asked = request.body as { labels?: string[]; milestone?: unknown };
    const got = new Set(labelNames(data).map((l) => l.toLowerCase()));
    const missing = (asked.labels ?? []).filter(
      (l) => !got.has(l.toLowerCase()),
    );
    const notes = [
      missing.length ? `labels ${missing.join(", ")}` : "",
      asked.milestone !== undefined && !data.milestone ? "the milestone" : "",
    ].filter(Boolean);
    return {
      key: `#${data.number}`,
      ...(notes.length
        ? {
            note: `GitHub didn't apply ${notes.join(" and ")} (the token may lack triage access to this repository).`,
          }
        : {}),
    };
  }

  /** Creates a label ("feature: …"); a label that already exists is used as it is. */
  async createLabel(request: GitHubRequest): Promise<string> {
    const name = String((request.body as { name: string }).name);
    const res = await this.write<unknown>(request, [422]);
    if (
      res.status === 422 &&
      !JSON.stringify(res.data ?? "").includes("already_exists")
    )
      throw new RemoteServiceError(
        `GitHub refused to create label "${name}".`,
        "GitHub",
        422,
        res.data,
      );
    return name;
  }

  /** Creates a milestone; returns its number. One with the same title is used as it is. */
  async createMilestone(request: GitHubRequest): Promise<string> {
    const title = String((request.body as { title: string }).title);
    const res = await this.write<{ number?: number }>(request, [422]);
    if (res.status === 422) {
      const existing = (await this.milestones()).get(
        title.trim().toLowerCase(),
      );
      if (existing === undefined)
        throw new RemoteServiceError(
          `GitHub refused to create milestone "${title}".`,
          "GitHub",
          422,
          res.data,
        );
      return String(existing);
    }
    if (!Number.isInteger(res.data?.number))
      throw new IntegrationError(
        "GitHub answered without the new milestone's number, so the outcome is unknown.",
      );
    return String(res.data.number);
  }

  /**
   * Updates an issue only if nobody changed it since `updatedAt` (GitHub has no conditional update, so its
   * last-updated time is read just before sending; an edit in between makes Coherence refuse the update).
   */
  async updateIssue(
    key: string,
    requests: GitHubRequest[],
    updatedAt: number,
  ): Promise<void> {
    const issue = await this.issue(key.replace(/^#/, ""));
    if (!issue)
      throw new RemoteServiceError(
        `${key} wasn't found on GitHub, so it wasn't updated.`,
        "GitHub",
        404,
      );
    if (Date.parse(String(issue.updated_at ?? "")) !== updatedAt)
      throw new RemoteServiceError(
        `${key} was edited on GitHub after this plan was made, so it wasn't updated.`,
        "GitHub",
        409,
      );
    for (const request of requests) await this.write(request);
  }

  browseUrl(key: string): string {
    // Issues are "#12", milestones "3", labels their name.
    if (/^#\d+$/.test(key)) return `${this.web}/issues/${key.slice(1)}`;
    if (/^\d+$/.test(key)) return `${this.web}/milestone/${key}`;
    return `${this.web}/labels/${encodeURIComponent(key)}`;
  }

  milestoneUrl(number: string): string {
    return `${this.web}/milestone/${number}`;
  }
}
