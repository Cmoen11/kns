// Bottom row (docs/ux.md §2.5): mode badge, hints generated from the action registry for the
// focused scope, status indicators, connection. Messages replace the hints while they show.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ActionId } from "../actions";
import type { ModeBadge } from "../actions/scopes";
import { engine, useEngineValue, useHints, useKeyState, type AvailableAction } from "../keys";
import { clusterStore, healthOf, type Health } from "../store/cluster";
import { zoomFactor } from "../store/appearance";
import { useSettings } from "../store/settings";
import { useStatusMessage } from "../store/status";
import { tables } from "../store/tables";
import { actionTip, keepFocus, KeyChip, menuAnchor, Nodelinje, openMenu, runAction, tip, useActionState, useErrorOverflow, type NodelinjeState } from "../ui";
import { useBuilt } from "./Titlebar";
import { useShell } from "./slots";

const HintItem = memo(function HintItem({ hint }: { hint: AvailableAction }) {
  const b = hint.bindings[0];
  // a hint is live in the current scopes (it may belong to an overlay or an input), so it runs as it is
  return (
    <button
      type="button"
      className="k-hint t-hint bottom-hint"
      tabIndex={-1}
      // the key and the label are the hint itself: a tooltip only says why it is disabled
      aria-disabled={!hint.enabled || undefined}
      {...(hint.enabled ? undefined : tip(hint.action.label, { reason: hint.reason ?? "not available" }))}
      data-action={hint.action.id}
      onMouseDown={keepFocus}
      onClick={() => engine.run(hint.action.id, { source: "pointer" })}
    >
      {b && <KeyChip binding={b} />}
      {hint.action.label}
    </button>
  );
});

/** Hints wrap inside a one-row box; the ones that wrapped are counted as `+N` (§2.5). */
function Hints() {
  const hints = useHints();
  const box = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const count = () => {
      let n = 0;
      for (const c of el.children) if ((c as HTMLElement).offsetTop > 0) n++;
      setHidden((prev) => (prev === n ? prev : n));
    };
    count();
    const ro = new ResizeObserver(count);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hints]);
  return (
    <>
      <div className="bottom-hints" ref={box}>
        {hints.map((h) => (
          <HintItem key={h.action.id} hint={h} />
        ))}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          className="bottom-more t-hint"
          tabIndex={-1}
          {...tip("More actions")}
          aria-label={`${hidden} more actions`}
          aria-haspopup="menu"
          onMouseDown={keepFocus}
          // the hints that did not fit, as a menu above the row
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const rest = hints.slice(hints.length - hidden).map((h) => h.action.id);
            openMenu({ at: { x: menuAnchor(e.currentTarget).x, y: r.top - rest.length * 20 * zoomFactor() - 8 }, items: rest });
          }}
        >
          +{hidden}
        </button>
      )}
    </>
  );
}

function useHealth(): Health {
  const last = useRef<Health | null>(null);
  const subscribe = useCallback((fn: () => void) => {
    const a = clusterStore.subscribe(fn);
    const b = tables().subscribeHealth(fn);
    return () => {
      a();
      b();
    };
  }, []);
  return useSyncExternalStore(subscribe, () => {
    const next = healthOf(clusterStore.getState(), tables().health());
    const prev = last.current;
    if (prev && prev.state === next.state && ("retryAt" in prev ? prev.retryAt : null) === ("retryAt" in next ? next.retryAt : null)) return prev;
    return (last.current = next);
  });
}

const GLYPH: Record<Health["state"], NodelinjeState> = { live: "live", reconnecting: "reconnecting", offline: "stale" };

function Connection() {
  const health = useHealth();
  const retryAt = health.state === "live" ? null : health.retryAt;
  const [, tick] = useState(0);
  // the countdown is the only thing that ticks, and only while offline
  useEffect(() => {
    if (!retryAt) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [retryAt]);
  const wait = retryAt ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : 0;
  const word = health.state === "live" ? "live" : health.state === "offline" ? `offline${retryAt ? ` ${wait}s` : ""}` : "reconnecting";
  const canRetry = useBuilt("conn.reconnect");
  const retry = canRetry && health.state !== "live";
  return (
    <button
      type="button"
      className="bottom-conn t-ui"
      tabIndex={-1}
      data-state={health.state}
      aria-label={`Connection: ${word}`}
      data-retry={retry || undefined}
      {...(retry ? actionTip("conn.reconnect", undefined, health.state === "offline" ? health.message : undefined) : tip(`Connection: ${word}`))}
      onMouseDown={keepFocus}
      onClick={retry ? () => engine.run("conn.reconnect", { source: "pointer" }) : undefined}
    >
      <Nodelinje state={GLYPH[health.state]} />
      <span className="bottom-conn-word">{word}</span>
    </button>
  );
}

function Errors() {
  const n = useErrorOverflow();
  const built = useBuilt("messages.open");
  if (n === 0) return null;
  return (
    <button type="button" className="bottom-errors t-ui" tabIndex={-1} {...(built ? actionTip("messages.open") : undefined)} onMouseDown={keepFocus} onClick={built ? () => engine.run("messages.open", { source: "pointer" }) : undefined}>
      errors {n}
    </button>
  );
}

/** The action that leaves a mode: what Esc does there. NORMAL, TERM and the vim modes have none. */
const LEAVE: Partial<Record<ModeBadge, ActionId>> = {
  FILTER: "filter.cancel",
  COMMAND: "list.close",
  MOVE: "move.cancel",
  RESIZE: "resize.done",
  COPY: "copy.leave",
  EDIT: "editor.leave",
  REVIEW: "review.back",
  SIDE: "side.leave",
};

/** The mode badge. Outside NORMAL a click leaves the mode, through the same action as its key. */
function Mode({ mode }: { mode: ModeBadge }) {
  const action = LEAVE[mode];
  // PANE and NEW are a pending key sequence, not a layer: they are dropped, as Esc does
  const pending = mode === "PANE" || mode === "NEW →" || mode === "NEW ↓";
  const state = useActionState(action ?? "list.close");
  if (pending) {
    return (
      <button type="button" className="bottom-mode bottom-mode-leave t-label" data-mode={mode} tabIndex={-1} {...tip("cancel", { keys: ["Esc"] })} onMouseDown={keepFocus} onClick={() => engine.reset()}>
        {mode}
      </button>
    );
  }
  if (!action || !state.present) {
    return (
      <span className="bottom-mode t-label" data-mode={mode}>
        {mode}
      </span>
    );
  }
  return (
    <button type="button" className="bottom-mode bottom-mode-leave t-label" data-mode={mode} tabIndex={-1} {...actionTip(action, undefined, state.reason)} onMouseDown={keepFocus} onClick={() => runAction(action)}>
      {mode}
    </button>
  );
}

export function BottomRow() {
  const { mode } = useKeyState();
  const readOnly = useEngineValue((e) => e.env().readOnly);
  const showHints = useSettings((s) => s.hints);
  const message = useStatusMessage();
  const items = useShell((s) => s.items);
  return (
    <footer className="bottom">
      <Mode mode={mode} />
      {readOnly && <span className="bottom-mode t-label">RO</span>}
      {message ? (
        <span className="bottom-message t-ui" data-kind={message.kind} role="status">
          {message.text}
        </span>
      ) : showHints ? (
        <Hints />
      ) : null}
      <span className="bottom-fill" />
      <Errors />
      {items
        .filter((i) => i.area === "status")
        .map((i) => (
          <span key={i.id} className="bottom-item t-ui" data-item={i.id}>
            <i.component />
          </span>
        ))}
      <Connection />
    </footer>
  );
}
