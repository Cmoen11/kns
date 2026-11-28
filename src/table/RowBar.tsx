// The row action bar (docs/frontend.md §17): ONE floating bar for the row under the pointer,
// at the right edge of the visible table. The Grid drives it from its delegated mouseover; rows
// carry no buttons, listeners or state. A button moves the cursor to the bar's row, then runs its
// action through the engine. Hidden while rows are marked: the bulk bar owns the actions then.
import { useCallback, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { ActionButton, actionState, Icon, keepFocus, menuAnchor, openMenu, tip } from "../foundation";
import type { PaneId } from "../types";
import type { TableModel } from "./model";
import { ROW_ACTIONS, rowBarMax, rowMenu } from "./pointer";

export interface RowBarHandle {
  show(index: number, uid: string): void;
  hide(): void;
}

export interface RowBarProps {
  model: TableModel;
  pane: PaneId;
  /** width of the visible table (CSS px): the rail sticks to it while the rows scroll sideways */
  width: number;
  rowH: number;
  ref: Ref<RowBarHandle>;
}

export function RowBar({ model, pane, width, rowH, ref }: RowBarProps) {
  const [at, setAt] = useState<{ index: number; uid: string } | null>(null);
  const uid = useRef("");
  const el = useRef<HTMLDivElement>(null);
  // The bar follows the pointer in the same frame as the row's hover look: a mounted bar is moved
  // (and hidden) in the DOM at once, the state follows one render later. Without this the bar
  // sits on the row the pointer just left for a frame.
  useImperativeHandle(
    ref,
    () => ({
      show: (index, id) => {
        const bar = el.current;
        if (bar) {
          uid.current = id;
          bar.style.top = `${index * rowH}px`;
          bar.style.visibility = "";
          bar.setAttribute("data-index", String(index));
          bar.toggleAttribute("data-cursor", model.cursorUid === id);
        }
        setAt((p) => (p && p.index === index && p.uid === id ? p : { index, uid: id }));
      },
      hide: () => {
        if (el.current) el.current.style.visibility = "hidden";
        setAt((p) => (p === null ? p : null));
      },
    }),
    [model, rowH],
  );
  // the same function for every row, so the memoized buttons never re-render on a hover
  const before = useCallback(() => {
    model.point(uid.current);
  }, [model]);

  // which actions: by the pane's scopes, once per hovered row, not on every Grid render (live
  // data, the 1s age tick). Each button still follows its own action state. `cursor` is a
  // dependency because a `when` may read the cursor row.
  const cursor = model.cursorUid;
  const shown = useMemo(
    () => (at ? ROW_ACTIONS.filter((a) => actionState(a.action, { pane }).present).slice(0, rowBarMax(width)) : []),
    [at, pane, width, cursor],
  );

  // live data moved another row under the pointer, or rows got marked: no bar
  // (marks the filter hides do not count: the same rule as the bulk bar and the selection store)
  if (!at || model.uidAt(at.index) !== at.uid || model.markedRefs().length > 0) return null;
  uid.current = at.uid;

  return (
    <div className="tbl-rail" style={{ width }}>
      <div
        ref={el}
        className="tbl-rowbar"
        role="toolbar"
        aria-label="Row actions"
        data-index={at.index}
        data-cursor={model.cursorUid === at.uid || undefined}
        style={{ top: at.index * rowH }}
      >
        {shown.map((a) => (
          <ActionButton key={a.action} action={a.action} icon={a.icon} before={before} />
        ))}
        <button
          type="button"
          className="k-abtn"
          tabIndex={-1}
          {...tip("More actions", { reason: "also on a right-click of the row" })}
          aria-label="More actions"
          aria-haspopup="menu"
          onMouseDown={keepFocus}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            // the row the bar is on now (it may have moved since this render)
            const row = model.display?.rows.get(uid.current);
            const ns = model.src.namespaceColumn ? (row?.namespace ?? null) : null;
            if (model.point(uid.current)) openMenu({ at: menuAnchor(e.currentTarget), items: rowMenu(ns, pane), pane });
          }}
        >
          <Icon name="more" />
        </button>
      </div>
    </div>
  );
}
