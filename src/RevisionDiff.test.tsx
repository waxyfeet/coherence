import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { RevisionDiff } from "./RevisionDiff";
it("renders the entire long diff, including important late changes, as escaped readable text", () => {
  const text = "Retained narrative.\n".repeat(700);
  const html = renderToStaticMarkup(
    <RevisionDiff
      before={text + "REMOVE BEYOND 4000\nMODIFY OLD\n"}
      after={text + "MODIFY NEW\nADD BEYOND 4000 <script>synthetic</script>\n"}
    />,
  );
  for (const marker of [
    "REMOVE BEYOND 4000",
    "MODIFY OLD",
    "MODIFY NEW",
    "ADD BEYOND 4000",
  ])
    expect(html).toContain(marker);
  expect(html).not.toContain("<script>");
  expect(html).toContain('aria-label="Complete revision diff"');
  expect(html).toContain('class="proposal-diff-line removed"');
  expect(html).toContain('class="proposal-diff-line added"');
});
