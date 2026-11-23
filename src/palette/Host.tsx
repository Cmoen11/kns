// Always mounted (registerOverlay(..., { always: true })): the leader which-key panel (§5.5), the
// `:` command bar (§6.2) of the focused pane (the `/` filter bar is the table's), and the namespace
// recency tracker for the slot rule (§8.1). Everything here renders nothing until it is needed.
import { useEffect } from "react";
import { useLeaderPanel, useWorkspace, type LeaderItem } from "../foundation";
import { CommandBar } from "./command/CommandBar";
import { noteNamespaceUsed } from "./favourites/store";

import { useBars } from "./session";
import "./palette.css";

/** Runs of the same action (pane 1..9) collapse into one entry: first key, last key. */
function collapse(items: readonly LeaderItem[]): { id: string; label: string; first: LeaderItem; last: LeaderItem | null }[] {
  const out: { id: string; label: string; first: LeaderItem; last: LeaderItem | null }[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (prev && prev.id === it.action.id) prev.last = it;
    else out.push({ id: it.action.id, label: it.action.label, first: it, last: null });
  }
  return out;
}

function Chips({ keys }: { keys: readonly string[] }) {
  return (
    <span className="k-keys-chord" aria-hidden="true">
      {keys.map((k, i) => (
        <kbd className="k-chip t-ui" key={i}>
          {k}
        </kbd>
      ))}
    </span>
  );
}

function WhichKey() {
  const { open, items } = useLeaderPanel();
  if (!open || items.length === 0) return null;
  return (
    <div className="pal-which k-overlay" role="status" aria-label="Pane commands">
      {collapse(items).map((e) => (
        <span className="pal-which-item t-hint" key={`${e.id}:${e.first.chord}`}>
          <span className="k-keys t-ui">
            <Chips keys={e.first.keys} />
            {e.last && (
              <>
                {/^[0-9]$/.test(e.first.chord) && <span className="pal-which-range">..</span>}
                <Chips keys={e.last.keys} />
              </>
            )}
          </span>
          {e.label}
        </span>
      ))}
    </div>
  );
}

/** §8.1: a namespace that is used takes a slot; the slot rule needs to know what was used last. */
function NamespaceTracker() {
  const namespace = useWorkspace((ws) => {
    const p = ws?.panes[ws.focused];
    const v = p?.history[p.index];
    return v?.kind === "table" ? v.namespace : null;
  });
  useEffect(() => {
    if (namespace && namespace !== "*") noteNamespaceUsed(namespace);
  }, [namespace]);
  return null;
}

export default function Host() {
  const command = useBars((s) => s.command);

  return (
    <>
      <NamespaceTracker />
      <WhichKey />
      {command && <CommandBar key={command.key} pane={command.pane} newPane={command.newPane} />}

    </>
  );
}
