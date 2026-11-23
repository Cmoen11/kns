// Key chips (docs/ux.md §11.4). A chip shows the produced character; combos are separate chips.
// Chips never hardcode a key: pass an action id and the chip follows the live keymap.
import { memo } from "react";
import type { ActionId } from "../actions";
import { bindingText, chordLabels, platform, useBindings } from "../keys";
import type { Binding } from "../types";

/** The chips of one binding (a chord or a sequence), e.g. [Ctrl][K] or [Ctrl][.] [r]. */
export const KeyChip = memo(function KeyChip({ binding, disabled }: { binding: Binding; disabled?: boolean }) {
  return (
    <span className="k-keys t-ui" data-disabled={disabled || undefined} aria-label={bindingText(binding, platform)}>
      {binding.map((chord, i) => (
        <span className="k-keys-chord" key={i} aria-hidden="true">
          {chordLabels(chord, platform).map((label, j) => (
            <kbd className="k-chip t-ui" key={j}>
              {label}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  );
});

/**
 * The first live binding of an action as chips. Renders nothing when the action has no key
 * (unbound, or command-only), so callers never show a stale key.
 */
export function Keys({ action, disabled, index = 0 }: { action: ActionId; disabled?: boolean; index?: number }) {
  const bindings = useBindings(action);
  const b = bindings[index] ?? bindings[0];
  return b ? <KeyChip binding={b} disabled={disabled} /> : null;
}

/** Key chip + label: the only action affordance in the bottom row and pane headers (§11.4). */
export function Hint({ action, label, onClick }: { action: ActionId; label: string; onClick?: () => void }) {
  return (
    <span className="k-hint t-hint" onClick={onClick}>
      <Keys action={action} />
      {label}
    </span>
  );
}
