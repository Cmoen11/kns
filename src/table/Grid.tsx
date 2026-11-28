// The virtualized grid shared by resource tables and the containers view (docs/ux.md §11.2,
// §11.3, §12). Rows are fixed height and absolutely positioned; the column header is sticky
// inside the same scroller, so it follows horizontal scroll (wide mode) for free.
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { engine, openMenu, PaneSlot, PaneToolbar, runAction, setSelection, zoomFactor } from "../foundation";
import { setPaneFaults } from "../store/pane-status";
import { useSettings } from "../store/settings";
import { ActionHint, EmptyState, FilterChip, Toolbar } from "../ui";
import { ColumnMenu } from "./ColumnMenu";
import { FilterBar } from "./FilterBar";
import { chipOf } from "./filter";
import { Header } from "./Header";
import { HEADER_H, type GridSource, type TableModel } from "./model";
import { BULK_ACTIONS, CHECK_HIT, paneToolbar, rowMenu } from "./pointer";
import { usePrefs } from "./prefs";
import { attachModel, detachModel } from "./registry";
import { TableRow } from "./Row";
import { RowBar, type RowBarHandle } from "./RowBar";
import "./table.css";

const OVERSCAN = 10;
/** §11.10: the full empty state needs 320×240; smaller panes get the text line only */
const EMPTY_MIN_W = 320;
const EMPTY_MIN_H = 240;

export interface GridProps {
  model: TableModel;
  source: GridSource;
  focused: boolean;
  visible: boolean;
}

export function Grid({ model, source, focused, visible }: GridProps) {
  useSyncExternalStore(model.subscribe, model.getVersion);
  const prefs = usePrefs(source.prefsKey);
  const rowH = useSettings((s) => s.rowHeight);
  const view = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // w: the scroller's client width; h: the height the table may use; bar: the horizontal scrollbar
  const [size, setSize] = useState({ w: 0, h: 0, bar: 0 });
  const [now, setNow] = useState(() => Date.now());

  // The viewport ends on a row edge: the scroller is the header plus a whole number of rows (plus
  // its horizontal scrollbar), so the last row is never cut. What is left over (< one row) stays
  // empty below it.
  const fullRows = Math.floor((size.h - HEADER_H - size.bar) / rowH);
  model.rowH = rowH;
  model.viewH = fullRows >= 1 ? fullRows * rowH : Math.max(0, size.h - HEADER_H - size.bar);
  const d = model.derive(source, prefs, size.w, now);
  const { order, fit } = d;
  // the pane header and tab hint: faulty rows in this table (status colours)
  useEffect(() => setPaneFaults(source.pane, d.faults), [source.pane, d.faults]);
  useEffect(() => () => setPaneFaults(source.pane, null), [source.pane]);

  // one ResizeObserver per pane, coalesced per frame (§12.1)
  useLayoutEffect(() => {
    const el = scroller.current;
    const box = view.current;
    if (!el || !box) return;
    model.el = el;
    // the height comes from the wrapper (the scroller's own height is the snapped one), the width
    // from the scroller (without its vertical scrollbar)
    const measure = () => ({ w: el.clientWidth, h: box.clientHeight, bar: el.offsetHeight - el.clientHeight });
    setSize(measure());
    let frame = 0;
    const ro = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const m = measure();
        setSize((s) => (s.w === m.w && s.h === m.h && s.bar === m.bar ? s : m));
      });
    });
    ro.observe(box);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
      model.el = null;
    };
  }, [model]);

  // Scrolling moves by whole rows, so the viewport starts and ends on a row edge. The wheel steps
  // rows at once (no smooth-scroll animation, §16; pixel deltas of a trackpad add up to rows), and
  // whatever else scrolls (the scrollbar, autoscroll, touch) settles on a row when it ends. CSS
  // scroll snap cannot do this: it snaps to rendered rows only, and the list is virtualized.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let acc = 0;
    const aligned = (top: number) => Math.max(0, Math.min(Math.round(top / model.rowH) * model.rowH, el.scrollHeight - el.clientHeight));
    const onWheel = (e: WheelEvent) => {
      // sideways, zoom and Shift+wheel stay native
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (el.scrollHeight <= el.clientHeight) return;
      e.preventDefault();
      const h = model.rowH;
      const px = e.deltaMode === 1 ? e.deltaY * h : e.deltaMode === 2 ? e.deltaY * Math.max(h, model.viewH - h) : e.deltaY;
      if (acc !== 0 && Math.sign(px) !== Math.sign(acc)) acc = 0;
      acc += px;
      const rows = Math.trunc(acc / h);
      if (rows === 0) return;
      acc -= rows * h;
      const top = aligned(el.scrollTop + rows * h);
      if (top !== el.scrollTop) el.scrollTop = top;
    };
    let settled = -1;
    const onScrollEnd = () => {
      const top = aligned(el.scrollTop);
      // the tolerance covers device-pixel rounding under zoom; never set the same target twice
      if (Math.abs(top - el.scrollTop) < 1 || top === settled) return;
      settled = top;
      el.scrollTop = top;
    };
    // a webview without `scrollend` (WKWebView before Safari 26): settle once scrolling has been idle
    const native = "onscrollend" in window;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (Math.abs(el.scrollTop - settled) >= 1) settled = -1;
      if (native) return;
      clearTimeout(idle);
      idle = setTimeout(onScrollEnd, 120);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    if (native) el.addEventListener("scrollend", onScrollEnd);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(idle);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scrollend", onScrollEnd);
      el.removeEventListener("scroll", onScroll);
    };
  }, [model]);

  useEffect(() => {
    attachModel(source.pane, model);
    return () => {
      detachModel(source.pane, model);
      setSelection(source.pane, null);
      model.dispose();
    };
  }, [model, source.pane]);

  // ages tick on a coarse shared clock: 1s while a row still shows seconds, else 30s
  const period = model.tickMs();
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), period);
    return () => clearInterval(t);
  }, [period, visible]);

  const rangeExtractor = useCallback(
    (range: Range) => {
      const out = defaultRangeExtractor(range);
      // the cursor row stays mounted (§12.1)
      const c = model.cursorIndex;
      if (c >= 0 && c < range.count && out.length > 0) {
        if (c < out[0]) out.unshift(c);
        else if (c > out[out.length - 1]) out.push(c);
      }
      return out;
    },
    [model],
  );
  const estimateSize = useCallback(() => rowH, [rowH]);
  const virt = useVirtualizer({
    count: order.length,
    getScrollElement: () => scroller.current,
    estimateSize,
    overscan: OVERSCAN,
    scrollMargin: HEADER_H,
    rangeExtractor,
  });

  // anchoring (§12.3): rows that came or went above the anchor shift the scroll offset by the same
  // amount in the same frame, so the cursor row keeps its place on screen
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (model.pendingScroll !== 0) {
      el.scrollTop += model.pendingScroll;
      model.pendingScroll = 0;
      model.scrollTop = el.scrollTop;
    }
    if (model.ensureCursor) {
      model.ensureCursor = false;
      model.ensureVisible(model.cursorIndex);
    }
  });

  const cursorRow = d.cursor ? d.rows.get(d.cursor) : undefined;
  useEffect(() => model.publish(), [model, d.cursor, cursorRow?.name, cursorRow?.namespace, model.marksVersion, order]);

  // predicates of the hint row (`when`, `enabled`) read this state
  const hasRow = d.cursor !== null;
  const chips = source.filters.length + (source.faultsOnly ? 1 : 0);
  useEffect(() => engine.invalidate(), [hasRow, chips, model.filter.open]);

  // ── pointer (docs/frontend.md §17): everything is delegated from the body by data-index; a row
  // has no listeners. A click first makes the clicked row the cursor row (model.point publishes
  // the selection at once), then the action runs through the engine for this pane.
  const pane = source.pane;
  const bar = useRef<RowBarHandle>(null);
  const hovered = useRef<{ el: Element; index: string | null } | null>(null);
  const rowAt = (e: ReactMouseEvent): { uid: string; el: Element } | null => {
    const el = e.target instanceof Element ? e.target.closest("[data-index]") : null;
    const uid = el ? model.uidAt(Number(el.getAttribute("data-index"))) : undefined;
    return el && uid !== undefined ? { uid, el } : null;
  };
  /** the checkbox: the mark gutter and the padding before the name */
  const onCheck = (e: ReactMouseEvent, el: Element): boolean =>
    source.marks && el.classList.contains("tbl-row") && (e.clientX - el.getBoundingClientRect().left) / zoomFactor() < CHECK_HIT;
  const nsOf = (e: ReactMouseEvent): string | null => (e.target instanceof Element ? (e.target.closest("[data-ns]")?.getAttribute("data-ns") ?? null) : null);

  const onClick = (e: ReactMouseEvent) => {
    const hit = rowAt(e);
    if (!hit) return;
    const mod = e.ctrlKey || e.metaKey;
    if (source.marks && e.shiftKey && !mod) {
      // Shift+click: mark from the cursor row (the last row clicked or marked) to this row
      if (model.pointRange(hit.uid)) runAction("mark.range", { pane });
      return;
    }
    if (onCheck(e, hit.el)) {
      runAction("mark.toggle", { pane, before: () => model.point(hit.uid) });
      return;
    }
    if (!model.point(hit.uid)) return;
    // the second click of a double-click is not another "open beside"
    if (mod && e.detail <= 1) runAction("nav.open", { pane, newPane: e.shiftKey ? "down" : "right" });
    // a plain click only selects, also on a namespace cell; Alt+click there scopes the pane to it
    // (no history is pushed, so it must not happen by accident). The row menu has the same entry.
    else if (!mod && e.altKey && e.detail <= 1) {
      const ns = nsOf(e);
      if (ns !== null) runAction("namespace.pick", { pane, args: [ns] });
    }
  };
  const onDoubleClick = (e: ReactMouseEvent) => {
    const hit = rowAt(e);
    if (!hit || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || onCheck(e, hit.el)) return;
    runAction("nav.open", { pane, before: () => model.point(hit.uid) });
  };
  const onAuxClick = (e: ReactMouseEvent) => {
    const hit = rowAt(e);
    if (e.button !== 1 || !hit) return;
    runAction("nav.open", { pane, newPane: "right", before: () => model.point(hit.uid) });
  };
  // Right-click acts on the clicked row. With marks: on a marked row the menu acts on the marks;
  // on an unmarked row the marks are dropped first (as a file manager does), so an action never
  // hits rows other than the one under the pointer, and the rows' enabled state is the clicked
  // row's. Closing the menu without a pick puts the marks back.
  const onContextMenu = (e: ReactMouseEvent) => {
    const hit = rowAt(e);
    if (!hit) return;
    e.preventDefault();
    const ns = hit.el.querySelector("[data-ns]")?.getAttribute("data-ns") ?? null;
    const at = { x: e.clientX, y: e.clientY };
    // a right-click on an unmarked row acts on that row: the marks are dropped first and come back
    // when the menu closes without a pick, however it closes (the menu reports every such close)
    const kept = model.markedRefs().length > 0 && !model.marks.has(hit.uid) ? new Set(model.marks) : null;
    if (kept) model.clearMarks();
    const restore = kept ? () => model.restoreMarks(kept) : undefined;
    if (!model.point(hit.uid) || !openMenu({ at, items: rowMenu(ns, pane), pane, onCancel: restore })) restore?.();
  };
  // the one row action bar follows the pointer; the hovered row keeps its hover look under the bar
  const hover = (el: Element | null) => {
    if ((hovered.current?.el ?? null) === el) return;
    hovered.current?.el.removeAttribute("data-hover");
    hovered.current = el ? { el, index: el.getAttribute("data-index") } : null;
    el?.setAttribute("data-hover", "");
  };
  // rows are keyed by uid: when live data reorders, the node (and its hover look) moves away from
  // the pointer. Drop it then, like the row bar does; the next mouse move sets it again.
  useLayoutEffect(() => {
    const h = hovered.current;
    if (h && (!h.el.isConnected || h.el.getAttribute("data-index") !== h.index)) hover(null);
  });
  const onMouseOver = (e: ReactMouseEvent) => {
    const hit = rowAt(e);
    if (!hit) {
      hover(null);
      bar.current?.hide();
    } else if (hit.el.classList.contains("tbl-row")) {
      hover(hit.el);
      bar.current?.show(Number(hit.el.getAttribute("data-index")), hit.uid);
    }
  };
  const onMouseLeave = () => {
    hover(null);
    bar.current?.hide();
  };

  const toolbar = useMemo(() => paneToolbar(source.faultsOnly, source.wide, source.stripNsPrefix), [source.faultsOnly, source.wide, source.stripNsPrefix]);

  const compact = size.w < EMPTY_MIN_W || size.h < EMPTY_MIN_H;
  const filtered = chips > 0 || model.filter.open;
  let empty: ReactNode = null;
  if (order.length === 0) {
    if (source.state === "forbidden") {
      empty = (
        <EmptyState compact={compact} title="Forbidden">
          {source.message || `You may not list ${source.resource} here.`}
        </EmptyState>
      );
    } else if (source.state === "error") {
      empty = (
        <EmptyState compact={compact} title="Watch failed">
          {source.message || "The watch could not start."} <ActionHint action="view.refresh" label="retry" />
        </EmptyState>
      );
    } else if (!source.synced) {
      // never "no resources" before the first snapshot (§11.10)
      empty = <div className="tbl-syncing t-cell">syncing</div>;
    } else if (filtered) {
      empty = (
        <EmptyState compact={compact} title="No matches">
          {d.total} {source.resource} hidden by the filter.{" "}
          {/* while the input is open Esc drops what is typed; after that it removes the last chip */}
          {model.filter.open ? <ActionHint action="filter.cancel" label="cancel the filter" /> : <ActionHint action="filter.clear" label="remove the last chip" />}
        </EmptyState>
      );
    } else {
      empty = (
        <EmptyState compact={compact} title={`No ${source.resource}`}>
          {source.emptyHint === "namespace" ? (
            <>
              Nothing in this namespace. <ActionHint action="namespace.all" label="show all namespaces" />
            </>
          ) : (
            "Nothing here yet."
          )}
        </EmptyState>
      );
    }
  }

  const items = virt.getVirtualItems();
  const firstAppended = d.unsorted > 0 ? order.length - d.unsorted : -1;
  const width = Math.max(fit.total, size.w);
  const marks = model.marks;
  // marks on rows the filter hides are kept but not counted (the same rule as the selection store)
  const markedCount = marks.size > 0 ? model.markedRefs().length : 0;

  return (
    <div className="tbl" data-focused={focused || undefined} data-rows={rowH} data-marks={source.marks || undefined} data-marking={markedCount > 0 || undefined}>
      <PaneToolbar items={toolbar} label="Table actions" />
      <PaneSlot name="chips">
        {model.filter.open ? (
          <FilterBar model={model} filters={source.filters} />
        ) : (
          <>
            {source.filters.map((f, i) => {
              const c = chipOf(f);
              return <FilterChip key={`${c.mode}:${c.value}`} mode={c.mode} value={c.value} onRemove={() => model.removeChip(i)} />;
            })}
            {source.faultsOnly && <FilterChip mode={source.resource === "events" ? "WARNING" : "FAULTS"} onRemove={() => source.setFaults(false)} />}
          </>
        )}
      </PaneSlot>
      <PaneSlot name="labels">
        {d.unsorted > 0 && <span className="tbl-label">UNSORTED {d.unsorted}</span>}
        {source.wide && <span className="tbl-label">WIDE</span>}
      </PaneSlot>
      <PaneSlot name="count">{markedCount > 0 ? `${markedCount} marked` : source.synced ? `${order.length}/${d.total}` : ""}</PaneSlot>

      <div className="tbl-view" ref={view}>
        <div
          className="tbl-scroll"
          ref={scroller}
          style={order.length > 0 && fullRows >= 1 ? { height: HEADER_H + fullRows * rowH + size.bar } : undefined}
          role="grid"
          aria-rowcount={order.length + 1}
          aria-multiselectable={source.marks}
          onScroll={(e) => {
            model.scrollTop = e.currentTarget.scrollTop;
          }}
        >
          {/* before the server's columns arrive only the synthetic ones exist (NAMESPACE, CPU, MEM):
              an empty header bar then, so no column shows up just to move a moment later */}
          {source.columns.length === 0 && !source.synced ? (
            <div className="tbl-head" role="row" aria-rowindex={1} style={{ width }} />
          ) : fit.cols.length > 0 ? (
            <Header
              model={model}
              cols={fit.cols}
              sort={d.sort}
              selected={model.selectedCol}
              width={width}
              kind={source.kind}
              wide={source.wide}
              marks={source.marks && order.length > 0}
              marked={markedCount === 0 ? 0 : markedCount >= order.length ? 2 : 1}
            />
          ) : null}
          {empty ? (
            <div className="tbl-empty">{empty}</div>
          ) : (
            <div
              className="tbl-body"
              style={{ height: order.length * rowH, width }}
              onClick={onClick}
              onDoubleClick={onDoubleClick}
              onAuxClick={onAuxClick}
              onContextMenu={onContextMenu}
              onMouseOver={onMouseOver}
              onMouseLeave={onMouseLeave}
            >
              {items.map((it) => {
                const uid = order[it.index];
                const row = uid === undefined ? undefined : d.rows.get(uid);
                if (!row) return null;
                return (
                  <TableRow
                    key={uid}
                    row={row}
                    cols={fit.cols}
                    ctx={d.ctx}
                    matcher={d.matcher}
                    index={it.index}
                    top={it.index * rowH}
                    width={width}
                    cursor={uid === d.cursor}
                    marked={marks.has(uid)}
                    held={uid === d.held}
                    stale={source.stale}
                    appended={it.index === firstAppended}
                    delta={model.deltaOf(uid)}
                  />
                );
              })}
              {/* after the rows: it paints over them, and under the sticky header */}
              <RowBar ref={bar} model={model} pane={pane} width={size.w} rowH={rowH} />
            </div>
          )}
        </div>
      </div>
      {markedCount > 0 && (
        <div className="tbl-bulk" role="group" aria-label="Marked rows">
          <span className="tbl-bulk-count t-ui num">{markedCount} marked</span>
          <Toolbar items={BULK_ACTIONS} label="Actions on the marked rows" />
        </div>
      )}
      {model.columnsOpen && <ColumnMenu model={model} display={d} prefs={prefs} />}
    </div>
  );
}
