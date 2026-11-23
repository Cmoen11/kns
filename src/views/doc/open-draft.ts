// Agent drafts (docs/plan-features.md §2.10a, seam for H2's `propose_apply`): opens an EDIT pane
// prefilled with text the human did not write, labelled `AGENT DRAFT` in the pane header. Saving
// goes through the normal REVIEW (server dry run, then apply), so nothing here writes to the
// cluster. Separate from the draft store (drafts.ts), which it calls: the text is put where the
// editor looks for a kept draft, and the editor offers it ("Resume draft") when the pane opens.
import { useSyncExternalStore } from "react";
import { backend } from "../../ipc";
// direct store imports (not foundation): the pane header imports this file
import { openView, paneContext } from "../../store/layout";
import { sameRef } from "../../store/selection";
import type { ObjectRef, PaneId, ViewState } from "../../types";
import { cleanUntrusted } from "../../ui/untrusted";
import { draftKey } from "./drafts";
import { freshEdits } from "./session";

export interface OpenDraftOptions {
  /** header label; default "AGENT DRAFT" (agent text: cleaned, at most 40 characters) */
  label?: string;
  /** the source pane (default: the focused one) */
  pane?: PaneId;
  /** default "right": an agent draft never replaces what the human is looking at */
  newPane?: "right" | "down";
}

interface Label {
  ref: ObjectRef;
  text: string;
}

const labels = new Map<PaneId, Label>();
const subs = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  for (const fn of [...subs]) fn();
};

/** Secrets never go to the draft store (drafts.ts), so an agent cannot prefill one. */
export const isSecretRef = (ref: ObjectRef): boolean => ref.gvr.group === "" && ref.gvr.resource === "secrets";

/** The label text shown for a draft (pure). */
export const draftLabel = (label?: string): string => {
  const clean = label === undefined ? "" : cleanUntrusted(label, 40).trim();
  return clean === "" ? "AGENT DRAFT" : clean;
};

/**
 * Opens `ref` in EDIT beside the source with `text` as the buffer. Returns the pane, or null when
 * it could not open (a Secret, the pane cap). The editor asks before it shows the text instead of
 * the server version, and REVIEW shows the diff before anything is applied.
 */
export async function openDraft(ref: ObjectRef, text: string, opts: OpenDraftOptions = {}): Promise<PaneId | null> {
  if (isSecretRef(ref)) throw new Error("an agent draft cannot target a Secret");
  // the draft pane opens beside its source, in the source's context (§8.3)
  const context = paneContext(opts.pane);
  if (!context) throw new Error("not connected");
  // the draft store's format ({ text, at }); awaited, so the editor finds it when it loads
  await backend.saveState(draftKey(context, ref), { text, at: Date.now() });
  const pane = openView(
    { kind: "doc", ref, format: "yaml", mode: "edit", managedFields: false, wrap: false },
    { pane: opts.pane, newPane: opts.newPane ?? "right", follow: false },
  );
  if (!pane) return null;
  freshEdits.set(pane, Date.now());
  labels.set(pane, { ref, text: draftLabel(opts.label) });
  changed();
  return pane;
}

/** The label of `pane` while it still edits or reviews the drafted object; null otherwise. */
export function draftLabelFor(pane: PaneId, view: ViewState | undefined): string | null {
  const l = labels.get(pane);
  if (!l || !view || view.kind !== "doc" || view.mode === "view" || !sameRef(view.ref, l.ref)) return null;
  return l.text;
}

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

/** Pane header hook (src/panes/Pane.tsx). */
export function useDraftLabel(pane: PaneId, view: ViewState | undefined): string | null {
  useSyncExternalStore(subscribe, () => version);
  return draftLabelFor(pane, view);
}

/** Forgets the label of a pane (closed, or the edit ended). */
export function clearDraftLabel(pane: PaneId): void {
  if (labels.delete(pane)) changed();
}
