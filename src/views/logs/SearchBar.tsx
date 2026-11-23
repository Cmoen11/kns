// The search input in the pane header (docs/ux.md §6.3, §11.5). Its keys are registry actions in
// the search.input layer (filter.apply / cancel / cycleMode, logs.filterLines); the layer is only
// pushed while the input has focus, so a click elsewhere gives the pane its single keys back.
import { useEffect, useRef, useState } from "react";
import { LAYERS, useScopeLayer } from "../../foundation";
import { actionTip, BarInput, FilterChip } from "../../ui";
import { MODE_LABEL, nextMode } from "./match";
import type { LogSession } from "./session";

export function SearchBar({ session: s }: { session: LogSession }) {
  const input = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);
  useScopeLayer(LAYERS.searchInput, active);

  // `/` focuses the input, also when the bar is already open
  useEffect(() => {
    input.current?.focus();
  }, [s.focusTick]);

  // closing the bar removes the focused input: give the focus back to the pane
  useEffect(() => {
    const pane = input.current?.closest<HTMLElement>(".pane");
    return () => {
      const a = document.activeElement;
      if (pane?.isConnected && (!a || a === document.body)) pane.focus({ preventScroll: true });
    };
  }, []);

  return (
    <BarInput
      ref={input}
      className="logs-search"
      label="Search"
      aria-label="Search log lines"
      chip={
        <span className="logs-mode" {...actionTip("filter.cycleMode", "Search mode")} onMouseDown={(e) => e.preventDefault()} onClick={() => s.setDraft({ mode: nextMode(s.draft.mode) })}>
          <FilterChip mode={MODE_LABEL[s.draft.mode]} />
        </span>
      }
      value={s.draft.text}
      onChange={(e) => s.setDraft({ text: e.target.value })}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      error={s.matcher?.error}
    />
  );
}
