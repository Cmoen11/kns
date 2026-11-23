// Column header (docs/ux.md §11.3): sticky, click sorts, the sorted column shows an arrow, the
// selected column (Shift+←/→) a 2px accent underline, and each column has a 6px resize handle.
// Mouse parity (docs/frontend.md §17): a click selects the column and runs `sort.selectedColumn`,
// right-click or the hover caret opens the column's menu, and the gutter holds the mark-all box.
import { memo, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { actionTip, Icon, keepFocus, menuAnchor, openMenu, runAction, tip, useActionState, zoomFactor } from "../foundation";
import type { Sort } from "../types";
import { titleWidth, type FitCol } from "./columns";
import type { TableModel } from "./model";

/** narrower than this a column has no room for the menu caret (right-click still opens the menu) */
const CARET_MIN = 48;
/** viewport px the pointer must travel on a resize handle before the column's width changes */
const DRAG_MIN = 3;

export interface HeaderProps {
  model: TableModel;
  cols: readonly FitCol[];
  sort: Sort | null;
  selected: string | null;
  width: number;
  /** resource tables have the sort / column actions; the containers view sorts only */
  kind: "table" | "containers";
  wide: boolean;
  /** rows can be marked: the gutter shows the mark-all box */
  marks: boolean;
  /** 0 none marked, 1 some, 2 every row */
  marked: 0 | 1 | 2;
}

export const Header = memo(function Header({ model, cols, sort, selected, width, kind, wide, marks, marked }: HeaderProps) {
  const pane = model.pane;
  const sortState = useActionState("sort.selectedColumn", { pane });
  const allState = useActionState(marked > 0 ? "mark.clear" : "mark.all", { pane });
  const actions = kind === "table";

  const startResize = (e: ReactPointerEvent<HTMLSpanElement>, col: FitCol) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    const x0 = e.clientX;
    const w0 = col.width;
    handle.setPointerCapture(e.pointerId);
    let frame = 0;
    let last = x0;
    let active = false;
    const move = (ev: PointerEvent) => {
      last = ev.clientX;
      // a press on the handle that barely moves is not a resize: it must not pin the width
      if (!active) {
        if (Math.abs(last - x0) < DRAG_MIN) return;
        active = true;
        handle.setAttribute("data-active", "");
      }
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        // pointer coordinates are viewport px; widths are CSS px
        model.setColumnWidth(col.spec.id, w0 + (last - x0) / zoomFactor());
      });
    };
    const up = () => {
      handle.removeAttribute("data-active");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  // a click sorts by that column; the same column again reverses
  const sortBy = (id: string) => {
    if (actions) runAction("sort.selectedColumn", { pane, before: () => model.pointColumn(id) });
    else model.sortBy({ column: id });
  };
  // the column's menu: the column becomes the selected one first, so the rows act on it
  const menu = (e: ReactMouseEvent, col: FitCol, at: { x: number; y: number }) => {
    if (!actions) return;
    e.preventDefault();
    e.stopPropagation();
    const id = col.spec.id;
    model.pointColumn(id);
    const sorted = sort?.column === id;
    openMenu({
      at,
      pane,
      items: [
        { action: "sort.selectedColumn", label: sorted ? (sort.desc ? "sort ascending" : "sort descending") : "sort by this column" },
        "column.hide",
        "column.wider",
        "column.narrower",
        { action: "view.wide", label: wide ? "fewer columns" : "wide: more columns" },
        "view.columns",
      ],
    });
  };

  return (
    <div className="tbl-head" role="row" aria-rowindex={1} style={{ width }}>
      {marks ? (
        <button
          type="button"
          className="tbl-gutter tbl-checkall"
          tabIndex={-1}
          {...actionTip(marked > 0 ? "mark.clear" : "mark.all", marked > 0 ? "clear marks" : "mark all", allState.reason)}
          aria-label={marked > 0 ? "Clear marks" : "Mark all"}
          data-marked={marked || undefined}
          onMouseDown={keepFocus}
          onClick={() => runAction(marked > 0 ? "mark.clear" : "mark.all", { pane })}
        >
          <span className="tbl-check" />
        </button>
      ) : (
        <span className="tbl-gutter" aria-hidden="true" />
      )}
      {cols.map((c) => {
        const s = c.spec;
        const sorted = sort?.column === s.id;
        const title = c.glyphOnly ? "" : s.short && c.width < titleWidth(s.title) ? s.short : s.title;
        return (
          <div
            key={s.id}
            className={s.numeric ? "tbl-hcell t-colhead num" : "tbl-hcell t-colhead"}
            role="columnheader"
            aria-sort={sorted ? (sort.desc ? "descending" : "ascending") : "none"}
            aria-label={s.title}
            // the full title (the header may show the short one) and the sort key; slow: the pointer crosses headers on its way to the toolbar
            {...tip(`Sort by ${s.title}`, { action: sortState.present ? "sort.selectedColumn" : undefined, reason: sortState.reason, delay: 600 })}
            data-sorted={sorted || undefined}
            data-selected={selected === s.id || undefined}
            style={{ width: c.width }}
            onClick={() => sortBy(s.id)}
            onContextMenu={(e) => menu(e, c, { x: e.clientX, y: e.clientY })}
          >
            <span className="truncate">{title}</span>
            {sorted && !c.glyphOnly && <Icon name={sort.desc ? "sort-desc" : "sort-asc"} />}
            {actions && c.width >= CARET_MIN && (
              <button
                type="button"
                className="k-abtn tbl-hmenu"
                tabIndex={-1}
                {...tip("Column menu", { reason: "sort, hide, width" })}
                aria-label={`${s.title}: column menu`}
                aria-haspopup="menu"
                onMouseDown={keepFocus}
                onClick={(e) => menu(e, c, menuAnchor(e.currentTarget))}
              >
                <Icon name="caret" />
              </button>
            )}
            {!c.glyphOnly && (
              <span
                className="tbl-resize"
                {...tip("Drag to resize", { reason: "double-click fits the content", delay: 1200 })}
                onPointerDown={(e) => startResize(e, c)}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={() => model.fitColumn(s.id)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
});
