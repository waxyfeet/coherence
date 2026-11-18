/**
 * OWNER: formats builder.
 * features/UC-003-<slug>.feature — one Gherkin feature per use case for Cucumber / SpecFlow / playwright-bdd.
 * Proper-case keywords (Given/When/Then/And), tags @UC-003 on the feature and @<type> on each scenario,
 * the user story as the feature description. Rendered from the model on every write; never parsed back.
 */
import type { BddScenario, UseCase } from "@shared/types";
import { oneLine } from "../markdown";
import type { Lookup } from "./lookup";
import { storyParts } from "./render";
import { GENERATED_MARKER, featureFilePath } from "./shared";

/** Gherkin tag: no whitespace, no '@'. */
function tag(value: string): string {
  return `@${value.replace(/[\s@#]+/g, "-").replace(/^-+|-+$/g, "") || "x"}`;
}

/** A free-text line must not start with a Gherkin keyword or comment/tag marker inside a description. */
function descriptionLine(text: string): string {
  const s = oneLine(text);
  return /^(feature|scenario|background|examples|rule|example|scenario outline|scenario template)\s*:|^[#@|]|^"""/i.test(
    s,
  )
    ? `- ${s}`
    : s;
}

function steps(sc: BddScenario): string[] {
  const lines: string[] = [];
  const add = (keyword: "Given" | "When" | "Then", items: string[]) => {
    items
      .map(oneLine)
      .filter(Boolean)
      .forEach((text, i) => lines.push(`${i === 0 ? keyword : "And"} ${text}`));
  };
  add("Given", sc.given);
  add("When", sc.when);
  add("Then", sc.then);
  return lines;
}

export function renderFeatureFile(
  lookup: Lookup,
  uc: UseCase,
): { path: string; content: string } {
  const ucFile = lookup.useCaseFile(uc);
  const path = featureFilePath(ucFile);
  const story = storyParts(uc);
  // English is Gherkin's default dialect, so no "# language:" header (it must be the very first line anyway).
  const lines: string[] = [
    `# ${GENERATED_MARKER} from ${ucFile} — edit that file; this one is rewritten on every write.`,
  ];
  const featureTags = [tag(uc.id)];
  if (uc.featureId) featureTags.push(tag(uc.featureId));
  featureTags.push(tag(`size-${uc.size}`));
  lines.push(featureTags.join(" "));
  lines.push(`Feature: ${uc.id} ${oneLine(uc.title)}`.trimEnd());
  const description = [
    story.asA ? `As a ${story.asA}` : "",
    story.iWant ? `I want to ${story.iWant}` : "",
    story.soThat ? `So that ${story.soThat}` : "",
  ].filter(Boolean);
  if (oneLine(uc.scope)) description.push("", `Scope: ${oneLine(uc.scope)}`);
  if (uc.preconditions.length)
    description.push(
      "",
      `Preconditions: ${uc.preconditions.map(oneLine).join("; ")}`,
    );
  for (const line of description)
    lines.push(line ? `  ${descriptionLine(line)}` : "");

  if (!uc.scenarios.length) {
    lines.push("", "  # No scenarios have been written for this use case yet.");
  }
  for (const sc of uc.scenarios) {
    lines.push("");
    lines.push(`  ${tag(sc.id)} ${tag(sc.type)}`);
    lines.push(`  Scenario: ${sc.id} ${oneLine(sc.title)}`.trimEnd());
    for (const step of steps(sc)) lines.push(`    ${step}`);
  }
  return { path, content: `${lines.join("\n")}\n` };
}
