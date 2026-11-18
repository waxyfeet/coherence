import { useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import type { ListModelsResponse } from "../shared/api";
import { visibleModels } from "../shared/modelCatalogue";
import { validModelId } from "../shared/modelSelection";
import type { Connection } from "./data";
import { Button, Field, IconButton } from "./ui";
import {
  ModelCapabilityTests,
  type CapabilityTester,
} from "./ModelCapabilityTests";
import { catalogueIdentity } from "./connectionIdentity";
export { catalogueIdentity } from "./connectionIdentity";

/** A recognised service's key check, in plain words (owner test note 3); empty when none ran. */
export function keyCheckText(check: ListModelsResponse["keyCheck"]): string {
  return check === "accepted"
    ? " The service accepted the key."
    : check === "refused"
      ? " The service refused this key: check it before running an analysis."
      : check === "missing"
        ? " No API key is entered yet: this service lists models without one, but analysis needs it."
        : "";
}

/** Catalogue refresh is an explicit GET-only provider operation, separate from account Save and inference Test. */
export function ConnectionModels({
  connection,
  onChange,
  onFind,
  testModel,
  onTestModel,
  entry,
  onEntry,
  saveError,
  onTest,
}: {
  connection: Connection;
  onChange: (patch: Partial<Connection>) => void;
  onFind: () => Promise<ListModelsResponse>;
  testModel: string;
  onTestModel: (id: string) => void;
  entry: string;
  onEntry: (id: string) => void;
  saveError?: string;
  onTest: CapabilityTester;
}) {
  const ids = connection.modelIds ?? [];
  const visible = visibleModels(connection);
  const [result, setResult] = useState<ListModelsResponse | undefined>(() =>
    connection.catalogue
      ? {
          models: connection.catalogue.models,
          catalogue: connection.catalogue,
          cached: true,
        }
      : undefined,
  );
  const [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [error, setError] = useState("");
  const sequence = useRef(0);
  const identity = catalogueIdentity(connection);
  useEffect(() => {
    sequence.current++;
    setBusy(false);
    setQuery("");
    setResult(
      connection.catalogue
        ? {
            models: connection.catalogue.models,
            catalogue: connection.catalogue,
            cached: true,
          }
        : undefined,
    );
    return () => {
      sequence.current++;
    };
    // A metadata-only parent refresh must not erase this attempt's error/loading state.
    // A new account/credential/endpoint identity (or reopening) hydrates its own cache.
  }, [identity]);
  async function find() {
    const n = ++sequence.current;
    setBusy(true);
    try {
      const value = await onFind();
      if (n === sequence.current) setResult(value);
    } catch (e) {
      if (n === sequence.current)
        setResult((old) => ({
          ...old,
          models: old?.models ?? [],
          cached: !!old?.catalogue,
          error:
            e instanceof Error
              ? e.message
              : "Model discovery failed. You can enter IDs manually.",
        }));
    } finally {
      if (n === sequence.current) setBusy(false);
    }
  }
  function show(id: string, checked: boolean) {
    if (checked && !ids.includes(id) && ids.length >= 200) {
      setError("Keep up to 200 configured model IDs per account.");
      return;
    }
    onChange({
      modelIds: checked ? [...new Set([...ids, id])] : ids,
      visibleModelIds: checked
        ? [...new Set([...visible, id])]
        : visible.filter((v) => v !== id),
    });
  }
  function add() {
    const id = entry.trim();
    if (!validModelId(id)) {
      setError(
        "Enter an exact model ID or deployment name (up to 300 characters).",
      );
      return;
    }
    if (!ids.includes(id) && ids.length >= 200) {
      setError("Keep up to 200 model IDs per connection.");
      return;
    }
    onChange({
      modelIds: [...new Set([...ids, id])],
      visibleModelIds: [...new Set([...visible, id])],
      manualModelIds: [...new Set([...(connection.manualModelIds ?? []), id])],
    });
    onEntry("");
    setError("");
  }
  const list = result?.models ?? [];
  const matches = list.filter((m) =>
    (m.id + " " + (m.label ?? "")).toLowerCase().includes(query.toLowerCase()),
  );
  const azure = connection.provider === "azure";
  const sourceLabel =
    result?.catalogue &&
    (
      {
        openai: "OpenAI",
        anthropic: "Anthropic",
        gemini: "Google Gemini",
        ollama: "Ollama installed models",
        "lm-studio-v1": "LM Studio native",
        "lm-studio-v0": "LM Studio legacy",
        compatible: "Compatible endpoint",
      } as const
    )[result.catalogue.source];
  return (
    <section className="connection-models" aria-label="Configured model IDs">
      <div className="catalogue-heading">
        <div>
          <h3>Models for this account</h3>
          <p className="field-hint">
            Choose which IDs appear in Analysis. Finding models does not run
            inference or prove their capabilities.
          </p>
        </div>
        {!azure && (
          <Button onClick={() => void find()} disabled={busy}>
            <RefreshCw size={13} />
            {busy
              ? "Finding models…"
              : result?.catalogue
                ? "Refresh models"
                : "Connect & find models"}
          </Button>
        )}
      </div>
      {azure && (
        <p className="catalogue-message" role="note">
          Azure base-model lists do not identify deployed models. Enter the
          exact deployment names from your resource below.
        </p>
      )}
      <div role="status" aria-live="polite" className="catalogue-status">
        {busy
          ? "Finding models at the configured endpoint…"
          : result?.error
            ? result.error
            : result
              ? list.length
                ? `${list.length} models found. No inference test was performed.${keyCheckText(result.keyCheck)}`
                : "The endpoint returned an empty model list. You can enter exact IDs manually."
              : !azure
                ? "No catalogue loaded. Connect explicitly or enter model IDs manually."
                : ""}
        {result?.catalogue && (
          <p className="field-hint">
            {result.cached ? "Cached catalogue" : "Catalogue fetched"} ·{" "}
            {new Date(result.catalogue.refreshedAt).toLocaleString()} ·{" "}
            {sourceLabel}
            {!result.catalogue.complete ? " · Partial result" : ""}. Cached
            results do not prove the endpoint is reachable now.
          </p>
        )}
        {result?.partial && (
          <p className="field-hint">
            The refresh was incomplete.{" "}
            {result.cached
              ? "The last successful catalogue is retained."
              : "Only the returned portion is shown; it has not replaced the saved catalogue."}
          </p>
        )}
      </div>
      {list.length > 0 && (
        <>
          <Field label="Search models">
            <input
              aria-label="Search models"
              placeholder="Find an ID or name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </Field>
          <div
            className="catalogue-list"
            role="group"
            aria-label="Provider catalogue"
          >
            {matches.slice(0, 80).map((m) => (
              <label className="catalogue-model" key={m.id}>
                <input
                  type="checkbox"
                  aria-label={`Show ${m.id} in Analysis`}
                  checked={visible.includes(m.id)}
                  onChange={(e) => show(m.id, e.target.checked)}
                />
                <span>
                  <strong>{m.label ?? m.id}</strong>
                  {m.label && <code>{m.id}</code>}
                  <small>
                    Provider-listed ·{" "}
                    {m.reported?.vision === true
                      ? "Provider reports image input"
                      : m.reported?.vision === false
                        ? "Provider reports no image input"
                        : "Image input unknown"}
                    {m.reported?.contextWindow
                      ? ` · Reported context: ${m.reported.contextWindow.toLocaleString()}`
                      : ""}
                    {m.reported?.inputTokenLimit
                      ? ` · Reported input limit: ${m.reported.inputTokenLimit.toLocaleString()}`
                      : ""}
                    {m.reported?.outputTokenLimit
                      ? ` · Reported answer limit: ${m.reported.outputTokenLimit.toLocaleString()}`
                      : ""}
                    {m.reported?.loaded === false
                      ? " · Not loaded at last refresh"
                      : ""}{" "}
                    · Not independently tested
                  </small>
                </span>
              </label>
            ))}
            {!matches.length && (
              <p className="field-hint">
                No matches. Your configured IDs below are retained.
              </p>
            )}
          </div>
          {matches.length > 80 && (
            <p className="field-hint">
              Showing 80 of {matches.length} matching models. Refine the search.
            </p>
          )}
        </>
      )}
      <Field
        label="Model ID or deployment name"
        error={error || saveError}
        hint="Manual entry always works without a catalogue. Add exact IDs; no default model is required to save an account."
      >
        <div className="input-action">
          <input
            aria-label="Model ID or deployment name"
            value={entry}
            maxLength={300}
            autoComplete="off"
            onChange={(e) => onEntry(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button compact onClick={add}>
            <Plus size={13} />
            Add model
          </Button>
        </div>
      </Field>
      {ids.length ? (
        <ul className="configured-models">
          {ids.map((id) => (
            <li key={id}>
              <label className="configured-model-visibility">
                <input
                  type="checkbox"
                  aria-label={`Show configured ${id} in Analysis`}
                  checked={visible.includes(id)}
                  onChange={(e) => show(id, e.target.checked)}
                />
                <span>
                  <code>{id}</code>
                  <small>
                    {connection.manualModelIds?.includes(id)
                      ? "Manually entered"
                      : "Configured ID"}
                    {result?.catalogue && !list.some((m) => m.id === id)
                      ? " · Not in last catalogue; kept configured"
                      : ""}{" "}
                    · Capabilities not independently tested
                  </small>
                </span>
              </label>
              <IconButton
                label={`Remove model ${id}`}
                onClick={() =>
                  onChange({
                    modelIds: ids.filter((v) => v !== id),
                    visibleModelIds: visible.filter((v) => v !== id),
                    manualModelIds: connection.manualModelIds?.filter(
                      (v) => v !== id,
                    ),
                  })
                }
              >
                <Trash2 size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-hint">
          No models configured yet. You can save this account now and choose
          models later.
        </p>
      )}
      <p className="field-hint">
        Unchecking hides an ID from ordinary selectors and keeps existing
        assignments usable. Remove deletes its configuration and requires
        affected projects to reselect. Catalogue refresh never removes
        configured IDs.
      </p>
      <details className="catalogue-test">
        <summary>Optional model test</summary>
        <Field
          label="Model for explicit test"
          hint="Choose an exact model to inspect and test. Unlike catalogue discovery, inference tests may incur API charges."
        >
          <input
            aria-label="Model for explicit test"
            value={testModel}
            onChange={(e) => onTestModel(e.target.value)}
            autoComplete="off"
            maxLength={300}
            list="configured-test-models"
          />
          <datalist id="configured-test-models">
            {ids.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </Field>
        <ModelCapabilityTests
          connection={connection}
          modelId={testModel.trim()}
          onTest={onTest}
          onEvidence={(id, records) =>
            onChange({
              capabilities: { ...connection.capabilities, [id]: records },
            })
          }
        />
      </details>
    </section>
  );
}
