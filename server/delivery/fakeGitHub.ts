/**
 * A stateful fake GitHub for publishing tests (never a live service): issues, labels and milestones of acme/portal,
 * plus another repository whose issues must never be touched. Labels and milestones created by a test show up in the
 * read-only discovery calls too. `dropLabelsAndMilestone` imitates a token without triage access: GitHub then
 * creates the issue but silently ignores its labels and milestone. Used only by *.test.ts.
 */
import type { MockResponse, RecordedCall } from "../export/testUtils";
import { githubRoutes } from "./testFixtures";

export interface FakeGitHubIssue {
  number: number;
  id: number;
  repo: string;
  title: string;
  body: string;
  labels: string[];
  milestone: number | null;
  type?: string;
  updated: number;
}

const API = "https://api.github.com";

export class FakeGitHub {
  readonly issues = new Map<string, FakeGitHubIssue>();
  readonly milestones = new Map<
    number,
    { title: string; description?: string }
  >([[1, { title: "Authentication" }]]);
  readonly labels = new Set(["bug", "feature: Authentication", "coherence"]);
  readonly calls: RecordedCall[] = [];
  dropLabelsAndMilestone = false;
  private next = new Map<string, number>();
  private clock = Date.parse("2026-11-03T10:00:00Z");
  private readonly discovery = githubRoutes();

  private tick() {
    this.clock += 1000;
    return this.clock;
  }

  seed(repo: string, issue: Partial<FakeGitHubIssue>) {
    const number = (this.next.get(repo) ?? 0) + 1;
    this.next.set(repo, number);
    const full: FakeGitHubIssue = {
      number,
      id: 900_000 + this.issues.size,
      repo,
      title: "",
      body: "",
      labels: [],
      milestone: null,
      updated: this.tick(),
      ...issue,
    };
    this.issues.set(`${repo}#${number}`, full);
    return full;
  }

  /** A person edits an issue on GitHub (its updated_at moves). */
  edit(number: number, change: Partial<FakeGitHubIssue>) {
    const issue = this.issues.get(`acme/portal#${number}`)!;
    Object.assign(issue, change);
    issue.updated = this.tick();
  }

  portal(): FakeGitHubIssue[] {
    return [...this.issues.values()].filter((i) => i.repo === "acme/portal");
  }

  writes(): RecordedCall[] {
    return this.calls.filter((c) => c.method !== "GET");
  }

  private json(i: FakeGitHubIssue) {
    return {
      number: i.number,
      id: i.id,
      title: i.title,
      body: i.body,
      labels: i.labels.map((name) => ({ name })),
      milestone:
        i.milestone === null
          ? null
          : {
              number: i.milestone,
              title: this.milestones.get(i.milestone)?.title,
            },
      ...(i.type ? { type: { name: i.type } } : {}),
      html_url: `https://github.com/${i.repo}/issues/${i.number}`,
      updated_at: new Date(i.updated).toISOString(),
    };
  }

  handle(call: RecordedCall): MockResponse {
    this.calls.push(call);
    const url = new URL(call.url);
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname);
    const repo = m?.[1] ?? "";
    const rest = m?.[2] ?? "";
    const body = (call.body ?? {}) as Record<string, unknown>;
    if (call.method === "GET" && repo === "acme/portal" && rest === "/labels")
      return {
        json:
          url.searchParams.get("page") === "1"
            ? [...this.labels].map((name) => ({ name }))
            : [],
      };
    if (
      call.method === "GET" &&
      repo === "acme/portal" &&
      rest === "/milestones"
    )
      return {
        json:
          url.searchParams.get("page") === "1"
            ? [...this.milestones].map(([number, x]) => ({
                number,
                title: x.title,
              }))
            : [],
      };
    if (call.method === "GET" && rest === "/issues") {
      const label = url.searchParams.get("labels");
      return {
        json:
          url.searchParams.get("page") === "1"
            ? [...this.issues.values()]
                .filter(
                  (i) =>
                    i.repo === repo && (!label || i.labels.includes(label)),
                )
                .map((i) => this.json(i))
            : [],
      };
    }
    const one = /^\/issues\/(\d+)$/.exec(rest);
    if (one) {
      const issue = this.issues.get(`${repo}#${one[1]}`);
      if (!issue) return { status: 404, json: { message: "Not Found" } };
      if (call.method === "GET") return { json: this.json(issue) };
      if (call.method === "PATCH") {
        for (const k of ["title", "body", "type"] as const)
          if (typeof body[k] === "string") issue[k] = body[k] as string;
        issue.updated = this.tick();
        return { json: this.json(issue) };
      }
    }
    const addLabels = /^\/issues\/(\d+)\/labels$/.exec(rest);
    if (addLabels && call.method === "POST") {
      const issue = this.issues.get(`${repo}#${addLabels[1]}`);
      if (!issue) return { status: 404, json: { message: "Not Found" } };
      for (const l of (body.labels as string[]) ?? [])
        if (!issue.labels.includes(l)) issue.labels.push(l);
      issue.updated = this.tick();
      return { json: issue.labels.map((name) => ({ name })) };
    }
    if (
      call.method === "POST" &&
      repo === "acme/portal" &&
      rest === "/labels"
    ) {
      const name = String(body.name);
      if (this.labels.has(name))
        return {
          status: 422,
          json: {
            message: "Validation Failed",
            errors: [{ resource: "Label", code: "already_exists" }],
          },
        };
      this.labels.add(name);
      return { status: 201, json: { name } };
    }
    if (
      call.method === "POST" &&
      repo === "acme/portal" &&
      rest === "/milestones"
    ) {
      const title = String(body.title);
      if (
        [...this.milestones.values()].some(
          (x) => x.title.toLowerCase() === title.toLowerCase(),
        )
      )
        return {
          status: 422,
          json: {
            message: "Validation Failed",
            errors: [{ resource: "Milestone", code: "already_exists" }],
          },
        };
      const number = Math.max(0, ...this.milestones.keys()) + 1;
      this.milestones.set(number, {
        title,
        description: body.description as string,
      });
      return { status: 201, json: { number, title } };
    }
    if (call.method === "POST" && rest === "/issues") {
      if (!body.title)
        return { status: 422, json: { message: "Validation Failed" } };
      const milestone = body.milestone;
      if (milestone !== undefined && !this.milestones.has(Number(milestone)))
        return {
          status: 422,
          json: {
            message: "Validation Failed",
            errors: [{ field: "milestone", code: "invalid" }],
          },
        };
      const labels = this.dropLabelsAndMilestone
        ? []
        : ((body.labels as string[]) ?? []);
      for (const l of labels) this.labels.add(l);
      const issue = this.seed(repo, {
        title: String(body.title),
        body: String(body.body ?? ""),
        labels: [...labels],
        milestone:
          this.dropLabelsAndMilestone || milestone === undefined
            ? null
            : Number(milestone),
        ...(typeof body.type === "string" ? { type: body.type } : {}),
      });
      return { status: 201, json: this.json(issue) };
    }
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
        message: `Unexpected fake route ${call.method} ${call.url} (${API})`,
      },
    };
  }
}
