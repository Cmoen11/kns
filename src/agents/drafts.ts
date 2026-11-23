// Agent drafts of `propose_apply` (docs/plan-features.md §2.10a, §6.5 open items). The human may
// open an agent's YAML as a draft (`openDraft`, A2's seam) instead of applying it as shown. Two
// rules on top of that seam, kept here so `open-draft.ts` stays untouched:
//
// - An agent draft never replaces a draft the human kept for the same object: the option is not
//   offered while one exists (checked under both draft keys, with and without the object's uid).
// - A declined agent draft is not later offered as the human's own: every agent draft is recorded
//   (key, text, pane). When its pane stops editing the object, or after a reload, the stored draft
//   is removed if it still holds the agent's text unchanged. A draft the human edited is theirs.
import { backend, focusedContext, layoutStore, paneState } from "../foundation";
import type { Proposal } from "../ipc/types";
import type { ObjectRef } from "../types";
import { currentView } from "../store/workspace";
import { deleteDraft, draftKey, loadDraft } from "../views/doc/drafts";
import { clearDraftLabel, draftLabelFor, isSecretRef, openDraft } from "../views/doc/open-draft";
import { cleanUntrusted } from "../ui/untrusted";

const STORE = "kns:agentDrafts";

export interface AgentDraftMark {
  key: string;
  text: string;
  pane: string | null;
  at: number;
}

function load(): AgentDraftMark[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORE) ?? "[]");
    return Array.isArray(v) ? v.filter((m): m is AgentDraftMark => typeof m?.key === "string" && typeof m?.text === "string") : [];
  } catch {
    return [];
  }
}
function save(marks: readonly AgentDraftMark[]): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(marks.slice(-20)));
  } catch {
    /* private mode: cleanup then only happens while this window lives */
  }
}
let marks: AgentDraftMark[] = load();
/** the key openAgentDraft is opening right now (its pane is not known yet) */
let opening: string | null = null;

/** The marks whose pane no longer edits the drafted object (pure; `editing` asks the layout). */
export function staleMarks(list: readonly AgentDraftMark[], editing: (pane: string) => boolean): AgentDraftMark[] {
  return list.filter((m) => m.pane === null || !editing(m.pane));
}

/** Removes the stored draft when it still holds exactly the agent's text. */
async function sweep(m: AgentDraftMark): Promise<void> {
  const d = await loadDraft(m.key);
  if (d && d.text === m.text) deleteDraft(m.key);
  if (m.pane) clearDraftLabel(m.pane);
}

function editing(pane: string): boolean {
  const p = paneState(pane);
  return !!p && draftLabelFor(pane, currentView(p)) !== null;
}

function check(): void {
  if (marks.length === 0) return;
  const stale = staleMarks(marks, editing).filter((m) => m.key !== opening);
  if (stale.length === 0) return;
  marks = marks.filter((m) => !stale.includes(m));
  save(marks);
  for (const m of stale) void sweep(m);
}

let started = false;
/** At boot: panes do not survive a reload with their labels, so every recorded draft is checked. */
export function startAgentDrafts(): void {
  if (started) return;
  started = true;
  marks = marks.map((m) => ({ ...m, pane: null }));
  check();
  layoutStore.subscribe(check);
}

const refOf = (p: Proposal): ObjectRef | null =>
  p.payload.kind === "apply" ? { gvr: p.payload.parsed.gvr, namespace: p.payload.parsed.namespace, name: p.payload.parsed.name } : null;

/** The draft keys the editor may use for this object: without and with its uid. */
async function keysOf(context: string, ref: ObjectRef): Promise<string[]> {
  const keys = [draftKey(context, ref)];
  try {
    const o = (await backend.getJson({ context, gvr: ref.gvr, namespace: ref.namespace, name: ref.name })) as { metadata?: { uid?: unknown } };
    const uid = o?.metadata?.uid;
    if (typeof uid === "string" && uid) keys.push(draftKey(context, { ...ref, uid }));
  } catch {
    /* a new object has no uid yet */
  }
  return keys;
}

/** Why "open as draft" is not offered for `p`, or null when it is. */
export async function draftBlockedReason(p: Proposal): Promise<string | null> {
  const ref = refOf(p);
  if (!ref) return "only an apply can be opened as a draft";
  if (isSecretRef(ref)) return "A Secret cannot be opened as an agent draft; approve or reject it.";
  const context = focusedContext();
  if (context !== p.context) return `Focus a pane in ${p.context} to open it as a draft.`;
  for (const key of await keysOf(context, ref)) {
    const kept = await loadDraft(key);
    if (kept && !marks.some((m) => m.key === key && m.text === kept.text)) {
      return "You have an unsaved draft of this object; resume or discard it first. An agent draft never replaces yours.";
    }
  }
  return null;
}

/** Opens the agent's YAML as a draft beside, labelled with the client; false when not possible. */
export async function openAgentDraft(p: Proposal): Promise<boolean> {
  const ref = refOf(p);
  if (!ref || p.payload.kind !== "apply") return false;
  const blocked = await draftBlockedReason(p);
  if (blocked) throw new Error(blocked);
  const text = p.payload.yaml;
  const key = draftKey(p.context, ref);
  // recorded before the pane opens, so a crash in between still gets cleaned up at the next boot
  marks = [...marks.filter((m) => m.key !== key), { key, text, pane: null, at: Date.now() }];
  save(marks);
  opening = key;
  let pane: string | null = null;
  try {
    pane = await openDraft(ref, text, { label: `AGENT DRAFT · ${cleanUntrusted(p.client, 24)}` });
  } finally {
    opening = null;
  }
  marks = marks.map((m) => (m.key === key ? { ...m, pane } : m));
  save(marks);
  if (!pane) check();
  return pane !== null;
}

/** Tests: forget every mark. */
export function resetAgentDrafts(): void {
  marks = [];
  save(marks);
}
