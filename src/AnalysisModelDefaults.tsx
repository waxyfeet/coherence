import type { AnalysisModelDefaults as Defaults } from "../shared/types";
import { useState } from "react";
import {
  changeDefaultConnection,
  defaultRoleIssue,
} from "../shared/analysisDefaults";
import {
  evidenceLabel,
  modelEvidenceForConnection,
} from "../shared/modelCapabilities";
import { visibleModels } from "../shared/modelCatalogue";
import { OFFLINE_MODEL_ID } from "../shared/modelSelection";
import type { Connection } from "./data";
import { Button, Field, Picker, Toggle } from "./ui";

export function AnalysisModelDefaults({
  value,
  connections,
  onChange,
  onConnections,
}: {
  value: Defaults;
  connections: Connection[];
  onChange: (next: Defaults) => void;
  onConnections: (id?: string) => void;
}) {
  const [separateWriting, setSeparateWriting] = useState(
    value.visionConnectionId !== value.textConnectionId ||
      value.visionModelId !== value.textModelId,
  );
  function change(next: Defaults) {
    onChange(
      separateWriting
        ? next
        : {
            ...next,
            textConnectionId: next.visionConnectionId,
            textModelId: next.visionModelId,
          },
    );
  }
  const summary = (reading: boolean) => {
    const id = reading ? value.visionConnectionId : value.textConnectionId,
      model = reading ? value.visionModelId : value.textModelId,
      account = connections.find((c) => c.id === id);
    return {
      name: account?.name ?? "Connection unavailable",
      model: model || "Choose a model",
    };
  };
  const reader = summary(true),
    writer = summary(false);
  return (
    <section
      className="settings-section analysis-model-defaults"
      aria-label="Default models for new projects"
    >
      <h3>Default models for new projects</h3>
      <p className="field-hint">
        New projects start with these choices. Existing projects and previous
        results stay unchanged. Override a project's models on its Analysis
        page.
      </p>
      <Toggle
        checked={separateWriting}
        label="Use a separate model for writing"
        description="Optional. Start with one image-capable model for the whole workflow."
        onChange={(next) => {
          setSeparateWriting(next);
          if (!next)
            onChange({
              ...value,
              textConnectionId: value.visionConnectionId,
              textModelId: value.visionModelId,
            });
        }}
      />
      {[true, false].map((reading) => {
        if (!reading && !separateWriting) return null;
        const id = reading ? value.visionConnectionId : value.textConnectionId,
          model = reading ? value.visionModelId : value.textModelId,
          c = connections.find((c) => c.id === id),
          role = reading ? "reading" : "writing",
          ids =
            c?.provider === "mock"
              ? [OFFLINE_MODEL_ID]
              : c
                ? visibleModels(c)
                : [],
          e = modelEvidenceForConnection(c, model),
          issue =
            defaultRoleIssue(value, connections, reading) ??
            (!separateWriting
              ? defaultRoleIssue(value, connections, false)
              : undefined);
        const accounts = connections.map((c) => ({
          value: c.id,
          label: c.name,
          detail:
            c.provider === "mock"
              ? "Built-in simulation · no AI"
              : "Saved provider account",
        }));
        if (id && !c)
          accounts.push({
            value: id,
            label: "Connection unavailable — choose again",
            detail: "Saved choice retained until you replace it",
          });
        const models = ids.map((id) => ({
          value: id,
          label: id,
          detail:
            c?.provider === "mock"
              ? "Simulated output · no provider calls"
              : "Configured exact model ID",
        }));
        if (model && !ids.includes(model))
          models.push({
            value: model,
            label: model,
            detail: c?.modelIds?.includes(model)
              ? "Current default · hidden from ordinary selectors"
              : "Model unavailable — choose again",
          });
        return (
          <div className="default-model-role" key={role}>
            <h4>
              {reading
                ? separateWriting
                  ? "Read screens"
                  : "Model for the whole workflow"
                : "Write use cases / reasoning"}
            </h4>
            <p className="field-hint">
              {reading
                ? separateWriting
                  ? "Reads screenshots and runs the optional inspection pass."
                  : "Reads screenshots, maps journeys, writes and reviews your specifications."
                : "Maps journeys, plans, writes and reviews use cases, and supports change reasoning."}
            </p>
            <div className="form-grid">
              <Field
                label={
                  separateWriting ? `Default ${role} connection` : "Connection"
                }
              >
                <Picker
                  value={id}
                  onChange={(id) =>
                    change(
                      changeDefaultConnection(value, connections, reading, id),
                    )
                  }
                  options={accounts}
                  label={`Default ${role} connection`}
                  placeholder="Choose a connection"
                />
              </Field>
              <Field
                label={separateWriting ? `Default ${role} model` : "Model"}
              >
                <Picker
                  value={model}
                  onChange={(model) =>
                    change(
                      reading
                        ? { ...value, visionModelId: model }
                        : { ...value, textModelId: model },
                    )
                  }
                  options={models}
                  label={`Default ${role} model`}
                  placeholder="Choose a model"
                  disabled={!c || models.length === 0}
                />
              </Field>
            </div>
            {issue ? (
              <p className="catalogue-message" role="status">
                {issue}
              </p>
            ) : c?.provider === "mock" ? (
              <p className="field-hint">
                Offline demo uses simulated output. No AI or provider calls.
              </p>
            ) : (
              <p className="field-hint">
                {reading ? "Image understanding" : "Text generation"}:{" "}
                {evidenceLabel(reading ? e.image : e.text)}.{" "}
                {reading && e.image.state === "unknown"
                  ? "Confirm image support on the project's Analysis page or explicitly test it in Connections."
                  : "Choosing or saving defaults does not test the model or make an AI request."}
              </p>
            )}
            {c?.provider !== "mock" &&
              (!c || (c.modelIds?.length ?? 0) === 0) && (
                <Button compact onClick={() => onConnections(c?.id)}>
                  Add models in Connections
                </Button>
              )}
          </div>
        );
      })}
      {separateWriting && (
        <Button
          compact
          disabled={
            !!defaultRoleIssue(value, connections, true) ||
            !!defaultRoleIssue(
              {
                ...value,
                textConnectionId: value.visionConnectionId,
                textModelId: value.visionModelId,
              },
              connections,
              false,
            )
          }
          onClick={() => {
            setSeparateWriting(false);
            onChange({
              ...value,
              textConnectionId: value.visionConnectionId,
              textModelId: value.visionModelId,
            });
          }}
        >
          Use the same model for both
        </Button>
      )}
      <div className="default-stage-heading">
        How these defaults map to the pipeline
      </div>
      <ol
        className="default-stage-summary"
        aria-label="Default model assignments by stage"
      >
        {["Read", "Map", "Plan", "Write", "Review"].map((stage, i) => {
          const choice = i === 0 ? reader : writer;
          return (
            <li key={stage}>
              <strong>{stage}</strong>
              <span>{choice.name}</span>
              <code>{choice.model}</code>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
