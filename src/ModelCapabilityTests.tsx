import {
  Component,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LoaderCircle } from "lucide-react";
import type {
  Capability,
  CapabilityRecord,
  CapabilityTestResponse,
  StructuredTestMode,
} from "../shared/modelCapabilities";
import {
  capabilityRecords,
  evidenceLabel,
  modelEvidenceForConnection,
} from "../shared/modelCapabilities";
import { validModelId } from "../shared/modelSelection";
import { SessionAuthorization } from "./sessionAuthorization";
import type { Connection } from "./data";
import { Button } from "./ui";
import { catalogueIdentity } from "./connectionIdentity";

export const capabilityIdentity = (c: Connection) =>
  JSON.stringify([
    catalogueIdentity(c),
    c.vision,
    c.structured,
    c.effort,
    c.temperature,
    c.maxTokens,
    c.timeout,
  ]);
function displayEndpoint(value: string) {
  try {
    const u = new URL(value);
    return u.username || u.password || u.search || u.hash
      ? "Check the address: remove credentials and query parameters"
      : u.origin + u.pathname;
  } catch {
    return "Address not yet configured";
  }
}
export type CapabilityTester = (
  c: Connection,
  model: string,
  capability: Capability,
  mode?: StructuredTestMode,
  signal?: AbortSignal,
) => Promise<CapabilityTestResponse>;

/** A presentation failure in optional tests must never unmount the workbench editor. */
export class ModelTestBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <section className="model-tests" aria-label="Model capability tests">
        <p role="alert">
          Model test details could not be displayed. Change the model or reopen
          Settings to try again. Your workspace remains open.
        </p>
      </section>
    ) : (
      this.props.children
    );
  }
}
type ModelTestProps = {
  connection: Connection;
  modelId: string;
  onTest: CapabilityTester;
  onEvidence: (model: string, records: CapabilityRecord[]) => void;
};
export function ModelCapabilityTests(props: ModelTestProps) {
  return (
    <ModelTestBoundary
      key={capabilityIdentity(props.connection) + ":" + props.modelId}
    >
      <ModelCapabilityPanel {...props} />
    </ModelTestBoundary>
  );
}
function ModelCapabilityPanel({
  connection,
  modelId,
  onTest,
  onEvidence,
}: ModelTestProps) {
  const authorized = useContext(SessionAuthorization);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const pending = useRef<AbortController | null>(null),
    sequence = useRef(0);
  const activeTest = useRef<{
    capability: Capability;
    mode?: StructuredTestMode;
  } | null>(null);
  const identity = capabilityIdentity(connection) + ":" + modelId;
  useEffect(() => {
    sequence.current++;
    pending.current?.abort();
    setBusy(false);
    setMessage("");
    return () => {
      sequence.current++;
      pending.current?.abort();
    };
  }, [identity, authorized]);
  const evidence = modelEvidenceForConnection(connection, modelId);
  async function run(capability: Capability, mode?: StructuredTestMode) {
    activeTest.current = { capability, mode };
    const seq = ++sequence.current,
      controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage("Testing the exact selected model…");
    try {
      const result = await onTest(
        connection,
        modelId,
        capability,
        mode,
        controller.signal,
      );
      if (seq !== sequence.current || controller.signal.aborted) return;
      onEvidence(modelId, result.records ?? [result.record]);
      setMessage(result.message);
    } catch {
      if (seq === sequence.current && !controller.signal.aborted)
        setMessage(
          "The test could not be completed. Check the connection or reconnect your local session and try again. No successful verification was recorded.",
        );
    } finally {
      if (seq === sequence.current) {
        setBusy(false);
        pending.current = null;
      }
    }
  }
  const disabled = busy || !authorized || !validModelId(modelId);
  return (
    <section className="model-tests" aria-label="Model capability tests">
      <h4>What this model can do</h4>
      <p className="field-hint">
        A listed or saved model is not a tested model. Tests contact this exact
        endpoint and model and may incur API charges. Only synthetic content is
        sent. Results expire after seven days and changes to credentials,
        address or request settings require another test.
      </p>
      {!modelId && (
        <p className="field-hint">
          Enter an exact model ID above to inspect or test it.
        </p>
      )}
      <dl className="capability-evidence">
        {[
          ["Text generation", evidence.text],
          ["Image understanding", evidence.image],
          ["Native structured output", evidence.nativeStructured],
          ["Prompt and validate", evidence.promptStructured],
          ["Reasoning control", evidence.reasoning],
          ["Sampling control", evidence.sampling],
        ].map(([label, item]) => (
          <div key={String(label)}>
            <dt>{String(label)}</dt>
            <dd>
              {evidenceLabel(item as typeof evidence.text)}
              {(item as typeof evidence.text).at && (
                <small>
                  {new Date(
                    (item as typeof evidence.text).at!,
                  ).toLocaleString()}
                </small>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {evidence.contextWindow && (
        <p className="field-hint">
          Provider-reported context: {evidence.contextWindow.toLocaleString()}{" "}
          tokens. Not a tested limit.
        </p>
      )}
      <p className="field-hint">
        Destination: {connection.name} · {displayEndpoint(connection.endpoint)}{" "}
        · {modelId || "Choose a model"}. Save an account and its model first to
        retain test results. A passed request is a small compatibility check,
        not a full-workflow qualification or quality guarantee. Tested controls
        mean this request accepted the selected value.
      </p>
      <div className="model-test-actions">
        <Button compact disabled={disabled} onClick={() => void run("text")}>
          Test text model
        </Button>
        <Button compact disabled={disabled} onClick={() => void run("image")}>
          Test image understanding
        </Button>
        <Button
          compact
          disabled={disabled}
          onClick={() => void run("structured", "native")}
        >
          Test native structured output
        </Button>
        <Button
          compact
          disabled={disabled}
          onClick={() => void run("structured", "prompt")}
        >
          Test prompt and validate
        </Button>
        {connection.provider === "ollama" && (
          <Button
            compact
            disabled={disabled}
            onClick={() => void run("metadata")}
          >
            Read model info (no inference)
          </Button>
        )}
        {busy && (
          <Button
            compact
            onClick={() => {
              sequence.current++;
              pending.current?.abort();
              setBusy(false);
              const attempt = activeTest.current;
              if (attempt)
                onEvidence(modelId, [
                  {
                    ...attempt,
                    at: new Date().toISOString(),
                    state: "unknown",
                    outcome: "cancelled",
                    reason: "cancelled",
                  },
                  ...capabilityRecords(connection.capabilities, modelId).filter(
                    (r) =>
                      r.capability !== attempt.capability ||
                      r.mode !== attempt.mode,
                  ),
                ]);
              setMessage("Test cancelled. This attempt was not verified.");
            }}
          >
            Cancel model test
          </Button>
        )}
      </div>
      <div role="status" className="model-test-status">
        {busy && <LoaderCircle size={14} className="spin" />}
        {message}
      </div>
    </section>
  );
}
