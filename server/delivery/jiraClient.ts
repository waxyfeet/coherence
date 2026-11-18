/**
 * Jira issues for publishing (docs/ARCHITECTURE.md, "Publishing"). Every request it can make is here: a
 * project-scoped search for Coherence's issues, reads, creates, label-adding updates and issue links. It never
 * deletes, never transitions, assigns or comments, and never repeats a write automatically (server/export/http.ts).
 * Cloud uses REST v3 (ADF) and the enhanced search; Server/Data Center uses v2 (wiki markup).
 * Writes ignore the job's cancel signal: Stop takes effect between writes.
 */
import type { JiraSettings } from "@shared/types";
import { IntegrationError } from "../errors";
import { httpDefaults, RemoteServiceError, requestJson } from "../export/http";
import { OWN_LABEL } from "../export/identity";
import {
  JIRA_SERVICE,
  jiraHeaders,
  jiraIssueUrl,
  jqlString,
  validateJiraSettings,
} from "../export/jira";
import type { JiraRequest, JiraTarget } from "./jiraRequests";

const PAGE = 100;
/** A search reads at most this many pages (5,000 issues) before reporting that it couldn't finish. */
const MAX_PAGES = 50;
const KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

export interface JiraIssue {
  key: string;
  fields: Record<string, unknown>;
}

export interface JiraLink {
  type?: { name?: string };
  inwardIssue?: { key?: string };
  outwardIssue?: { key?: string };
}

export class JiraIssues {
  readonly site: JiraTarget;
  private readonly headers: Record<string, string>;
  requests = 0;

  constructor(
    settings: JiraSettings,
    private readonly signal?: AbortSignal,
  ) {
    this.site = {
      baseUrl: validateJiraSettings(settings).baseUrl,
      projectKey: settings.projectKey.trim().toUpperCase(),
      api: settings.deployment === "server" ? "2" : "3",
    };
    this.headers = jiraHeaders(settings);
  }

  private get<T>(path: string) {
    this.requests++;
    return requestJson<T>(JIRA_SERVICE, `${this.site.baseUrl}${path}`, {
      headers: this.headers,
      signal: this.signal,
    });
  }

  /** Every issue matching `jql` in the configured project (the project clause is always added). */
  async search(jql: string, fields: string[]): Promise<JiraIssue[]> {
    const scoped = `project = ${jqlString(this.site.projectKey)} AND (${jql})`;
    const qs = `jql=${encodeURIComponent(scoped)}&fields=${encodeURIComponent(fields.join(","))}&maxResults=${PAGE}`;
    const out: JiraIssue[] = [];
    if (this.site.api === "3") {
      let token: string | undefined;
      for (let n = 0; n < MAX_PAGES; n++) {
        const { data } = await this.get<{
          issues?: JiraIssue[];
          nextPageToken?: string;
          isLast?: boolean;
        }>(
          `/rest/api/3/search/jql?${qs}${token ? `&nextPageToken=${encodeURIComponent(token)}` : ""}`,
        );
        out.push(...(data?.issues ?? []));
        token = data?.nextPageToken;
        if (!token || data?.isLast) return this.own(out);
      }
    } else {
      let startAt = 0;
      for (let n = 0; n < MAX_PAGES; n++) {
        const { data } = await this.get<{
          issues?: JiraIssue[];
          total?: number;
        }>(`/rest/api/2/search?${qs}&startAt=${startAt}`);
        const issues = data?.issues ?? [];
        out.push(...issues);
        startAt += issues.length;
        if (!issues.length || startAt >= (data?.total ?? 0))
          return this.own(out);
      }
    }
    throw new IntegrationError(
      "Jira returned more issues than Coherence reads in one search, so it couldn't check them all. Nothing was sent.",
    );
  }

  /** Only issues of the configured project, with a well-formed key. */
  private own(issues: JiraIssue[]): JiraIssue[] {
    return issues.filter(
      (i) =>
        typeof i?.key === "string" &&
        KEY.test(i.key) &&
        i.key.startsWith(`${this.site.projectKey}-`),
    );
  }

  /**
   * Issues that may be Coherence's: those carrying its label, and every issue of the given types (Epics often have
   * no Labels field). The caller decides by the durable key in the description.
   */
  async coherenceIssues(typeIds: string[] = []): Promise<JiraIssue[]> {
    const types = typeIds.filter((id) => /^\d+$/.test(id));
    return this.search(
      `labels = ${jqlString(OWN_LABEL)}${types.length ? ` OR issuetype in (${types.join(",")})` : ""}`,
      ["summary", "labels", "description"],
    );
  }

  /** Current values (every field) and the last-updated time of existing issues. */
  async readCurrent(
    keys: string[],
  ): Promise<Map<string, { rev: number; fields: Record<string, unknown> }>> {
    const out = new Map<
      string,
      { rev: number; fields: Record<string, unknown> }
    >();
    const valid = keys.filter((k) => KEY.test(k));
    for (let i = 0; i < valid.length; i += PAGE) {
      const issues = await this.search(
        `issuekey in (${valid.slice(i, i + PAGE).join(",")})`,
        ["*all"],
      );
      for (const issue of issues) {
        const rev = Date.parse(String(issue.fields?.updated ?? ""));
        if (Number.isFinite(rev))
          out.set(issue.key, { rev, fields: issue.fields ?? {} });
      }
    }
    return out;
  }

  async links(key: string): Promise<JiraLink[]> {
    const { data } = await this.get<{ fields?: { issuelinks?: JiraLink[] } }>(
      `/rest/api/${this.site.api}/issue/${encodeURIComponent(key)}?fields=issuelinks`,
    );
    return data?.fields?.issuelinks ?? [];
  }

  private async write<T>(request: JiraRequest) {
    if (!request.url.startsWith(`${this.site.baseUrl}/rest/api/`))
      throw new IntegrationError(
        "Internal error: a publishing write left the configured Jira site.",
      );
    this.requests++;
    return requestJson<T>(JIRA_SERVICE, request.url, {
      method: request.method,
      json: request.body,
      headers: this.headers,
      timeoutMs: httpDefaults.writeTimeoutMs,
      idempotent: false,
    });
  }

  /** Creates one issue. Returns its key. Never repeated automatically. */
  async create(request: JiraRequest): Promise<string> {
    const { data } = await this.write<{ key?: unknown }>(request);
    const key = String(data?.key ?? "");
    if (!KEY.test(key) || !key.startsWith(`${this.site.projectKey}-`))
      throw new IntegrationError(
        "Jira answered without the new issue's key, so the outcome is unknown.",
      );
    return key;
  }

  /**
   * Updates an issue only if nobody changed it since `updatedAt` (Jira has no conditional update, so its
   * last-updated time is read just before sending; an edit in between makes Coherence refuse the update).
   */
  async update(
    key: string,
    request: JiraRequest,
    updatedAt: number,
  ): Promise<void> {
    const { data } = await this.get<{ fields?: { updated?: string } }>(
      `/rest/api/${this.site.api}/issue/${encodeURIComponent(key)}?fields=updated`,
    );
    if (Date.parse(String(data?.fields?.updated ?? "")) !== updatedAt)
      throw new RemoteServiceError(
        `${key} was edited in Jira after this plan was made, so it wasn't updated.`,
        "Jira",
        409,
      );
    await this.write(request);
  }

  async addLink(request: JiraRequest): Promise<void> {
    await this.write(request);
  }

  browseUrl(key: string): string {
    return jiraIssueUrl(this.site.baseUrl, key);
  }
}
