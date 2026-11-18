import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AnalysisModelDefaults } from "./AnalysisModelDefaults";
import { analysisModelDefaults } from "../shared/analysisDefaults";
import { newConnection } from "./data";
const cloud = {
  ...newConnection("gemini", "cloud"),
  name: "Synthetic Gemini",
  modelIds: ["constructor", "writer"],
};
const offline = newConnection("mock", "offline");
const defaults = {
  visionConnectionId: cloud.id,
  visionModelId: "constructor",
  textConnectionId: cloud.id,
  textModelId: "writer",
};
function render(value = defaults, connections = [cloud, offline]) {
  return renderToStaticMarkup(
    <AnalysisModelDefaults
      value={value}
      connections={connections}
      onChange={() => {
        throw Error("Rendering must not mutate defaults");
      }}
      onConnections={() => {
        throw Error("Rendering must not navigate");
      }}
    />,
  );
}
it("renders four accessible selectors, truthful scope and five mapped stages", () => {
  const html = render();
  for (const name of [
    "reading connection",
    "reading model",
    "writing connection",
    "writing model",
  ])
    expect(html).toContain(`aria-label="Default ${name}"`);
  expect(html).toContain(
    "Existing projects and previous results stay unchanged",
  );
  expect(html).toContain("Use the same model for both");
  expect(html.match(/<code>constructor<\/code>/g)).toHaveLength(1);
  expect(html.match(/<code>writer<\/code>/g)).toHaveLength(4);
  expect(html).toContain("Image understanding");
  expect(html).toContain("Unknown");
});
it("shows missing account/model recovery without hiding the saved selections", () => {
  expect(render(defaults, [offline])).toContain("Connection unavailable");
  expect(render(defaults, [offline])).toContain("Add models in Connections");
  expect(render(defaults, [{ ...cloud, modelIds: [] }, offline])).toContain(
    "choose a configured model",
  );
});
it("uses a plain simulated Offline explanation even with unused legacy tuning", () => {
  const accounts = [{ ...offline, vision: "no", maxTokens: -1 }];
  const html = render(analysisModelDefaults(undefined, accounts), accounts);
  expect(html).toContain("Offline demo uses simulated output");
  expect(html.match(/<code>demo<\/code>/g)).toHaveLength(5);
  expect(html).not.toContain("reported as unable");
});
it("keeps long IDs intact and safely escaped in stage summaries", () => {
  const id = "long-model-" + "x".repeat(200);
  expect(
    render({ ...defaults, textModelId: id }, [
      { ...cloud, modelIds: ["constructor", id] },
      offline,
    ]),
  ).toContain(`<code>${id}</code>`);
  expect(
    render({ ...defaults, textModelId: "<script>synthetic</script>" }),
  ).not.toContain("<script>");
});
