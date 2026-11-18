import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { Project, PublicSettings } from "../shared/types";
import { fixtureModel } from "../server/graph/testFixtures";
import { RealExport } from "./RealDelivery";
it("does not mark an old-target issue as current after changing the Jira destination", () => {
  const model = fixtureModel();
  model.useCases[0].external = [
    {
      system: "jira",
      key: "ABC-1",
      url: "https://old.fixture.invalid/browse/ABC-1",
      revision: model.useCases[0].revision,
      exportedAt: new Date().toISOString(),
    },
  ];
  const settings = {
    connections: [],
    dataDir: "fixture",
    settingsPath: "fixture",
    integrations: {
      jira: {
        baseUrl: "https://new.fixture.invalid",
        projectKey: "ABC",
        email: "fixture@example.invalid",
        issueType: "Story",
        epicIssueType: "Epic",
        deployment: "cloud" as const,
        labels: [],
        linkType: "Blocks",
        apiToken: "",
        hasSecret: false,
      },
    },
  } satisfies PublicSettings;
  const markup = renderToStaticMarkup(
    <RealExport
      project={{ id: "fixture" } as Project}
      model={model}
      settings={settings}
      onJob={async () => {}}
      attempt={async (action) => action()}
      job={null}
      onSettings={() => {}}
    />,
  );
  expect(markup).toContain("Different destination · new item planned");
  expect(markup).not.toContain("Exported revision is current");
});
