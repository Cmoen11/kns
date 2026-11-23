// Bottom-row messages (docs/ux.md §2.5, §3.2): short, transient, never a dialog. Used for the
// pane cap, fold notices, the cancelled `+` prefix and blocked keys.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export interface StatusMessage {
  text: string;
  kind: "info" | "warn";
  id: number;
}

const store = createStore<{ message: StatusMessage | null }>(() => ({ message: null }));
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Shows a message in the bottom row for 4s (it replaces the hints while shown). */
export function flash(text: string, kind: "info" | "warn" = "info"): void {
  const id = ++seq;
  store.setState({ message: { text, kind, id } });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (store.getState().message?.id === id) store.setState({ message: null });
  }, 4000);
}

export const useStatusMessage = (): StatusMessage | null => useStore(store, (s) => s.message);
