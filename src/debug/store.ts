// Feature F state: the persisted `tools` store (user snippets, recently used debug images) and the
// debug pods list of the current context (fetched on demand: after a debug action, on a context
// switch, when the panel group first renders; never on a timer).
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { backend } from "../ipc";
import type { DebugPod } from "../ipc/types";
import { PERSIST_KEYS, persistedStore } from "../store/persist";
import { MAX_RECENT, MAX_SNIPPETS, sanitizeTools, validImage, type Snippet, type ToolsState } from "./model";

export type { ToolsState };

// ── persisted: user snippets, recent images ────────────────────────────────

export const toolsStore = persistedStore<ToolsState>({
  key: PERSIST_KEYS.tools,
  version: 1,
  defaults: () => ({ snippets: [], recentImages: [] }),
  sanitize: (data) => sanitizeTools(data),
});
export const useTools = <T,>(select: (s: ToolsState) => T): T => useStore(toolsStore, select);

export function noteImage(image: string): void {
  if (!validImage(image)) return;
  toolsStore.setState((s) => ({ ...s, recentImages: [image, ...s.recentImages.filter((i) => i !== image)].slice(0, MAX_RECENT) }));
}

export function saveSnippet(s: Snippet): void {
  toolsStore.setState((st) => ({ ...st, snippets: [...st.snippets.filter((x) => x.id !== s.id), { ...s, builtIn: undefined }].slice(-MAX_SNIPPETS) }));
}

/** False when there is no user snippet with that id (built-ins cannot be removed). */
export function removeSnippet(id: string): boolean {
  const had = toolsStore.getState().snippets.some((s) => s.id === id);
  if (had) toolsStore.setState((st) => ({ ...st, snippets: st.snippets.filter((s) => s.id !== id) }));
  return had;
}

// ── debug pods of the current context ──────────────────────────────────────

interface PodsState {
  context: string | null;
  pods: DebugPod[];
  error?: string;
}

export const podsStore = createStore<PodsState>(() => ({ context: null, pods: [] }));
export const useDebugPods = <T,>(select: (s: PodsState) => T): T => useStore(podsStore, select);

let generation = 0;

/** Re-lists the debug pods of `context` (null clears). The last call wins. */
export async function refreshDebugPods(context: string | null): Promise<void> {
  const gen = ++generation;
  if (!context) {
    podsStore.setState({ context: null, pods: [], error: undefined });
    return;
  }
  try {
    const pods = await backend.debugPodsList(context);
    if (gen === generation) podsStore.setState({ context, pods, error: undefined });
  } catch (e) {
    if (gen !== generation) return;
    const message = typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e);
    podsStore.setState({ context, pods: [], error: message });
  }
}

/** Drops one pod from the list at once (after a delete), before the next listing. */
export function forgetDebugPod(p: Pick<DebugPod, "context" | "namespace" | "name" | "kind">): void {
  podsStore.setState((s) => ({ ...s, pods: s.pods.filter((x) => !(x.context === p.context && x.namespace === p.namespace && x.name === p.name && x.kind === p.kind)) }));
}
