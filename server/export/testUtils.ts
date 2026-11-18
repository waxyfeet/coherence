/**
 * Test helpers for the export module: a realistic sample use case/model and a tiny fetch router.
 * Used only by *.test.ts files.
 */
import { vi } from "vitest";
import type { Project, SolutionModel, UseCase } from "@shared/types";
import type { ExportContent } from "./content";

export function sampleUseCase(overrides: Partial<UseCase> = {}): UseCase {
  return {
    id: "UC-003",
    slug: "sign-in-with-email",
    title: "Sign in with email and password",
    formatId: "use-case-bdd",
    featureId: "FEAT-01",
    personaId: "persona-registered-user",
    screenIds: ["scr_login"],
    regionIds: ["login.form"],
    elementIds: ["login.email", "login.sign_in"],
    dependsOn: ["UC-001"],
    order: 3,
    size: "M",
    scope:
      "Sign-in form on the Login screen: credentials entry, remember-me and submission.",
    story: {
      asA: "registered user",
      iWant: "sign in with my email address and password",
      soThat: "I can access my account securely",
    },
    preconditions: ["The Login screen is displayed"],
    postconditions: [
      "The user is signed in",
      "The Dashboard screen is displayed",
    ],
    businessRules: [
      {
        id: "BR-01",
        elementId: "login.email",
        element: "Email address",
        elementType: "email_input",
        description:
          'Single-line email input labelled "Email address" with placeholder "you@company.com".',
        rules: [
          "Mandatory; the form cannot be submitted while it is empty.",
          "Must be a valid email address, max 254 characters.",
        ],
      },
      {
        id: "BR-05",
        element: "Screen-level rules",
        elementType: "general",
        description: "Rules that apply to the whole sign-in form.",
        rules: [
          "After 5 consecutive failed attempts the account is locked for 15 minutes.",
        ],
      },
    ],
    scenarios: [
      {
        id: "SC-01",
        title: "Successful sign-in",
        type: "happy",
        given: [
          "the Login screen is displayed",
          "the user has an active account",
        ],
        when: [
          'the user enters a registered email address in "Email address"',
          'the user selects "Sign in"',
        ],
        then: ["the user is signed in", "the Dashboard screen is displayed"],
        elementIds: ["login.email", "login.sign_in"],
      },
    ],
    assumptions: ["Error message wording is inferred; confirm with UX."],
    openQuestions: ["Is single sign-on required?"],
    notes: "",
    status: "approved",
    revision: 2,
    updatedAt: "2026-10-14T10:00:00.000Z",
    external: [],
    filePath: "use-cases/UC-003-sign-in-with-email.md",
    ...overrides,
  };
}

export function sampleContent(
  overrides: Partial<UseCase> = {},
  extra: Partial<ExportContent> = {},
): ExportContent {
  const useCase = sampleUseCase(overrides);
  return {
    useCase,
    markdownBody: [
      `# ${useCase.id} · ${useCase.title}`,
      "",
      "| Feature | Persona | Screens | Size | Depends on |",
      "|---|---|---|---|---|",
      "| Authentication | Registered user | [Login](../screens/login.md) | M | [UC-001](UC-001-open-the-app.md) |",
      "",
      "![Login](../screens/images/login.png)",
      "",
      "## BDD scenarios",
      "",
      "```gherkin",
      "GIVEN the Login screen is displayed",
      "THEN the user is signed in",
      "```",
      "",
    ].join("\n"),
    source: "file",
    warnings: [],
    featureName: "Authentication",
    personaName: "Registered user",
    screenNames: ["Login"],
    ...extra,
  };
}

export function sampleProject(outputDir = "/tmp/specs"): Project {
  return {
    id: "acme",
    name: "Acme",
    description: "Acme portal",
    additionalContext: "",
    formatId: "use-case-bdd",
    outputDir,
    llm: {},
    screens: [
      {
        id: "scr_login",
        name: "Login",
        notes: "",
        order: 0,
        version: 1,
        fileName: "scr_login/v1.png",
        originalFileName: "login.png",
        mimeType: "image/png",
        width: 100,
        height: 100,
        sizeBytes: 10,
        uploadedAt: "2026-10-14T00:00:00.000Z",
      },
    ],
    status: "specified",
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
  };
}

export function sampleModel(useCases: UseCase[]): SolutionModel {
  return {
    schemaVersion: 1,
    projectId: "acme",
    formatId: "use-case-bdd",
    generatedAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
    generator: { vision: "mock/mock", text: "mock/mock" },
    options: {
      thoroughness: "standard",
      granularity: "balanced",
      preserveEdited: true,
      embedScreenImages: true,
      reuseScreenAnalyses: true,
    },
    summary: "",
    personas: [
      {
        id: "persona-registered-user",
        name: "Registered user",
        description: "",
        goals: [],
      },
    ],
    screens: [],
    flows: [],
    features: [
      {
        id: "FEAT-01",
        name: "Authentication",
        description: "Signing in and out.",
        useCaseIds: useCases.map((u) => u.id),
      },
    ],
    useCases,
    review: [],
    changeLog: [],
  };
}

export interface MockResponse {
  status?: number;
  json?: unknown;
  text?: string;
  body?: Buffer;
  headers?: Record<string, string>;
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: RecordedCall) => MockResponse | Promise<MockResponse>;

/**
 * Install a fetch mock. Routes are matched in order on "METHOD url"; the first match handles the call.
 * Unmatched calls fail the test loudly.
 */
export function mockFetch(routes: [RegExp, Handler | MockResponse][]) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      let body: unknown = init?.body;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          // keep the raw string
        }
      }
      const call = { method, url, headers, body };
      calls.push(call);
      const route = routes.find(([re]) => re.test(`${method} ${url}`));
      if (!route) throw new Error(`Unexpected fetch: ${method} ${url}`);
      const r =
        typeof route[1] === "function" ? await route[1](call) : route[1];
      const status = r.status ?? 200;
      const responseHeaders = new Headers(r.headers ?? {});
      if (r.body) {
        return new Response(new Uint8Array(r.body), {
          status,
          headers: responseHeaders,
        });
      }
      if (r.json !== undefined && !responseHeaders.has("content-type"))
        responseHeaders.set("content-type", "application/json");
      const text =
        r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? "");
      return new Response(status === 204 ? null : text, {
        status,
        headers: responseHeaders,
      });
    },
  );
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

export const silentLog = { info: () => undefined, warn: () => undefined };
