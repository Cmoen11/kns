// The activity panel (right): everything live in one list, grouped with counts. Port-forwards,
// shell / attach sessions, log streams, cluster writes in flight, connection and watch health, and
// Recent: the action log of what the human did and what happened (store/actionlog.ts), persisted
// per context; Enter jumps to where it happened (recent.ts). It reads the features' own stores; nothing here talks to the backend
// except the stop-all of forwards. Lazy chunk: mounted only while the panel is open. Idle cost is
// nil: the ages tick in their own leaf (Frame.tsx), and the row list is rebuilt only when something
// it shows changes; a 1s clock runs only while a log stream is sampled or a reconnect counts down.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { backend } from "../ipc";
import type { Forward } from "../ipc/types";
import { engine } from "../keys";
import { connOf, useCluster, windowContext } from "../store/cluster";
import { closePane, focusPane, getWorkspace, openView, paneOrder, paneView, useWorkspace } from "../store/layout";
import { leafIds } from "../store/layout-tree";
import { useOperations, type Operation } from "../store/operations";
import { usePaneStatuses, type PaneWatch } from "../store/pane-status";
import { flash } from "../store/status";
import { tables } from "../store/tables";
import { currentView } from "../store/workspace";
import type { PaneId } from "../types";
import { confirm, toast, toasts, type GlyphState } from "../ui";
import { titleOf } from "../views/registry";
import { logsOf } from "../views/logs/sessions";
import { forwardMeta, forwardName, getForwards, openForward, refreshForwards, setCursor as setForwardCursor, stopForward, useForwards, watchForwards } from "../views/shell/forwards";
import { forwardPanelRows } from "../views/shell/forward-rows";
import { forwardHost } from "../views/shell/ports";
import { sessionRefs } from "../views/shell/session-refs";
import { endSession, stopSession } from "../views/shell/end";
import { getSession, isLiveStatus, useSessions, type SessionInfo } from "../views/shell/state";
import { recordAction, useActionLog } from "../store/actionlog";
import { sessionStartedAt, useActivity, type LogStream } from "./activity";
import { recentRows } from "./recent";
import { PanelHeader, Rows } from "./Frame";
import { activityGroups, BUILTIN_ORDER, groupSection, layoutSections, type SectionSpec } from "./groups";
import { headerKey, type PanelRow } from "./model";
import { usePrefs } from "./store";

const TICK_MS = 1000;

const errorText = (e: unknown): string => (typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e));

/** A 1s clock that only runs while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") setNow(Date.now());
    }, TICK_MS);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Lines per second of each log pane, sampled on the panel's tick from the buffer's sequence counter. */
function useLogRates(streams: readonly LogStream[], now: number): ReadonlyMap<PaneId, number> {
  const last = useRef(new Map<PaneId, { seq: number; at: number }>());
  const [rates, setRates] = useState<ReadonlyMap<PaneId, number>>(() => new Map());
  useEffect(() => {
    const out = new Map<PaneId, number>();
    const seen = new Set<PaneId>();
    for (const s of streams) {
      seen.add(s.pane);
      const session = logsOf(s.pane)?.session;
      if (!session) continue;
      const seq = session.ring.nextSeq;
      const prev = last.current.get(s.pane);
      if (prev && now <= prev.at) {
        // the same tick again (StrictMode): keep the sample
        const kept = rates.get(s.pane);
        if (kept !== undefined) out.set(s.pane, kept);
        continue;
      }
      // a cleared or restarted buffer starts counting again
      if (prev && seq >= prev.seq) out.set(s.pane, Math.round(((seq - prev.seq) * 1000) / (now - prev.at)));
      last.current.set(s.pane, { seq, at: now });
    }
    for (const pane of [...last.current.keys()]) if (!seen.has(pane)) last.current.delete(pane);
    setRates((cur) => (cur.size === out.size && [...out].every(([k, v]) => cur.get(k) === v) ? cur : out));
    // sampled once per tick; `rates` is only read for the StrictMode repeat
  }, [streams, now]);
  return rates;
}

function useWatchHealth(): { subscriptions: number; reconnecting: number; failed: number } {
  const last = useRef<{ subscriptions: number; reconnecting: number; failed: number } | null>(null);
  const subscribe = useCallback((fn: () => void) => tables().subscribeHealth(fn), []);
  return useSyncExternalStore(subscribe, () => {
    const next = tables().health();
    const prev = last.current;
    if (prev && prev.subscriptions === next.subscriptions && prev.reconnecting === next.reconnecting && prev.failed === next.failed) return prev;
    return (last.current = next);
  });
}

// ── what the keys do ───────────────────────────────────────────────────────

function copyAddress(f: Forward): void {
  const text = forwardHost(f);
  navigator.clipboard.writeText(text).then(
    () => flash(`copied ${text}`),
    () => toasts.error("Copy failed: the clipboard is not available"),
  );
}

/** Enter on a forward: its row in the port-forward manager (an open manager pane is reused). */
function openForwardRow(f: Forward): void {
  const existing = paneOrder().find((p) => paneView(p)?.kind === "portforwards");
  const pane = existing ?? openView({ kind: "portforwards" });
  if (!pane) return;
  if (existing) focusPane(existing);
  const index = getForwards().findIndex((x) => x.id === f.id);
  if (index >= 0) setForwardCursor(pane, index);
}

const FROM_PANEL = "ended from the activity panel";

async function stopAllForwards(): Promise<void> {
  const list = getForwards();
  if (list.length === 0) return;
  const ok = await confirm({
    tier: 1,
    title: `Stop ${list.length} port-forward${list.length === 1 ? "" : "s"}`,
    items: list.map((f) => `${forwardHost(f)} -> ${forwardName(f)}`),
    confirmLabel: "Stop all",
    cancelLabel: "Keep",
  });
  if (!ok) return;
  const results = await Promise.allSettled(list.map((f) => backend.stopForward(f.id)));
  void refreshForwards();
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length > 0) toasts.error(`Could not stop ${failed.length} of ${list.length} port-forwards: ${errorText(failed[0].reason)}`);
  else toast({ kind: "ok", text: `Stopped ${list.length} port-forward${list.length === 1 ? "" : "s"}` });
}

/** x on a dev-set header in Port-forwards: stops every forward of the set (tier 0, like one forward). */
async function stopDevSet(id: string, name: string): Promise<void> {
  try {
    await backend.devSetDown(id);
    recordAction({ text: `dev set ${name} down`, state: "info", target: { kind: "devset", id } });
    toast({ kind: "ok", text: `Stopped dev set ${name}` });
  } catch (e) {
    recordAction({ text: `dev set ${name} down failed`, state: "error", error: errorText(e), target: { kind: "devset", id } });
    toasts.error(`Could not stop dev set ${name}: ${errorText(e)}`);
  }
  void refreshForwards();
}

async function stopAllSessions(live: readonly SessionInfo[]): Promise<void> {
  if (live.length === 0) return;
  const ok = await confirm({
    tier: 1,
    title: `End ${live.length} session${live.length === 1 ? "" : "s"}`,
    body: "The scrollback stays in each pane.",
    items: live.map((s) => `${s.kind} in ${s.pod}`),
    confirmLabel: "End all",
    cancelLabel: "Keep",
  });
  if (!ok) return;
  for (const s of live) if (isLiveStatus(getSession(s.id)?.status ?? "ended")) endSession(s.id, FROM_PANEL);
}

async function stopAllLogs(streams: readonly LogStream[]): Promise<void> {
  if (streams.length === 0) return;
  const ok = await confirm({
    tier: 1,
    title: `Close ${streams.length} log pane${streams.length === 1 ? "" : "s"}`,
    body: "A closed pane can be reopened.",
    items: streams.map((l) => l.title),
    confirmLabel: "Close all",
    cancelLabel: "Keep",
  });
  if (!ok) return;
  for (const l of streams) await closePane(l.pane);
}

const WATCH_WORD: Record<PaneWatch, string> = {
  live: "live", syncing: "syncing", reconnecting: "reconnecting", stale: "paused", forbidden: "forbidden", error: "error",
};
const WATCH_GLYPH: Record<PaneWatch, GlyphState> = {
  live: "ok", syncing: "progress", reconnecting: "progress", stale: "suspended", forbidden: "warn", error: "error",
};
const OP_GLYPH: Record<Operation["state"], GlyphState> = { running: "progress", ok: "ok", error: "error" };

// ── the panel ──────────────────────────────────────────────────────────────

export default function ActivityPanel() {
  const collapsed = usePrefs((s) => s.right.collapsed);
  const forwards = useForwards((s) => s.list);
  const devSetNames = useForwards((s) => s.devSetNames);
  const sessions = useSessions((s) => s);
  const streams = useActivity((s) => s.logs);
  const operations = useOperations((s) => s.list);
  const statuses = usePaneStatuses();
  const context = useCluster((s) => s.context);
  const status = useCluster((s) => s.status);
  const serverVersion = useCluster((s) => s.info?.serverVersion);
  const clusterError = useCluster((s) => s.error?.message);
  const retryAt = useCluster((s) => s.retryAt);
  const watches = useWatchHealth();
  // pane order and titles for the session, log and health rows
  const root = useWorkspace((ws) => ws?.root);
  const panes = useWorkspace((ws) => ws?.panes);
  // the clock: only for the lines/s sample and the reconnect countdown
  const now = useNow(streams.length > 0 || retryAt != null);
  const rates = useLogRates(streams, now);
  const wait = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;
  // Recent is the log of the focused pane's context (§8.3): the one keys act on
  const focusedCtx = useWorkspace((ws) => (ws ? (ws.panes[ws.focused]?.context ?? ws.context) : null));
  const logContext = focusedCtx ?? context;
  const recent = useActionLog(logContext);
  const conns = useCluster((s) => s.conns);
  // feature groups (groups.ts): the list is fixed once the panel has mounted, so calling each
  // group's hook here keeps the hook order stable
  const groups = activityGroups();
  const groupData = groups.map((g) => g.useRows());
  const groupDeps = groupData.flatMap((d) => [d.rows, d.count, d.stopAll, d.clear]);

  // connection counts while the panel shows forwards (2s, the manager's own rate); nothing is
  // polled with no forward (starting one refreshes the list by itself)
  const pollForwards = !(collapsed.forwards ?? false) && forwards.length > 0;
  useEffect(() => (pollForwards ? watchForwards() : undefined), [pollForwards]);

  const rows = useMemo(() => {
    const specs: SectionSpec[] = [];
    const section = (id: keyof typeof BUILTIN_ORDER, label: string, items: PanelRow[], extra?: Partial<PanelRow>) => {
      specs.push({ id, label, order: BUILTIN_ORDER[id], items, extra });
    };
    const order = root ? leafIds(root) : [];
    const paneNo = (pane: PaneId): number => order.indexOf(pane) + 1;
    const here = windowContext();

    // ── port-forwards ──
    section(
      "forwards",
      "Port-forwards",
      forwardPanelRows(forwards, {
        here,
        devSetNames,
        since: (f) => forwardMeta(f.id)?.at,
        activate: openForwardRow,
        stop: stopForward,
        copy: copyAddress,
        open: openForward,
        openSet: (id) => openView({ kind: "devsets", selected: id }),
        stopSet: stopDevSet,
      }),
      { stopAll: forwards.length > 0 ? stopAllForwards : undefined, count: forwards.length },
    );

    // ── shell / attach ──
    const live = Object.values(sessions).filter((s) => isLiveStatus(s.status));
    const refs = sessionRefs(getWorkspace());
    section(
      "sessions",
      "Shells",
      live.map((s): PanelRow => {
        const pane = refs.current.get(s.id);
        const started = sessionStartedAt(s.id);
        const facts = [s.kind, s.container ?? "default container", s.namespace];
        if (pane) facts.push(`pane ${paneNo(pane)}`);
        return {
          key: `sh:${s.id}`,
          section: "sessions",
          label: s.pod,
          detail: (s.status === "connecting" ? ["connecting", ...facts] : facts).join(" · "),
          since: started,
          glyph: s.status === "connecting" ? "progress" : "ok",
          activate: pane ? () => focusPane(pane) : undefined,
          stop: () => stopSession(s, FROM_PANEL),
        };
      }),
      { stopAll: live.length > 0 ? () => stopAllSessions(live) : undefined },
    );

    // ── log streams ──
    section(
      "logs",
      "Log streams",
      streams.map((l): PanelRow => {
        const watch = statuses[l.pane]?.watch ?? null;
        const rate = rates.get(l.pane);
        const facts = [rate === undefined ? "" : `${rate} lines/s`, l.container, watch && watch !== "live" ? WATCH_WORD[watch] : "", `pane ${paneNo(l.pane)}`].filter(Boolean);
        return {
          key: `log:${l.pane}`,
          section: "logs",
          label: l.title,
          detail: facts.join(" · "),
          since: l.since,
          glyph: watch ? WATCH_GLYPH[watch] : "suspended",
          activate: () => focusPane(l.pane),
          // a stream lives exactly as long as its pane shows it: stopping closes the pane
          stop: () => closePane(l.pane),
        };
      }),
      { stopAll: streams.length > 0 ? () => stopAllLogs(streams) : undefined },
    );

    // ── operations in flight; a finished one is in Recent (the write gate records its result line) ──
    const running = operations.filter((o) => o.state === "running");
    const opRow = (o: Operation, sectionId: string): PanelRow => {
      const running = o.state === "running";
      const facts = running
        ? [`${o.done}/${o.total}`, o.failed > 0 ? `${o.failed} failed` : "", o.context].filter(Boolean)
        : [o.state === "error" ? "failed" : "done", o.total > 1 ? `${o.done - o.failed}/${o.total}` : "", o.context].filter(Boolean);
      return {
        key: `op:${o.id}`,
        section: sectionId,
        label: o.text,
        detail: facts.join(" · "),
        since: running ? o.startedAt : (o.endedAt ?? o.startedAt),
        glyph: OP_GLYPH[o.state],
        stay: true,
        // a failure's full text is in the message log; anything else is read out in the bottom row
        activate: () => (o.state === "error" ? void engine.run("messages.open", { source: "api" }) : flash(o.text)),
      };
    };
    section("operations", "Operations", [...running].reverse().map((o) => opRow(o, "operations")), { count: running.length });

    // ── connection and watches ──
    const health: PanelRow[] = [];
    health.push({
      key: "health:connection",
      section: "health",
      label: context ?? "no context",
      detail: status === "connected" ? `connected${serverVersion ? ` · ${serverVersion}` : ""}` : status === "offline" ? `offline${retryAt ? ` · retry in ${wait}s` : ""}${clusterError ? ` · ${clusterError}` : ""}` : status,
      glyph: status === "connected" ? "ok" : status === "offline" ? "error" : "progress",
      stay: true,
      activate: () => void engine.run("conn.reconnect", { source: "api" }),
    });
    // panes in other contexts (§8.3): one row each, so a dead connection behind a pane is visible
    const others = new Set<string>();
    for (const p of Object.values(panes ?? {})) if (p.context && p.context !== context) others.add(p.context);
    for (const other of others) {
      const c = conns[other] ?? connOf(other);
      health.push({
        key: `health:connection:${other}`,
        section: "health",
        label: other,
        detail: c.status === "connected" ? `connected${c.info?.serverVersion ? ` · ${c.info.serverVersion}` : ""} · pane context` : c.status === "offline" ? `offline${c.error ? ` · ${c.error.message}` : ""}` : c.status,
        glyph: c.status === "connected" ? "ok" : c.status === "offline" ? "error" : "progress",
        stay: true,
        activate: () => void engine.run("conn.reconnect", { source: "api" }),
      });
    }
    health.push({
      key: "health:watches",
      section: "health",
      label: `${watches.subscriptions} watch${watches.subscriptions === 1 ? "" : "es"}`,
      detail: watches.reconnecting + watches.failed === 0 ? "all live" : [watches.reconnecting > 0 ? `${watches.reconnecting} reconnecting` : "", watches.failed > 0 ? `${watches.failed} failed` : ""].filter(Boolean).join(" · "),
      glyph: watches.failed > 0 ? "warn" : watches.reconnecting > 0 ? "progress" : "ok",
      stay: true,
      activate: () => void engine.run("conn.reconnect", { source: "api" }),
    });
    let problems = (status === "connected" ? 0 : 1) + (watches.reconnecting + watches.failed > 0 ? 1 : 0);
    for (const pane of order) {
      const st = statuses[pane];
      const p = panes?.[pane];
      // log panes have their own group
      if (!st?.watch || st.watch === "live" || !p || currentView(p).kind === "logs") continue;
      problems++;
      health.push({
        key: `health:pane:${pane}`,
        section: "health",
        label: `pane ${paneNo(pane)}: ${titleOf(currentView(p))}`,
        detail: `${WATCH_WORD[st.watch]}${st.message ? ` · ${st.message}` : ""}`,
        glyph: WATCH_GLYPH[st.watch],
        activate: () => focusPane(pane),
      });
    }
    section("health", "Connection", health, { count: problems });

    // ── recent: the action log, newest first; failures stay marked ──
    section("recent", logContext && logContext !== context ? `Recent · ${logContext}` : "Recent", recentRows(recent, logContext ?? undefined), { clearable: recent.length > 0 });

    // ── feature groups, placed by their order; a group with no rows renders nothing ──
    groups.forEach((g, i) => specs.push(groupSection(g, groupData[i])));
    return layoutSections(specs, collapsed, headerKey);
    // groupDeps: each group's rows (groups is fixed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, forwards, devSetNames, sessions, streams, recent, operations, statuses, context, logContext, conns, status, serverVersion, clusterError, retryAt, wait, watches, root, panes, rates, ...groupDeps]);

  return (
    <>
      <PanelHeader side="right" title="Activity" toggle="activity.toggle" />
      <Rows side="right" rows={rows} label="Activity" />
    </>
  );
}
