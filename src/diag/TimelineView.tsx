// The `timeline` view (docs/plan-features.md §3 C2): TIME · SOURCE · WHAT for an object, what it
// owns, its pods and their nodes, oldest first (the newest row is at the bottom, where the cursor
// starts). Enter describes the row's object, `l` opens its logs at that time. Keys arrive as
// registry actions through the pane's controller; this component has no key handling. Every
// `what` comes from Rust cleaned and redacted, and is rendered as text only.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TimelineRow } from "../ipc/types";
import { backend, openInContext, paneContext, usePaneContext, EmptyState, flash, Glyph, Icon, keepFocus, PaneSlot, tip, toObjRef, type ViewProps } from "../foundation";
import { cleanUntrusted } from "../ui/untrusted";
import { invalidateC2 } from "./c2-actions";
import { timelineControllers, type NewPane, type TimelineController } from "./c2-controller";
import { errorText } from "./c2-store";
import { listPointer } from "./list-pointer";
import { countLabel, logsTarget, rowTarget, sinceLabel, SOURCE_LABEL, timeLabel } from "./timeline-model";
import "./c2.css";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; rows: TimelineRow[]; at: number };

const SEV_GLYPH = { error: "error", warn: "warn", info: null } as const;
const clamp = (i: number, n: number) => (n === 0 ? 0 : Math.min(Math.max(0, i), n - 1));

export default function TimelineView({ pane, view, focused }: ViewProps<"timeline">) {
  const context = usePaneContext(pane);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [cursor, setCursorState] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const seq = useRef(0);
  const ref = view.ref;
  const refKey = `${ref.gvr.group}/${ref.gvr.resource}/${ref.namespace ?? ""}/${ref.name}/${view.sinceMinutes}`;

  useEffect(() => {
    if (!context) return;
    const id = ++seq.current;
    backend.timeline(toObjRef(ref, context), view.sinceMinutes).then(
      (rows) => {
        if (id !== seq.current) return;
        setLoad((prev) => {
          // first load: the cursor starts on the newest row
          if (prev.state !== "ok") setCursorState(Math.max(0, rows.length - 1));
          return { state: "ok", rows, at: Date.now() };
        });
      },
      (e: unknown) => {
        if (id === seq.current) setLoad({ state: "error", message: errorText(e) });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, refKey, epoch]);

  const rows = useMemo(() => (load.state === "ok" ? load.rows : []), [load]);
  const cur = clamp(cursor, rows.length);
  const state = useRef({ rows, cur });
  state.current = { rows, cur };
  const setCursor = useCallback((i: number) => {
    state.current.cur = clamp(i, state.current.rows.length);
    setCursorState(state.current.cur);
  }, []);

  useEffect(() => {
    const open = (newPane: NewPane, target: ReturnType<typeof rowTarget>) => {
      if (!target) return flash("this row names no object", "warn");
      openInContext(target, state.current.rows[state.current.cur]?.ref?.context || paneContext(pane), { pane, newPane });
    };
    const c: TimelineController = {
      move: (d) => setCursor(state.current.cur + d),
      moveTo: (w) => setCursor(w === "top" ? 0 : state.current.rows.length - 1),
      open: (newPane) => open(newPane, rowTarget(state.current.rows[state.current.cur])),
      canOpen: () => (rowTarget(state.current.rows[state.current.cur]) ? true : "this row names no object"),
      logs: (newPane) => open(newPane, logsTarget(state.current.rows[state.current.cur], ref)),
      canLogs: () => (logsTarget(state.current.rows[state.current.cur], ref) ? true : "no pod for this row"),
      refresh: () => setEpoch((n) => n + 1),
      loaded: () => state.current.rows.length > 0,
    };
    timelineControllers.set(pane, c);
    return () => timelineControllers.set(pane, null);
  }, [pane, ref, setCursor]);

  useEffect(() => invalidateC2(), [rows, cur]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${cur}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cur, rows]);

  const pointer = useMemo(() => listPointer(pane, setCursor, invalidateC2), [pane, setCursor]);

  const label = cleanUntrusted(`${ref.gvr.resource.replace(/s$/, "")}/${ref.name}${ref.namespace ? ` (${ref.namespace})` : ""}`);
  const head = (
    <div className="c2-head t-ui">
      <span className="c2-head-ref">{label}</span>
      <span className="muted">last {sinceLabel(view.sinceMinutes)}</span>
      {load.state === "ok" && <span className="muted">read {new Date(load.at).toLocaleTimeString()}</span>}
    </div>
  );
  if (load.state === "loading") return <div className="c2">{head}<EmptyState compact>reading what happened to {label}</EmptyState></div>;
  if (load.state === "error") return <div className="c2">{head}<EmptyState compact title="Could not read the timeline">{cleanUntrusted(load.message)}</EmptyState></div>;

  const now = new Date();
  return (
    <div className="c2" data-active={focused || undefined}>
      <PaneSlot name="count">{countLabel(rows)}</PaneSlot>
      {head}
      {rows.length === 0 ? (
        <EmptyState compact title="Nothing happened in this window">
          No events, restarts or rollouts in the last {sinceLabel(view.sinceMinutes)}. Events older than about an hour need the event journal (:journal on); a wider window: :timeline 1d on the row.
        </EmptyState>
      ) : (
        <>
          <div className="c2-cols t-label" aria-hidden>
            <span className="c2-time">time</span>
            <span className="c2-src">source</span>
            <span>what</span>
          </div>
          <div className="c2-list" ref={listRef} role="listbox" aria-label="timeline" {...pointer}>
            {rows.map((r, i) => {
              const sev = r.severity ? SEV_GLYPH[r.severity] : null;
              return (
                <div key={`${i}:${r.at}`} className="c2-row row t-cell" data-index={i} data-focus={i === cur || undefined} data-sev={r.severity} role="option" aria-selected={i === cur} title={r.at}>
                  <span className="c2-time muted">{timeLabel(r.at, now)}</span>
                  <span className="c2-src muted">{SOURCE_LABEL[r.source]}</span>
                  <span className="c2-glyph">{sev && <Glyph state={sev} />}</span>
                  <span className="c2-what" dir="ltr">{r.what}</span>
                  {r.ref && (
                    <button type="button" className="k-abtn c2-open" tabIndex={-1} data-act="open" onMouseDown={keepFocus} aria-label="describe" {...tip("describe", { reason: "Enter · Ctrl+click opens beside" })}>
                      <Icon name="open" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
