/**
 * GitHub discovery (GET only): repository, labels, milestones and — for organisation repositories — issue types
 * and issue fields. Issue forms are web templates, not writable API fields, so they are not read. A read cannot
 * prove that a token may create issues (fine-grained grants are not visible), so that stays Unknown.
 */
import type {
  CapabilityState,
  DestinationCapability,
  DestinationField,
  DestinationHierarchy,
  DestinationItemType,
  DestinationLinkType,
  FieldKind,
} from "@shared/delivery";
import type { GitHubSettings } from "@shared/types";
import { IntegrationError, errorMessage } from "../../errors";
import {
  GITHUB_SERVICE,
  githubHeaders,
  repoPath,
  validateGitHubSettings,
} from "../../export/github";
import { targetBase } from "../../export/target";
import {
  LIMITS,
  permittedValue,
  permittedValues,
  untrustedText,
} from "../untrusted";
import { ReadOnlyClient } from "./readOnly";
import type { DiscoveryDraft } from "./types";

interface Repo {
  full_name?: string;
  has_issues?: boolean;
  archived?: boolean;
  owner?: { login?: string; type?: string };
  permissions?: Record<string, boolean>;
}
interface IssueType {
  id?: number | string;
  name?: string;
  is_enabled?: boolean;
}
interface IssueField {
  id?: number | string;
  name?: string;
  data_type?: string;
  options?: { name?: string }[];
}

const ISSUE_FIELD_KIND: Record<string, FieldKind> = {
  text: "single-line",
  number: "number",
  date: "date",
  single_select: "option",
  multi_select: "multi-option",
};

function roleOf(perms: Record<string, boolean> | undefined): string {
  if (!perms) return "unknown";
  for (const role of ["admin", "maintain", "push", "triage", "pull"])
    if (perms[role]) return role;
  return "none";
}

export async function discoverGitHub(
  settings: GitHubSettings,
  signal?: AbortSignal,
): Promise<DiscoveryDraft> {
  const { apiBase } = validateGitHubSettings(settings);
  const repo = repoPath(settings);
  const client = new ReadOnlyClient(
    GITHUB_SERVICE,
    apiBase,
    githubHeaders(settings),
    signal,
  );
  const gaps: string[] = [];
  const enterprise = !/^https:\/\/api\.github\.com\/?$/i.test(apiBase);

  const info = await client.get<Repo>(repo, [404]);
  if (info.status === 404)
    throw new IntegrationError(
      `GitHub repository "${settings.owner}/${settings.repo}" was not found, or the token cannot see it. Nothing was changed.`,
    );
  const org =
    info.data?.owner?.type === "Organization"
      ? info.data.owner.login?.trim()
      : undefined;

  const labels: string[] = [];
  for (let page = 1; page <= 5 && labels.length < LIMITS.labels; page++) {
    try {
      const res = await client.get<{ name?: string }[]>(
        `${repo}/labels?per_page=100&page=${page}`,
      );
      const batch = Array.isArray(res.data) ? res.data : [];
      for (const l of batch) {
        const name = permittedValue(l.name, 50);
        if (name) labels.push(name);
      }
      if (batch.length < 100) break;
    } catch (err) {
      gaps.push(`Repository labels could not be read (${errorMessage(err)}).`);
      break;
    }
  }

  const milestones: string[] = [];
  for (let page = 1; page <= 2; page++) {
    try {
      const res = await client.get<{ title?: string }[]>(
        `${repo}/milestones?state=all&per_page=100&page=${page}`,
      );
      const batch = Array.isArray(res.data) ? res.data : [];
      for (const m of batch) {
        const title = permittedValue(m.title);
        if (title) milestones.push(title);
      }
      if (batch.length < 100) break;
    } catch (err) {
      gaps.push(`Milestones could not be read (${errorMessage(err)}).`);
      break;
    }
  }

  let issueTypes: string[] | undefined;
  let typesState: CapabilityState = org ? "unknown" : "unsupported";
  let typesNote = org
    ? "Issue types could not be read."
    : "Issue types belong to organisations; this repository is owned by a user.";
  const issueFields: DestinationField[] = [];
  let fieldsState: CapabilityState = org ? "unknown" : "unsupported";
  let fieldsNote = org
    ? "Issue fields could not be read."
    : "Issue fields belong to organisations; this repository is owned by a user.";
  if (org) {
    try {
      const res = await client.get<IssueType[]>(
        `/orgs/${encodeURIComponent(org)}/issue-types`,
        [403, 404],
      );
      if (res.status === 200 && Array.isArray(res.data)) {
        issueTypes = permittedValues(
          res.data.filter((t) => t.is_enabled !== false).map((t) => t.name),
        ).values;
        typesState = issueTypes?.length ? "supported" : "unsupported";
        typesNote = issueTypes?.length
          ? `The organisation defines ${issueTypes.length} issue type(s).`
          : "The organisation defines no issue types.";
      } else {
        typesNote =
          "Issue types could not be read with this token (it needs organisation read access).";
      }
    } catch (err) {
      gaps.push(`Issue types could not be read (${errorMessage(err)}).`);
    }
    try {
      const res = await client.get<IssueField[]>(
        `/orgs/${encodeURIComponent(org)}/issue-fields`,
        [403, 404],
      );
      if (res.status === 200 && Array.isArray(res.data)) {
        for (const f of res.data) {
          const kind = ISSUE_FIELD_KIND[f.data_type ?? ""] ?? "unknown";
          const id = `issue-field:${String(f.id ?? "").replace(/[^\w-]/g, "")}`;
          if (id === "issue-field:") continue;
          const allowed =
            kind === "option" || kind === "multi-option"
              ? permittedValues((f.options ?? []).map((o) => o.name))
              : {};
          issueFields.push({
            id,
            name: untrustedText(f.name ?? id, LIMITS.name) || id,
            kind,
            role: "custom",
            required: false,
            hasDefault: false,
            readOnly: false,
            custom: true,
            ...(allowed.values ? { allowedValues: allowed.values } : {}),
            ...(allowed.truncated ? { allowedValuesTruncated: true } : {}),
            sourceType: untrustedText(f.data_type ?? "", 40),
          });
        }
        fieldsState = "unknown";
        fieldsNote = issueFields.length
          ? `The organisation defines ${issueFields.length} issue field(s). GitHub silently ignores values where the feature is not enabled for a repository, so values need confirming after publishing.`
          : "The organisation defines no issue fields.";
      } else {
        fieldsNote =
          "Issue fields could not be read with this token (it needs the organisation Issue Fields read permission).";
      }
    } catch (err) {
      gaps.push(`Issue fields could not be read (${errorMessage(err)}).`);
    }
  }

  const issueFieldsCore: DestinationField[] = [
    {
      id: "title",
      name: "Title",
      kind: "single-line",
      role: "title",
      required: true,
      hasDefault: false,
      readOnly: false,
      custom: false,
      maxLength: 256,
    },
    {
      id: "body",
      name: "Body",
      kind: "rich-text",
      role: "description",
      required: false,
      hasDefault: false,
      readOnly: false,
      custom: false,
      maxLength: 65_536,
    },
    {
      id: "labels",
      name: "Labels",
      kind: "labels",
      role: "labels",
      required: false,
      hasDefault: false,
      readOnly: false,
      custom: false,
    },
    {
      id: "milestone",
      name: "Milestone",
      kind: "reference",
      role: "milestone",
      required: false,
      hasDefault: false,
      readOnly: false,
      custom: false,
    },
    {
      id: "assignees",
      name: "Assignees",
      kind: "user",
      role: "team",
      required: false,
      hasDefault: false,
      readOnly: false,
      custom: false,
    },
  ];
  if (issueTypes?.length)
    issueFieldsCore.push({
      id: "type",
      name: "Issue type",
      kind: "option",
      role: "issue-type",
      required: false,
      hasDefault: false,
      readOnly: false,
      custom: false,
      allowedValues: issueTypes,
    });

  const itemTypes: DestinationItemType[] = [
    {
      id: "issue",
      name: "Issue",
      level: "requirement",
      isDefault: true,
      fields: [...issueFieldsCore, ...issueFields],
    },
    {
      id: "milestone",
      name: "Milestone",
      level: "portfolio",
      isDefault: !!settings.useMilestonesForFeatures,
      fields: [
        {
          id: "title",
          name: "Title",
          kind: "single-line",
          role: "title",
          required: true,
          hasDefault: false,
          readOnly: false,
          custom: false,
          maxLength: 255,
        },
        {
          id: "description",
          name: "Description",
          kind: "multi-line",
          role: "description",
          required: false,
          hasDefault: false,
          readOnly: false,
          custom: false,
        },
      ],
    },
    {
      id: "label",
      name: "Label",
      level: "portfolio",
      isDefault: !settings.useMilestonesForFeatures,
      fields: [
        {
          id: "name",
          name: "Name",
          kind: "single-line",
          role: "title",
          required: true,
          hasDefault: false,
          readOnly: false,
          custom: false,
          maxLength: 50,
        },
      ],
    },
  ];
  const hierarchy: DestinationHierarchy[] = [
    { parentTypeId: "milestone", childTypeId: "issue", via: "milestone" },
    { parentTypeId: "label", childTypeId: "issue", via: "label" },
    { parentTypeId: "issue", childTypeId: "issue", via: "sub-issue" },
  ];
  const linkTypes: DestinationLinkType[] = [
    {
      id: "blocked-by",
      name: "Blocked by",
      kind: "dependency",
      direction: "is blocked by",
    },
  ];
  const documented: CapabilityState = enterprise ? "unknown" : "supported";
  const role = roleOf(info.data?.permissions);
  const capabilities: DestinationCapability[] = [
    {
      id: "issues-enabled",
      state:
        info.data?.has_issues === false || info.data?.archived
          ? "unsupported"
          : "supported",
      note: info.data?.archived
        ? "The repository is archived; issues cannot be created."
        : info.data?.has_issues === false
          ? "Issues are turned off for this repository."
          : "Issues are enabled.",
    },
    {
      id: "create-permission",
      state: "unknown",
      note: `Your repository role is "${role}". Whether the token may create issues, labels or milestones cannot be confirmed without writing.`,
    },
    { id: "issue-types", state: typesState, note: typesNote },
    { id: "issue-fields", state: fieldsState, note: fieldsNote },
    {
      id: "sub-issues",
      state: documented,
      note: enterprise
        ? "Sub-issues depend on the GitHub Enterprise Server version; not confirmed for this server."
        : "Documented in the GitHub REST API (up to 100 sub-issues per parent).",
    },
    {
      id: "issue-dependencies",
      state: documented,
      note: enterprise
        ? "Issue dependencies depend on the GitHub Enterprise Server version; not confirmed for this server."
        : "Documented in the GitHub REST API (up to 50 per relationship type).",
    },
    {
      id: "attachments",
      state: "unsupported",
      note: "The GitHub REST API cannot upload files to issues; screenshots would need another route.",
    },
  ];
  if (info.data?.has_issues === false || info.data?.archived)
    gaps.push(capabilities[0].note);

  return {
    identity: {
      system: "github",
      base:
        (targetBase("github", settings) ?? "").replace(
          `/${settings.owner.trim()}/${settings.repo.trim()}`.toLowerCase(),
          "",
        ) || apiBase.toLowerCase(),
      container:
        `${settings.owner.trim()}/${settings.repo.trim()}`.toLowerCase(),
      variant: enterprise ? "enterprise" : "github.com",
    },
    textFormat: "markdown",
    itemTypes,
    linkTypes,
    hierarchy,
    labels,
    milestones,
    capabilities,
    gaps,
    requestCount: client.requests.length,
  };
}
