// Cluster state: contexts, the window's context (§8.2), connection health, discovery per context,
// the alias map and the namespace list (a shared table subscription).
import { useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { backend } from "../ipc";
import type { ApiResource, BackendError, ClusterInfo, ContextInfo, Gvr, SsoStatus, TableQuery } from "../ipc/types";
import { buildAliases, gvrKey, resolveAlias, type AliasMap } from "./aliases";
import { focusedContext, layoutStore, openTabs, removeTab, setLayoutContext, tabContexts, tabLiveSessions, tabMru, tabToEvict } from "./layout";
import { afterClose, stepTab as stepIn } from "./tabs";
import { setActiveContext } from "./settings";
import { initTables, tables, useTable, type Lease } from "./tables";
import { CORE_NAMESPACES } from "./workspace";
import { confirm } from "../ui/confirm";
import { flash } from "./status";
import { toasts } from "../ui/toast";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "offline";

/** Connection and discovery of one context. */
export interface ContextConn {
  status: ConnectionStatus;
  info: ClusterInfo | null;
  error: BackendError | null;
  /** when the next automatic connect attempt runs (ms epoch), while offline */
  retryAt: number | null;
  /** discovery; empty until it arrives */
  resources: readonly ApiResource[];
  discovered: boolean;
  aliases: AliasMap;
}

export interface ClusterState extends ContextConn {
  contexts: readonly ContextInfo[];
  /** kubeconfig files that were read */
  files: readonly string[];
  /** kubeconfig's current-context */
  kubeCurrent?: string;
  /**
   * The window's context (§8.2); null until contexts are known and nothing was persisted. The
   * ContextConn fields at the top level mirror this context; a pane in another one (§8.3) reads
   * `conns[its context]`.
   */
  context: string | null;
  /** every context this session connected or is connecting, by name */
  conns: Readonly<Record<string, ContextConn>>;
  /** the context an `aws sso login` is running for */
  signingIn: string | null;
  /**
   * SSO sign-in status of the contexts with an AWS profile; null until the first check. A failed
   * check leaves an empty map: every such context then offers its sign-in, as before.
   */
  sso: Readonly<Record<string, SsoStatus>> | null;
}

const NO_ALIASES = buildAliases([]);
const IDLE: ContextConn = { status: "idle", info: null, error: null, retryAt: null, resources: [], discovered: false, aliases: NO_ALIASES };

export const clusterStore = createStore<ClusterState>(() => ({
  ...IDLE, contexts: [], files: [], context: null, conns: {}, signingIn: null, sso: null,
}));

/** Narrow selector: useCluster((s) => s.contexts). For a pane's connection use useConn. */
export function useCluster<T>(select: (s: ClusterState) => T): T {
  return useStore(clusterStore, select);
}
export const getCluster = (): ClusterState => clusterStore.getState();
/**
 * The window's kube context ("" before it is known): the titlebar, the context sidebar, the
 * workspace key. What an action or a view is about is a pane's context: paneContext(pane) /
 * focusedContext() / usePaneContext(pane) (§8.3).
 */
export const windowContext = (): string => clusterStore.getState().context ?? "";

/** The connection of a context (idle when it was never connected). */
export const connOf = (context: string, s: ClusterState = clusterStore.getState()): ContextConn => s.conns[context] ?? IDLE;
/** Narrow selector on a context's connection. */
export function useConn<T>(context: string, select: (c: ContextConn) => T): T {
  return useStore(clusterStore, (s) => select(connOf(context, s)));
}

/** Writes a context's connection; the window's is mirrored at the top level. */
function setConn(context: string, patch: Partial<ContextConn>): void {
  clusterStore.setState((s) => {
    const conn = { ...connOf(context, s), ...patch };
    const out: Partial<ClusterState> = { conns: { ...s.conns, [context]: conn } };
    return s.context === context ? { ...out, ...conn } : out;
  });
}

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

/** Per-context connect bookkeeping: a foreign pane's connect never cancels the window's. */
interface Runtime {
  attempt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  generation: number;
  nsLease: Lease | null;
}
const runtimes = new Map<string, Runtime>();
const runtime = (context: string): Runtime => {
  let r = runtimes.get(context);
  if (!r) runtimes.set(context, (r = { attempt: 0, retryTimer: null, generation: 0, nsLease: null }));
  return r;
};

const asError = (e: unknown): BackendError => {
  const b = e as Partial<BackendError> | null;
  return { code: typeof b?.code === "number" ? b.code : 0, reason: typeof b?.reason === "string" ? b.reason : "Error", message: typeof b?.message === "string" ? b.message : String(e) };
};

function namespacesQuery(context: string): TableQuery {
  return { context, gvr: CORE_NAMESPACES };
}

async function connect(context: string): Promise<void> {
  const rt = runtime(context);
  const gen = ++rt.generation;
  if (rt.retryTimer) clearTimeout(rt.retryTimer);
  rt.retryTimer = null;
  if (!clusterStore.getState().contexts.some((c) => c.name === context) && clusterStore.getState().contexts.length > 0) {
    // a pane restored in a context the kubeconfig no longer has: say so, never show another cluster
    setConn(context, { status: "offline", error: { code: 0, reason: "Config", message: `no context "${context}" in the kubeconfig` }, retryAt: null });
    return;
  }
  setConn(context, { status: "connecting", retryAt: null });
  try {
    const info = await backend.connect(context);
    if (gen !== rt.generation) return;
    rt.attempt = 0;
    setConn(context, { status: "connected", info, error: null });
    // the namespace list is one shared watch per context; pickers and `:ns` read it
    rt.nsLease?.release();
    rt.nsLease = tables().acquire(namespacesQuery(context));
    const resources = await backend.discover(context);
    if (gen !== rt.generation) return;
    setConn(context, { resources, aliases: buildAliases(resources), discovered: true });
  } catch (e) {
    if (gen !== rt.generation) return;
    const wait = BACKOFF_MS[Math.min(rt.attempt, BACKOFF_MS.length - 1)];
    rt.attempt++;
    setConn(context, { status: "offline", error: asError(e), retryAt: Date.now() + wait });
    // the app never exits on connection loss (§2.5): keep trying with backoff
    rt.retryTimer = setTimeout(() => void connect(context), wait);
  }
}

/** Stops retrying a context nothing on screen shows; its discovery stays cached. */
function release(context: string): void {
  const rt = runtimes.get(context);
  if (!rt) return;
  rt.generation++;
  if (rt.retryTimer) clearTimeout(rt.retryTimer);
  rt.retryTimer = null;
  rt.nsLease?.release();
  rt.nsLease = null;
  rt.attempt = 0;
  const c = connOf(context);
  if (c.status !== "idle") setConn(context, { status: "idle", info: null, error: null, retryAt: null });
}

/**
 * Connects a context a pane shows, unless it is connected or connecting (§8.3). Panes call it on
 * mount; the window's context is connected by activate.
 */
export function ensureConnected(context: string): void {
  if (!context) return;
  const c = connOf(context);
  if (c.status === "idle") void connect(context);
}

/** Releases every context no pane of an open tab and not the window shows. */
function releaseUnused(): void {
  const used = new Set(tabContexts());
  const win = clusterStore.getState().context;
  if (win) used.add(win);
  for (const name of runtimes.keys()) if (!used.has(name)) release(name);
}

function activate(context: string): void {
  const s = clusterStore.getState();
  clusterStore.setState({ context, ...connOf(context, s) });
  setLayoutContext(context, undefined, s.contexts.find((c) => c.name === context)?.namespace);
  setActiveContext(focusedContext() || context);
  const c = connOf(context);
  if (c.status !== "connected" && c.status !== "connecting") {
    runtime(context).attempt = 0;
    void connect(context);
  }
  releaseUnused();
}

let started = false;
/**
 * Startup: paints the persisted workspace first (no cluster call), then lists contexts, connects
 * and discovers. Call once from main.tsx.
 */
export async function initCluster(): Promise<void> {
  if (started) return;
  started = true;
  initTables(backend);
  watchPaneContexts();
  await layoutStore.hydrated;
  const persisted = layoutStore.getState().current;
  if (persisted) {
    clusterStore.setState({ context: persisted });
    setActiveContext(focusedContext() || persisted);
  }
  try {
    const list = await backend.listContexts();
    clusterStore.setState({ contexts: list.contexts, files: list.files, kubeCurrent: list.current });
    const names = list.contexts.map((c) => c.name);
    const pick = persisted && names.includes(persisted) ? persisted : list.current && names.includes(list.current) ? list.current : names[0];
    if (pick) {
      activate(pick);
      for (const c of tabContexts()) ensureConnected(c);
    }
    else clusterStore.setState({ status: "offline", error: { code: 0, reason: "Config", message: "No kube context found" } });
  } catch (e) {
    clusterStore.setState({ status: "offline", error: asError(e) });
  }
}

/**
 * Switches the window's context (§8.2): goes to its tab, opening one when it is not open. The tab
 * left behind stays warm, its shells keep running. A full strip first closes the least recently
 * used tab; when that ends live sessions, they are confirmed.
 */
export async function switchContext(name: string): Promise<boolean> {
  const s = clusterStore.getState();
  if (!s.contexts.some((c) => c.name === name)) return false;
  if (s.context === name) return true;
  const evict = tabToEvict(name);
  if (evict) {
    if (!(await confirmTabEnd(evict, `Open ${name}`, `The ${evict} tab closes to make room. These sessions end.`))) return false;
    removeTab(evict);
  }
  activate(name);
  return true;
}

async function confirmTabEnd(context: string, title: string, body: string): Promise<boolean> {
  const ending = tabLiveSessions(context).filter((l) => l.onClose === "ends").map((l) => l.label);
  if (ending.length === 0) return true;
  return !!(await confirm({ tier: 1, title, body, items: ending, confirmLabel: "End", cancelLabel: "Keep" }));
}

/**
 * Closes a context tab (default: the one on screen). Its workspace stays saved, so opening the
 * context again lands where it was; its connection, watches and live sessions end (confirmed).
 */
export async function closeTab(context: string | null = clusterStore.getState().context): Promise<boolean> {
  const tabs = openTabs();
  if (!context || !tabs.includes(context)) return false;
  const next = afterClose(tabs, context, tabMru());
  if (!next) {
    flash("the last tab stays open");
    return false;
  }
  if (!(await confirmTabEnd(context, `Close ${context}`, "These sessions end."))) return false;
  if (clusterStore.getState().context === context) activate(next);
  removeTab(context);
  releaseUnused();
  return true;
}

/** Ctrl+Tab / Ctrl+Shift+Tab: the next or previous tab in strip order. */
export function stepTab(delta: 1 | -1): boolean {
  const cur = clusterStore.getState().context;
  const next = stepIn(openTabs(), cur, delta);
  if (!next || next === cur) return false;
  activate(next);
  return true;
}

/** F5 / :reconnect: retries now (every context of an open tab), resets the backoff and re-opens every watch. */
export function reconnect(): void {
  const context = clusterStore.getState().context;
  if (!context) return;
  tables().resyncAll();
  const all = new Set([context, ...tabContexts()]);
  for (const c of all) {
    runtime(c).attempt = 0;
    void connect(c);
  }
}

/**
 * `aws sso login` for a context (the AWS CLI opens the browser). Afterwards the sign-in status is
 * read again, and every context on screen that signs in with that login connects at once instead
 * of waiting for its backoff.
 */
export async function awsSsoLogin(context: string): Promise<void> {
  if (clusterStore.getState().signingIn) return;
  clusterStore.setState({ signingIn: context });
  try {
    await backend.awsSsoLogin(context);
    toasts.show({ kind: "ok", text: `Signed in for ${context}` });
    await checkSso();
    const s = clusterStore.getState();
    if (s.context && (s.context === context || connOf(s.context).status === "offline")) reconnect();
  } catch (e) {
    toasts.error(asError(e).message);
  } finally {
    clusterStore.setState({ signingIn: null });
  }
}

// ── SSO sign-in status ─────────────────────────────────────────────────────

/** How often the status is read while someone watches it; it is a few file reads, no network. */
const SSO_POLL_MS = 60_000;

/** A connection error that a new sign-in may fix: the cluster refused the token, or the exec plugin failed. */
export function looksLikeAuthError(e: BackendError | null): boolean {
  if (!e) return false;
  if (e.code === 401) return true;
  return /\b(sso|token|expired|credential|exec plugin|getting credentials|unauthori[sz]ed)\b/i.test(e.message);
}

/**
 * Whether a context's row offers `aws sso login`: when its cached token expired or is missing,
 * when the check failed, or when its connection was refused for credentials. A context that does
 * not sign in with an AWS profile never does.
 */
export function needsSsoLogin(c: ContextInfo, s: ClusterState = clusterStore.getState()): boolean {
  if (!c.awsProfile) return false;
  if (looksLikeAuthError(connOf(c.name, s).error) && connOf(c.name, s).status === "offline") return true;
  if (s.sso === null) return false; // not read yet: no button that vanishes a moment later
  const st = s.sso[c.name]?.state;
  return st !== "valid" && st !== "refreshable";
}

let ssoCheck: Promise<void> | null = null;

/** Reads the sign-in status of every context with an AWS profile (one at a time). */
export function checkSso(): Promise<void> {
  ssoCheck ??= (async () => {
    const names = clusterStore.getState().contexts.filter((c) => c.awsProfile).map((c) => c.name);
    try {
      const sso = names.length > 0 ? await backend.awsSsoStatus(names) : {};
      clusterStore.setState({ sso });
    } catch {
      clusterStore.setState({ sso: {} });
    } finally {
      ssoCheck = null;
    }
    scheduleExpiry();
  })();
  return ssoCheck;
}

let ssoWatchers = 0;
let ssoTimer: ReturnType<typeof setInterval> | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
const onWake = () => {
  if (document.visibilityState === "visible") void checkSso();
};

/** A check right after the soonest valid token expires, so its button returns on time. */
function scheduleExpiry(): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  if (ssoWatchers === 0) return;
  const soonest = Object.values(clusterStore.getState().sso ?? {})
    .filter((st) => st.state === "valid" && st.expiresAt)
    .map((st) => Date.parse(st.expiresAt!))
    .filter((t) => Number.isFinite(t) && t > Date.now())
    .sort((a, b) => a - b)[0];
  // within the poll interval anyway, or so far out that the poll gets there first
  if (soonest !== undefined && soonest - Date.now() < SSO_POLL_MS) {
    expiryTimer = setTimeout(() => void checkSso(), soonest - Date.now() + 1000);
  }
}

/**
 * Keeps the SSO status fresh while the caller shows it: every minute, when the window becomes
 * visible or focused again (the user may have run `aws sso login` in a terminal), when a token
 * expires, and when the contexts change. Returns the stop function; watchers are counted.
 */
export function watchSso(): () => void {
  if (ssoWatchers++ === 0) {
    void checkSso();
    ssoTimer = setInterval(() => void checkSso(), SSO_POLL_MS);
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--ssoWatchers > 0) return;
    if (ssoTimer) clearInterval(ssoTimer);
    if (expiryTimer) clearTimeout(expiryTimer);
    ssoTimer = expiryTimer = null;
    window.removeEventListener("focus", onWake);
    document.removeEventListener("visibilitychange", onWake);
  };
}

/** Re-reads the kubeconfig contexts (context picker). */
export async function refreshContexts(): Promise<void> {
  const list = await backend.listContexts();
  clusterStore.setState({ contexts: list.contexts, files: list.files, kubeCurrent: list.current });
  if (ssoWatchers > 0) void checkSso();
}

// ── discovery lookups ──────────────────────────────────────────────────────

/**
 * Aliases of a context (default: the focused pane's). Until a context's discovery arrives, the
 * window's is used, so names still resolve; a resource the other cluster lacks then shows its error.
 */
function aliasesOf(context: string | undefined, s: ClusterState = clusterStore.getState()): AliasMap {
  const ctx = context ?? focusedContext();
  const c = ctx ? s.conns[ctx] : undefined;
  return c?.discovered ? c.aliases : s.aliases;
}
const lookup = (a: AliasMap, gvr: Gvr): ApiResource | undefined =>
  a.byGvr.get(gvrKey(gvr)) ?? a.byAlias.get(gvr.group ? `${gvr.resource}.${gvr.group}` : gvr.resource);

/** Resolves a plural, singular, short name, kind or `name.group` to a resource (in `context`, default: the focused pane's). */
export const resolveResource = (name: string, context?: string): ApiResource | undefined => resolveAlias(aliasesOf(context), name);
/** Discovery entry of a GVR (the version is ignored when it does not match exactly). */
export const resourceFor = (gvr: Gvr, context?: string): ApiResource | undefined => lookup(aliasesOf(context), gvr);
/** Kind name for crumbs and dialogs; falls back to the plural. */
export const kindOf = (gvr: Gvr, context?: string): string => resourceFor(gvr, context)?.kind ?? gvr.resource;
/** Discovery of a GVR in a pane's context, in React. */
export const useResource = (gvr: Gvr, context: string): ApiResource | undefined => useCluster((s) => lookup(aliasesOf(context, s), gvr));
/** Discovery of a context (default: the window's), in React. */
export function useDiscovery(context?: string): { resources: readonly ApiResource[]; aliases: AliasMap; discovered: boolean } {
  const resources = useCluster((s) => (context ? connOf(context, s).resources : s.resources));
  const aliases = useCluster((s) => (context ? connOf(context, s).aliases : s.aliases));
  const discovered = useCluster((s) => (context ? connOf(context, s).discovered : s.discovered));
  return useMemo(() => ({ resources, aliases, discovered }), [resources, aliases, discovered]);
}

// ── namespaces ─────────────────────────────────────────────────────────────

/** Namespace names of a context (default: the window's), live. Empty while syncing or when listing is forbidden. */
export function useNamespaces(context?: string): { names: readonly string[]; synced: boolean; forbidden: boolean } {
  const ctx = useCluster((s) => {
    const name = context ?? s.context;
    return name && connOf(name, s).status === "connected" ? name : null;
  });
  const query = useMemo(() => (ctx ? namespacesQuery(ctx) : null), [ctx]);
  const snap = useTable(query);
  return useMemo(
    () => ({ names: snap.rows.map((r) => r.name).sort(), synced: snap.synced, forbidden: snap.state === "forbidden" }),
    [snap],
  );
}

/** Namespace names right now (default: the focused pane's context), for `:ns` completion outside React. */
export function namespaceNames(context: string = focusedContext()): string[] {
  const lease = context ? runtimes.get(context)?.nsLease : null;
  if (!lease) return [];
  return tables().get(lease.key).rows.map((r) => r.name).sort();
}

// ── connection health for the bottom row (§2.5) ────────────────────────────

export type Health = { state: "live" } | { state: "reconnecting"; retryAt: number | null } | { state: "offline"; retryAt: number | null; message?: string };

export function healthOf(s: ContextConn, watches: { reconnecting: number }): Health {
  if (s.status === "offline") return { state: "offline", retryAt: s.retryAt, message: s.error?.message };
  if (s.status !== "connected" || watches.reconnecting > 0) return { state: "reconnecting", retryAt: null };
  return { state: "live" };
}

// ── panes in other contexts (§8.3) ─────────────────────────────────────────

let paneWatch = false;
/**
 * Keeps the contexts panes show connected and releases the ones nothing shows any more; read-only
 * mode (the key engine) follows the focused pane's context. Called once from initCluster.
 */
function watchPaneContexts(): void {
  if (paneWatch) return;
  paneWatch = true;
  let last = "";
  let lastFocused = "";
  layoutStore.subscribe(() => {
    const focused = focusedContext();
    if (focused && focused !== lastFocused) {
      lastFocused = focused;
      setActiveContext(focused);
    }
    if (clusterStore.getState().contexts.length === 0) return;
    const now = tabContexts().join("\u0001");
    if (now === last) return;
    last = now;
    for (const c of tabContexts()) ensureConnected(c);
    releaseUnused();
  });
}
