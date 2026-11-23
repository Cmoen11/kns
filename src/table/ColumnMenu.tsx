// Column menu (docs/ux.md §12.2 overrides, Ctrl/⌘+Shift+M): hide, pin, reorder, fit and width
// per column, stored per kind. A small in-pane overlay; every key is a `columns.*` action.
import { useEffect, useRef } from "react";
import { LAYERS, runAction, useScopeLayer, type ActionId } from "../foundation";
import type { ScopeLayer } from "../actions/scopes";
import type { ColumnPrefs } from "../types";
import { Hint } from "../ui";
import type { Display, TableModel } from "./model";

// `columns` carries the menu keys (Esc / Enter = columns.close). Chords pass below, so
// Ctrl/⌘+Shift+M toggles it shut as well.
const COLUMNS_LAYER: ScopeLayer = LAYERS.columns;

export function ColumnMenu({ model, display, prefs }: { model: TableModel; display: Display; prefs: ColumnPrefs }) {
  useScopeLayer(COLUMNS_LAYER);
  const list = useRef<HTMLDivElement>(null);
  const shown = new Map(display.fit.cols.map((c) => [c.spec.id, c]));
  const index = model.menuIndex;
  // every hint is its action, run through the engine for this pane (the keys do the same)
  const run = (id: ActionId) => () => void runAction(id, { pane: model.pane });

  useEffect(() => {
    list.current?.querySelector('[data-focus="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <div className="tbl-colmenu k-overlay" role="dialog" aria-label="Columns">
      <div className="tbl-colmenu-title t-label">Columns</div>
      <div className="tbl-colmenu-list" role="listbox" ref={list}>
        {display.specs.map((s, i) => {
          const hidden = s.role !== "name" && prefs.hidden.includes(s.id);
          const pinned = prefs.pinned.includes(s.id);
          const col = shown.get(s.id);
          const width = prefs.widths[s.id];
          const state = hidden ? "hidden" : col ? (col.glyphOnly ? "glyph" : "") : s.tier >= 5 && !pinned ? "wide" : "no room";
          return (
            <div
              key={s.id}
              className="row tbl-colmenu-row t-row"
              role="option"
              aria-selected={i === index}
              data-focus={i === index || undefined}
              data-off={hidden || undefined}
              onClick={() => model.menuMove(i - model.menuIndex)}
            >
              {/* the checkbox: a click on it shows or hides the column; the rest of the row selects it */}
              <span
                className="tbl-gutter tbl-colmenu-check"
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation();
                  runAction("columns.toggle", { pane: model.pane, before: () => model.menuMove(i - model.menuIndex) });
                }}
              >
                <span className="tbl-check" data-on={!hidden || undefined} />
              </span>
              <span className="tbl-colmenu-name truncate">{s.title}</span>
              {pinned && <span className="t-label">PIN</span>}
              {state && <span className="tbl-colmenu-state t-ui">{state}</span>}
              {width !== undefined && <span className="tbl-colmenu-state t-ui num">{width}px</span>}
            </div>
          );
        })}
      </div>
      <div className="tbl-colmenu-hints">
        <Hint action="columns.toggle" label="show/hide" onClick={run("columns.toggle")} />
        <Hint action="columns.pin" label="pin" onClick={run("columns.pin")} />
        <Hint action="columns.reorderDown" label="down" onClick={run("columns.reorderDown")} />
        <Hint action="columns.reorderUp" label="up" onClick={run("columns.reorderUp")} />
        <Hint action="column.wider" label="wider" onClick={run("column.wider")} />
        <Hint action="column.narrower" label="narrower" onClick={run("column.narrower")} />
        <Hint action="columns.fit" label="fit" onClick={run("columns.fit")} />
        <Hint action="columns.reset" label="reset" onClick={run("columns.reset")} />
        <Hint action="columns.close" label="close" onClick={run("columns.close")} />
      </div>
    </div>
  );
}
