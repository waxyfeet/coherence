import { describe, expect, it } from "vitest";
import type {
  AzdoSettings,
  ExternalLink,
  ExternalSystem,
  GitHubSettings,
  JiraSettings,
} from "@shared/types";
import { linkBelongsToTarget, targetBase } from "./target";

const jira: JiraSettings = {
  baseUrl: "https://prod.atlassian.net/",
  email: "ba@acme.test",
  apiToken: "t",
  projectKey: "ABC",
  issueType: "Story",
  epicIssueType: "Epic",
  labels: [],
  linkType: "Blocks",
  deployment: "cloud",
};
const azdo: AzdoSettings = {
  orgUrl: "https://dev.azure.com/Prod",
  project: "Portal",
  pat: "p",
  workItemType: "User Story",
  parentWorkItemType: "Feature",
  tags: [],
};
const github: GitHubSettings = {
  owner: "Acme",
  repo: "Production",
  token: "t",
  labels: [],
  apiBaseUrl: "",
  useMilestonesForFeatures: true,
};

function link(system: ExternalSystem, url: string, key = "5"): ExternalLink {
  return {
    system,
    key,
    url,
    revision: 1,
    exportedAt: "2026-10-14T00:00:00.000Z",
  };
}

describe("linkBelongsToTarget", () => {
  it("requires the stored key to match an exact item URL, not merely a target prefix", () => {
    expect(
      linkBelongsToTarget(
        "jira",
        jira,
        link("jira", "https://prod.atlassian.net/browse/ABC-7", "ABC-8"),
      ),
    ).toBe(false);
    expect(
      linkBelongsToTarget(
        "jira",
        jira,
        link("jira", "https://prod.atlassian.net/arbitrary/ABC-7", "ABC-7"),
      ),
    ).toBe(false);
    expect(
      linkBelongsToTarget(
        "github",
        github,
        link("github", "https://github.com/acme/production/issues/5", "#6"),
      ),
    ).toBe(false);
    expect(
      linkBelongsToTarget(
        "github",
        github,
        link("github", "https://github.com/acme/production/pull/5", "#5"),
      ),
    ).toBe(false);
    expect(
      linkBelongsToTarget(
        "azdo",
        azdo,
        link(
          "azdo",
          "https://dev.azure.com/prod/Portal/_workitems/edit/4711",
          "4712",
        ),
      ),
    ).toBe(false);
    expect(
      linkBelongsToTarget(
        "azdo",
        azdo,
        link(
          "azdo",
          "https://dev.azure.com/prod/Portal/_workitems/query/4711",
          "4711",
        ),
      ),
    ).toBe(false);
    expect(
      linkBelongsToTarget(
        "jira",
        jira,
        link("jira", "https://prod.atlassian.net/browse/%ZZ", "ABC-7"),
      ),
    ).toBe(false);
  });
  it("rejects a GitHub issue exported to another repository", () => {
    expect(
      linkBelongsToTarget(
        "github",
        github,
        link("github", "https://github.com/acme/sandbox/issues/5", "#5"),
      ),
    ).toBe(false);
    expect(
      linkBelongsToTarget(
        "github",
        github,
        link("github", "https://github.com/acme/production-old/issues/5", "#5"),
      ),
    ).toBe(false);
    expect(
      linkBelongsToTarget(
        "github",
        github,
        link("github", "https://github.com/acme/production/issues/5", "#5"),
      ),
    ).toBe(true);
    // Owner/repo compare case-insensitively.
    expect(
      linkBelongsToTarget(
        "github",
        github,
        link("github", "https://github.com/ACME/production/issues/5", "#5"),
      ),
    ).toBe(true);
  });

  it("maps a GitHub Enterprise API base to its web host", () => {
    const ghe = { ...github, apiBaseUrl: "https://ghe.acme.test/api/v3" };
    expect(targetBase("github", ghe)).toBe("ghe.acme.test/acme/production");
    expect(
      linkBelongsToTarget(
        "github",
        ghe,
        link("github", "https://ghe.acme.test/Acme/Production/issues/9", "9"),
      ),
    ).toBe(true);
    expect(
      linkBelongsToTarget(
        "github",
        ghe,
        link("github", "https://github.com/acme/production/issues/9"),
      ),
    ).toBe(false);
    // GHE.com (data residency): API on api.<tenant>.ghe.com, issues on <tenant>.ghe.com.
    const tenant = { ...github, apiBaseUrl: "https://api.acme.ghe.com" };
    expect(
      linkBelongsToTarget(
        "github",
        tenant,
        link("github", "https://acme.ghe.com/acme/production/issues/9", "#9"),
      ),
    ).toBe(true);
    expect(targetBase("github", github)).toBe("github.com/acme/production");
  });

  it("rejects a Jira issue exported to another site", () => {
    expect(
      linkBelongsToTarget(
        "jira",
        jira,
        link("jira", "https://sandbox.atlassian.net/browse/ABC-7", "ABC-7"),
      ),
    ).toBe(false);
    expect(
      linkBelongsToTarget(
        "jira",
        jira,
        link("jira", "https://PROD.atlassian.net/browse/ABC-7", "ABC-7"),
      ),
    ).toBe(true);
    // A site URL with a context path (Server/DC) must match it too.
    const dc = { ...jira, baseUrl: "https://tools.acme.test/jira" };
    expect(
      linkBelongsToTarget(
        "jira",
        dc,
        link("jira", "https://tools.acme.test/jira/browse/ABC-7", "ABC-7"),
      ),
    ).toBe(true);
    expect(
      linkBelongsToTarget(
        "jira",
        dc,
        link("jira", "https://tools.acme.test/jira2/browse/ABC-7"),
      ),
    ).toBe(false);
  });

  it("rejects an Azure DevOps work item from another organisation, accepting the legacy host name", () => {
    expect(
      linkBelongsToTarget(
        "azdo",
        azdo,
        link(
          "azdo",
          "https://dev.azure.com/sandbox/Portal/_workitems/edit/4711",
          "4711",
        ),
      ),
    ).toBe(false);
    expect(
      linkBelongsToTarget(
        "azdo",
        azdo,
        link(
          "azdo",
          "https://dev.azure.com/prod/Other%20project/_workitems/edit/4711",
          "4711",
        ),
      ),
    ).toBe(false);
    expect(
      linkBelongsToTarget(
        "azdo",
        azdo,
        link(
          "azdo",
          "https://prod.visualstudio.com/Portal/_workitems/edit/4711",
          "4711",
        ),
      ),
    ).toBe(true);
    expect(
      linkBelongsToTarget(
        "azdo",
        azdo,
        link(
          "azdo",
          "https://prod.visualstudio.com/DefaultCollection/Portal/_workitems/edit/4711",
          "4711",
        ),
      ),
    ).toBe(true);
  });

  it("rejects a link without target evidence, other systems and unusable URLs", () => {
    expect(linkBelongsToTarget("github", github, link("github", ""))).toBe(
      false,
    );
    expect(
      linkBelongsToTarget(
        "github",
        github,
        link("jira", "https://github.com/acme/production/issues/5"),
      ),
    ).toBe(false);
    expect(
      linkBelongsToTarget("github", github, link("github", "not a url")),
    ).toBe(false);
    expect(
      linkBelongsToTarget(
        "jira",
        { ...jira, baseUrl: "" },
        link("jira", "https://prod.atlassian.net/browse/ABC-7"),
      ),
    ).toBe(false);
  });
});
