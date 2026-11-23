// Names on one port (docs/plan-features.md §3 B2): the state of the `*.localhost` name proxy that
// Rust runs (proxy.rs). Eager and small: the port-forwards view, the hub status and `:dev names`
// read it. Polls nothing: it re-asks on boot and on `forwards` / `devSets` events while on.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { backend, flash, toast, toasts } from "../foundation";
import type { NameProxyStatus } from "../ipc/types";
import { errorText } from "./store";

interface NamesState {
  status: NameProxyStatus | null;
}

const store = createStore<NamesState>(() => ({ status: null }));

export const useNames = <T,>(select: (s: NamesState) => T): T => useStore(store, select);
export const getNames = (): NameProxyStatus | null => store.getState().status;

/** `http://<host>:<port>` of a forward while the proxy routes it; null otherwise. */
export function nameUrl(status: NameProxyStatus | null, forwardId: string): string | null {
  if (!status?.on) return null;
  const n = status.names.find((x) => x.forward === forwardId);
  return n ? `http://${n.host}:${status.port}` : null;
}

/** The hub's status line: `on · :7080 · 3 names`; null while off (an error says why). */
export function namesStatusText(s: NameProxyStatus | null): { text: string; state: "off" | "ok" | "warn" | "active" } | null {
  if (!s) return null;
  if (s.error) return { text: `off · ${s.error}`, state: "warn" };
  if (!s.on) return null;
  return { text: `on · 127.0.0.1:${s.port} · ${s.names.length} name${s.names.length === 1 ? "" : "s"}`, state: "active" };
}

const same = (a: NameProxyStatus | null, b: NameProxyStatus): boolean =>
  a !== null && a.on === b.on && a.port === b.port && a.error === b.error && JSON.stringify(a.names) === JSON.stringify(b.names);

export async function refreshNames(): Promise<void> {
  try {
    const s = await backend.nameProxyStatus();
    if (!same(store.getState().status, s)) store.setState({ status: s });
  } catch {
    /* not available (older backend): the toggle reports the error when used */
  }
}

/** `:dev names on [port]` / `:dev names off` and the toggles. */
export async function setNames(on: boolean, port?: number): Promise<void> {
  try {
    const was = store.getState().status;
    const s = await backend.nameProxySet(on, port);
    store.setState({ status: s });
    // a port change while off (settings row) only remembers the port
    if (!on && was && !was.on) return flash(`names stay off; next start uses port ${s.port}`);
    if (!on) return flash("names off: forwards are reachable by port only");
    const first = s.names[0];
    toast({ kind: "ok", text: `Names on · 127.0.0.1:${s.port}${first ? ` · e.g. http://${first.host}:${s.port}` : " · no forward yet"}` });
  } catch (e) {
    // the store must show what Rust really runs (a taken port leaves the old state)
    void refreshNames();
    toasts.error(`Could not turn names ${on ? "on" : "off"}: ${errorText(e)}`);
  }
}

let started = false;
/** Asks once at boot (Rust then starts the proxy if it was left on) and follows forward changes. */
export function initNames(): void {
  if (started) return;
  started = true;
  void refreshNames();
  try {
    backend.onEvent((e) => {
      if (e.type === "forwards" || e.type === "devSets") void refreshNames();
    });
  } catch {
    /* tests without an event bus */
  }
}
