// The dev-set picker (`leader e` / `:dev`, docs/plan-features.md §2.7): Enter starts the set (on a
// running set: its devsets view), +Enter opens the devsets view beside, Mod+Shift+Backspace stops,
// F2 edits. Its keys are the list.* and picker.dev* actions (LAYERS.pickerDev), not listeners.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { LAYERS } from "../actions";
import { closeOverlay, focusedContext, openView, useScopeLayer, type OverlayProps } from "../foundation";
import { useOverlaySession, type NewPane } from "../palette/session";
import { ListBox, type ListRow } from "../palette/ui/ListBox";
import "../palette/palette.css";
import { setPickerSelection } from "./actions";
import { OVERLAY, startSet } from "./flows";
import { approved, originText } from "./model";
import { useDevSets, useRunningSetIds } from "./store";

export default function DevPicker(_: OverlayProps<unknown>) {
  useScopeLayer(LAYERS.pickerDev);
  const sets = useDevSets((s) => s.sets);
  const running = useRunningSetIds();
  const [text, setText] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const here = focusedContext();

  const shown = useMemo(() => {
    const q = text.trim().toLowerCase();
    return [...sets]
      .filter((s) => q === "" || s.name.includes(q) || s.context.toLowerCase().includes(q))
      .sort((a, b) => Number(b.context === here) - Number(a.context === here) || a.name.localeCompare(b.name));
  }, [sets, text, here]);
  const rows: ListRow[] = shown.map((s) => ({
    key: s.id,
    label: s.name,
    detail: `${s.context === here ? "" : `${s.context} · `}${s.forwards.length} forward${s.forwards.length === 1 ? "" : "s"} · ${originText(s)}`,
    tag: running.includes(s.id) ? "up" : approved(s) ? "" : "review",
    current: running.includes(s.id),
  }));
  const sel = Math.min(selected, Math.max(0, rows.length - 1));
  const selRef = useRef<string | undefined>(undefined);
  selRef.current = shown[sel]?.id;

  useEffect(() => {
    setPickerSelection(() => selRef.current);
    input.current?.focus({ preventScroll: true });
    return () => setPickerSelection(null);
  }, []);

  const close = () => closeOverlay(OVERLAY.picker);
  const accept = (i: number, newPane: NewPane) => {
    const s = shown[i];
    close();
    if (!s) return;
    if (newPane || running.includes(s.id)) openView({ kind: "devsets", selected: s.id }, { newPane: newPane ?? null });
    else void startSet(s);
  };
  useOverlaySession(LAYERS.pickerDev, {
    down: () => setSelected((i) => Math.min(rows.length - 1, i + 1)),
    up: () => setSelected((i) => Math.max(0, i - 1)),
    accept: (newPane) => accept(sel, newPane),
    close,
  });

  return (
    <div
      className="k-scrim pal-scrim"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        close();
      }}
    >
      <div className="pal k-overlay" data-size="picker" role="dialog" aria-label="Dev sets">
        <div className="pal-input-row">
          <label className="pal-input-label t-label" htmlFor={id}>
            DEV SETS
          </label>
          <div className="pal-input-wrap">
            <input
              ref={input}
              id={id}
              className="pal-input t-palette-input"
              type="text"
              spellCheck={false}
              autoComplete="off"
              role="combobox"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setSelected(0);
              }}
            />
          </div>
        </div>
        {rows.length > 0 ? (
          <div id={`${id}-list`}>
            <ListBox rows={rows} selected={sel} onPick={accept} onHover={setSelected} id={`${id}-row`} label="Dev sets" />
          </div>
        ) : (
          <div className="pal-empty t-row">{sets.length === 0 ? "No dev sets yet: E on a workload builds one" : "No set matches"}</div>
        )}
      </div>
    </div>
  );
}
