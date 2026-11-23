// The `traps` view (`:traps`, docs/plan-features.md §3 C2): armed traps, each followed by the
// incident bundles it captured. Enter opens a bundle (the trap's newest on a trap row) as a `text`
// view; `x` disarms. Keys arrive through the pane's controller; no key handling here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { backend, EmptyState, Icon, keepFocus, openView, PaneSlot, tip, toast, toasts, useCluster, type ViewProps } from "../foundation";
import { cleanUntrusted } from "../ui/untrusted";
import { invalidateC2 } from "./c2-actions";
import { trapsControllers, type TrapsController } from "./c2-controller";
import { errorText, refreshTraps, useC2 } from "./c2-store";
import { listPointer } from "./list-pointer";
import { timeLabel } from "./timeline-model";
import { rowBundle, trapDetail, trapRows, trapTargetLabel, TRIGGER_WORD } from "./traps-model";
import "./c2.css";

const clamp = (i: number, n: number) => (n === 0 ? 0 : Math.min(Math.max(0, i), n - 1));

function openBundle(id: string, title: string, newPane: "right" | "down" | null, pane?: string): void {
  openView({ kind: "text", title: `bundle · ${title}`, source: { by: "bundle", id } }, { pane, newPane });
}

export default function TrapsView({ pane, focused }: ViewProps<"traps">) {
  const traps = useC2((s) => s.traps);
  const loadedOnce = useC2((s) => s.loaded);
  const context = useCluster((s) => s.context);
  const rows = useMemo(() => trapRows(traps), [traps]);
  const [cursor, setCursorState] = useState(0);
  const cur = clamp(cursor, rows.length);
  const state = useRef({ rows, cur });
  state.current = { rows, cur };
  const setCursor = useCallback((i: number) => {
    state.current.cur = clamp(i, state.current.rows.length);
    setCursorState(state.current.cur);
  }, []);

  useEffect(() => void refreshTraps(), []);

  useEffect(() => {
    const c: TrapsController = {
      move: (d) => setCursor(state.current.cur + d),
      moveTo: (w) => setCursor(w === "top" ? 0 : state.current.rows.length - 1),
      open: (newPane) => {
        const row = state.current.rows[state.current.cur];
        const id = rowBundle(row);
        if (row && id) openBundle(id, trapTargetLabel(row.trap), newPane, pane);
      },
      canOpen: () => (rowBundle(state.current.rows[state.current.cur]) ? true : state.current.rows.length ? "this trap has not fired yet" : "no traps"),
      disarm: () => {
        const row = state.current.rows[state.current.cur];
        if (!row) return;
        backend.trapDisarm(row.trap.id).then(
          () => {
            toast({ kind: "ok", text: `Trap on ${cleanUntrusted(trapTargetLabel(row.trap))} disarmed${row.trap.fired.length ? " (its bundles stay)" : ""}` });
            void refreshTraps();
          },
          (e: unknown) => toasts.error(`Disarm: ${errorText(e)}`),
        );
      },
      canDisarm: () => (state.current.rows[state.current.cur] ? true : "no trap selected"),
      refresh: () => void refreshTraps(),
      loaded: () => true,
    };
    trapsControllers.set(pane, c);
    return () => trapsControllers.set(pane, null);
  }, [pane, setCursor]);

  useEffect(() => invalidateC2(), [rows, cur]);

  const pointer = useMemo(() => listPointer(pane, setCursor, invalidateC2), [pane, setCursor]);
  const now = new Date();

  const head = (
    <div className="c2-head t-ui">
      <span className="c2-head-ref">traps</span>
      <span className="muted">only while kns runs · bundles are redacted and stay on this machine</span>
    </div>
  );
  if (!loadedOnce) return <div className="c2">{head}<EmptyState compact>loading</EmptyState></div>;
  return (
    <div className="c2" data-active={focused || undefined}>
      <PaneSlot name="count">{`${traps.length} armed`}</PaneSlot>
      {head}
      {rows.length === 0 ? (
        <EmptyState compact title="No traps armed">
          Select a pod, workload or Service and run :trap (row menu: trap). When it restarts, OOMs or crash-loops, kns saves an incident bundle here{context ? "" : " (connect first)"}.
        </EmptyState>
      ) : (
        <div className="c2-list" role="listbox" aria-label="traps" {...pointer}>
          {rows.map((r, i) =>
            r.type === "trap" ? (
              <div key={r.key} className="c2-row row t-cell" data-index={i} data-focus={i === cur || undefined} role="option" aria-selected={i === cur}>
                <Icon name="trap" />
                <span className="c2-what" dir="ltr">{cleanUntrusted(trapTargetLabel(r.trap))}</span>
                <span className="c2-detail">{trapDetail(r.trap)}</span>
                <button type="button" className="k-abtn c2-open" tabIndex={-1} data-act="trap.disarm" onMouseDown={keepFocus} aria-label="disarm" {...tip("disarm", { reason: "x" })}>
                  <Icon name="stop" />
                </button>
              </div>
            ) : (
              <div key={r.key} className="c2-row c2-bundle row t-cell" data-index={i} data-focus={i === cur || undefined} role="option" aria-selected={i === cur}>
                <span className="c2-time muted">{timeLabel(r.at, now)}</span>
                <span className="c2-what">bundle {r.bundleId}</span>
                <span className="c2-detail">{r.trap.triggers.map((t) => TRIGGER_WORD[t]).join(", ")}</span>
                <button type="button" className="k-abtn c2-open" tabIndex={-1} data-act="open" onMouseDown={keepFocus} aria-label="open bundle" {...tip("open bundle", { reason: "Enter · Ctrl+click opens beside" })}>
                  <Icon name="open" />
                </button>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
