// Edit drafts (docs/ux.md §13.2). The backend has no drafts API, so each draft is one persisted
// state key `draft.<context>.<uid>` (a JSON file in the app config dir). Secrets never come here.
import { backend } from "../../ipc";
import type { Json } from "../../ipc/types";
import type { ObjectRef } from "../../types";

export interface Draft {
  text: string;
  /** epoch ms of the last save */
  at: number;
}

/** State keys allow [A-Za-z0-9._-] and at most 100 characters. */
export function draftKey(context: string, ref: ObjectRef): string {
  const id = ref.uid ?? `${ref.gvr.resource}.${ref.namespace ?? "_"}.${ref.name}`;
  return `draft.${context}.${id}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
}

export async function loadDraft(key: string): Promise<Draft | null> {
  try {
    const v = (await backend.loadState(key)) as Json;
    if (typeof v === "object" && v !== null && !Array.isArray(v) && typeof v.text === "string" && typeof v.at === "number") {
      return { text: v.text, at: v.at };
    }
  } catch {
    // an unreadable draft is no draft
  }
  return null;
}

export function saveDraft(key: string, text: string): void {
  void backend.saveState(key, { text, at: Date.now() }).catch(() => undefined);
}

/** The state API cannot delete a key; null marks the draft as gone. */
export function deleteDraft(key: string): void {
  void backend.saveState(key, null).catch(() => undefined);
}
