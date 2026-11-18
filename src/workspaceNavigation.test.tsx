import { expect, it } from "vitest";
import { readWorkspaceRoute, workspaceHash } from "./workspaceNavigation";

it("keeps library visibility separate from the remembered project and tab on reload", () => {
  const route = {
    pid: "project A",
    page: "use-cases" as const,
    library: true,
    caseId: "UC-021",
    screenId: "",
  };
  expect(readWorkspaceRoute(workspaceHash(route))).toEqual(route);
  expect(workspaceHash(route)).toContain("#/projects?active=project+A");
});
it.each([
  "overview",
  "screens",
  "analysis",
  "use-cases",
  "graph",
  "changes",
  "export",
] as const)("preserves existing project deep links to %s", (page) => {
  expect(readWorkspaceRoute("#/projects/project%20B/" + page)).toMatchObject({
    pid: "project B",
    page,
    library: false,
  });
});
it("retains exact screen and use-case links without confusing the two projects", () => {
  expect(
    readWorkspaceRoute("#/projects/B/screens?screen=scr-two"),
  ).toMatchObject({ pid: "B", screenId: "scr-two" });
  expect(
    readWorkspaceRoute(
      "#/projects/A/use-cases?file=use-cases%2Fexample.md&case=UC-007&line=120",
    ),
  ).toMatchObject({ pid: "A", caseId: "UC-007", library: false });
});
it("leaves an empty library empty and handles malformed links safely", () => {
  expect(readWorkspaceRoute("#/projects")).toMatchObject({
    pid: "",
    library: true,
  });
  expect(readWorkspaceRoute("#/projects/%XX/screens").pid).toBe("");
  expect(readWorkspaceRoute("#/projects/A/unknown").page).toBe("screens");
  expect(
    workspaceHash({
      pid: "",
      page: "screens",
      library: true,
      caseId: "old",
      screenId: "old",
    }),
  ).toBe("#/projects");
});
