// Toast stack (docs/ux.md §11.9): bottom-right, 280 wide, at most three, overlay surface.
import { memo, useEffect } from "react";
import { useStore } from "zustand";
import { useEngineValue } from "../keys";
import { Glyph } from "./Glyph";
import { Keys } from "./KeyChip";
import { announce } from "./live";
import { GLYPH_FOR, toasts, type Toast } from "./toast";

const ToastItem = memo(function ToastItem({ t, ownsUndoKey }: { t: Toast; ownsUndoKey: boolean }) {
  return (
    <div className="k-toast k-overlay" data-kind={t.kind} role={t.kind === "error" ? "alert" : "status"}>
      <Glyph state={GLYPH_FOR[t.kind]} />
      <span className="k-toast-text t-body selectable">{t.text}</span>
      {t.undo && (
        <button type="button" className="k-toast-action t-ui" onClick={() => toasts.undo(t.id)}>
          {t.undoLabel}
          {/* only the newest undo toast shows the chip; it is the one the key undoes */}
          {ownsUndoKey && <Keys action="undo.lastAction" />}
        </button>
      )}
    </div>
  );
});

/** Mount once at the root. */
export function ToastHost() {
  const visible = useStore(toasts.store, (s) => s.visible);
  let undoId = -1;
  for (const t of visible) if (t.undo) undoId = t.id;
  // the undo key works in NORMAL only, so the chip hides in inputs, EDIT and TERM
  const normal = useEngineValue((e) => e.snapshot().mode === "NORMAL" && e.snapshot().scopes.includes("pane"));
  if (!normal) undoId = -1;
  const newest = visible[visible.length - 1];
  useEffect(() => {
    if (newest) announce(newest.text);
  }, [newest?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (visible.length === 0) return null;
  return (
    <div className="k-toasts">
      {visible.map((t) => (
        <ToastItem key={t.id} t={t} ownsUndoKey={t.id === undoId} />
      ))}
    </div>
  );
}

/** Narrow hooks for the bottom row and the messages view. */
export const useErrorOverflow = (): number => useStore(toasts.store, (s) => s.overflowErrors);
export const useMessageLog = () => useStore(toasts.store, (s) => s.log);
