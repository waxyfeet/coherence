/**
 * Jira client (REST v2 + wiki markup — works on Cloud and Server/Data Center).
 * Auth: Cloud = Basic email:apiToken; Server/DC = Bearer PAT (or Basic username:password when a username is set).
 * Feature groups become Epics (found by JQL or created); stories attach via `parent` on Cloud and the
 * Epic Link custom field on Server/DC. Dependencies are issue links of `settings.linkType`.
 *
 * Link direction (verified against Jira behaviour): POST /issueLink with type "Blocks" makes the
 * `inwardIssue` the one that *blocks* the `outwardIssue` (the inward issue gets the outward label
 * "blocks"). So the prerequisite goes in `inwardIssue` and the dependent use case in `outwardIssue`
 * (JRACLOUD-98338). On GET of the dependent, a correct link lists the prerequisite as its `inwardIssue`.
 */
import type { TestConnectionResponse } from "@shared/api";
import type {
  ExportPreview,
  ExternalLink,
  FeatureGroup,
  JiraSettings,
} from "@shared/types";
import { STORY_POINTS } from "@shared/types";
import { CancelledError, IntegrationError, errorMessage } from "../errors";
import {
  basicAuth,
  jiraErrorMessage,
  normaliseBaseUrl,
  RemoteServiceError,
  requestJson,
  type ServiceInfo,
} from "./http";
import {
  buildDescriptionMarkdown,
  exportTitle,
  truncate,
  uniqueLabels,
  type ExportContent,
} from "./content";
import { markdownToJiraWiki } from "./markdown";
import { LEGACY_OWN_LABEL, OWN_LABEL, isOwnLabel } from "./identity";
import type {
  LinkInput,
  LinkOutcome,
  RemoteRef,
  TrackerClient,
  TrackerEnv,
  UpsertInput,
  UpsertResult,
} from "./types";

export const JIRA_SERVICE: ServiceInfo = {
  label: "Jira",
  extractMessage: jiraErrorMessage,
  authHint:
    "Check the Jira email and API token (Cloud) or personal access token (Server/Data Center) in Settings → Integrations.",
};

/** Jira text fields hold 32,767 characters; leave room for the truncation note. */
const DESCRIPTION_LIMIT = 32_000;
const TRUNCATION_NOTE =
  "\n\n_(Truncated — the full use case is in the Coherence spec file.)_";
const EPIC_LINK_SCHEMA = "com.pyxis.greenhopper.jira:gh-epic-link";
const EPIC_NAME_SCHEMA = "com.pyxis.greenhopper.jira:gh-epic-label";
/** Epic lookups read at most SEARCH_MAX_PAGES × SEARCH_PAGE_SIZE matches before giving up and creating one. */
const SEARCH_PAGE_SIZE = 50;
const SEARCH_MAX_PAGES = 5;

export function validateJiraSettings(s: JiraSettings): { baseUrl: string } {
  const missing: string[] = [];
  if (!s.baseUrl?.trim()) missing.push("site URL");
  if (!s.apiToken?.trim())
    missing.push(
      s.deployment === "server" ? "personal access token" : "API token",
    );
  if (!s.projectKey?.trim()) missing.push("project key");
  if (s.deployment !== "server" && !s.email?.trim())
    missing.push("account email (Jira Cloud signs in with email + API token)");
  if (missing.length)
    throw new IntegrationError(
      `Jira settings are incomplete: missing ${missing.join(", ")}.`,
    );
  return { baseUrl: normaliseBaseUrl(s.baseUrl, "The Jira site URL") };
}

export function jiraHeaders(s: JiraSettings): Record<string, string> {
  const token = s.apiToken.trim();
  const auth =
    s.deployment === "server" && !s.email?.trim()
      ? `Bearer ${token}`
      : basicAuth(s.email.trim(), token);
  return { Authorization: auth, "X-Atlassian-Token": "no-check" };
}

export function jiraIssueUrl(baseUrl: string, key: string): string {
  return `${baseUrl}/browse/${encodeURIComponent(key)}`;
}

export function buildJiraLabels(s: JiraSettings, useCaseId: string): string[] {
  return uniqueLabels(
    [...(s.labels ?? []), OWN_LABEL, useCaseId.toLowerCase()],
    true,
  );
}

export function buildJiraDescription(content: ExportContent): string {
  const wiki = markdownToJiraWiki(
    buildDescriptionMarkdown(content, {
      includeScenarios: true,
      includeFooter: true,
    }),
  );
  return wiki.length > DESCRIPTION_LIMIT
    ? `${truncate(wiki, DESCRIPTION_LIMIT - TRUNCATION_NOTE.length, "")}${TRUNCATION_NOTE}`
    : wiki;
}

export interface JiraFieldOptions {
  includeStoryPoints: boolean;
  /** Epic key when the story should sit under its feature's epic. */
  parentKey?: string;
  /** Server/DC only: the Epic Link custom field id. */
  epicLinkFieldId?: string;
}

/** Fields shared by create and update (summary, description, story points, epic). */
function commonFields(
  content: ExportContent,
  s: JiraSettings,
  opts: JiraFieldOptions,
): Record<string, unknown> {
  const uc = content.useCase;
  const fields: Record<string, unknown> = {
    summary: exportTitle(uc),
    description: buildJiraDescription(content),
  };
  if (opts.includeStoryPoints && s.storyPointsFieldId?.trim()) {
    fields[s.storyPointsFieldId.trim()] =
      STORY_POINTS[uc.size] ?? STORY_POINTS.M;
  }
  if (opts.parentKey) {
    if (s.deployment === "server") {
      if (opts.epicLinkFieldId) fields[opts.epicLinkFieldId] = opts.parentKey;
    } else {
      fields.parent = { key: opts.parentKey };
    }
  }
  return fields;
}

export function buildJiraCreatePayload(
  content: ExportContent,
  s: JiraSettings,
  opts: JiraFieldOptions,
): { fields: Record<string, unknown> } {
  return {
    fields: {
      project: { key: s.projectKey.trim() },
      issuetype: { name: s.issueType?.trim() || "Story" },
      ...commonFields(content, s, opts),
      labels: buildJiraLabels(s, content.useCase.id),
    },
  };
}

/** Update keeps labels someone added in Jira: ours are added, nothing is removed. */
export function buildJiraUpdatePayload(
  content: ExportContent,
  s: JiraSettings,
  opts: JiraFieldOptions,
): { fields: Record<string, unknown>; update: { labels: { add: string }[] } } {
  return {
    fields: commonFields(content, s, opts),
    update: {
      labels: buildJiraLabels(s, content.useCase.id).map((label) => ({
        add: label,
      })),
    },
  };
}

/** JQL string literal: backslash and double quote escaped. */
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Summary of a feature's epic — the lookup compares against the same truncated text that create sends. */
export function epicSummary(name: string): string {
  return truncate(name.trim(), 255);
}

/** The label Coherence puts on a feature's epic ("feat-01"), as uniqueLabels writes it. */
export function featureLabel(featureId: string): string | undefined {
  return uniqueLabels([featureId.toLowerCase()], true)[0];
}

function epicScopeJql(s: JiraSettings): string {
  return `project = ${jqlString(s.projectKey.trim())} AND issuetype = ${jqlString(s.epicIssueType?.trim() || "Epic")}`;
}

/**
 * Epics Coherence created for this feature id (feature ids repeat across projects: match the summary too), including
 * epics from before the visible rename, which carry the old label.
 */
export function buildEpicLabelJql(
  s: JiraSettings,
  featureId: string,
): string | undefined {
  const label = featureLabel(featureId);
  if (!label) return undefined;
  return `${epicScopeJql(s)} AND labels in (${jqlString(OWN_LABEL)}, ${jqlString(LEGACY_OWN_LABEL)}) AND labels = ${jqlString(label)} ORDER BY created ASC`;
}

/** Exact-phrase summary search for an epic; Lucene operators stripped from the phrase. */
export function buildEpicSearchJql(
  s: JiraSettings,
  name: string,
): string | undefined {
  const phrase = name
    .replace(/[+\-&|!(){}[\]^"~*?:\\/…]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!phrase) return undefined;
  return `${epicScopeJql(s)} AND summary ~ ${jqlString(`"${phrase}"`)} ORDER BY created ASC`;
}

export function previewJira(
  content: ExportContent,
  s: JiraSettings,
  existing?: ExternalLink,
): ExportPreview {
  const uc = content.useCase;
  const linkType = s.linkType?.trim() || "Blocks";
  const fields: Record<string, string> = {
    Project: s.projectKey,
    "Issue type": s.issueType?.trim() || "Story",
    Summary: exportTitle(uc),
    Labels: buildJiraLabels(s, uc.id).join(", "),
    "Parent epic": content.featureName
      ? `${s.epicIssueType?.trim() || "Epic"} "${content.featureName}" — found or created when "Create feature parents" is on (updates keep an epic chosen in Jira)`
      : "None (the use case has no feature group)",
    "Story points": s.storyPointsFieldId?.trim()
      ? `${STORY_POINTS[uc.size]} (size ${uc.size}) → ${s.storyPointsFieldId.trim()} when "Include story points" is on (updates fill it only when empty)`
      : "Not sent — set the story points field id in Settings → Integrations → Jira",
    "Dependency links": uc.dependsOn.length
      ? `"${linkType}" links: ${uc.dependsOn.join(", ")} → this issue (when "Link dependencies" is on)`
      : "None",
    "Existing issue": existing
      ? `${existing.key} — updated when "Update existing" is on`
      : "None — a new issue will be created",
  };
  return {
    target: "jira",
    useCaseId: uc.id,
    title: exportTitle(uc),
    bodyFormat: "jira-wiki",
    description: buildJiraDescription(content),
    acceptanceCriteria: "",
    fields,
  };
}

interface JiraField {
  id: string;
  name?: string;
  schema?: { custom?: string };
}

interface SearchIssue {
  key: string;
  fields?: { summary?: string };
}

interface IssueLinkInfo {
  type?: { name?: string };
  inwardIssue?: { key?: string };
  outwardIssue?: { key?: string };
}

export class JiraClient implements TrackerClient {
  readonly system = "jira" as const;
  readonly label = "Jira";
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private epicFields?: Promise<{ epicLink?: string; epicName?: string }>;
  /** Set once Jira refused a field, so later items skip it instead of failing again. */
  private readonly dropped = new Set<string>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly settings: JiraSettings,
    private readonly env: TrackerEnv,
  ) {
    this.baseUrl = validateJiraSettings(settings).baseUrl;
    this.headers = jiraHeaders(settings);
  }

  private request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    json?: unknown,
    allowStatuses?: number[],
  ) {
    return requestJson<T>(JIRA_SERVICE, `${this.baseUrl}${path}`, {
      method,
      json,
      headers: this.headers,
      signal: this.env.signal,
      allowStatuses,
    });
  }

  private warnOnce(key: string, message: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.env.log.warn(message);
  }

  /** Epic Link / Epic Name custom fields (Server/DC, and Cloud sites that still require Epic Name). */
  private getEpicFields(): Promise<{ epicLink?: string; epicName?: string }> {
    this.epicFields ??= this.request<JiraField[]>("GET", "/rest/api/2/field")
      .then(({ data }) => {
        const list = Array.isArray(data) ? data : [];
        return {
          epicLink: list.find((f) => f.schema?.custom === EPIC_LINK_SCHEMA)?.id,
          epicName: list.find((f) => f.schema?.custom === EPIC_NAME_SCHEMA)?.id,
        };
      })
      .catch(() => ({}));
    return this.epicFields;
  }

  /**
   * First issue matching `jql` and `match`, reading up to `maxPages` pages of results.
   * Cloud: the new /rest/api/3/search/jql (nextPageToken; the old /search is being removed); fall back to v2 /search (startAt).
   */
  async searchFor(
    jql: string,
    match: (issue: SearchIssue) => boolean,
    maxPages = SEARCH_MAX_PAGES,
  ): Promise<SearchIssue | undefined> {
    const qs = `jql=${encodeURIComponent(jql)}&fields=summary&maxResults=${SEARCH_PAGE_SIZE}`;
    if (this.settings.deployment !== "server") {
      type Page = {
        issues?: SearchIssue[];
        nextPageToken?: string;
        isLast?: boolean;
      };
      const first = await this.request<Page>(
        "GET",
        `/rest/api/3/search/jql?${qs}`,
        undefined,
        [404, 405, 410],
      );
      if (first.status < 300) {
        let page = first.data;
        for (let n = 1; ; n++) {
          const hit = (page?.issues ?? []).find(match);
          if (hit) return hit;
          const token = page?.nextPageToken;
          if (!token || page?.isLast || n >= maxPages) return undefined;
          page = (
            await this.request<Page>(
              "GET",
              `/rest/api/3/search/jql?${qs}&nextPageToken=${encodeURIComponent(token)}`,
            )
          ).data;
        }
      }
    }
    let startAt = 0;
    for (let n = 0; n < maxPages; n++) {
      const { data } = await this.request<{
        issues?: SearchIssue[];
        total?: number;
      }>("GET", `/rest/api/2/search?${qs}&startAt=${startAt}`);
      const issues = data?.issues ?? [];
      const hit = issues.find(match);
      if (hit) return hit;
      startAt += issues.length;
      if (!issues.length || startAt >= (data?.total ?? 0)) return undefined;
    }
    return undefined;
  }

  /** The feature's epic: by Coherence's labels first (exact, short), then by a paged summary search. */
  async findEpic(
    feature: Pick<FeatureGroup, "id" | "name">,
  ): Promise<RemoteRef | undefined> {
    const wanted = epicSummary(feature.name).toLowerCase();
    if (!wanted) return undefined;
    const same = (i: SearchIssue) =>
      (i.fields?.summary ?? "").trim().toLowerCase() === wanted;
    let hit: SearchIssue | undefined;
    const labelJql = buildEpicLabelJql(this.settings, feature.id);
    if (labelJql) {
      try {
        hit = await this.searchFor(labelJql, same);
      } catch (err) {
        if (err instanceof RemoteServiceError && err.remoteStatus === 401)
          throw err;
        // Fall through to the summary search.
      }
    }
    const phraseJql = hit
      ? undefined
      : buildEpicSearchJql(this.settings, epicSummary(feature.name));
    if (phraseJql) hit = await this.searchFor(phraseJql, same);
    return hit
      ? { key: hit.key, url: jiraIssueUrl(this.baseUrl, hit.key) }
      : undefined;
  }

  async ensureParent(
    feature: FeatureGroup,
  ): Promise<{ action: "created" | "skipped"; ref: RemoteRef }> {
    try {
      const found = await this.findEpic(feature);
      if (found) return { action: "skipped", ref: found };
    } catch (err) {
      if (err instanceof RemoteServiceError && err.remoteStatus === 401)
        throw err;
      this.env.log.warn(
        `Could not search Jira for an existing epic "${feature.name}" (${errorMessage(err)}) — creating a new one.`,
      );
    }
    const description = markdownToJiraWiki(
      `${feature.description.trim() || feature.name}\n\n---\n\n_Feature group ${feature.id} generated by Coherence_`,
    );
    const fields: Record<string, unknown> = {
      project: { key: this.settings.projectKey.trim() },
      issuetype: { name: this.settings.epicIssueType?.trim() || "Epic" },
      summary: epicSummary(feature.name),
      description,
      labels: uniqueLabels(
        [...(this.settings.labels ?? []), OWN_LABEL, feature.id.toLowerCase()],
        true,
      ),
    };
    let data: { key: string };
    try {
      ({ data } = await this.request<{ key: string }>(
        "POST",
        "/rest/api/2/issue",
        { fields },
      ));
    } catch (err) {
      // Classic projects require "Epic Name" on epics; add it and try once more.
      const errors = fieldErrors(err);
      const { epicName } = errors ? await this.getEpicFields() : {};
      if (!errors || !epicName || !(epicName in errors)) throw err;
      fields[epicName] = epicSummary(feature.name);
      ({ data } = await this.request<{ key: string }>(
        "POST",
        "/rest/api/2/issue",
        { fields },
      ));
    }
    return {
      action: "created",
      ref: { key: data.key, url: jiraIssueUrl(this.baseUrl, data.key) },
    };
  }

  private async fieldOptions(input: UpsertInput): Promise<JiraFieldOptions> {
    const opts: JiraFieldOptions = {
      includeStoryPoints:
        input.options.includeStoryPoints && !this.dropped.has("storyPoints"),
    };
    if (
      input.options.includeStoryPoints &&
      !this.settings.storyPointsFieldId?.trim()
    ) {
      this.warnOnce(
        "noStoryPointsField",
        "Story points were not sent to Jira: set the story points field id (e.g. customfield_10016) in Settings → Integrations → Jira.",
      );
    }
    if (input.parent && !this.dropped.has("parent")) {
      if (this.settings.deployment === "server") {
        const { epicLink } = await this.getEpicFields();
        if (epicLink) {
          opts.parentKey = input.parent.key;
          opts.epicLinkFieldId = epicLink;
        } else {
          this.warnOnce(
            "noEpicLink",
            'Jira did not report an "Epic Link" field, so stories were not attached to their epics — link them in Jira if needed.',
          );
        }
      } else {
        opts.parentKey = input.parent.key;
      }
    }
    return opts;
  }

  /** Send, and when Jira rejects an optional field (parent / story points) drop it, warn once and retry. */
  private async sendIssue(
    method: "POST" | "PUT",
    path: string,
    build: (opts: JiraFieldOptions) => unknown,
    opts: JiraFieldOptions,
    allow?: number[],
  ) {
    let current = { ...opts };
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request<{ key?: string }>(
          method,
          path,
          build(current),
          allow,
        );
      } catch (err) {
        const errors = fieldErrors(err);
        if (!errors || attempt >= 2) throw err;
        const next = { ...current };
        let changed = false;
        const parentField =
          this.settings.deployment === "server"
            ? current.epicLinkFieldId
            : "parent";
        if (current.parentKey && parentField && parentField in errors) {
          this.dropped.add("parent");
          this.warnOnce(
            "parentRejected",
            `Jira did not accept the epic as parent (${errors[parentField]}); stories were exported without a parent epic.`,
          );
          next.parentKey = undefined;
          next.epicLinkFieldId = undefined;
          changed = true;
        }
        const sp = this.settings.storyPointsFieldId?.trim();
        if (current.includeStoryPoints && sp && sp in errors) {
          this.dropped.add("storyPoints");
          this.warnOnce(
            "storyPointsRejected",
            `Jira did not accept story points in ${sp} (${errors[sp]}); items were exported without story points.`,
          );
          next.includeStoryPoints = false;
          changed = true;
        }
        if (!changed) throw err;
        current = next;
      }
    }
  }

  /**
   * Update options that leave the team's planning alone: story points only while the issue has none,
   * and a different parent epic is replaced only when it is one Coherence created (the use case moved
   * to another feature group). Undefined when the issue no longer exists.
   */
  private async updateOptions(
    uc: ExportContent["useCase"],
    key: string,
    opts: JiraFieldOptions,
  ): Promise<JiraFieldOptions | undefined> {
    const sp = opts.includeStoryPoints
      ? this.settings.storyPointsFieldId?.trim()
      : undefined;
    const parentField = !opts.parentKey
      ? undefined
      : this.settings.deployment === "server"
        ? opts.epicLinkFieldId
        : "parent";
    const wanted = [sp, parentField].filter((f): f is string => !!f);
    if (!wanted.length) return opts;
    const next = { ...opts };
    let fields: Record<string, unknown>;
    try {
      const res = await this.request<{ fields?: Record<string, unknown> }>(
        "GET",
        `/rest/api/2/issue/${encodeURIComponent(key)}?fields=${wanted.map(encodeURIComponent).join(",")}`,
        undefined,
        [404],
      );
      if (res.status === 404) return undefined;
      fields = res.data?.fields ?? {};
    } catch (err) {
      if (
        err instanceof CancelledError ||
        (err instanceof RemoteServiceError && err.remoteStatus === 401)
      )
        throw err;
      this.env.log.warn(
        `${uc.id}: could not read ${key}'s story points and epic (${errorMessage(err)}); they were left unchanged.`,
      );
      return {
        ...opts,
        includeStoryPoints: false,
        parentKey: undefined,
        epicLinkFieldId: undefined,
      };
    }
    if (sp && !isEmptyField(fields[sp])) next.includeStoryPoints = false;
    if (parentField && opts.parentKey) {
      const raw = fields[parentField];
      const currentParent =
        typeof raw === "string"
          ? raw
          : (raw as { key?: string } | null | undefined)?.key;
      if (currentParent === opts.parentKey) {
        next.parentKey = undefined;
        next.epicLinkFieldId = undefined;
      } else if (
        currentParent &&
        !(await this.isCoherenceEpic(currentParent))
      ) {
        this.env.log.info(
          `${uc.id}: ${key} keeps the parent ${currentParent} chosen in Jira (its feature group's epic is ${opts.parentKey}).`,
        );
        next.parentKey = undefined;
        next.epicLinkFieldId = undefined;
      }
    }
    return next;
  }

  /** Was this epic created by Coherence (it carries Coherence's label, old or new)? Unknown counts as no. */
  private async isCoherenceEpic(key: string): Promise<boolean> {
    try {
      const { data } = await this.request<{ fields?: { labels?: string[] } }>(
        "GET",
        `/rest/api/2/issue/${encodeURIComponent(key)}?fields=labels`,
      );
      return (data?.fields?.labels ?? []).some(isOwnLabel);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      return false;
    }
  }

  async upsert(input: UpsertInput): Promise<UpsertResult> {
    const { content } = input;
    const uc = content.useCase;
    const opts = await this.fieldOptions(input);

    if (input.existing) {
      const key = input.existing.key;
      const updateOpts = await this.updateOptions(uc, key, opts);
      if (updateOpts) {
        const res = await this.sendIssue(
          "PUT",
          `/rest/api/2/issue/${encodeURIComponent(key)}`,
          (o) => buildJiraUpdatePayload(content, this.settings, o),
          updateOpts,
          [404],
        );
        if (res.status !== 404)
          return {
            action: "updated",
            ref: { key, url: jiraIssueUrl(this.baseUrl, key) },
          };
      }
      this.env.log.warn(
        `${uc.id}: ${key} no longer exists in Jira — creating a new issue.`,
      );
    }

    const res = await this.sendIssue(
      "POST",
      "/rest/api/2/issue",
      (o) => buildJiraCreatePayload(content, this.settings, o),
      opts,
    );
    const key = res.data?.key;
    if (!key)
      throw new IntegrationError(
        `Jira created the issue for ${uc.id} but did not return its key.`,
      );
    return {
      action: "created",
      ref: { key, url: jiraIssueUrl(this.baseUrl, key) },
    };
  }

  async linkDependencies(input: LinkInput): Promise<LinkOutcome[]> {
    const linkType = this.settings.linkType?.trim() || "Blocks";
    const alreadyLinked = new Set<string>();
    const reversed = new Set<string>();
    if (input.preExisting) {
      try {
        const { data } = await this.request<{
          fields?: { issuelinks?: IssueLinkInfo[] };
        }>(
          "GET",
          `/rest/api/2/issue/${encodeURIComponent(input.ref.key)}?fields=issuelinks`,
        );
        for (const link of data?.fields?.issuelinks ?? []) {
          if ((link.type?.name ?? "").toLowerCase() !== linkType.toLowerCase())
            continue;
          // On the dependent, "<prerequisite> blocks this" is listed with the prerequisite as inwardIssue.
          // An outwardIssue entry is the reverse ("this blocks <it>") and does not satisfy the dependency.
          if (link.inwardIssue?.key) alreadyLinked.add(link.inwardIssue.key);
          if (link.outwardIssue?.key) reversed.add(link.outwardIssue.key);
        }
      } catch (err) {
        this.env.log.warn(
          `Could not read the existing links of ${input.ref.key} (${errorMessage(err)}); links will be added anyway.`,
        );
      }
    }

    const outcomes: LinkOutcome[] = [];
    for (const dep of input.dependencies) {
      if (alreadyLinked.has(dep.ref.key)) {
        outcomes.push({ toUseCaseId: dep.useCaseId, ok: true });
        continue;
      }
      if (reversed.has(dep.ref.key)) {
        this.env.log.warn(
          `Jira also has a "${linkType}" link in the reverse direction (${input.ref.key} → ${dep.ref.key}); it was left in place — remove it if the dependency changed.`,
        );
      }
      try {
        await this.request(
          "POST",
          "/rest/api/2/issueLink",
          buildJiraLinkPayload(linkType, dep.ref.key, input.ref.key),
        );
        outcomes.push({ toUseCaseId: dep.useCaseId, ok: true });
      } catch (err) {
        outcomes.push({
          toUseCaseId: dep.useCaseId,
          ok: false,
          error: errorMessage(err),
        });
      }
    }
    return outcomes;
  }
}

/** The prerequisite (inwardIssue) blocks the dependent (outwardIssue) — see the file header. */
export function buildJiraLinkPayload(
  linkType: string,
  prerequisiteKey: string,
  dependentKey: string,
) {
  return {
    type: { name: linkType },
    inwardIssue: { key: prerequisiteKey },
    outwardIssue: { key: dependentKey },
  };
}

function isEmptyField(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** Field-level errors of a Jira 400 ({ errors: { field: message } }), if that is what failed. */
function fieldErrors(err: unknown): Record<string, string> | undefined {
  if (!(err instanceof RemoteServiceError) || err.remoteStatus !== 400)
    return undefined;
  const errors = (err.body as { errors?: unknown } | undefined)?.errors;
  if (!errors || typeof errors !== "object" || !Object.keys(errors).length)
    return undefined;
  return errors as Record<string, string>;
}

export async function testJira(
  settings: JiraSettings,
): Promise<TestConnectionResponse> {
  const started = Date.now();
  try {
    const { baseUrl } = validateJiraSettings(settings);
    const headers = jiraHeaders(settings);
    const get = <T>(path: string, allow?: number[]) =>
      requestJson<T>(JIRA_SERVICE, `${baseUrl}${path}`, {
        headers,
        allowStatuses: allow,
      });

    const me = await get<{ displayName?: string; name?: string }>(
      "/rest/api/2/myself",
    );
    const who =
      me.data?.displayName ?? me.data?.name ?? "the configured account";
    const key = settings.projectKey.trim();
    const project = await get<{
      key?: string;
      name?: string;
      issueTypes?: { name: string; subtask?: boolean }[];
    }>(`/rest/api/2/project/${encodeURIComponent(key)}`, [404]);
    if (project.status === 404) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Signed in as ${who}, but project "${key}" was not found or this account cannot see it.`,
      };
    }
    const types = (project.data?.issueTypes ?? [])
      .filter((t) => !t.subtask)
      .map((t) => t.name);
    const wanted = [
      settings.issueType?.trim() || "Story",
      settings.epicIssueType?.trim() || "Epic",
    ];
    const missing = types.length
      ? wanted.filter(
          (w) => !types.some((t) => t.toLowerCase() === w.toLowerCase()),
        )
      : [];
    const projectLabel = `project ${project.data?.key ?? key}${project.data?.name ? ` (${project.data.name})` : ""}`;
    if (missing.length) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Signed in as ${who} and found ${projectLabel}, but it has no issue type ${missing.map((m) => `"${m}"`).join(" or ")}. Available: ${types.join(", ")}.`,
      };
    }
    return {
      ok: true,
      latencyMs: Date.now() - started,
      message: `Connected to Jira as ${who}; ${projectLabel} is ready for export.`,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: errorMessage(err),
    };
  }
}
