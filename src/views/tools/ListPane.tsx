// The list behind every tool view (docs/ux.md §11.10): virtualized 20px rows in sections, one
// cursor, `/` filter. Keys arrive as registry actions through the pane's controller; this
// component has no key handling of its own. The pointer gets the same actions as buttons in the
// row (docs/frontend.md §17): a click moves the cursor to that row and runs the action.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ActionId } from "../../actions";
import { LAYERS, PaneSlot, engine, focusedPane, focusPane, useScopeLayer } from "../../foundation";
import { useSettings } from "../../store/settings";
import type { PaneId } from "../../types";
import { actionTip, BarInput, CLIP_DELAY, EmptyState, FilterChip, Glyph, Icon, KeyChip, keepFocus, tip, type IconName, type TipProps } from "../../ui";
import { setController, type ListController } from "./controllers";
import { countItems, cursorIndex, filterRows, moveCursor, nearestItem, type ItemRow, type ListRow } from "./list-model";
import "./tools.css";

export interface ListPaneProps {
  pane: PaneId;
  focused: boolean;
  /** selects the column layout in tools.css */
  name: "home" | "aliases" | "messages" | "settings";
  rows: readonly ListRow[];
  /** column labels (aliases) */
  head?: readonly string[];
  /** shown instead of the list when there are no rows at all */
  empty: ReactNode;
  /** told when the cursor row or the filter input state changes */
  onCurrent?: (row: ItemRow | undefined, filtering: boolean) => void;
  /** the row the cursor starts on (`:keys` opens settings on the keymap section) */
  initialKey?: string;
  /** a launcher (home): one click opens the row; Ctrl/⌘+click opens it beside (Shift: below) */
  openOnClick?: boolean;
}

/** What a row button does: the action its key runs, after the cursor moved to the row. */
const ACTS = {
  prev: { action: "settings.cyclePrev", icon: "back" },
  next: { action: "settings.cycleNext", icon: "forward" },
  change: { action: "settings.change" },
  rebind: { action: "keymap.rebind", icon: "edit" },
  unbind: { action: "keymap.clear", icon: "close" },
  reset: { action: "keymap.reset", icon: "history" },
  open: { action: "nav.open", icon: "open" },
  beside: { action: "nav.open", icon: "split-right", newPane: "right" },
} as const satisfies Record<string, { action: ActionId; icon?: IconName; newPane?: "right" }>;
type Act = keyof typeof ACTS;
/** Tooltips of the row buttons: the action's label and, when the tooltip opens, its live key. Nothing per row. */
const TIPS: Readonly<Record<Act, TipProps>> = {
  prev: actionTip("settings.cyclePrev"),
  next: actionTip("settings.cycleNext"),
  change: actionTip("settings.change"),
  rebind: actionTip("keymap.rebind"),
  unbind: actionTip("keymap.clear"),
  reset: actionTip("keymap.reset", "reset to the default keys"),
  open: actionTip("nav.open"),
  beside: tip("open beside", { reason: "also Ctrl+click on the row" }),
};

/** A plain button (a row must not subscribe to the engine): the list's click handler reads data-act. */
function Act({ act, off, className, children }: { act: Act; off?: boolean; className?: string; children?: ReactNode }) {
  const icon = (ACTS[act] as { icon?: IconName }).icon;
  return (
    <button type="button" className={className ?? "k-abtn"} tabIndex={-1} {...TIPS[act]} aria-label={TIPS[act]["data-tip"]} data-act={act} data-disabled={off || undefined} onMouseDown={keepFocus}>
      {children ?? (icon && <Icon name={icon} />)}
    </button>
  );
}

const Row = memo(function Row({ row, index, top, focus, launcher }: { row: ListRow; index: number; top: number; focus: boolean; launcher?: boolean }) {
  if (row.type === "group") {
    return (
      <div className="tl-row tl-group t-label" style={{ top }} data-index={index} role="presentation">
        {row.label}
      </div>
    );
  }
  return (
    <div
      className="tl-row row t-cell"
      style={{ top }}
      data-index={index}
      data-focus={focus || undefined}
      data-toggle={row.control === "toggle" || undefined}
      role="option"
      aria-selected={focus}
      // the full text of the row (a message, an action id), unhurried: the pointer crosses rows all the time
      {...tip(row.title, { plain: true, delay: CLIP_DELAY })}
    >
      {row.glyph && <Glyph state={row.glyph} />}
      {row.cells.map((c, i) => (
        <span key={i} className={i === 0 ? "tl-cell" : "tl-cell muted"}>
          {c}
        </span>
      ))}
      {row.actionId ? (
        // keymap row: the keys are the rebind button
        <Act act="rebind" className="tl-keybtn">
          {row.keys && row.keys.length > 0 ? row.keys.map((b, i) => <KeyChip key={i} binding={b as string[]} />) : <span className="tl-nokey t-ui">no key</span>}
        </Act>
      ) : (
        row.keys?.map((b, i) => <KeyChip key={i} binding={b as string[]} />)
      )}
      {row.control === "choice" && <Act act="prev" className="k-abtn tl-reveal" />}
      {row.value !== undefined &&
        (row.control ? (
          <Act act="change" className="tl-value tl-valuebtn">
            {row.control === "toggle" && <span className="tl-switch" data-on={row.value === "on" || undefined} aria-hidden="true" />}
            {row.value}
          </Act>
        ) : (
          !(row.actionId && row.value === "no key") && <span className="tl-value">{row.value}</span>
        ))}
      {row.control === "choice" && <Act act="next" className="k-abtn tl-reveal" />}
      {row.actionId && (
        <span className="tl-acts tl-reveal">
          <Act act="rebind" />
          <Act act="unbind" off={!row.keys || row.keys.length === 0} />
          <Act act="reset" off={!row.edited} />
        </span>
      )}
      {row.open && !launcher && (
        <span className="tl-acts tl-reveal">
          <Act act="open" />
          <Act act="beside" />
        </span>
      )}
    </div>
  );
});

function FilterBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // the input owns its keys through this layer: Enter applies, Esc cancels (filter.apply / filter.cancel)
  useScopeLayer(LAYERS.filterInput);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return <BarInput ref={ref} label="FILTER" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Filter" />;
}

export function ListPane({ pane, focused, name, rows, head, empty, onCurrent, initialKey, openOnClick }: ListPaneProps) {
  const rowHeight = useSettings((s) => s.rowHeight);
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [cursorKey, setCursorKey] = useState<string | null>(initialKey ?? null);
  const scroll = useRef<HTMLDivElement>(null);
  const beforeFilter = useRef("");

  const shown = useMemo(() => filterRows(rows, filter), [rows, filter]);
  const index = useMemo(() => cursorIndex(shown, cursorKey), [shown, cursorKey]);
  const current = index >= 0 ? (shown[index] as ItemRow) : undefined;

  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  });
  useEffect(() => virtualizer.measure(), [rowHeight, virtualizer]);
  // a list opened on a given row (`:keys`) shows it, with its section label when that fits
  useEffect(() => {
    const i = initialKey ? shown.findIndex((r) => r.key === initialKey) : -1;
    if (i >= 0) virtualizer.scrollToIndex(Math.max(0, i - 1), { align: "start" });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // the handlers below run from actions, long after render: they read the latest state from here
  const live = useRef({ shown, index, current, filtering, filter });
  live.current = { shown, index, current, filtering, filter };

  const goTo = useCallback(
    (i: number) => {
      const row = live.current.shown[i];
      if (!row || row.type !== "item") return;
      setCursorKey(row.key);
      // a second key can arrive before the next render: keep the handlers' view of the cursor current
      live.current = { ...live.current, index: i, current: row };
      // keep the section label in view when the cursor reaches the first row under it
      const target = i > 0 && live.current.shown[i - 1].type === "group" ? i - 1 : i;
      virtualizer.scrollToIndex(target, { align: "auto" });
      if (target !== i) virtualizer.scrollToIndex(i, { align: "auto" });
    },
    [virtualizer],
  );

  useEffect(() => {
    const closeFilter = () => {
      setFiltering(false);
      // the input is gone: give focus back to the list so the pane keeps it
      scroll.current?.focus();
    };
    const c: ListController = {
      move: (delta) => goTo(moveCursor(live.current.shown, live.current.index, delta)),
      page: (dir) => {
        const page = Math.max(1, Math.floor((scroll.current?.clientHeight ?? rowHeight) / rowHeight) - 1);
        goTo(moveCursor(live.current.shown, live.current.index, dir * page));
      },
      top: () => goTo(nearestItem(live.current.shown, 0, 1)),
      bottom: () => goTo(nearestItem(live.current.shown, live.current.shown.length - 1, -1)),
      current: () => live.current.current,
      filterOpen: () => {
        beforeFilter.current = live.current.filter;
        setFiltering(true);
      },
      filterApply: closeFilter,
      filterCancel: () => {
        // Esc in the input drops the edit; Esc again (filter.clear) removes the filter
        setFilter(beforeFilter.current);
        closeFilter();
      },
      isFiltering: () => live.current.filtering,
      hasFilter: () => live.current.filter !== "",
      filterClear: () => setFilter(""),
    };
    return setController(pane, c);
  }, [pane, goTo, rowHeight]);

  // hints and `enabled` depend on what the cursor row can do, not on which row it is
  const abilities = `${current?.open ? "o" : ""}${current?.change ? "c" : ""}${current?.cycle ? "y" : ""}${current?.actionId ? "k" : ""}${filtering ? "f" : ""}${filter ? "x" : ""}`;
  useEffect(() => engine.invalidate(), [abilities]);
  useEffect(() => onCurrent?.(current, filtering), [current, filtering, onCurrent]);

  const rowAt = (e: MouseEvent): number => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
    return el ? Number(el.dataset.index) : -1;
  };
  // A row button: this pane takes the focus, the cursor goes to the row, then the action runs.
  // engine.run and not runAction: the keymap actions live in a layer that is only pushed once the
  // cursor sits on a keymap row (an effect), and a click must not depend on where the cursor was.
  const runAct = (act: Act, i: number) => {
    if (focusedPane() !== pane) focusPane(pane);
    const a = document.activeElement;
    if (a instanceof HTMLElement && a !== document.body && !a.closest(".pane")) scroll.current?.focus({ preventScroll: true });
    goTo(i);
    const def: { action: ActionId; newPane?: "right" } = ACTS[act];
    engine.run(def.action, { source: "pointer", newPane: def.newPane ?? null });
  };
  /** a click (home) or double-click that opens the row: the same `nav.open` Enter runs */
  const openAt = (i: number, newPane: "right" | "down" | null) => {
    if (focusedPane() !== pane) focusPane(pane);
    goTo(i);
    engine.run("nav.open", { source: "pointer", newPane });
  };
  const actAt = (e: MouseEvent): Act | undefined => (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act as Act | undefined;
  const onClick = (e: MouseEvent) => {
    const act = actAt(e);
    if (act) return runAct(act, rowAt(e));
    const row = shown[rowAt(e)];
    if (openOnClick && row?.type === "item" && row.open) openAt(rowAt(e), e.ctrlKey || e.metaKey ? (e.shiftKey ? "down" : "right") : null);
    // an on / off row is one switch: a click anywhere on it flips it, like a checkbox's label
    else if (row?.type === "item" && row.control === "toggle") runAct("change", rowAt(e));
    else goTo(rowAt(e));
  };
  const onDoubleClick = (e: MouseEvent) => {
    const row = shown[rowAt(e)];
    // a double-click on a row button is two clicks on the button, nothing more
    // ... and on an on / off row it is two flips (the two clicks did them)
    if (row?.type !== "item" || openOnClick || actAt(e) || row.control === "toggle") return;
    if (row.open) openAt(rowAt(e), null);
    else if (row.change) row.change();
    else if (row.actionId) runAct("rebind", rowAt(e));
  };

  const total = useMemo(() => countItems(rows), [rows]);
  const matched = filter ? countItems(shown) : total;

  return (
    <div className="tl" data-view={name} data-active={focused || undefined}>
      <PaneSlot name="count">{filter ? `${matched}/${total}` : total}</PaneSlot>
      {/* the input lives in the pane header (§11.5), so the list never shifts */}
      {(filtering || filter) && (
        <PaneSlot name="chips">
          {filtering ? <FilterBar value={filter} onChange={setFilter} /> : <FilterChip mode="FILTER" value={filter} onRemove={() => setFilter("")} />}
        </PaneSlot>
      )}
      {head && (
        <div className="tl-head t-colhead">
          {head.map((h) => (
            <span key={h} className="tl-cell">
              {h}
            </span>
          ))}
        </div>
      )}
      {total === 0 ? (
        empty
      ) : matched === 0 ? (
        <EmptyState compact>Nothing matches “{filter}”</EmptyState>
      ) : (
        <div ref={scroll} className="tl-scroll" tabIndex={-1} role="listbox" data-click={openOnClick ? "open" : undefined} onClick={onClick} onDoubleClick={onDoubleClick} onContextMenu={(e) => goTo(rowAt(e))}>
          <div className="tl-inner" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((v) => (
              <Row key={shown[v.index].key} row={shown[v.index]} index={v.index} top={v.start} focus={v.index === index} launcher={openOnClick} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
