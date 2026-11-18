/**
 * A stateful fake Azure DevOps for publishing tests (never a live service). It keeps work items in several projects
 * of one organisation, so an unscoped search would find another project's items and fail a test. It enforces
 * rule-required fields on save, refuses links to missing items, stores nothing for validate-only, answers duplicate
 * links like Azure DevOps, and lets a test inject faults (any status, applied-then-error). Used only by *.test.ts.
 */
import type { MockResponse, RecordedCall } from "../export/testUtils";
import { azdoRoutes, type AzdoFixture } from "./testFixtures";

export interface FakeItem {
  id: number;
  project: string;
  type: string;
  fields: Record<string, unknown>;
  relations: {
    rel: string;
    url: string;
    attributes?: Record<string, unknown>;
  }[];
  rev: number;
}

export interface Fault {
  when: (call: RecordedCall) => boolean;
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Carry the request out first, then answer with the fault (the "saved, but the answer was lost" case). */
  apply?: boolean;
  /** How many matching calls fail (default 1). */
  times?: number;
}

const ORG = "https://dev.azure.com/acme";

function ruleError(field: string): MockResponse {
  return {
    status: 400,
    json: {
      $id: "1",
      message: `TF401320: Rule Error for field ${field}. Error code: Required, HasValues, LimitedToValues, AllowsOldValue, InvalidEmpty.`,
      typeKey: "RuleValidationException",
      errorCode: 600171,
    },
  };
}

export class FakeAzdo {
  readonly items = new Map<number, FakeItem>();
  readonly calls: RecordedCall[] = [];
  readonly faults: Fault[] = [];
  /** Fields a process rule requires on save, per work item type (not visible in field metadata). */
  readonly required: Record<string, string[]> = {};
  private nextId = 100;
  private readonly discovery;

  constructor(fixture: AzdoFixture = {}) {
    this.discovery = azdoRoutes(fixture);
  }

  seed(item: Omit<FakeItem, "id" | "rev" | "relations"> & Partial<FakeItem>) {
    const id = item.id ?? this.nextId++;
    this.items.set(id, { relations: [], rev: 1, ...item, id });
    return id;
  }

  /** A person edits a work item in Azure DevOps (its revision goes up). */
  edit(id: number, fields: Record<string, unknown>) {
    const item = this.items.get(id)!;
    Object.assign(item.fields, fields);
    item.rev++;
  }

  /** Writes (anything but GET and WIQL queries) made so far. */
  writes(): RecordedCall[] {
    return this.calls.filter(
      (c) => c.method !== "GET" && !c.url.includes("/_apis/wit/wiql"),
    );
  }

  handle(call: RecordedCall): MockResponse {
    this.calls.push(call);
    const fault = this.faults.find((f) => (f.times ?? 1) > 0 && f.when(call));
    if (fault) {
      fault.times = (fault.times ?? 1) - 1;
      if (fault.apply) this.route(call);
      return {
        status: fault.status,
        json: fault.json ?? { message: "Injected fault" },
        ...(fault.text !== undefined
          ? { text: fault.text, json: undefined }
          : {}),
        ...(fault.headers ? { headers: fault.headers } : {}),
      };
    }
    return this.route(call);
  }

  private route(call: RecordedCall): MockResponse {
    const { method, url } = call;
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").map(decodeURIComponent);
    // ["", "acme", "<project>", "_apis", "wit", ...]
    const project = parts[2];
    if (method === "POST" && parsed.pathname.endsWith("/_apis/wit/wiql"))
      return this.wiql(
        project,
        String((call.body as { query?: string })?.query ?? ""),
      );
    if (
      method === "GET" &&
      /\/_apis\/wit\/workitems$/i.test(parsed.pathname) &&
      parsed.searchParams.has("ids")
    )
      return this.batch(parsed.searchParams.get("ids")!.split(","));
    const single = /\/_apis\/wit\/workitems\/(\d+)$/i.exec(parsed.pathname);
    if (single && method === "GET") {
      const item = this.items.get(Number(single[1]));
      return item
        ? { json: this.json(item) }
        : {
            status: 404,
            json: {
              message: `TF401232: Work item ${single[1]} does not exist.`,
            },
          };
    }
    if (single && method === "PATCH")
      return this.patch(Number(single[1]), call);
    const create = /\/_apis\/wit\/workitems\/\$([^/]+)$/i.exec(parsed.pathname);
    if (create && method === "POST")
      return this.create(
        project,
        decodeURIComponent(create[1]),
        call,
        parsed.searchParams.get("validateOnly") === "true",
      );
    const route = this.discovery.find(([re]) => re.test(`${method} ${url}`));
    if (route)
      return typeof route[1] === "function" ? route[1]({ url }) : route[1];
    return {
      status: 404,
      json: { message: `Unexpected fake route ${method} ${url}` },
    };
  }

  private json(item: FakeItem) {
    return {
      id: item.id,
      rev: item.rev,
      fields: {
        ...item.fields,
        "System.Id": item.id,
        "System.TeamProject": item.project,
        "System.WorkItemType": item.type,
      },
      relations: item.relations,
      url: `${ORG}/_apis/wit/workItems/${item.id}`,
    };
  }

  private wiql(project: string, query: string): MockResponse {
    const scoped = /\[System\.TeamProject\]\s*=\s*@project/i.test(query);
    const tags = [
      ...query.matchAll(/\[System\.Tags\]\s+CONTAINS\s+'([^']*)'/gi),
    ].map((m) => m[1].toLowerCase());
    const ids = [...this.items.values()]
      .filter(
        (i) => !scoped || i.project.toLowerCase() === project.toLowerCase(),
      )
      .filter((i) => {
        const own = String(i.fields["System.Tags"] ?? "")
          .split(";")
          .map((t) => t.trim().toLowerCase());
        return tags.every((t) => own.includes(t));
      })
      .map((i) => ({ id: i.id }));
    return { json: { workItems: ids } };
  }

  private batch(ids: string[]): MockResponse {
    return {
      json: {
        count: ids.length,
        value: ids.map((id) => {
          const item = this.items.get(Number(id));
          return item ? this.json(item) : null;
        }),
      },
    };
  }

  private applyOps(
    item: Pick<FakeItem, "fields" | "relations">,
    ops: { op: string; path: string; value?: unknown }[],
  ): MockResponse | undefined {
    for (const op of ops) {
      if (op.path.startsWith("/fields/"))
        item.fields[op.path.slice(8)] = op.value;
      else if (op.path === "/relations/-") {
        const rel = op.value as FakeItem["relations"][number];
        const target = Number(/\/workItems\/(\d+)$/i.exec(rel.url)?.[1]);
        if (!this.items.has(target))
          return {
            status: 400,
            json: {
              message: `TF201036: You cannot add a link to work item ${target}, it does not exist.`,
            },
          };
        if (
          item.relations.some(
            (r) =>
              r.rel === rel.rel &&
              r.url.toLowerCase() === rel.url.toLowerCase(),
          )
        )
          return {
            status: 400,
            json: { message: "TF201035: Relation already exists." },
          };
        if (
          rel.rel === "System.LinkTypes.Hierarchy-Reverse" &&
          item.relations.some((r) => r.rel === rel.rel)
        )
          return {
            status: 400,
            json: { message: "TF201036: Work item can only have one parent." },
          };
        item.relations.push(rel);
      }
    }
    return undefined;
  }

  private create(
    project: string,
    type: string,
    call: RecordedCall,
    validateOnly: boolean,
  ): MockResponse {
    const ops = (call.body ?? []) as {
      op: string;
      path: string;
      value?: unknown;
    }[];
    const draft: Pick<FakeItem, "fields" | "relations"> = {
      fields: {},
      relations: [],
    };
    const problem = this.applyOps(draft, ops);
    if (problem) return problem;
    for (const field of this.required[type] ?? [])
      if (draft.fields[field] === undefined || draft.fields[field] === "")
        return ruleError(field);
    if (validateOnly) return { json: { id: 0, rev: 0, fields: draft.fields } };
    const id = this.seed({ project, type, ...draft });
    return { json: this.json(this.items.get(id)!) };
  }

  private patch(id: number, call: RecordedCall): MockResponse {
    const item = this.items.get(id);
    if (!item)
      return {
        status: 404,
        json: { message: `TF401232: Work item ${id} does not exist.` },
      };
    const ops = (call.body ?? []) as {
      op: string;
      path: string;
      value?: unknown;
    }[];
    // JSON Patch "test": the whole request fails when the work item changed in between.
    for (const op of ops)
      if (op.op === "test" && op.path === "/rev" && op.value !== item.rev)
        return {
          status: 412,
          json: {
            message:
              "TF26071: This work item has been changed by someone else since you opened it.",
          },
        };
    const copy = { fields: { ...item.fields }, relations: [...item.relations] };
    const problem = this.applyOps(
      copy,
      ops.filter((op) => op.op !== "test"),
    );
    if (problem) return problem;
    if (new URL(call.url).searchParams.get("validateOnly") === "true")
      return { json: this.json({ ...item, ...copy }) };
    Object.assign(item, copy, { rev: item.rev + 1 });
    return { json: this.json(item) };
  }
}
