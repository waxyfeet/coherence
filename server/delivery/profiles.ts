/**
 * Reusable mapping profiles: a team's approved answers (types, field mappings, permitted values, link types),
 * stored in the global profile per destination and applied deterministically by later plans without AI.
 * Each field rule remembers the field's signature; when the destination changes that field, the rule is
 * reported invalid and not applied.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  DestinationField,
  DestinationIdentity,
  MappingProfile,
  MappingRule,
  MappingRuleKind,
  PlanDecision,
} from "@shared/delivery";
import { config } from "../config";
import { readJsonIfExists, writeJsonAtomic } from "../storage/fsUtils";
import {
  DELIVERY_SCHEMA_VERSION,
  NewerDataError,
  isNewerFormat,
} from "../storage/formats";
import { destinationKey } from "./discovery";

export function fieldSignature(
  field: Pick<DestinationField, "kind" | "allowedValues">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([field.kind, [...(field.allowedValues ?? [])].sort()]),
    )
    .digest("hex")
    .slice(0, 16);
}

const ruleSchema = z.object({
  id: z.string().min(1).max(400),
  kind: z.enum([
    "item-type",
    "field-evidence",
    "field-constant",
    "field-skip",
    "link-type",
  ]),
  role: z.enum(["group", "requirement", "child"]).optional(),
  typeId: z.string().max(200).optional(),
  fieldId: z.string().max(200).optional(),
  value: z.string().max(2000),
  signature: z.string().max(64).optional(),
  approvedAt: z.string(),
});
const profileSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  identity: z.object({
    system: z.enum(["jira", "azdo", "github"]),
    base: z.string(),
    container: z.string(),
    variant: z.string().optional(),
  }),
  revision: z.number().int().nonnegative(),
  schemaFingerprint: z.string(),
  rules: z.array(ruleSchema).max(2000),
  updatedAt: z.string(),
});

function profileFile(identity: DestinationIdentity): string {
  return path.join(
    config.dataDir,
    "delivery",
    "profiles",
    `${destinationKey(identity)}.json`,
  );
}

/**
 * The saved profile, or undefined when none exists or the file is damaged (never trusted partially). A profile from
 * a newer Coherence is refused instead, so it is never treated as absent and then overwritten (installer ST-06).
 */
export async function readProfile(
  identity: DestinationIdentity,
): Promise<MappingProfile | undefined> {
  let raw: unknown;
  try {
    raw = await readJsonIfExists<unknown>(profileFile(identity));
  } catch {
    return undefined;
  }
  if (
    isNewerFormat(
      (raw as { schemaVersion?: unknown } | undefined)?.schemaVersion,
      DELIVERY_SCHEMA_VERSION,
    )
  )
    throw new NewerDataError("The saved mapping for this destination");
  try {
    const parsed = profileSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    return parsed.data.id === destinationKey(identity)
      ? (parsed.data as MappingProfile)
      : undefined;
  } catch {
    return undefined;
  }
}

function ruleKind(decision: PlanDecision, value: string): MappingRuleKind {
  if (decision.kind === "item-type") return "item-type";
  if (decision.kind === "link-type") return "link-type";
  if (value === "skip") return "field-skip";
  if (value.startsWith("evidence:")) return "field-evidence";
  return "field-constant";
}

/** A rule for a resolved type-level decision; item-level decisions (conflicts) are never saved. */
export function ruleFor(
  decision: PlanDecision,
  field: DestinationField | undefined,
  now: string,
): MappingRule | undefined {
  const value = decision.resolution?.value;
  if (!value || decision.itemId || decision.kind === "update-conflict")
    return undefined;
  return {
    id: decision.id,
    kind: ruleKind(decision, value),
    ...(decision.id.startsWith("item-type:")
      ? { role: decision.id.slice(10) as MappingRule["role"] }
      : {}),
    ...(decision.typeId ? { typeId: decision.typeId } : {}),
    ...(decision.fieldId ? { fieldId: decision.fieldId } : {}),
    value,
    ...(field ? { signature: fieldSignature(field) } : {}),
    approvedAt: now,
  };
}

/** Add or replace rules (by id) and bump the revision. */
export async function saveRules(
  identity: DestinationIdentity,
  schemaFingerprint: string,
  rules: MappingRule[],
  remove: string[] = [],
): Promise<MappingProfile> {
  const current = await readProfile(identity);
  const keep = (current?.rules ?? []).filter(
    (r) => !remove.includes(r.id) && !rules.some((n) => n.id === r.id),
  );
  const profile: MappingProfile = {
    schemaVersion: 1,
    id: destinationKey(identity),
    identity,
    revision: (current?.revision ?? 0) + 1,
    schemaFingerprint,
    rules: [...keep, ...rules],
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(profileFile(identity), profile);
  return profile;
}
