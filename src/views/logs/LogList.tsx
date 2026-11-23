// The virtualized line list (docs/ux.md §13.3): a custom window over the session's rows. Row
// heights are whole lines known without measuring (hard wrap), so the window is O(log n) to find
// and nothing is ever laid out twice. Follow sticks to the bottom; a paused viewport never moves,
// also not when the ring buffer drops lines above it.
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { runAction, usePaneId } from "../../ui";
import { Row } from "./Row";
import type { LogSession } from "./session";
import { sourceLabel } from "./targets";
import { CLOCK_CHARS } from "./time";

/** --k-h-line */
const LINE_PX = 16;
/** padding-inline of a line (--k-luft-15) */
const PAD_PX = 8;
/** room above the first line, so it never touches the pane header (--k-luft-05) */
const HEAD_PX = 2;
const OVERSCAN = 12;
const PROBE = "0".repeat(200);

interface Box {
  w: number;
  h: number;
  /** width of one mono character in CSS px */
  cw: number;
  /** what is left of the pane's height after whole lines: kept under the list, as a terminal does */
  slack: number;
}

export interface LogListProps {
  session: LogSession;
  wrap: boolean;
  timestamps: boolean;
}

export function LogList({ session: s, wrap, timestamps }: LogListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const pane = usePaneId();
  const [box, setBox] = useState<Box>({ w: 0, h: 0, cw: 0, slack: 0 });
  const [topUnit, setTopUnit] = useState(0);
  /** scrollTop after our own last write: a scroll event at this position is not the user */
  const expected = useRef(0);
  const prevPad = useRef(0);

  useLayoutEffect(() => {
    const el = scroller.current;
    const p = probe.current;
    if (!el || !p) return;
    const frame = el.parentElement ?? el;
    const measure = () => {
      // The viewport is a whole number of lines: a list that sticks to the bottom (follow) would
      // otherwise show its top line cut off under the pane header at most pane heights.
      const room = Math.max(0, frame.clientHeight - HEAD_PX);
      const slack = room >= LINE_PX ? room % LINE_PX : 0;
      const next = { w: el.clientWidth, h: room - slack, cw: p.offsetWidth / PROBE.length, slack };
      setBox((b) => (b.w === next.w && b.h === next.h && b.cw === next.cw && b.slack === next.slack ? b : next));
    };
    measure();
    // the probe is observed too: the mono font may arrive after the first layout; the frame,
    // because the list's own height only changes in whole lines
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(frame);
    ro.observe(p);
    return () => ro.disconnect();
  }, []);

  const gutter = s.gutter;
  const cols = box.cw > 0 ? Math.max(8, Math.floor((box.w - PAD_PX * 2) / box.cw) - (timestamps ? CLOCK_CHARS + 1 : 0) - (gutter > 0 ? gutter + 1 : 0)) : 0;

  const labels = useMemo(
    () => (gutter > 0 ? s.sources.map((src) => sourceLabel(s.gutterMode, src.marker, src.pod, src.container, gutter)) : null),
    // sources only ever grow, and the gutter mode and width follow them
    [s, s.sources.length, gutter, s.gutterMode], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const heights = s.heights;
  const rows = s.rowCount;
  const pad = s.droppedTotal > 0 ? 1 : 0;
  const total = heights.total + pad;
  const viewUnits = Math.max(1, Math.ceil(box.h / LINE_PX));
  const first = s.follow ? Math.max(0, total - viewUnits) : Math.max(0, topUnit - s.peekDropped());
  const r0 = rows > 0 ? heights.rowAt(first - pad - OVERSCAN) : 0;
  const r1 = rows > 0 ? heights.rowAt(first - pad + viewUnits + OVERSCAN) : -1;

  const sel = s.selection();
  const items = [];
  for (let row = r0; row <= r1; row++) {
    const e = s.entryAtRow(row);
    if (!e) continue;
    const src = e.src >= 0 ? s.sources[e.src] : undefined;
    items.push(
      <Row
        key={e.seq}
        entry={e}
        top={(heights.offset(row) + pad) * LINE_PX}
        matcher={s.matcher}
        wrapped={s.isWrapped(e.seq)}
        cols={cols}
        maxUnits={s.maxUnits(e.seq)}
        timestamps={timestamps}
        label={labels && src ? (labels[e.src] ?? null) : null}
        source={labels && src ? `${src.pod}/${src.container}` : null}
        podIndex={labels && src && s.gutterMode !== "container" ? src.podIndex : null}
        structured={s.isStructured(e)}
        expanded={s.expanded.has(e.seq)}
        cursor={e.seq === s.cursor}
        selected={sel !== null && e.seq >= sel[0] && e.seq <= sel[1]}
        current={e.seq === s.currentHit}
      />,
    );
  }

  // After every render: apply follow, the compensation for dropped lines and scroll commands in
  // one write, then tell the session what is on screen.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // a change of columns or wrap rebuilds the heights: this render's geometry is stale, and the
    // render it triggers (still before paint) applies the scroll commands against the new one
    if (s.setLayout(cols, wrap)) return;
    const dropped = s.takeDropped();
    const cmd = s.takeScroll();
    const padDelta = pad - prevPad.current;
    prevPad.current = pad;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    let top = el.scrollTop;
    if (s.follow || cmd === "bottom") top = max;
    else {
      top -= (dropped - padDelta) * LINE_PX;
      if (cmd) {
        const row = s.rowOfSeq(cmd.seq);
        if (row >= 0) {
          const rowTop = (heights.offset(row) + pad) * LINE_PX;
          const rowH = heights.units(row) * LINE_PX;
          const head = pad * LINE_PX;
          if (cmd.align === "start") top = rowTop - head;
          else if (rowTop < top + head || rowTop + rowH > top + el.clientHeight) {
            if (cmd.align === "center") top = rowTop - Math.max(0, el.clientHeight - rowH) / 2;
            else top = rowTop < top + head ? rowTop - head : rowTop + rowH - el.clientHeight;
          }
        }
      }
    }
    top = Math.max(0, Math.min(Math.round(top), max));
    if (Math.abs(top - el.scrollTop) >= 1) el.scrollTop = top;
    expected.current = el.scrollTop;
    const unit = Math.floor(el.scrollTop / LINE_PX);
    if (unit !== topUnit) setTopUnit(unit);
    const lines = Math.max(1, Math.floor(el.clientHeight / LINE_PX));
    s.viewFirst = Math.max(0, heights.rowAt(unit - pad + (el.scrollTop % LINE_PX > 0 ? 1 : 0)));
    s.viewLast = Math.max(0, heights.rowAt(unit - pad + lines - 1));
    s.pageRows = Math.max(1, lines - 1);
  });

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const moved = el.scrollTop - expected.current;
    if (Math.abs(moved) >= 1) {
      // The user moved the viewport (wheel, scrollbar, touch). Direction matters: a list that
      // got shorter is clamped upwards by the browser, and that must never resume follow.
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 2;
      if (s.follow && moved < 0 && !atBottom) s.pauseAtScroll();
      else if (!s.follow && moved > 0 && atBottom && s.rowCount > 0) s.resume();
      expected.current = el.scrollTop;
    }
    setTopUnit(Math.floor(el.scrollTop / LINE_PX));
  };

  // mouse parity for the line cursor; a drag that selected text is left alone. A click on the
  // pod gutter is "go to pod of line" (logs.goToPod) for that line; Ctrl/⌘+click opens it beside.
  const onClick = (e: MouseEvent) => {
    if (!window.getSelection()?.isCollapsed) return;
    const target = e.target as HTMLElement;
    const line = target.closest<HTMLElement>("[data-seq]");
    if (!line?.dataset.seq) return;
    const seq = Number(line.dataset.seq);
    if (target.closest(".logs-src")) {
      const beside = e.ctrlKey || e.metaKey ? (e.shiftKey ? "down" : "right") : null;
      runAction("logs.goToPod", { pane, before: () => s.setCursor(seq), newPane: beside });
      return;
    }
    s.setCursor(seq);
  };

  return (
    <div
      ref={scroller}
      className="logs-scroll t-mono selectable"
      role="log"
      aria-label="Log lines"
      style={{ "--logs-gutter": `${gutter}ch`, top: HEAD_PX, bottom: box.slack } as CSSProperties}
      onScroll={onScroll}
      onClick={onClick}
    >
      <span ref={probe} className="logs-probe" aria-hidden="true">
        {PROBE}
      </span>
      <div className="logs-space" style={{ height: total * LINE_PX }}>
        {pad > 0 && r0 === 0 && (
          <div className="logs-row">
            <div className="logs-note">
              <span className="logs-note-word t-label">older lines dropped</span>
            </div>
          </div>
        )}
        {items}
      </div>
    </div>
  );
}
