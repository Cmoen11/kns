// The context menu (docs/ux.md §11.10): the list component, 240 wide, holding actions with their
// key chips. Opened by menu.open: from the keyboard at the focused pane with the actions of the
// hint row; from the pointer (openMenu in src/ui/menu.ts) at the click, optionally with the
// caller's own list of actions (a toolbar's overflow, the pane menu, a row menu).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LAYERS } from "../actions";
import { zoomFactor, type ActionId, type OverlayProps } from "../foundation";
import { runAction, type MenuRequest } from "../ui";
import { currentSnapshot, dismiss, runFromSnapshot, useOverlaySession, type ListController, type NewPane } from "./session";
import { first, ListBox, step, type ListRow } from "./ui/ListBox";
import "./palette.css";

interface Entry {
  row: ListRow;
  opens: boolean;
  run(newPane: NewPane): void;
}

/** rows before the menu scrolls: what the window has room for (maxHeight below), never an arbitrary 14 */
const MAX_ROWS = 40;
/** px kept free above and below the menu */
const EDGE = 4;

export default function Menu({ props }: OverlayProps<MenuRequest | null | undefined>) {
  const snapshot = currentSnapshot();
  const entries = useMemo<Entry[]>(() => {
    if (props?.rows) {
      // resolved by openMenu before this overlay's layer took the keys (it hides every other
      // layer). A menu of the window chrome (no pane) acts on the focused pane and leaves the
      // DOM focus where it is: a side panel's actions read it.
      const pane = props.pane ?? null;
      return props.rows.map((r, i) =>
        r.separator
          ? { row: { key: `sep:${i}`, label: "", group: true, separator: true }, opens: false, run: () => {} }
          : {
              row: { key: `${r.action}:${i}`, label: r.label, bindings: r.bindings, disabled: !r.enabled, reason: r.reason },
              opens: r.opens,
              run: (newPane) => void runAction(r.action, { pane, args: r.args, before: r.before, newPane, source: "menu" }),
            },
      );
    }
    return snapshot.hints.map((h) => ({
      row: { key: h.action.id, label: h.action.label, bindings: h.bindings },
      opens: h.action.opens === "view",
      run: (newPane) => void runFromSnapshot(h.action.id as ActionId, { source: "menu", newPane }),
    }));
  }, [snapshot, props]);
  const rows = useMemo(() => entries.map((e) => e.row), [entries]);
  const [sel, setSel] = useState(() => first(rows));
  const box = useRef<HTMLDivElement>(null);
  // what the window has room for (the scrim covers it; CSS px): a long row menu shows whole on a
  // normal window and scrolls only on a short one. The 8px are the menu's margin and frame.
  const [room] = useState(() => window.innerHeight / zoomFactor() - 2 * EDGE - 8);

  // at the pointer when the click said where, else at the focused pane's top-left corner under
  // its header. Viewport px are divided by the zoom; the menu is kept inside the window.
  const [at, setAt] = useState(() => {
    const z = zoomFactor();
    if (props?.at) return { left: props.at.x / z, top: props.at.y / z, margin: 0 };
    const r = document.querySelector(".pane[data-focused] > .pane-body")?.getBoundingClientRect();
    return r ? { left: r.left / z, top: r.top / z } : { left: 0, top: 0 };
  });
  useLayoutEffect(() => {
    const el = box.current;
    const scrim = el?.parentElement;
    if (!el || !scrim || !props?.at) return;
    const maxLeft = scrim.clientWidth - el.offsetWidth - EDGE;
    const maxTop = scrim.clientHeight - el.offsetHeight - EDGE;
    setAt((p) => {
      const left = Math.max(0, Math.min(p.left, maxLeft));
      const top = Math.max(0, Math.min(p.top, maxTop));
      return left === p.left && top === p.top ? p : { ...p, left, top };
    });
  }, [props]);

  useEffect(() => box.current?.focus({ preventScroll: true }), []);

  // Closed without a pick, however it closed (Esc, a click outside, another overlay opening over
  // it, Shift+F10 again): the opener may undo what opening changed (a table's dropped marks).
  // Reported once, when the menu is gone; the microtask tells a real unmount from StrictMode's
  // simulated one.
  const done = useRef(false);
  const mounted = useRef(false);
  const onCancel = props?.onCancel;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (mounted.current || done.current) return;
        done.current = true;
        onCancel?.();
      });
    };
  }, [onCancel]);

  const run = (i: number, newPane: NewPane) => {
    const e = entries[i];
    if (!e || e.row.disabled || e.row.group) return;
    done.current = true;
    dismiss();
    e.run(e.opens ? newPane : null);
  };
  const cancel = () => {
    if (!done.current) {
      done.current = true;
      props?.onCancel?.();
    }
    dismiss();
  };
  const controller: ListController = {
    down: () => setSel((s) => step(rows, s, 1)),
    up: () => setSel((s) => step(rows, s, -1)),
    accept: (newPane) => run(sel, newPane),
    close: cancel,
  };
  useOverlaySession(LAYERS.menu, controller);

  return (
    <div
      className="pal-menu-scrim"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // focus goes back to the opener; the click itself must not move it to <body>
        e.preventDefault();
        cancel();
      }}
      onContextMenu={(e) => {
        // a right-click outside the menu closes it, like a click
        e.preventDefault();
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div ref={box} className="pal pal-menu k-overlay" role="menu" aria-label="Actions" tabIndex={-1} style={at}>
        {rows.length > 0 ? <ListBox rows={rows} selected={sel} onPick={run} onHover={setSel} id="pal-menu" label="Actions" maxRows={MAX_ROWS} maxHeight={room} /> : <div className="pal-empty t-row">No actions here</div>}
      </div>
    </div>
  );
}
