// The shared side-panel frame: a slim column beside the pane area that pushes the panes (the pane
// tree re-measures through its own ResizeObserver), resizable by its inner edge, with one flat,
// keyboard-driven row list. On a narrow window it overlays the panes and shows only while focused.
// Closed panels render nothing; the bodies are lazy chunks.
import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { ActionId } from "../actions";
import { engine } from "../keys";
import { zoomFactor } from "../store/appearance";
import { flash } from "../store/status";
import { NsBadge } from "../status/NsBadge";
import { actionTip, Glyph, Icon, keepFocus, Keys, openMenu, tip, type IconName } from "../ui";
import { ageText, clampWidth, DEFAULT_WIDTH, headerKey, type PanelRow, type Side } from "./model";
import {
  activateRow, hidePanel, noteReturn, panelFocusIn, panelFocusOut, panelRows, runtimeStore, setCursor, setPanelRows, setWidth, usePrefs, useRuntime,
  useShown, watchNarrow,
} from "./store";

const ContextSidebar = lazy(() => import("./ContextSidebar"));
const ActivityPanel = lazy(() => import("./ActivityPanel"));

const LABEL: Record<Side, string> = { left: "Context sidebar", right: "Activity panel" };

// ── resize handle on the inner edge ────────────────────────────────────────

function ResizeHandle({ side }: { side: Side }) {
  const drag = useRef<{ pointer: number; start: number; width: number; next: number; frame: number } | null>(null);
  const panel = (el: HTMLElement) => el.parentElement as HTMLElement;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      return;
    }
    e.currentTarget.dataset.drag = "";
    // offsetWidth is CSS px already (border included); pointer coordinates are divided by the zoom below
    const width = panel(e.currentTarget).offsetWidth;
    drag.current = { pointer: e.pointerId, start: e.clientX, width, next: width, frame: 0 };
  };
  const track = (d: { start: number; width: number; next: number }, x: number) => {
    const delta = (x - d.start) / zoomFactor();
    d.next = clampWidth(d.width + (side === "left" ? delta : -delta), side);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    track(d, e.clientX);
    const el = panel(e.currentTarget);
    // straight to the DOM, one write per frame; the store (and the save) get the width on drop
    if (!d.frame) {
      d.frame = requestAnimationFrame(() => {
        d.frame = 0;
        el.style.width = `${d.next}px`;
      });
    }
  };
  const finish = (e: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    if (d.frame) cancelAnimationFrame(d.frame);
    // the release point counts even when no move event came before it
    if (commit) track(d, e.clientX);
    drag.current = null;
    delete e.currentTarget.dataset.drag;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const el = panel(e.currentTarget);
    if (commit && d.next !== d.width) {
      el.style.width = `${d.next}px`;
      setWidth(side, d.next);
    } else el.style.width = `${d.width}px`;
  };

  return (
    <div
      className="side-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${LABEL[side].toLowerCase()}`}
      {...tip("Drag to resize", { reason: "double-click resets the width", delay: 1200 })}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, true)}
      onPointerCancel={(e) => finish(e, false)}
      onDoubleClick={() => setWidth(side, DEFAULT_WIDTH[side])}
    />
  );
}

// ── the frame ──────────────────────────────────────────────────────────────

export function SidePanel({ side }: { side: Side }) {
  const width = usePrefs((s) => s[side].width);
  const narrow = useRuntime((s) => s.narrow);
  const focused = useRuntime((s) => s.focused === side);
  const tick = useRuntime((s) => s.focusTick);
  const root = useRef<HTMLElement>(null);
  const handled = useRef(0);
  const visible = useShown(side);
  // two docked panels share what the panes can spare (sidepanels.css)
  const both = useShown(side === "left" ? "right" : "left") && !narrow;

  useEffect(watchNarrow, []);

  // a focus request (the focus key, or Esc out of the filter input): the panel element takes focus
  useEffect(() => {
    if (tick === handled.current || !visible || !root.current) return;
    if (runtimeStore.getState().active !== side) return;
    handled.current = tick;
    root.current.focus({ preventScroll: true });
  }, [tick, visible, side]);

  // unmounting with the focus inside fires no focusout: drop the scope by hand
  useEffect(() => {
    if (!visible) panelFocusOut(side, null);
  }, [visible, side]);
  useEffect(() => () => panelFocusOut(side, null), [side]);

  if (!visible) return null;
  return (
    <aside
      ref={root}
      className="side-panel"
      data-side={side}
      data-focused={focused || undefined}
      data-narrow={narrow || undefined}
      data-both={both || undefined}
      tabIndex={-1}
      aria-label={LABEL[side]}
      style={{ width }}
      onPointerDownCapture={noteReturn}
      onFocus={() => panelFocusIn(side)}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        // the window lost focus, not the panel: the element is still the active one
        if (!e.relatedTarget && !document.hasFocus()) return;
        panelFocusOut(side, e.relatedTarget as Element | null);
      }}
    >
      <Suspense fallback={null}>{side === "left" ? <ContextSidebar /> : <ActivityPanel />}</Suspense>
      <ResizeHandle side={side} />
    </aside>
  );
}

// ── pieces the two bodies share ────────────────────────────────────────────

/** The 20px title row: the panel's name, its toggle key and a close button for the pointer. */
export function PanelHeader({ side, title, toggle, children }: { side: Side; title: string; toggle: ActionId; children?: ReactNode }) {
  const hide = `Hide ${LABEL[side].toLowerCase()}`;
  return (
    <header className="side-header">
      <span className="side-title t-crumb truncate">{title}</span>
      {children}
      <span className="side-fill" />
      <Keys action={toggle} />
      {/* keepFocus: the focus stays where it is (a pane, or this panel, which hands it back when it hides) */}
      <button type="button" className="k-abtn side-close" tabIndex={-1} {...actionTip(toggle, hide)} aria-label={hide} onMouseDown={keepFocus} onClick={() => hidePanel(side)}>
        <Icon name="close" />
      </button>
    </header>
  );
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg className="side-chevron" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" focusable="false">
    <path d={open ? "M0 2H8L4 7Z" : "M2 0V8L7 4Z"} fill="currentColor" />
  </svg>
);

// ── ages: one 1s timer for every visible age, and only the text that changed re-renders ──

const ageSubs = new Set<() => void>();
let ageTimer: ReturnType<typeof setInterval> | null = null;
function subscribeAge(fn: () => void): () => void {
  ageSubs.add(fn);
  ageTimer ??= setInterval(() => {
    if (document.visibilityState !== "hidden") for (const f of ageSubs) f();
  }, 1000);
  return () => {
    ageSubs.delete(fn);
    if (ageSubs.size === 0 && ageTimer) {
      clearInterval(ageTimer);
      ageTimer = null;
    }
  };
}
function Age({ since }: { since: number }) {
  return useSyncExternalStore(subscribeAge, () => ageText(Date.now() - since));
}

type RowAction = "activity.openBrowser" | "activity.copyAddress" | "activity.stop" | "activity.stopAll" | "activity.clearFinished";

interface RowProps {
  side: Side;
  row: PanelRow;
  index: number;
  focus: boolean;
}

/**
 * A row button (mouse parity): runs the row's action through the engine, naming the row, so it
 * works while the keyboard focus is in a pane. It never takes the focus: a stopped row is removed,
 * and focus on a removed element is lost without a focusout. The mousedown still reaches the row,
 * which moves the cursor to it.
 */
function RowButton({ action, arg, icon }: { action: RowAction; arg: string; icon: IconName }) {
  // the registry's label and, when the tooltip opens, the live key ("stop  x")
  const props = actionTip(action);
  return (
    <button
      type="button"
      className="k-abtn side-act"
      tabIndex={-1}
      {...props}
      aria-label={props["data-tip"]}
      data-action={action}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        engine.run(action, { source: "pointer", args: [arg] });
      }}
    >
      <Icon name={icon} />
    </button>
  );
}

/**
 * Right-click on an activity row: the cursor moves to it, then a menu of what the row can do
 * (open = go to where it happened, copy, stop, clear the group). The same actions as the keys.
 */
function rowMenu(e: ReactMouseEvent, side: Side, index: number, row: PanelRow): void {
  e.preventDefault();
  setCursor(side, index);
  // only what this row can do (the keys stay the same for every row)
  const head = panelRows(side).find((r) => r.key === headerKey(row.section));
  const items: ActionId[] = [];
  if (row.activate) items.push("side.activate");
  if (row.copy) items.push("activity.copyAddress");
  if (row.open) items.push("activity.openBrowser");
  if (row.stop) items.push("activity.stop");
  const group: ActionId[] = [];
  if (head?.stopAll) group.push("activity.stopAll");
  if (head?.clearable) group.push("activity.clearFinished");
  if (items.length + group.length === 0) return;
  openMenu({ at: { x: e.clientX, y: e.clientY }, items: [...items, ...(items.length && group.length ? ["|" as const] : []), ...group] });
}

const Row = memo(function Row({ side, row, index, focus }: RowProps) {
  const click = () => {
    if (row.disabled && !row.header) return flash(row.disabled, "warn");
    void activateRow(side, row);
  };
  if (row.header) {
    return (
      <div className="side-row side-head t-label" role="option" aria-selected={focus} aria-expanded={!row.collapsed} data-key={row.key} data-focus={focus || undefined} onMouseDown={() => setCursor(side, index)} onClick={click}>
        <Chevron open={!row.collapsed} />
        <span className="side-label truncate">{row.label}</span>
        {row.count !== undefined && row.count > 0 && <span className="side-count t-ui num">{row.count}</span>}
        <span className="side-fill" />
        <span className="side-end">
          {row.trailing && <span className="side-trailing t-ui" {...tip(row.trailingTip, { plain: true })}>{row.trailing}</span>}
          {(row.stopAll || row.clearable) && (
            <span className="side-acts">
              {row.stopAll && <RowButton action="activity.stopAll" arg={row.section} icon="stop" />}
              {row.clearable && <RowButton action="activity.clearFinished" arg={row.section} icon="clear" />}
            </span>
          )}
        </span>
      </div>
    );
  }
  return (
    <div
      className="side-row t-cell"
      role="option"
      aria-selected={focus}
      aria-disabled={row.disabled ? true : undefined}
      {...tip(row.disabled)}
      data-key={row.key}
      data-focus={focus || undefined}
      data-current={row.current || undefined}
      data-disabled={row.disabled ? "" : undefined}
      data-two={row.detail !== undefined ? "" : undefined}
      data-tone={row.tone}
      onMouseDown={() => setCursor(side, index)}
      onClick={click}
      onContextMenu={side === "right" ? (e) => rowMenu(e, side, index, row) : undefined}
    >
      <span className="side-gutter" data-current={row.current || undefined}>
        {row.glyph && <Glyph state={row.glyph} />}
      </span>
      <span className="side-main">
        <span className="side-line">
          <span className="side-label truncate">{row.label}</span>
          {row.labels?.map((l) => (
            <span key={l} className="side-tag t-label">
              {l}
            </span>
          ))}
          <span className="side-fill" />
          {row.login && (
            <button
              type="button"
              className="side-login t-ui"
              tabIndex={-1}
              disabled={row.login.busy}
              {...tip(row.login.hint)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                void row.login?.run();
              }}
            >
              {row.login.busy ? "signing in…" : "sign in"}
            </button>
          )}
          {row.health !== undefined && <NsBadge ns={row.health} />}
          {/* age and buttons share one cell: the buttons replace the age on hover, nothing shifts */}
          <span className="side-end">
            {(row.since !== undefined || row.trailing) && (
              <span className="side-trailing t-ui num">{row.since !== undefined ? <Age since={row.since} /> : row.trailing}</span>
            )}
            {side === "right" && (row.open || row.copy || row.stop) && (
              <span className="side-acts">
                {row.open && <RowButton action="activity.openBrowser" arg={row.key} icon="external" />}
                {row.copy && <RowButton action="activity.copyAddress" arg={row.key} icon="copy" />}
                {row.stop && <RowButton action="activity.stop" arg={row.key} icon="stop" />}
              </span>
            )}
          </span>
        </span>
        {row.detail !== undefined && <span className="side-detail t-ui truncate">{row.detail}</span>}
      </span>
    </div>
  );
});

/**
 * The row list. Publishes the rows to the store (the actions read them) and keeps the cursor row
 * in view. `empty` shows when there is not a single row.
 */
export function Rows({ side, rows, label, empty }: { side: Side; rows: readonly PanelRow[]; label: string; empty?: ReactNode }) {
  const cursor = useRuntime((s) => s.cursor[side]);
  const focused = useRuntime((s) => s.focused === side);
  const box = useRef<HTMLDivElement>(null);
  // inline cursorIndex: by key, else the old index, else the first row
  let at = rows.length === 0 ? -1 : 0;
  if (cursor && rows.length > 0) {
    const i = rows.findIndex((r) => r.key === cursor.key);
    at = i >= 0 ? i : Math.min(Math.max(0, cursor.index), rows.length - 1);
  }

  useLayoutEffect(() => {
    setPanelRows(side, rows);
  }, [side, rows]);
  useEffect(() => () => setPanelRows(side, []), [side]);
  // the hint row lists what the cursor row can do
  useEffect(() => {
    if (focused) engine.invalidate();
  }, [focused, at]);

  const key = at >= 0 ? rows[at].key : null;
  useEffect(() => {
    if (key === null) return;
    box.current?.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [key]);

  return (
    <div className="side-rows" ref={box} role="listbox" aria-label={label}>
      {rows.map((r, i) => (
        <Row key={r.key} side={side} row={r} index={i} focus={i === at} />
      ))}
      {rows.length === 0 && empty}
    </div>
  );
}
