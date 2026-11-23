// The patterns view (docs/plan-features.md §3 E): the source logs pane's buffer reduced to line
// templates, counted: COUNT · FIRST · LAST · LEVEL · TEMPLATE. Mined in a module worker over the
// newest 20k lines, again when new lines arrived (debounced, only while visible). NEW marks
// templates that the previous container run (a one-shot `previous` read, 2000 lines per stream)
// never printed. When the source pane closes or leaves its logs view the table freezes.
import { useEffect, useMemo, useRef, useSyncExternalStore, type MouseEvent } from "react";
import { backend, engine, paneContext, PaneSlot, PaneToolbar, paneIndex, useWorkspace, type ViewProps } from "../../foundation";
import type { LogLine } from "../../ipc/types";
import { cleanUntrusted } from "../../ui/untrusted";
import { EmptyState, runAction, type ToolbarItem } from "../../ui";
import { parseAnsi } from "./ansi";
import { MAX_LINES, type MineLine } from "./patterns";
import { acquirePatterns, holdPatterns, releasePatterns, type PatternsModel } from "./patterns-model";
import { minerOnMainThread, runMine, holdMiner } from "./patterns-run";
import { LINE, type LogSession } from "./session";
import { logsOf } from "./sessions";
import { formatClock } from "./time";
import "./patterns.css";

/** new lines in the source wait this long before the table is mined again */
const REMINE_MS = 2000;
/** lines read per stream of the previous container run */
const PREVIOUS_TAIL = 2000;
/** at most this many streams are read for the previous run */
const PREVIOUS_STREAMS = 8;
const PREVIOUS_TIMEOUT_MS = 20_000;
/** rows rendered; more are summarised */
const MAX_ROWS = 1000;

/** The newest lines of the session, as the miner wants them. */
function snapshot(s: LogSession): MineLine[] {
  const out: MineLine[] = [];
  const n = s.ring.size;
  for (let i = Math.max(0, n - MAX_LINES * 2); i < n; i++) {
    const e = s.ring.at(i);
    if (e && e.kind === LINE) out.push(e.plevel ? { text: e.text, ms: e.ms, level: e.plevel } : { text: e.text, ms: e.ms });
  }
  return out.length > MAX_LINES ? out.slice(out.length - MAX_LINES) : out;
}

/** Reads the previous container run of every stream (one-shot), as plain text. */
function readPrevious(s: LogSession, context: string, done: (texts: string[]) => void): () => void {
  const sources = s.sources.slice(0, PREVIOUS_STREAMS);
  const texts: string[] = [];
  let open = sources.length;
  let finished = false;
  const unsubs: (() => void)[] = [];
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    for (const u of unsubs) u();
    done(texts);
  };
  const timer = setTimeout(finish, PREVIOUS_TIMEOUT_MS);
  if (open === 0) finish();
  for (const src of sources) {
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (--open === 0) finish();
    };
    unsubs.push(
      backend.streamLogs(
        { context, targets: [{ namespace: src.namespace, pod: src.pod, container: src.container }], follow: false, previous: true, tailLines: PREVIOUS_TAIL },
        (e) => {
          if (e.type === "lines") for (const l of e.lines as LogLine[]) texts.push(parseAnsi(l.text).text);
          // no previous run ("previous terminated container not found") counts as an empty one
          else end();
        },
      ),
    );
  }
  return finish;
}

const LEVEL_TEXT: Record<string, string> = { trace: "TRACE", debug: "DEBUG", info: "INFO", warn: "WARN", error: "ERROR", fatal: "FATAL" };

function Row({ m, index, cursor }: { m: PatternsModel; index: number; cursor: boolean }) {
  const p = m.rows[index];
  const hue = p.level === "warn" ? "warn" : p.level === "error" || p.level === "fatal" ? "error" : undefined;
  return (
    <div className="pat-row t-mono" role="row" data-index={index} data-cursor={cursor || undefined} aria-selected={cursor}>
      <span className="pat-count num">{p.count}</span>
      <span className="pat-time num">{formatClock(p.first, { millis: false })}</span>
      <span className="pat-time num">{formatClock(p.last, { millis: false })}</span>
      <span className="pat-level" data-level={hue}>{p.level ? LEVEL_TEXT[p.level] : ""}</span>
      <span className="pat-template">
        {p.isNew && <span className="pat-new t-label">new</span>}
        {cleanUntrusted(p.template, 400)}
      </span>
    </div>
  );
}

export default function PatternsView({ pane, view, visible }: ViewProps<"patterns">) {
  const m = useMemo(() => acquirePatterns(pane, view.source), [pane, view.source]);
  useSyncExternalStore(m.subscribe, m.getVersion);
  m.errorsOnly = view.errorsOnly;

  useEffect(() => {
    holdPatterns(pane, m);
    engine.invalidate();
    const drop = holdMiner();
    return () => {
      drop();
      releasePatterns(pane, m);
    };
  }, [pane, m]);

  // the source is alive while its pane exists and still shows its logs view
  const sourceKind = useWorkspace((ws) => {
    const p = ws?.panes[view.source];
    return p ? p.history[p.index]?.kind : undefined;
  });
  const alive = sourceKind === "logs";
  const sourceIsPrevious = useWorkspace((ws) => {
    const p = ws?.panes[view.source];
    const v = p?.history[p.index];
    return v?.kind === "logs" && v.previous;
  });

  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    if (!alive) {
      if (!m.closed) {
        m.closed = true;
        m.touch();
      }
      return;
    }
    const pl = logsOf(view.source);
    if (!pl) return;
    const s = pl.session;
    m.closed = false;
    let disposed = false;
    let job = 0;
    let minedAt = -1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopPrevious: (() => void) | undefined;

    const mineNow = () => {
      timer = undefined;
      if (disposed) return;
      const lines = snapshot(s);
      minedAt = s.linesIn;
      const id = ++job;
      m.mining = true;
      m.touch();
      void runMine(lines, m.previousTexts, (done, total) => {
        if (disposed || id !== job) return;
        m.progress = { done, total };
        m.touch();
      }).then((r) => {
        if (disposed || id !== job) return;
        m.mainThread = minerOnMainThread();
        m.setResult(r.patterns, r.lines);
      });
    };
    const startPrevious = () => {
      if (m.previous !== "none") return;
      if (sourceIsPrevious) {
        m.previous = "skipped";
        return;
      }
      if (s.sources.length === 0) return;
      m.previous = "loading";
      stopPrevious = readPrevious(s, paneContext(pane), (texts) => {
        if (disposed) return;
        m.previousLines = texts.length;
        // no previous run (or nothing in it): nothing is marked NEW
        m.previous = texts.length > 0 ? "ready" : "empty";
        m.previousTexts = texts.length > 0 ? texts : null;
        mineNow();
      });
    };
    m.refresh = () => {
      if (timer) clearTimeout(timer);
      mineNow();
    };
    const onSource = () => {
      startPrevious();
      if (s.linesIn === minedAt || timer || !visibleRef.current) return;
      timer = setTimeout(mineNow, REMINE_MS);
    };
    startPrevious();
    mineNow();
    const unsub = s.subscribe(onSource);
    return () => {
      disposed = true;
      unsub();
      if (timer) clearTimeout(timer);
      stopPrevious?.();
      if (m.previous === "loading") m.previous = "none";
      m.refresh = () => {};
    };
  }, [m, alive, view.source, sourceIsPrevious]);

  // a pane that becomes visible again catches up once
  useEffect(() => {
    if (visible && alive) m.refresh();
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = m.rows;
  const cursor = m.cursor;
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor, rows]);

  const toolbar = useMemo<ToolbarItem[]>(
    () => [
      { action: "nav.open", icon: "filter", label: "filter the logs to this pattern" },
      { action: "patterns.errorsOnly", active: view.errorsOnly, label: "errors only" },
      "|",
      "view.refresh",
      "hub.help",
    ],
    [view.errorsOnly],
  );

  const at = (e: MouseEvent): number => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
    return el ? Number(el.dataset.index) : -1;
  };
  const onClick = (e: MouseEvent) => {
    const i = at(e);
    if (i >= 0) m.moveTo(i);
  };
  const onDoubleClick = (e: MouseEvent) => {
    const i = at(e);
    if (i >= 0) runAction("nav.open", { pane, before: () => m.moveTo(i) });
  };

  const src = paneIndex(view.source);
  const state = m.closed
    ? "source closed"
    : m.mining
      ? m.progress
        ? `mining ${m.progress.done.toLocaleString()}/${m.progress.total.toLocaleString()}`
        : "mining"
      : null;
  const prev =
    m.previous === "ready" ? "new vs previous run" : m.previous === "empty" ? "no previous run" : m.previous === "loading" ? "reading previous run" : null;

  return (
    <div className="pat">
      <PaneSlot name="labels">
        <span className="pat-labels">
          {state && <span className="pat-state">{state}</span>}
          {view.errorsOnly && <span>errors only</span>}
          {prev && <span>{prev}</span>}
          {m.mainThread && <span>no worker</span>}
        </span>
      </PaneSlot>
      <PaneSlot name="count">{`${rows.length}/${m.patterns.length} · ${m.lines.toLocaleString()} lines`}</PaneSlot>
      <PaneToolbar items={toolbar} label="Patterns" />
      <div className="pat-head t-label" role="row">
        <span className="pat-count">count</span>
        <span className="pat-time">first</span>
        <span className="pat-time">last</span>
        <span className="pat-level">level</span>
        <span className="pat-template">template{src ? ` · logs of pane ${src}` : ""}</span>
      </div>
      <div ref={listRef} className="pat-list" role="grid" aria-label="Log patterns" onClick={onClick} onDoubleClick={onDoubleClick}>
        {rows.slice(0, MAX_ROWS).map((_, i) => (
          <Row key={rows[i].template} m={m} index={i} cursor={i === cursor} />
        ))}
        {rows.length > MAX_ROWS && <div className="pat-more t-ui">{rows.length - MAX_ROWS} more patterns not shown</div>}
      </div>
      {rows.length === 0 && (
        <div className="pat-empty">
          <EmptyState compact>
            {m.closed
              ? "The source logs pane is gone; nothing to mine."
              : m.mining
                ? "Mining the log lines."
                : m.patterns.length > 0
                  ? "No pattern has an error level."
                  : "No log lines to group yet."}
          </EmptyState>
        </div>
      )}
    </div>
  );
}
