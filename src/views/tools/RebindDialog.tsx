// Rebinding one action (keymap.rebind, docs/ux.md §5.4). The next key pressed in the capture field
// becomes the binding. This is the one place a component reads a keydown itself: it captures a
// key to store, it does not act on one (docs/frontend.md §3). Keys the dialog owns (Enter, Esc,
// Tab, Space, arrows) cannot be captured here.
import { useState, type KeyboardEvent } from "react";
import { registry } from "../../actions";
import type { OverlayProps } from "../../foundation";
import { conflictsFor, isAssignable, keymap, normalizeEvent, platform } from "../../keys";
import { setKeymapOverride } from "../../store/settings";
import { Dialog, Facts, Field, KeyChip } from "../../ui";
import "./tools.css";

export interface RebindProps {
  id: string;
}

export default function RebindDialog({ props, close }: OverlayProps<RebindProps>) {
  const def = registry.get(props.id);
  const [chord, setChord] = useState<string | null>(null);
  if (!def) return null;

  const current = keymap.display(def.id, platform);
  const assignable = chord === null || isAssignable(chord, platform);
  const conflicts = chord && assignable ? conflictsFor(keymap, registry, def.id, [chord], platform) : [];
  const others = [...new Set(conflicts.map((c) => (c.a === def.id ? c.b : c.a)))].map((id) => registry.get(id)?.label ?? id);
  const ready = chord !== null && assignable;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const stroke = normalizeEvent(e.nativeEvent, platform);
    if (!stroke) return;
    e.preventDefault();
    setChord(stroke.chord);
  };
  const save = () => {
    if (!ready || chord === null) return;
    setKeymapOverride(def.id, { ...keymap.overrides()[def.id], [platform]: [[chord]] });
    close();
  };

  return (
    <Dialog
      title={`Rebind ${def.label}`}
      confirmLabel="Save"
      confirmDisabled={!ready}
      confirmDisabledReason={chord === null ? "press the new key first" : "that key is reserved"}
      onConfirm={save}
      onCancel={close}
    >
      <Facts facts={[{ label: "action", value: def.id }, { label: "scope", value: def.scope }]} />
      <div className="rebind-keys t-body">
        Now
        {current.length > 0 ? current.map((b, i) => <KeyChip key={i} binding={b} />) : <span>no key</span>}
      </div>
      {/* the value is display only: every key pressed here replaces it */}
      <Field label="Press the new key" value={chord ?? ""} onChange={() => {}} onKeyDown={onKeyDown} placeholder="waiting for a key" />
      {chord !== null && !assignable && (
        <p className="rebind-note t-ui-multi" data-kind="error">
          {chord} is reserved and cannot be assigned.
        </p>
      )}
      {others.length > 0 && (
        <p className="rebind-note t-ui-multi" data-kind="warn">
          Also bound to {others.join(", ")} in the same scope. Saving keeps both; the more specific scope wins.
        </p>
      )}
      <p className="rebind-note t-ui-multi">The new key replaces every key of this action on this platform. Enter, Esc, Tab, Space and arrows belong to this dialog and cannot be captured.</p>
    </Dialog>
  );
}
