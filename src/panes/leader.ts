// Which-key state for the leader panel (docs/ux.md §5.5). The panel UI belongs to the palette
// feature; this hook is everything it needs: whether to show, and what the next key can run.
import { useEffect, useState } from "react";
import type { ActionDef } from "../actions";
import { chordLabels, engine, platform, useEngineValue } from "../keys";
import type { Chord } from "../types";

/** §5.5: the panel appears 250ms after the leader. */
export const WHICH_KEY_DELAY_MS = 250;

export interface LeaderItem {
  /** the next chord, e.g. "r" or "Left" */
  chord: Chord;
  /** its key-chip labels */
  keys: string[];
  action: ActionDef;
}

export interface LeaderPanel {
  /** true while PANE mode is pending (immediately after the leader) */
  pending: boolean;
  /** true once the panel should be visible (pending for 250ms) */
  open: boolean;
  /** built actions the next key can run, in table order */
  items: readonly LeaderItem[];
}

const NONE: readonly LeaderItem[] = [];

/** Continuations of the pending leader sequence, right now. */
export function leaderItems(): LeaderItem[] {
  if (!engine.snapshot().leader) return [];
  return engine
    .continuations()
    .map((c) => ({ chord: c.chord, keys: chordLabels(c.chord, platform), action: c.action }))
    .sort((a, b) => a.action.order - b.action.order);
}

export function useLeaderPanel(delayMs: number = WHICH_KEY_DELAY_MS): LeaderPanel {
  const pending = useEngineValue((e) => e.snapshot().leader);
  const since = useEngineValue((e) => e.snapshot().pendingSince);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!pending) {
      setOpen(false);
      return;
    }
    const t = setTimeout(() => setOpen(true), Math.max(0, since + delayMs - Date.now()));
    return () => clearTimeout(t);
  }, [pending, since, delayMs]);
  return { pending, open: open && pending, items: open && pending ? leaderItems() : NONE };
}
