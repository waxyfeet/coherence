import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { fixtureModel } from "../server/graph/testFixtures";
import { GenerationProvenance } from "./GenerationProvenance";
function render(vision: string, text: string) {
  const model = fixtureModel();
  model.generator = { vision, text };
  return renderToStaticMarkup(<GenerationProvenance model={model} />);
}
it("identifies the saved Gemini run and explicitly separates it from next-run choices", () => {
  const markup = render(
    "gemini/gemini-3.5-flash-lite",
    "gemini/gemini-3.5-flash-lite",
  );
  expect(markup).toContain("Provider-backed generation");
  expect(markup).toContain(
    "Changing the next-run choices does not change this result",
  );
  expect(markup).not.toContain("Offline generation");
});
it("discloses partially offline generation rather than calling mixed steps wholly real or wholly synthetic", () => {
  const markup = render("mock/demo", "gemini/model");
  expect(markup).toContain("Mixed providers");
  expect(markup).toContain("combined offline fixture and model-backed steps");
});
it("does not invent provenance for a missing provider snapshot", () => {
  expect(render("", "")).toContain("Provenance unavailable");
});
