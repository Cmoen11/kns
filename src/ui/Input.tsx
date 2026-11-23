// Inputs (docs/ux.md §11.5). Keys inside an input are still registry actions: the owner pushes a
// scope layer (LAYERS.filterInput, LAYERS.command ...) while the input has focus.
import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from "react";
import { Glyph } from "./Glyph";

type NativeInput = Omit<InputHTMLAttributes<HTMLInputElement>, "children">;

const TEXT_PROPS = { type: "text", spellCheck: false, autoComplete: "off", autoCorrect: "off", autoCapitalize: "off" } as const;

export interface BarInputProps extends NativeInput {
  /** Etikett to the left of the field: FILTER, SEARCH, COMMAND */
  label: string;
  /** the mode chip, between the label and the field */
  chip?: ReactNode;
  /** shown at the right with the error glyph; the frame keeps its colour */
  error?: string;
  ref?: Ref<HTMLInputElement>;
}

/** The 20px bar input that fills a pane header (filter, search, command). */
export function BarInput({ label, chip, error, className, ref, ...rest }: BarInputProps) {
  const id = useId();
  return (
    <div className={className ? `k-bar ${className}` : "k-bar"} data-disabled={rest.disabled || undefined}>
      <label className="k-bar-label t-label" htmlFor={id}>
        {label}
      </label>
      {chip}
      <div className="k-bar-field">
        <input {...TEXT_PROPS} {...rest} ref={ref} id={id} className="t-input" aria-invalid={error ? true : undefined} />
      </div>
      {error && (
        <span className="k-bar-error t-ui" role="alert">
          <Glyph state="error" />
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Text the user has to type exactly, inside a label: mono and as written. A label is upper case
 * (Etikett), which would hide the case of a resource name.
 *
 *   <Field label={<>Type <Literal>{name}</Literal> to confirm</>} />
 */
export function Literal({ children }: { children: ReactNode }) {
  return <span className="k-literal t-mono">{children}</span>;
}

export interface FieldProps extends NativeInput {
  /** Etikett above the field; wrap text to type in <Literal> */
  label: ReactNode;
  /** shown below with the error glyph */
  error?: string;
  ref?: Ref<HTMLInputElement>;
}

/** The 32px dialog field with its label above. */
export function Field({ label, error, className, ref, ...rest }: FieldProps) {
  const id = useId();
  return (
    <div className={className ? `k-field ${className}` : "k-field"} data-disabled={rest.disabled || undefined}>
      <label className="k-field-label t-label" htmlFor={id}>
        {label}
      </label>
      <div className="k-field-box">
        <input {...TEXT_PROPS} {...rest} ref={ref} id={id} className="t-input" aria-invalid={error ? true : undefined} />
      </div>
      {error && (
        <span className="k-field-error t-ui-multi" role="alert">
          <Glyph state="error" />
          {error}
        </span>
      )}
    </div>
  );
}

export interface CheckboxProps extends Omit<NativeInput, "type"> {
  label: string;
}

/** The checkbox: a square that fills. Space toggles it (dialog.toggle). */
export function Checkbox({ label, ...rest }: CheckboxProps) {
  return (
    <label className="k-check t-body">
      <input type="checkbox" {...rest} />
      {label}
    </label>
  );
}

export interface RadioGroupProps<T extends string> {
  legend: string;
  name: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}

/** A radio group: one Tab stop; arrows move the choice (dialog.radioUp / radioDown). */
export function RadioGroup<T extends string>({ legend, name, value, options, onChange }: RadioGroupProps<T>) {
  return (
    <fieldset className="k-radio-group" role="radiogroup">
      <legend className="t-label">{legend}</legend>
      {options.map((o) => (
        <label className="k-radio t-body" key={o.value}>
          <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}
