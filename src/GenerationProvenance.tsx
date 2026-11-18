import type { SolutionModel } from "../shared/types";
import { savedGenerationKind } from "../shared/generationContext";
import { Badge } from "./ui";

export function GenerationProvenance({ model }: { model: SolutionModel }) {
  const kind = savedGenerationKind(model.generator);
  return (
    <section
      className="generation-provenance"
      aria-label="Saved generation provenance"
    >
      <div className="inline-between">
        <strong>Saved specification · generation providers</strong>
        <Badge tone={kind === "offline" || kind === "mixed" ? "amber" : "blue"}>
          {kind === "offline"
            ? "Offline generation"
            : kind === "mixed"
              ? "Mixed providers"
              : kind === "provider"
                ? "Provider-backed generation"
                : "Provenance unavailable"}
        </Badge>
      </div>
      <div className="generation-routes">
        <span>
          Screen reading <code>{model.generator.vision || "Unknown"}</code>
        </span>
        <span>
          Reasoning & writing <code>{model.generator.text || "Unknown"}</code>
        </span>
      </div>
      <p>
        {kind === "offline"
          ? "This saved run used the offline fixture provider. Generated fixture content is synthetic."
          : kind === "mixed"
            ? "This saved run combined offline fixture and model-backed steps. Review which content is synthetic."
            : kind === "provider"
              ? "These providers were recorded by the saved generation. Changing the next-run choices does not change this result. Human edits and preserved content may come from earlier work."
              : "This saved record does not identify its generation providers. Do not infer them from current Settings."}{" "}
        Generated requirements still need human review.
      </p>
    </section>
  );
}
