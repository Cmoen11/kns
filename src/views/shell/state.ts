// Exec session state that must be readable without loading xterm: status per session id, the pane
// guard, TERM scope sync and the lifetime rule. The terminals themselves live in ./sessions (lazy).
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { getWorkspace, openWorkspaces, setPaneScope, type LiveSession } from "../../foundation";
// subscribe-only: the foundation exports no "workspace changed" hook outside React
import { layoutStore } from "../../store/layout";
import type { PaneId, ViewState } from "../../types";
import { isShellView, sessionRefs } from "./session-refs";
import type { CopyMove } from "./term-search";

export type SessionStatus = "connecting" | "live" | "ended" | "error";

export interface SessionInfo {
  id: string;
  kind: "shell" | "attach";
  context: string;
  namespace: string;
  pod: string;
  /** undefined = the backend's default container */
  container?: string;
  status: SessionStatus;
  /** exit or error text (untrusted) */
  message?: string;
  /** COPY mode is on */
  copy: boolean;
  /** the header search bar is open */
  search: boolean;
  searchError?: string;
  /** "3/12" */
  searchCount?: string;
}

/** §4.6: at most 8 live shells per app. */
export const MAX_LIVE = 8;

export const isLiveStatus = (s: SessionStatus): boolean => s === "connecting" || s === "live";

const store = createStore<{ sessions: Record<string, SessionInfo> }>(() => ({ sessions: {} }));

export const getSession = (id: string | undefined): SessionInfo | undefined => (id ? store.getState().sessions[id] : undefined);
export const useSession = (id: string | undefined): SessionInfo | undefined => useStore(store, (s) => (id ? s.sessions[id] : undefined));
/** Every session, for the activity panel (src/sidepanels). */
export const useSessions = <T,>(select: (sessions: Readonly<Record<string, SessionInfo>>) => T): T => useStore(store, (s) => select(s.sessions));
export const getSessions = (): Readonly<Record<string, SessionInfo>> => store.getState().sessions;
export const subscribeSessions = (fn: () => void): (() => void) => store.subscribe(fn);
export const isLive = (id: string | undefined): boolean => {
  const s = getSession(id);
  return !!s && isLiveStatus(s.status);
};
export function liveCount(): number {
  let n = 0;
  for (const s of Object.values(store.getState().sessions)) if (isLiveStatus(s.status)) n++;
  return n;
}

let counter = 0;
export const newSessionId = (): string => `x${Date.now().toString(36)}${(counter++).toString(36)}`;

export function addSession(info: Omit<SessionInfo, "status" | "copy" | "search">): void {
  store.setState((s) => ({ sessions: { ...s.sessions, [info.id]: { ...info, status: "connecting", copy: false, search: false } } }));
  syncScopes();
}

export function patchSession(id: string, patch: Partial<SessionInfo>): void {
  const cur = getSession(id);
  if (!cur) return;
  let changed = false;
  for (const k of Object.keys(patch) as (keyof SessionInfo)[]) if (cur[k] !== patch[k]) changed = true;
  if (!changed) return;
  store.setState((s) => ({ sessions: { ...s.sessions, [id]: { ...cur, ...patch } } }));
  if (patch.status !== undefined && patch.status !== cur.status) syncScopes();
}

function removeSession(id: string): void {
  if (!getSession(id)) return;
  store.setState((s) => {
    const { [id]: _gone, ...rest } = s.sessions;
    return { sessions: rest };
  });
  queries.delete(id);
}

// ── search text: typed per keystroke, read on Enter; kept out of the store on purpose ──

const queries = new Map<string, string>();
export const getQuery = (id: string): string => queries.get(id) ?? "";
export const setQuery = (id: string, text: string): void => {
  queries.set(id, text);
};

export function openSearch(id: string): void {
  patchSession(id, { search: true, searchError: undefined, searchCount: undefined });
}
export function closeSearch(id: string): void {
  patchSession(id, { search: false, searchError: undefined, searchCount: undefined });
  runtime?.searchClosed(id);
}

// ── the terminal side, set when ./sessions has loaded ──

export interface TermRuntime {
  dispose(id: string): void;
  /** closes the exec, keeps the scrollback */
  end(id: string, message?: string): void;
  restart(id: string): void;
  hasSelection(id: string): boolean;
  copySelection(id: string): void;
  paste(id: string): void;
  scrollPages(id: string, pages: number): void;
  enterCopy(id: string): void;
  /** leaves COPY mode (of `id`, or whichever session has it) */
  leaveCopy(id?: string): void;
  copyMove(move: CopyMove): void;
  copySelect(): void;
  copyYank(): void;
  search(id: string, query: string): void;
  searchClosed(id: string): void;
}

let runtime: TermRuntime | null = null;
export const setRuntime = (r: TermRuntime): void => {
  runtime = r;
};
export const getRuntime = (): TermRuntime | null => runtime;

// ── lifetime and scopes, driven by the workspace ──

const liveScoped = new Set<PaneId>();

/** TERM while the pane's current entry is a live session, the placeholder scope otherwise (§5.3). */
function syncScopes(): void {
  const ws = getWorkspace();
  const seen = new Set<PaneId>();
  if (ws) {
    for (const [pane, p] of Object.entries(ws.panes)) {
      const v = p.history[p.index];
      if (!isShellView(v) || !isLive(v.session)) continue;
      seen.add(pane);
      if (!liveScoped.has(pane)) {
        liveScoped.add(pane);
        setPaneScope(pane, { live: true });
      }
    }
  }
  for (const pane of [...liveScoped]) {
    if (seen.has(pane)) continue;
    liveScoped.delete(pane);
    setPaneScope(pane, null);
  }
}

/**
 * The whole lifetime model (§4.6): a session whose id no pane history of an open tab holds any
 * more is disposed (pane closed, history truncated, tab closed); a live session that is no longer
 * its pane's current entry is ended and keeps its scrollback. A shell in a warm tab (§8.2) is
 * still its pane's current entry, so it keeps running while another tab is on screen.
 */
function reconcile(): void {
  const sessions = store.getState().sessions;
  const ids = Object.keys(sessions);
  if (ids.length === 0 && liveScoped.size === 0) return;
  const panes = Object.assign({}, ...openWorkspaces().map((w) => w.panes));
  const refs = sessionRefs({ panes });
  for (const id of ids) {
    if (!refs.all.has(id)) {
      runtime?.dispose(id);
      removeSession(id);
    } else if (!refs.current.has(id) && isLiveStatus(sessions[id].status)) {
      if (runtime) runtime.end(id, "left the view");
      else patchSession(id, { status: "ended", message: "left the view" });
    }
  }
  syncScopes();
}

let started = false;
export function initSessions(): void {
  if (started) return;
  started = true;
  layoutStore.subscribe(reconcile);
}

/** Close, close-others, context switch and quit ask before a live shell ends (§4.6). */
export function shellGuard(_pane: PaneId, view: ViewState): LiveSession | null {
  if (!isShellView(view)) return null;
  const s = getSession(view.session);
  if (!s || !isLiveStatus(s.status)) return null;
  return { label: s.kind === "shell" ? `shell in ${s.pod}` : `attach session in ${s.pod}`, onClose: "ends" };
}
