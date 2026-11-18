/**
 * Azure DevOps work items for publishing (docs/ARCHITECTURE.md, "Publishing"). Every request it can make
 * is here: a project-scoped search for Coherence's items, batch and single reads, validate-only checks, and the
 * writes built by azdoRequests.ts. It never deletes, never sends bypassRules or suppressNotifications, and never
 * repeats a write automatically (server/export/http.ts). Writes ignore the job's cancel signal: Stop takes effect
 * between writes, so no request is abandoned half-way.
 */
import type { AzdoSettings } from "@shared/types";
import { IntegrationError } from "../errors";
import {
  AZDO_SERVICE,
  azdoHeaders,
  azdoWorkItemUrl,
  validateAzdoSettings,
} from "../export/azdo";
import { OWN_TAG } from "../export/identity";
import { httpDefaults, RemoteServiceError, requestJson } from "../export/http";
import {
  AZDO_API_VERSION,
  projectUrl,
  type AzdoRequest,
  type AzdoTarget,
} from "./azdoRequests";

/** What publishing needs to know about a work item that already exists. */
export interface RemoteWorkItem {
  id: string;
  title: string;
  type: string;
  project: string;
  tags: string[];
  description: string;
}

export interface RemoteRelation {
  rel: string;
  url: string;
  attributes?: Record<string, unknown>;
}

const READ_FIELDS = [
  "System.Id",
  "System.Title",
  "System.WorkItemType",
  "System.TeamProject",
  "System.Tags",
  "System.Description",
];

/** A failure that proves the request was not carried out (safe to try again; nothing to reconcile). */
export function provenRefusal(error: unknown): boolean {
  return (
    error instanceof RemoteServiceError &&
    [400, 401, 403, 404, 409, 412, 422, 429].includes(error.remoteStatus)
  );
}

export class AzdoWorkItems {
  readonly target: AzdoTarget;
  private readonly headers: Record<string, string>;
  /** Requests made, for the run's request budget and diagnostics. */
  requests = 0;

  constructor(
    settings: AzdoSettings,
    private readonly signal?: AbortSignal,
  ) {
    this.target = {
      orgUrl: validateAzdoSettings(settings).orgUrl,
      project: settings.project.trim(),
    };
    this.headers = azdoHeaders(settings);
  }

  private read<T>(url: string, init: { method?: "POST"; json?: unknown } = {}) {
    this.requests++;
    return requestJson<T>(AZDO_SERVICE, url, {
      headers: this.headers,
      signal: this.signal,
      ...(init.method
        ? { method: init.method, json: init.json, idempotent: true }
        : {}),
    });
  }

  /**
   * Ids of the work items in the configured project that carry Coherence's tag. The query is always scoped to the
   * project, so a trial project and a real one in the same organisation never see each other's items.
   */
  async coherenceItemIds(): Promise<string[]> {
    const { data } = await this.read<{ workItems?: { id: number }[] }>(
      projectUrl(this.target, `/_apis/wit/wiql?${AZDO_API_VERSION}`),
      {
        method: "POST",
        json: {
          query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Tags] CONTAINS '${OWN_TAG}' ORDER BY [System.Id] ASC`,
        },
      },
    );
    return (data?.workItems ?? [])
      .map((w) => String(w.id))
      .filter((id) => /^\d+$/.test(id));
  }

  /** Reads work items by id (missing ones are skipped); anything outside the configured project is dropped. */
  async readItems(ids: string[]): Promise<RemoteWorkItem[]> {
    const out: RemoteWorkItem[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const { data } = await this.read<{
        value?: ({ id: number; fields?: Record<string, unknown> } | null)[];
      }>(
        projectUrl(
          this.target,
          `/_apis/wit/workitems?ids=${batch.join(",")}&fields=${READ_FIELDS.join(",")}&errorPolicy=omit&${AZDO_API_VERSION}`,
        ),
      );
      for (const w of data?.value ?? []) {
        if (!w || !Number.isInteger(w.id)) continue;
        const f = w.fields ?? {};
        const text = (k: string) =>
          typeof f[k] === "string" ? (f[k] as string) : "";
        const item: RemoteWorkItem = {
          id: String(w.id),
          title: text("System.Title"),
          type: text("System.WorkItemType"),
          project: text("System.TeamProject"),
          tags: text("System.Tags")
            .split(";")
            .map((t) => t.trim())
            .filter(Boolean),
          description: text("System.Description"),
        };
        if (item.project.toLowerCase() === this.target.project.toLowerCase())
          out.push(item);
      }
    }
    return out;
  }

  /** Current revision and every field of existing work items (missing ones and other projects' are left out). */
  async readCurrent(
    ids: string[],
  ): Promise<Map<string, { rev: number; fields: Record<string, unknown> }>> {
    const out = new Map<
      string,
      { rev: number; fields: Record<string, unknown> }
    >();
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await this.read<{
        value?: ({
          id: number;
          rev?: number;
          fields?: Record<string, unknown>;
        } | null)[];
      }>(
        projectUrl(
          this.target,
          `/_apis/wit/workitems?ids=${ids.slice(i, i + 200).join(",")}&errorPolicy=omit&${AZDO_API_VERSION}`,
        ),
      );
      for (const w of data?.value ?? []) {
        if (!w || !Number.isInteger(w.id) || !Number.isInteger(w.rev)) continue;
        const project = String(w.fields?.["System.TeamProject"] ?? "");
        if (project.toLowerCase() !== this.target.project.toLowerCase())
          continue;
        out.set(String(w.id), { rev: w.rev!, fields: w.fields ?? {} });
      }
    }
    return out;
  }

  async relations(id: string): Promise<RemoteRelation[]> {
    const { data } = await this.read<{ relations?: RemoteRelation[] }>(
      projectUrl(
        this.target,
        `/_apis/wit/workitems/${encodeURIComponent(id)}?$expand=relations&${AZDO_API_VERSION}`,
      ),
    );
    return data?.relations ?? [];
  }

  /** Asks Azure DevOps to check a create without saving it. Throws the refusal when it would be rejected. */
  async check(request: AzdoRequest): Promise<void> {
    if (!/[?&]validateOnly=true(&|$)/.test(request.url))
      throw new IntegrationError(
        "Internal error: a check must be validate-only.",
      );
    this.requests++;
    await requestJson(AZDO_SERVICE, request.url, {
      method: request.method,
      json: request.ops,
      contentType: "application/json-patch+json",
      headers: this.headers,
      signal: this.signal,
      idempotent: true,
    });
  }

  /** Sends one write. Returns the work item id. Never repeated automatically. */
  async send(request: AzdoRequest): Promise<string> {
    if (
      /[?&](validateOnly|bypassRules|suppressNotifications)=/i.test(request.url)
    )
      throw new IntegrationError(
        "Internal error: a publishing write must not carry validateOnly, bypassRules or suppressNotifications.",
      );
    this.requests++;
    const { data } = await requestJson<{ id?: unknown }>(
      AZDO_SERVICE,
      request.url,
      {
        method: request.method,
        json: request.ops,
        contentType: "application/json-patch+json",
        headers: this.headers,
        timeoutMs: httpDefaults.writeTimeoutMs,
        idempotent: false,
      },
    );
    const id = String(data?.id ?? "");
    if (!/^\d+$/.test(id))
      throw new IntegrationError(
        "Azure DevOps answered without a work item id, so the outcome is unknown.",
      );
    return id;
  }

  /** The page a person opens: always built from the configured organisation URL, never taken from a response. */
  browseUrl(id: string): string {
    return azdoWorkItemUrl(this.target.orgUrl, this.target.project, id);
  }
}
