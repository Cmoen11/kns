// Toast and message state (docs/ux.md §11.9). Pure store; <ToastHost/> renders it.
// - at most three toasts are visible; info lasts 4s, undo 10s, errors stay until dismissed
// - when a fourth arrives the oldest error leaves the stack (else the oldest toast) and is counted
//   in `overflowErrors` (bottom row "errors N"); nothing is dropped from `log`
// - only the newest undo toast owns Ctrl/Cmd+Z (undo.lastAction)
import { createStore, type StoreApi } from "zustand/vanilla";
import type { GlyphState } from "./Glyph";

export type ToastKind = "info" | "ok" | "warn" | "error";

export interface ToastInput {
  kind?: ToastKind;
  /** plain text; cluster text is untrusted and is rendered as text */
  text: string;
  /** makes this an undo toast (10s). Runs on Ctrl/Cmd+Z or a click on the action. */
  undo?: () => void | Promise<void>;
  /** label of the undo action, default "undo" */
  undoLabel?: string;
  /** override the lifetime in ms; 0 = sticky */
  ttl?: number;
}

export interface Toast extends Required<Pick<ToastInput, "text">> {
  id: number;
  kind: ToastKind;
  at: number;
  undo?: () => void | Promise<void>;
  undoLabel: string;
  /** 0 = stays until dismissed */
  ttl: number;
}

/** One entry of the message log (the `messages` view, `:errors`). */
export interface LogEntry {
  id: number;
  kind: ToastKind;
  text: string;
  at: number;
}

export interface ToastState {
  /** oldest first, at most MAX_VISIBLE */
  visible: Toast[];
  /** errors pushed out of the stack and not yet seen in the messages view */
  overflowErrors: number;
  /** every message, newest last, capped at LOG_CAP */
  log: LogEntry[];
}

export const MAX_VISIBLE = 3;
export const LOG_CAP = 500;
export const TTL_INFO = 4000;
export const TTL_UNDO = 10000;

export const GLYPH_FOR: Record<ToastKind, GlyphState> = { info: "done", ok: "ok", warn: "warn", error: "error" };

export interface ToastApi {
  store: StoreApi<ToastState>;
  /** Shows a toast and logs it. Returns its id. */
  show(input: ToastInput | string): number;
  error(text: string): number;
  dismiss(id: number): void;
  /** toast.dismiss (Ctrl/Cmd+Shift+X): removes every visible toast, errors included. */
  dismissAll(): void;
  /** The undo toast that owns Ctrl/Cmd+Z, if any. */
  newestUndo(): Toast | undefined;
  /** Runs the newest undo and removes its toast. Returns false when there is none. */
  undoLast(): boolean;
  /** Runs a specific toast's undo (click). */
  undo(id: number): boolean;
  /** The messages view calls this when it is shown: resets the overflow count. */
  markErrorsSeen(): void;
}

export function createToasts(now: () => number = () => Date.now()): ToastApi {
  const store = createStore<ToastState>(() => ({ visible: [], overflowErrors: 0, log: [] }));
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let seq = 0;

  function remove(id: number) {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
    const s = store.getState();
    if (s.visible.some((x) => x.id === id)) store.setState({ visible: s.visible.filter((x) => x.id !== id) });
  }

  function show(input: ToastInput | string): number {
    const i: ToastInput = typeof input === "string" ? { text: input } : input;
    const kind = i.kind ?? "info";
    const id = ++seq;
    const at = now();
    const ttl = i.ttl ?? (kind === "error" ? 0 : i.undo ? TTL_UNDO : TTL_INFO);
    const toast: Toast = { id, kind, text: i.text, at, undo: i.undo, undoLabel: i.undoLabel ?? "undo", ttl };
    const s = store.getState();
    let visible = [...s.visible, toast];
    let overflowErrors = s.overflowErrors;
    while (visible.length > MAX_VISIBLE) {
      // the oldest error leaves first and is counted; with no error, the oldest toast leaves
      const victim = visible.find((x) => x.kind === "error" && x.id !== id) ?? visible[0];
      if (victim.kind === "error") overflowErrors++;
      const t = timers.get(victim.id);
      if (t) clearTimeout(t);
      timers.delete(victim.id);
      visible = visible.filter((x) => x !== victim);
    }
    const log = [...s.log, { id, kind, text: i.text, at }];
    if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
    store.setState({ visible, overflowErrors, log });
    if (ttl > 0) timers.set(id, setTimeout(() => remove(id), ttl));
    return id;
  }

  const newestUndo = () => {
    const v = store.getState().visible;
    for (let i = v.length - 1; i >= 0; i--) if (v[i].undo) return v[i];
    return undefined;
  };

  function runUndo(t: Toast | undefined): boolean {
    if (!t?.undo) return false;
    const fn = t.undo;
    remove(t.id);
    try {
      const r = fn();
      if (r && typeof r.then === "function") r.then(undefined, (e: unknown) => show({ kind: "error", text: `Undo failed: ${String(e)}` }));
    } catch (e) {
      show({ kind: "error", text: `Undo failed: ${String(e)}` });
    }
    return true;
  }

  return {
    store,
    show,
    error: (text) => show({ kind: "error", text }),
    dismiss: remove,
    dismissAll() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      if (store.getState().visible.length > 0) store.setState({ visible: [] });
    },
    newestUndo,
    undoLast: () => runUndo(newestUndo()),
    undo: (id) => runUndo(store.getState().visible.find((x) => x.id === id)),
    markErrorsSeen() {
      if (store.getState().overflowErrors !== 0) store.setState({ overflowErrors: 0 });
    },
  };
}

/** The app's toasts. `toast("saved")`, `toast({ kind: "ok", text, undo })`, `toasts.error(msg)`. */
export const toasts = createToasts();
export const toast = toasts.show;
