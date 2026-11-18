/**
 * A stateful fake Jira for publishing tests (never a live service): Cloud (REST v3, ADF, enhanced search) or
 * Data Center (REST v2, wiki markup, startAt search). It keeps issues of several projects, so an unscoped search would
 * find another project's issue and fail a test. It enforces required fields on create, refuses text in the wrong
 * format for the API version, refuses a parent that doesn't exist, applies label "add" operations, records issue
 * links on both issues, and lets a test inject faults. Used only by *.test.ts.
 */
import type { MockResponse, RecordedCall } from "../export/testUtils";
import { jiraRoutes, type JiraFixture } from "./testFixtures";

export interface FakeIssue {
  key: string;
  id: string;
  project: string;
  issuetype: string;
  fields: Record<string, unknown>;
  links: {
    type: { name: string };
    inwardIssue?: { key: string };
    outwardIssue?: { key: string };
  }[];
  updated: number;
}

export interface JiraFault {
  when: (call: RecordedCall) => boolean;
  status: number;
  json?: unknown;
  apply?: boolean;
  times?: number;
}

const RICH = ["description", "customfield_10050", "environment"];

export class FakeJira {
  readonly issues = new Map<string, FakeIssue>();
  readonly calls: RecordedCall[] = [];
  readonly faults: JiraFault[] = [];
  /** Fields a workflow validator requires on create, per issue type id (not visible in createmeta). */
  readonly required: Record<string, string[]> = {};
  readonly cloud: boolean;
  private numbers = new Map<string, number>();
  private clock = Date.parse("2026-11-03T10:00:00.000Z");
  private readonly discovery;

  constructor(fixture: JiraFixture = {}) {
    this.cloud = fixture.cloud ?? true;
    this.discovery = jiraRoutes(fixture);
  }

  private tick() {
    this.clock += 1000;
    return this.clock;
  }

  seed(issue: Omit<FakeIssue, "key" | "id" | "links" | "updated">) {
    const n = (this.numbers.get(issue.project) ?? 0) + 1;
    this.numbers.set(issue.project, n);
    const key = `${issue.project}-${n}`;
    this.issues.set(key, {
      ...issue,
      key,
      id: String(10_000 + this.issues.size),
      links: [],
      updated: this.tick(),
    });
    return key;
  }

  /** A person edits an issue in Jira (its updated time moves). */
  edit(key: string, fields: Record<string, unknown>) {
    const issue = this.issues.get(key)!;
    Object.assign(issue.fields, fields);
    issue.updated = this.tick();
  }

  writes(): RecordedCall[] {
    return this.calls.filter((c) => c.method !== "GET");
  }

  handle(call: RecordedCall): MockResponse {
    this.calls.push(call);
    const fault = this.faults.find((f) => (f.times ?? 1) > 0 && f.when(call));
    if (fault) {
      fault.times = (fault.times ?? 1) - 1;
      if (fault.apply) this.route(call);
      return {
        status: fault.status,
        json: fault.json ?? { errorMessages: ["Injected fault"] },
      };
    }
    return this.route(call);
  }

  private json(issue: FakeIssue) {
    return {
      id: issue.id,
      key: issue.key,
      fields: {
        ...issue.fields,
        project: { key: issue.project },
        issuetype: { id: issue.issuetype },
        issuelinks: issue.links,
        updated: new Date(issue.updated).toISOString(),
      },
    };
  }

  private route(call: RecordedCall): MockResponse {
    const url = new URL(call.url);
    const api = this.cloud ? "3" : "2";
    const path = url.pathname;
    if (call.method === "GET" && /\/rest\/api\/3\/search\/jql$/.test(path))
      return this.search(url, true);
    if (call.method === "GET" && /\/rest\/api\/2\/search$/.test(path))
      return this.search(url, false);
    if (call.method === "POST" && path === `/rest/api/${api}/issue`)
      return this.create(call);
    if (call.method === "POST" && path === `/rest/api/${api}/issueLink`)
      return this.link(call);
    const one = new RegExp(
      `^/rest/api/${api}/issue/([A-Z][A-Z0-9_]*-\\d+)$`,
    ).exec(path);
    if (one && call.method === "GET") {
      const issue = this.issues.get(one[1]);
      return issue
        ? { json: this.json(issue) }
        : { status: 404, json: { errorMessages: ["Issue does not exist"] } };
    }
    if (one && call.method === "PUT") return this.update(one[1], call);
    const route = this.discovery.find(([re]) =>
      re.test(`${call.method} ${call.url}`),
    );
    if (route)
      return typeof route[1] === "function"
        ? route[1]({ url: call.url })
        : route[1];
    return {
      status: 404,
      json: {
        errorMessages: [`Unexpected fake route ${call.method} ${call.url}`],
      },
    };
  }

  private search(url: URL, cloud: boolean): MockResponse {
    if (cloud !== this.cloud)
      return { status: 404, json: { errorMessages: ["Not on this site"] } };
    const jql = url.searchParams.get("jql") ?? "";
    const project = /project = "([^"]+)"/.exec(jql)?.[1];
    const label = /labels = "([^"]+)"/.exec(jql)?.[1];
    const keys = /issuekey in \(([^)]*)\)/
      .exec(jql)?.[1]
      .split(",")
      .map((k) => k.trim());
    // "labels = x OR issuetype in (a, b)"
    const types = /issuetype in \(([^)]*)\)/
      .exec(jql)?.[1]
      .split(",")
      .map((t) => t.trim());
    const issues = [...this.issues.values()]
      .filter((i) => !project || i.project === project)
      .filter(
        (i) =>
          !label ||
          (Array.isArray(i.fields.labels) &&
            (i.fields.labels as string[]).includes(label)) ||
          !!types?.includes(i.issuetype),
      )
      .filter((i) => !keys || keys.includes(i.key))
      .map((i) => this.json(i));
    return {
      json: cloud
        ? { issues, isLast: true }
        : { issues, total: issues.length, startAt: 0 },
    };
  }

  private fieldProblems(fields: Record<string, unknown>) {
    const errors: Record<string, string> = {};
    for (const id of RICH)
      if (id in fields) {
        const value = fields[id];
        if (this.cloud && typeof value === "string")
          errors[id] = "Operation value must be an Atlassian Document";
        if (!this.cloud && typeof value !== "string")
          errors[id] = "Operation value must be a string";
      }
    return errors;
  }

  private create(call: RecordedCall): MockResponse {
    const fields = {
      ...((call.body as { fields?: Record<string, unknown> })?.fields ?? {}),
    };
    const project = (fields.project as { key?: string })?.key ?? "";
    const issuetype = (fields.issuetype as { id?: string })?.id ?? "";
    const errors = this.fieldProblems(fields);
    for (const id of this.required[issuetype] ?? [])
      if (fields[id] === undefined || fields[id] === "")
        errors[id] = `${id} is required.`;
    const parent = (fields.parent as { key?: string })?.key;
    if (parent && !this.issues.has(parent))
      errors.parent = `Issue ${parent} does not exist.`;
    const epicLink = fields.customfield_10100;
    if (typeof epicLink === "string" && !this.issues.has(epicLink))
      errors.customfield_10100 = `Epic ${epicLink} does not exist.`;
    if (Object.keys(errors).length)
      return { status: 400, json: { errorMessages: [], errors } };
    delete fields.project;
    delete fields.issuetype;
    const key = this.seed({ project, issuetype, fields });
    const issue = this.issues.get(key)!;
    return {
      status: 201,
      json: { id: issue.id, key, self: `${call.url}/${issue.id}` },
    };
  }

  private update(key: string, call: RecordedCall): MockResponse {
    const issue = this.issues.get(key);
    if (!issue)
      return { status: 404, json: { errorMessages: ["Issue does not exist"] } };
    const body = (call.body ?? {}) as {
      fields?: Record<string, unknown>;
      update?: Record<string, { add?: string }[]>;
    };
    const errors = this.fieldProblems(body.fields ?? {});
    if (Object.keys(errors).length)
      return { status: 400, json: { errorMessages: [], errors } };
    Object.assign(issue.fields, body.fields ?? {});
    for (const [field, ops] of Object.entries(body.update ?? {})) {
      const list = Array.isArray(issue.fields[field])
        ? [...(issue.fields[field] as string[])]
        : [];
      for (const op of ops)
        if (op.add !== undefined && !list.includes(op.add)) list.push(op.add);
      issue.fields[field] = list;
    }
    issue.updated = this.tick();
    return { status: 204 };
  }

  private link(call: RecordedCall): MockResponse {
    const body = call.body as {
      type: { name: string };
      inwardIssue: { key: string };
      outwardIssue: { key: string };
    };
    const inward = this.issues.get(body.inwardIssue.key);
    const outward = this.issues.get(body.outwardIssue.key);
    if (!inward || !outward)
      return { status: 404, json: { errorMessages: ["Issue does not exist"] } };
    // On the outward (dependent) issue the link lists the inward one, and the other way round.
    outward.links.push({ type: body.type, inwardIssue: { key: inward.key } });
    inward.links.push({ type: body.type, outwardIssue: { key: outward.key } });
    return { status: 201 };
  }
}
