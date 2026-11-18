/**
 * Does a stored ExternalLink point into the tracker target that is configured now?
 * Integration settings are global, so a BA who switches Settings → Integrations to another Jira site,
 * Azure DevOps organisation or GitHub repository must not have ScreenScribe update "#5" or "ABC-7" there:
 * keys/numbers are only unique within the site/org/repo they were created in.
 * Pure (no server imports) so the web UI can use the same rule.
 */
import type {
  AzdoSettings,
  ExternalLink,
  ExternalSystem,
  GitHubSettings,
  JiraSettings,
} from "@shared/types";

type TrackerSettings =
  | Pick<JiraSettings, "baseUrl" | "projectKey">
  | Pick<AzdoSettings, "orgUrl" | "project">
  | Pick<GitHubSettings, "apiBaseUrl" | "owner" | "repo">;

/** "host[:port]/path" in lower case without trailing slashes; undefined for anything but http(s) URLs. */
function hostAndPath(raw: string | undefined): string | undefined {
  try {
    const url = new URL((raw ?? "").trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return `${url.host}${url.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return undefined;
  }
}

/** Legacy "<org>.visualstudio.com[/DefaultCollection]" and "dev.azure.com/<org>" are the same organisation. */
function azdoCanonical(raw: string | undefined): string | undefined {
  const value = hostAndPath(raw);
  const legacy =
    value &&
    /^([^/.:]+)\.visualstudio\.com(?:\/defaultcollection(?=\/|$))?(.*)$/.exec(
      value,
    );
  return legacy ? `dev.azure.com/${legacy[1]}${legacy[2]}` : value;
}

function githubRepoBase(s: GitHubSettings): string | undefined {
  const api = hostAndPath(s.apiBaseUrl?.trim() || "https://api.github.com");
  if (!api || !s.owner?.trim() || !s.repo?.trim()) return undefined;
  // GHE Server serves the API under /api/v3 of the web host; github.com and GHE.com use an "api." subdomain.
  const web = /\/api\/v3$/.test(api)
    ? api.replace(/\/api\/v3$/, "")
    : api.replace(/^api\./, "");
  return `${web}/${s.owner.trim()}/${s.repo.trim()}`.toLowerCase();
}

/** Where items of this tracker land, as compared against link URLs ("acme.atlassian.net", "github.com/acme/portal"). */
export function targetBase(
  system: ExternalSystem,
  settings: TrackerSettings,
): string | undefined {
  switch (system) {
    case "jira":
      return hostAndPath((settings as JiraSettings).baseUrl);
    case "azdo":
      return azdoCanonical((settings as AzdoSettings).orgUrl);
    case "github":
      return githubRepoBase(settings as GitHubSettings);
    default:
      return undefined;
  }
}

/**
 * True when `link` was exported to the configured site (Jira), organisation (Azure DevOps) or repository
 * (GitHub), compared case-insensitively. URL-less legacy links need reconciliation before reuse.
 */
export function linkBelongsToTarget(
  system: ExternalSystem,
  settings: TrackerSettings,
  link: ExternalLink,
): boolean {
  if (link.system !== system) return false;
  if (!link.url?.trim()) return false;
  const base = targetBase(system, settings);
  const url =
    system === "azdo" ? azdoCanonical(link.url) : hostAndPath(link.url);
  if (!base || !url || !url.startsWith(`${base}/`)) return false;
  let suffix: string;
  try {
    suffix = decodeURIComponent(url.slice(base.length + 1));
  } catch {
    return false;
  }
  if (system === "jira") {
    const match = /^browse\/([^/]+)$/i.exec(suffix);
    if (!match) return false;
    const key = match[1].toUpperCase();
    return (
      key === link.key.trim().toUpperCase() &&
      key.startsWith(
        (settings as JiraSettings).projectKey.trim().toUpperCase() + "-",
      ) &&
      /^.+-\d+$/.test(key)
    );
  }
  if (system === "azdo") {
    const match = /^(.+)\/_workitems\/edit\/(\d+)$/i.exec(suffix);
    return (
      !!match &&
      match[1].toLowerCase() ===
        (settings as AzdoSettings).project.trim().toLowerCase() &&
      match[2] === link.key.trim()
    );
  }
  const match = /^issues\/(\d+)$/i.exec(suffix);
  return !!match && match[1] === link.key.trim().replace(/^#/, "");
}
