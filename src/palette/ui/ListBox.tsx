// The virtualized result list shared by the palette, the pickers, the menu and help
// (docs/ux.md §11.6): 20px rows, group labels, key chips right-aligned, matched characters
// underlined. Selection is one index owned by the parent; rows are memoized, so moving the
// selection re-renders two rows.
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useRef, type MouseEvent } from "react";
import { pointerMoved } from "./hover";
import type { Binding } from "../../types";
import { Icon, KeyChip, tip, type IconName } from "../../ui";
import { segments } from "../fuzzy";
import type { NewPane } from "../session";

export const ROW_HEIGHT = 20;
/** The row height the theme asks for (--k-h-list: 20px by default, roomier in "claude"). */
export function listRowHeight(): number {
  if (typeof document === "undefined") return ROW_HEIGHT;
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--k-h-list"));
  return v > 0 ? v : ROW_HEIGHT;
}
/** a rule between two groups of a menu: 2px of air, the hairline, 2px of air */
export const SEPARATOR_HEIGHT = 5;

export interface ListRow {
  key: string;
  /** a group label: not selectable */
  group?: boolean;
  /** with `group`: a rule instead of a label (a menu's groups), SEPARATOR_HEIGHT high */
  separator?: boolean;
  /** untrusted text; rendered as text */
  label: string;
  /** matched character indices in `label` */
  positions?: readonly number[];
  /** muted text after the label */
  detail?: string;
  /** right-aligned muted word (the kind of result, a state) */
  tag?: string;
  /** the namespace of an object row, shown before the name as `namespace/` ("" = cluster-scoped) */
  scope?: string;
  /** leading slot digit; "" keeps the column empty */
  slot?: string;
  /** gutter square: the current namespace or context */
  current?: boolean;
  /** Etikett labels: PROTECTED, READ ONLY, PIN */
  labels?: readonly string[];
  bindings?: readonly Binding[];
  disabled?: boolean;
  /** why it is disabled */
  reason?: string;
  /** icon buttons at the right of the selected row (the favourites picker's rename, delete) */
  actions?: readonly RowAction[];
}

export interface RowAction {
  id: string;
  icon: IconName;
  label: string;
}

/** The next selectable row from `from` in direction `delta`; stays put at the ends. */
export function step(rows: readonly ListRow[], from: number, delta: 1 | -1): number {
  for (let i = from + delta; i >= 0 && i < rows.length; i += delta) if (!rows[i].group) return i;
  return from >= 0 && from < rows.length && !rows[from].group ? from : first(rows);
}
export const first = (rows: readonly ListRow[]): number => rows.findIndex((r) => !r.group);

export const paneFromClick = (e: MouseEvent): NewPane => (e.ctrlKey || e.metaKey ? (e.shiftKey ? "down" : "right") : e.altKey ? "down" : null);

interface RowProps {
  row: ListRow;
  index: number;
  top: number;
  selected: boolean;
  id: string;
  onPick: (index: number, newPane: NewPane) => void;
  onAction?: (index: number, action: string) => void;
}

const Row = memo(function Row({ row, index, top, selected, id, onPick, onAction }: RowProps) {
  const style = { transform: `translateY(${top}px)` };
  if (row.separator) return <div className="pal-sep" style={style} role="separator" />;
  if (row.group) {
    return (
      <div className="pal-group t-label" style={style} role="presentation">
        {row.label}
      </div>
    );
  }
  return (
    <div
      id={id}
      className="pal-row t-row"
      style={style}
      role="option"
      aria-selected={selected}
      aria-disabled={row.disabled || undefined}
      data-selected={selected || undefined}
      data-disabled={row.disabled || undefined}
      data-index={index}
      // why it is disabled, in full: the inline reason is cut in a narrow menu
      {...(row.disabled && row.reason ? tip(row.label, { reason: row.reason }) : undefined)}
      onClick={(e) => onPick(index, paneFromClick(e))}
    >
      <span className="pal-gutter" data-current={row.current || undefined} aria-hidden="true" />
      {row.slot !== undefined && <span className="pal-slot t-ui">{row.slot}</span>}
      <span className="pal-label">
        {row.scope && <span className="pal-scope">{row.scope}/</span>}
        {segments(row.label, row.positions ?? []).map((s, i) =>
          s.hit ? (
            <span className="pal-hit" key={i}>
              {s.text}
            </span>
          ) : (
            s.text
          ),
        )}
      </span>
      {row.detail && <span className="pal-detail">{row.detail}</span>}
      <span className="pal-fill" />
      {row.reason && <span className="pal-reason t-ui">{row.reason}</span>}
      {row.labels?.map((l) => (
        <span className="pal-tag t-label" key={l}>
          {l}
        </span>
      ))}
      {row.tag && (
        <span className="pal-kind t-ui" data-col={row.scope !== undefined || undefined}>
          {row.tag}
        </span>
      )}
      {row.bindings && row.bindings.length > 0 && <KeyChip binding={row.bindings[0] as Binding} disabled={row.disabled} />}
      {selected &&
        onAction &&
        row.actions?.map((a) => (
          <button
            key={a.id}
            type="button"
            className="pal-act"
            data-action={a.id}
            aria-label={a.label}
            tabIndex={-1}
            {...tip(a.label)}
            // the input keeps focus: the keys of the picker keep working after a click
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              onAction(index, a.id);
            }}
          >
            <Icon name={a.icon} />
          </button>
        ))}
    </div>
  );
});

export interface ListBoxProps {
  rows: readonly ListRow[];
  selected: number;
  onPick: (index: number, newPane: NewPane) => void;
  /**
   * The pointer moved onto a row: the parent moves its selection there, so there is one
   * highlight, not a hover and a selection. Only real movement counts: a list that scrolls
   * under a resting pointer (arrow keys) never takes the selection back.
   */
  onHover?: (index: number) => void;
  /** a button of `ListRow.actions` was clicked */
  onAction?: (index: number, action: string) => void;
  /** id prefix for aria-activedescendant */
  id: string;
  /** rows visible before the list scrolls (§11.6: 14) */
  maxRows?: number;
  /** px the list may take at most (a menu: what the window has room for); `maxRows` still applies */
  maxHeight?: number;
  label: string;
}


export function ListBox({ rows, selected, onPick, onHover, onAction, id, maxRows = 14, maxHeight, label }: ListBoxProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const rowH = listRowHeight();
  const heightOf = (row: ListRow | undefined): number => (row?.separator ? SEPARATOR_HEIGHT : rowH);
  // rows and rules of a menu differ in height; the keys make the virtualizer measure again
  const rules = rows.reduce((n, r) => (r.separator ? n + 1 : n), 0);
  const total = rows.length * rowH - rules * (rowH - SEPARATOR_HEIGHT);
  // whole rows when the list is cut, so the last visible row is never half a row
  // a new function only when the rows change: the virtualizer then re-reads the sizes (not on a hover)
  const itemKey = useCallback((i: number) => rows[i]?.key ?? i, [rows]);
  const cap = Math.min(maxRows * rowH, maxHeight === undefined ? Infinity : Math.max(rowH, Math.floor(maxHeight / rowH) * rowH));
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => heightOf(rows[i]),
    getItemKey: itemKey,
    overscan: 6,
  });

  useEffect(() => {
    if (selected < 0) return;
    // keep a leading group label in view with its first row
    if (selected <= 1) virtual.scrollToOffset(0);
    else virtual.scrollToIndex(selected, { align: "auto" });
  }, [selected, rows, virtual]);

  const onMove = (e: MouseEvent) => {
    if (!onHover || !pointerMoved()) return;
    const index = Number((e.target as HTMLElement).closest<HTMLElement>("[data-index]")?.dataset.index ?? -1);
    if (index >= 0 && index !== selected && rows[index] && !rows[index].group) onHover(index);
  };

  return (
    <div
      ref={scroller}
      className="pal-list"
      role="listbox"
      aria-label={label}
      onMouseMove={onMove}
      style={{ height: Math.min(total, cap) }}
    >
      <div className="pal-list-inner" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map((v) => (
          <Row key={rows[v.index].key} row={rows[v.index]} index={v.index} top={v.start} selected={v.index === selected} id={`${id}-${v.index}`} onPick={onPick} onAction={onAction} />
        ))}
      </div>
    </div>
  );
}
