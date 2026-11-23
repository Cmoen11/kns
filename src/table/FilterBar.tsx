// The `/` filter input (docs/ux.md §6.3): lives in the pane header while editing. Its keys are
// registry actions in the filter.input scope (Enter, Esc, Tab, Ctrl+U, ←/→/Backspace on chips).
import { useEffect, useRef } from "react";
import { LAYERS, useScopeLayer } from "../foundation";
import type { Filter } from "../types";
import { BarInput, FilterChip } from "../ui";
import { chipOf, detectMode, MODE_LABEL } from "./filter";
import type { TableModel } from "./model";

export function FilterBar({ model, filters }: { model: TableModel; filters: readonly Filter[] }) {
  useScopeLayer(LAYERS.filterInput);
  const input = useRef<HTMLInputElement>(null);
  const f = model.filter;

  useEffect(() => {
    const el = input.current;
    const pane = el?.closest<HTMLElement>(".pane") ?? null;
    el?.focus();
    return () => {
      // the input is gone: hand DOM focus back to the pane so single keys work again
      const a = document.activeElement;
      if (pane?.isConnected && (!a || a === document.body)) pane.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div className="tbl-filterbar">
      {filters.map((x, i) => {
        const c = chipOf(x);
        return <FilterChip key={`${c.mode}:${c.value}`} mode={c.mode} value={c.value} focused={f.chip === i} onRemove={() => model.removeChip(i)} />;
      })}
      <BarInput
        ref={input}
        label="Filter"
        chip={<FilterChip mode={MODE_LABEL[detectMode(f.text, f.mode).mode]} />}
        value={f.text}
        error={f.error}
        aria-label="Filter rows"
        onChange={(e) => model.setFilterText(e.currentTarget.value)}
        onBlur={() => {
          // clicking elsewhere leaves the input (like Esc); switching windows does not
          if (document.hasFocus()) model.cancelFilter();
        }}
      />
    </div>
  );
}
