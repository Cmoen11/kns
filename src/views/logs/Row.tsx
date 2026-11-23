// One row of the log list. The outer element only carries the position, so a shift of the whole
// list (head dropped, follow) re-renders no line content; RowBody is memoized on primitives.
import { memo, type ReactNode } from "react";
import { CLIP_DELAY, tip } from "../../ui";
import { detectLevel } from "./level";
import type { Matcher } from "./match";
import { buildSegments, TRUNCATE_SLACK, wrapSegments, type Seg } from "./segments";
import { ERROR, GAP, LINE, MARK, type Entry } from "./session";
import { displayLine, expandedLines } from "./structured";
import { formatClock } from "./time";

export interface RowProps {
  entry: Entry;
  top: number;
  matcher: Matcher | null;
  /** hard-wrapped (wrap mode or expanded) */
  wrapped: boolean;
  cols: number;
  maxUnits: number;
  timestamps: boolean;
  /** pod/container gutter text; null = no gutter */
  label: string | null;
  /** full `pod/container`, for the gutter's tooltip */
  source: string | null;
  /** the pod's first-seen index: the gutter's colour (with the letter marker, never alone) */
  podIndex: number | null;
  /** shown in structured form (`J`): LEVEL message fields */
  structured: boolean;
  /** expanded with Enter (structured: the key/value block) */
  expanded: boolean;
  cursor: boolean;
  selected: boolean;
  current: boolean;
}

function segClass(s: Seg): string | undefined {
  if (s.hit) return "logs-hit";
  let c = "";
  if (s.level) c = `level level-${s.level}`;
  else if (s.tone) c = `tone-${s.tone}`;
  if (s.underline) c = c ? `${c} logs-ul` : "logs-ul";
  return c || undefined;
}

function renderSegs(segs: readonly Seg[]): ReactNode[] {
  return segs.map((s, i) => {
    const c = segClass(s);
    return c ? (
      <span key={i} className={c}>
        {s.text}
      </span>
    ) : (
      s.text
    );
  });
}

const NOTE_WORD: Record<number, string> = { [GAP]: "gap", [ERROR]: "error" };

/** pod gutter colours: the syntax tokens, cycled (the status hues stay for levels) */
const POD_TONES = 5;

const RowBody = memo(function RowBody({ entry, matcher, wrapped, cols, maxUnits, timestamps, label, source, podIndex, structured, expanded, cursor, selected, current }: Omit<RowProps, "top">) {
  if (entry.kind === MARK) {
    return (
      <div className="logs-mark" data-seq={entry.seq} data-cursor={cursor || undefined}>
        <span className="t-label">mark {formatClock(entry.ms, { millis: false })}</span>
      </div>
    );
  }
  if (entry.kind !== LINE) {
    return (
      <div className="logs-note" data-seq={entry.seq} data-kind={entry.kind === ERROR ? "error" : undefined} data-cursor={cursor || undefined}>
        <span className="logs-note-word t-label">{NOTE_WORD[entry.kind] ?? "note"}</span>
        <span className="logs-note-text t-ui truncate">
          {entry.text} · {formatClock(entry.ms, { millis: false })}
        </span>
      </div>
    );
  }

  if (entry.level === undefined) entry.level = detectLevel(entry.text);

  let text: ReactNode;
  const block = structured && expanded && (entry.fields?.length ?? 0) > 0;
  if (block) {
    // the head line, then one aligned `key  value` line per field
    const { head, rows, pad } = expandedLines(entry);
    const limit = cols > 0 ? cols + TRUNCATE_SLACK : 400;
    const headHits = matcher?.highlights ? matcher.ranges(head.text) : null;
    text = [
      <div className="logs-vline" key="h">{renderSegs(buildSegments(head.text, head.spans, head.level, headHits, limit))}</div>,
      ...rows.map((r, i) => {
        const line = `  ${r.key.padEnd(pad)}  ${r.value}`;
        const hits = matcher?.highlights ? matcher.ranges(line) : null;
        const keyEnd = 2 + Math.max(pad, r.key.length);
        return (
          <div className="logs-vline" key={i}>
            {renderSegs(buildSegments(line, [{ start: 0, end: keyEnd, tone: "muted", underline: false }], null, hits, limit))}
          </div>
        );
      }),
    ];
  } else if (structured) {
    const d = displayLine(entry);
    const hits = matcher?.highlights ? matcher.ranges(d.text) : null;
    // expanded without fields: the message wraps, as a plain line does
    text = renderLine(d.text, d.spans, d.level, hits, wrapped || expanded, cols, maxUnits);
  } else {
    text = renderLine(entry.text, entry.spans, entry.level, matcher?.highlights ? matcher.ranges(entry.text) : null, wrapped, cols, maxUnits);
  }

  return (
    <div
      className="logs-line line"
      data-seq={entry.seq}
      data-cursor={cursor || undefined}
      data-selected={selected || undefined}
      data-match-current={current || undefined}
      data-wrapped={wrapped || block || undefined}
    >
      {timestamps && <span className="logs-ts">{formatClock(entry.ms)}</span>}
      {label !== null && (
        <span className="logs-src" data-pod={podIndex === null ? undefined : podIndex % POD_TONES} {...tip(source, { plain: true, delay: CLIP_DELAY, reason: "click: go to this pod" })}>
          {label}
        </span>
      )}
      <span className="logs-text">{text}</span>
    </div>
  );
});

function renderLine(
  lineText: string,
  spans: Entry["spans"],
  level: Entry["level"],
  hits: ReturnType<Matcher["ranges"]> | null,
  wrapped: boolean,
  cols: number,
  maxUnits: number,
): ReactNode {
  let text: ReactNode;
  const entry = { text: lineText, spans, level: level ?? null };
  if (wrapped && cols > 0) {
    const room = maxUnits * cols;
    const cut = entry.text.length > room;
    const segs = buildSegments(entry.text, entry.spans, entry.level, hits, cut ? room - 1 : room);
    const lines = wrapSegments(segs, cols);
    text = lines.map((l, i) => (
      <div className="logs-vline" key={i}>
        {renderSegs(l)}
        {cut && i === lines.length - 1 && <span className="tone-muted">…</span>}
      </div>
    ));
  } else {
    // a truncated line never puts more than the visible columns (plus slack) into the DOM
    const limit = cols > 0 ? cols + TRUNCATE_SLACK : 400;
    text = renderSegs(buildSegments(entry.text, entry.spans, entry.level, hits, limit));
  }
  return text;
}

export const Row = memo(function Row({ top, ...body }: RowProps) {
  return (
    <div className="logs-row" style={{ transform: `translateY(${top}px)` }}>
      <RowBody {...body} />
    </div>
  );
});
