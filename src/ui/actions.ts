// Handlers for the actions the primitives own: dialog keys, toast dismiss and undo.
// Imported eagerly by main.tsx so the keys work before anything else loads.
import { registerActions } from "../actions";
import { dialogTabStops, focusField, topDialog } from "./Dialog";
import { toasts } from "./toast";

function moveFocus(dir: 1 | -1) {
  const el = topDialog()?.el;
  if (!el) return;
  const stops = dialogTabStops(el);
  if (stops.length === 0) return;
  const active = document.activeElement;
  let i = stops.findIndex((s) => s === active);
  // a focused unchecked radio belongs to its group's stop
  if (i < 0 && active instanceof HTMLInputElement && active.type === "radio") {
    i = stops.findIndex((s) => s instanceof HTMLInputElement && s.type === "radio" && s.name === active.name);
  }
  focusField(stops[(i + dir + stops.length) % stops.length]);
}

const focusedRadio = (): HTMLInputElement | null => {
  const a = document.activeElement;
  return a instanceof HTMLInputElement && a.type === "radio" && !!topDialog()?.el?.contains(a) ? a : null;
};
function moveRadio(dir: 1 | -1) {
  const r = focusedRadio();
  const el = topDialog()?.el;
  if (!r || !el) return;
  const group = [...el.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(r.name)}"]:not([disabled])`)];
  const next = group[(group.indexOf(r) + dir + group.length) % group.length];
  next.focus();
  next.click();
}
const focusedCheckbox = (): HTMLInputElement | null => {
  const a = document.activeElement;
  return a instanceof HTMLInputElement && a.type === "checkbox" ? a : null;
};

export const unregisterUiActions = registerActions({
  "dialog.confirm": {
    when: () => !!topDialog(),
    enabled: () => {
      const p = topDialog()?.props;
      return !p?.confirmDisabled || (p.confirmDisabledReason ?? "not ready to confirm");
    },
    run: () => topDialog()?.props.onConfirm(),
  },
  "dialog.cancel": { when: () => !!topDialog(), run: () => topDialog()?.props.onCancel() },
  "dialog.nextField": { when: () => !!topDialog(), run: () => moveFocus(1) },
  "dialog.previousField": { when: () => !!topDialog(), run: () => moveFocus(-1) },
  "dialog.radioUp": { when: () => !!focusedRadio(), run: () => moveRadio(-1) },
  "dialog.radioDown": { when: () => !!focusedRadio(), run: () => moveRadio(1) },
  "dialog.toggle": { when: () => !!focusedCheckbox(), run: () => focusedCheckbox()?.click() },
  "toast.dismiss": () => toasts.dismissAll(),
  // NORMAL only (scope 'pane'), while an undo toast is live; undoes the newest
  "undo.lastAction": { when: () => !!toasts.newestUndo(), run: () => void toasts.undoLast() },
});
