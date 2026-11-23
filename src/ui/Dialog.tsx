// Dialog (docs/ux.md §11.7): 400 wide overlay with frame and scrim, focus trapped, focus returned
// to the opener. Its keys are the registry's dialog.* actions (src/ui/actions.ts), not listeners.
import { useEffect, useId, useRef, type ReactNode } from "react";
import { LAYERS } from "../actions";
import { engine } from "../keys";
import { Button } from "./Button";
import { Glyph, type GlyphState } from "./Glyph";

export interface DialogProps {
  title: string;
  /** status glyph before the title (tier 3 only) */
  glyph?: GlyphState;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** the primary is disabled and Enter does nothing (type-to-confirm not matched yet) */
  confirmDisabled?: boolean;
  /** shown to assistive tech and in the blocked message while confirm is disabled */
  confirmDisabledReason?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

interface OpenDialog {
  el: HTMLElement | null;
  props: DialogProps;
}

const stack: OpenDialog[] = [];

/** The dialog that owns the keys right now. Used by the dialog.* handlers. */
export function topDialog(): OpenDialog | undefined {
  return stack[stack.length - 1];
}

const FOCUSABLE = 'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

const NOT_TEXT = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "image", "hidden"]);

/**
 * Keyboard focus on a dialog control. A text field gets its content selected, as a native dialog
 * does: typing replaces the value. Only for focus moved by a key (Tab, the dialog opening), never
 * for a click, which places the caret.
 */
export function focusField(el: HTMLElement): void {
  el.focus();
  if (el instanceof HTMLInputElement && !NOT_TEXT.has(el.type) && el.value !== "") el.select();
}

/** Tab stops of a dialog: a radio group counts once (its checked option). */
export function dialogTabStops(el: HTMLElement): HTMLElement[] {
  const seen = new Set<string>();
  const out: HTMLElement[] = [];
  for (const n of el.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (n instanceof HTMLInputElement && n.type === "radio") {
      if (seen.has(n.name)) continue;
      seen.add(n.name);
      out.push(el.querySelector<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(n.name)}"]:checked`) ?? n);
    } else out.push(n);
  }
  return out;
}

export function Dialog(props: DialogProps) {
  const { title, glyph, children, confirmLabel = "Confirm", cancelLabel = "Cancel", confirmDisabled, onConfirm, onCancel } = props;
  const ref = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const entry = useRef<OpenDialog>({ el: null, props });
  entry.current.props = props;
  const titleId = useId();

  useEffect(() => {
    const me = entry.current;
    me.el = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stack.push(me);
    const pop = engine.pushScope(LAYERS.dialog);
    // focus starts in the text field if there is one, else on the primary
    const field = ref.current?.querySelector<HTMLElement>('input[type="text"]:not([disabled]), textarea:not([disabled])');
    const first = field ?? primary.current ?? ref.current;
    if (first) focusField(first);
    return () => {
      pop();
      const i = stack.indexOf(me);
      if (i >= 0) stack.splice(i, 1);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div
      className="k-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div ref={ref} className="k-dialog k-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h2 id={titleId} className="k-dialog-title t-dialog-title">
          {glyph && <Glyph state={glyph} />}
          {title}
        </h2>
        {children && <div className="k-dialog-body t-body">{children}</div>}
        <div className="k-dialog-footer">
          <Button variant="tertiary" action="dialog.cancel" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button ref={primary} variant="primary" action="dialog.confirm" disabled={confirmDisabled} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface Fact {
  label: string;
  /** untrusted cluster text, rendered as text */
  value: string;
}

/** Fact block: kind, name, namespace and context in mono on --k-bg-input (§11.7, §14). */
export function Facts({ facts }: { facts: readonly Fact[] }) {
  return (
    <dl className="k-facts t-mono selectable">
      {facts.map((f) => (
        <div key={f.label} style={{ display: "contents" }}>
          <dt>{f.label}</dt>
          <dd>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}
