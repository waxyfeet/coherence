import type { Page } from "./data";

const pages: readonly Page[] = [
  "overview",
  "screens",
  "analysis",
  "use-cases",
  "graph",
  "changes",
  "export",
];
export interface WorkspaceRoute {
  pid: string;
  page: Page;
  library: boolean;
  caseId: string;
  screenId: string;
}
const validPage = (value: string | null | undefined): Page =>
  pages.includes(value as Page) ? (value as Page) : "screens";

/** Library visibility and remembered project identity are separate URL state. */
export function readWorkspaceRoute(hash: string): WorkspaceRoute {
  const [pathname, query = ""] = hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const match = /^\/projects\/([^/]+)\/([^/]+)$/.exec(pathname);
  let pid = "";
  try {
    pid = match ? decodeURIComponent(match[1]) : (params.get("active") ?? "");
  } catch {
    /* A malformed link must not crash the workspace. */
  }
  return {
    pid,
    library: !match,
    page: validPage(match?.[2] ?? params.get("view")),
    caseId: params.get("case") ?? "",
    screenId: params.get("screen") ?? "",
  };
}

export function workspaceHash(route: WorkspaceRoute): string {
  const params = new URLSearchParams();
  if (route.library && route.pid) {
    params.set("active", route.pid);
    params.set("view", route.page);
  }
  if (route.pid && route.caseId && route.page === "use-cases")
    params.set("case", route.caseId);
  if (route.pid && route.screenId && route.page === "screens")
    params.set("screen", route.screenId);
  const base =
    route.library || !route.pid
      ? "/projects"
      : `/projects/${encodeURIComponent(route.pid)}/${route.page}`;
  return "#" + base + (params.size ? "?" + params.toString() : "");
}
