// One table row (docs/ux.md §11.2). Memoized on stable props: a data frame re-renders only the
// rows whose Row object changed; a cursor move re-renders two rows. No state, no handlers (the
// body delegates pointer events by data-index).
import { memo, type ReactNode } from "react";
import type { Row } from "../ipc/types";
import { CLIP_DELAY, clipTip, Glyph, tip, type GlyphState } from "../ui";
import { columnText, type CellContext } from "./cells";
import type { FitCol } from "./columns";
import type { Matcher } from "./filter";
import { cellHeat, rowTint } from "./heat";
import type { Status, StatusState } from "./status";

export interface RowProps {
  row: Row;
  cols: readonly FitCol[];
  ctx: CellContext;
  matcher: Matcher;
  index: number;
  top: number;
  width: number;
  cursor: boolean;
  marked: boolean;
  /** left the filter while under the cursor (§12.3) */
  held: boolean;
  stale: boolean;
  /** first row appended out of sort position */
  appended: boolean;
  delta: ReadonlySet<number>;
}

const GLYPH: Record<StatusState, GlyphState | null> = {
  ok: "ok", progress: "progress", warn: "warn", error: "error", suspended: "suspended", done: "done",
  terminating: "terminating", unknown: null, none: null,
};

const MIDDLE_MIN = 24;
const MIDDLE_TAIL = 6;

/** Text with the filter matches marked (background step + underline). Text only: never HTML. */
function marked(text: string, ranges: [number, number][]): ReactNode {
  if (ranges.length === 0) return text;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(
      <mark className="tbl-match" key={i}>
        {text.slice(a, b)}
      </mark>,
    );
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function StatusCell({ status, text, glyphOnly, held }: { status: Status | null; text: string; glyphOnly: boolean; held: boolean }) {
  const state = status?.state ?? "unknown";
  const glyph = GLYPH[state];
  return (
    <>
      {glyph ? <Glyph state={glyph} /> : <span className="tbl-noglyph" />}
      {held ? (
        <span className="tbl-gone t-label">GONE</span>
      ) : (
        <span className={glyphOnly ? "sr-only" : "status-word truncate"} data-state={state}>
          {text}
        </span>
      )}
    </>
  );
}

export const TableRow = memo(function TableRow(p: RowProps) {
  const { row, cols, ctx, matcher, delta } = p;
  const muted = p.stale || p.held || !!row.deleting;
  const hasStatus = cols.some((c) => c.spec.role === "status");
  // status colour on the cells that explain a fault, and the faint tint (setting) of failing rows
  const status = ctx.statusOf(row);
  const tint = rowTint(status, muted);
  return (
    <div
      className="row tbl-row t-cell"
      role="row"
      aria-rowindex={p.index + 2}
      aria-selected={p.marked}
      data-index={p.index}
      data-focus={p.cursor || undefined}
      data-marked={p.marked || undefined}
      data-muted={muted || undefined}
      data-tint={tint}
      data-appended={p.appended || undefined}
      style={{ transform: `translateY(${p.top}px)`, width: p.width }}
    >
      {/* the checkbox: drawn by CSS (hover, cursor, marked); the body delegates its click */}
      <span className="tbl-gutter" aria-hidden="true">
        <span className="tbl-check" />
      </span>
      {cols.map((c) => {
        const s = c.spec;
        const text = columnText(row, s, ctx);
        const changed = s.delta && delta.size > 0 && (delta.has(s.index) || (s.role === "status" && delta.has(-2)));
        if (s.role === "status") {
          return (
            <div className="cell tbl-status" role="gridcell" key={s.id} style={{ width: c.width }} data-delta={changed || undefined}>
              <StatusCell status={status} text={text} glyphOnly={c.glyphOnly} held={p.held && !c.glyphOnly} />
            </div>
          );
        }
        const ranges = matcher.empty ? [] : matcher.ranges(text, s.role === "name");
        let body: ReactNode;
        if (s.role === "name" && ranges.length === 0 && text.length >= MIDDLE_MIN) {
          // middle ellipsis (§10): the head truncates, the tail (the pod hash) stays
          body = (
            <>
              <span className="truncate">{text.slice(0, -MIDDLE_TAIL)}</span>
              <span className="tbl-tail">{text.slice(-MIDDLE_TAIL)}</span>
            </>
          );
        } else if (s.id === "@ns" && row.namespace) {
          // Alt+click on the namespace scopes the pane to it (delegated by the body: data-ns); a
          // plain click selects the row like anywhere else, and the row menu has the same entry
          body = (
            <span className="truncate tbl-ns" data-ns={row.namespace} {...tip(row.namespace, { plain: true, reason: "Alt+click: show only this namespace", delay: CLIP_DELAY })}>
              {marked(text, ranges)}
            </span>
          );
        } else body = <span className={s.role === "age" ? undefined : "truncate"}>{marked(text, ranges)}</span>;
        return (
          <div
            className={s.role === "name" ? "cell tbl-name" : s.role === "age" ? "cell num muted tbl-age" : s.numeric ? (s.quiet ? "cell num muted" : "cell num") : s.quiet ? "cell muted" : "cell"}
            role="gridcell"
            key={s.id}
            style={{ width: c.width }}
            data-delta={changed || undefined}
            data-heat={s.role === "name" || muted ? undefined : cellHeat(s.id, text, status)}
            // the whole name: while the cell cuts it, or always when its namespace prefix is hidden
            {...(s.role === "name" ? (ctx.stripNs && text !== row.name ? tip(row.name, { plain: true, delay: CLIP_DELAY }) : clipTip(text)) : undefined)}
          >
            {body}
            {s.role === "name" && p.held && !hasStatus && <span className="tbl-gone t-label">GONE</span>}
          </div>
        );
      })}
    </div>
  );
});
