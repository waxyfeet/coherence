import { Field, Picker } from "./ui";

export function OutputBudgetField({
  id,
  value,
  onChange,
  error,
  live,
}: {
  id: string;
  value: number;
  onChange: (value: number) => void;
  error?: string;
  live: boolean;
}) {
  const automatic = value === 0;
  return (
    <Field
      label="Maximum output tokens"
      htmlFor={automatic ? undefined : id}
      error={error}
    >
      <Picker
        label="Output budget mode"
        value={automatic ? "auto" : "custom"}
        onChange={(mode) => onChange(mode === "auto" ? 0 : 16384)}
        options={[
          {
            value: "auto",
            label: "Automatic — recommended",
            detail: "Fits requests and recovers within a bounded allowance",
          },
          {
            value: "custom",
            label: "Custom hard limit",
            detail: "Never automatically exceed your limit",
          },
        ]}
      />
      {!automatic && (
        <input
          id={id}
          type="number"
          min={256}
          max={1000000}
          value={Number.isFinite(value) ? value : ""}
          onChange={(event) => {
            const input = event.target.value.trim(),
              parsed = Number(input);
            // An empty/zero custom input stays invalid Custom; only the mode picker chooses Auto.
            onChange(input && parsed !== 0 ? parsed : NaN);
          }}
        />
      )}
      <p className="field-hint">
        {live
          ? automatic
            ? "Coherence uses available model information to size requests and recover oversized work. Your selected model and provider stay unchanged. Recovery can use extra API calls; this is not a monetary spending cap. Saving settings makes no AI request."
            : "Coherence respects your saved hard cap and may work in smaller pieces. Choose Automatic for model-aware sizing, or keep this limit deliberately. Recovery can use extra API calls."
          : "Illustrative per-response output limit; no model requests are made."}
      </p>
    </Field>
  );
}
