// The overlay frame of the palette and the pickers (docs/ux.md §11.6): scrim, a 32px input row
// with its Etikett label and ghost completion, then the result list.
import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { Glyph } from "../../ui";
import { dismiss, type NewPane } from "../session";
import { ListBox, type ListRow } from "./ListBox";
import "../palette.css";

export interface ListOverlayProps {
  /** Etikett at the left of the field: SEARCH OR RUN, NAMESPACE, CONTEXT */
  label: string;
  /** 560 (640 on wide windows) or 400 */
  size: "palette" | "picker";
  text: string;
  onText: (text: string) => void;
  /** the rest of the ghost completion, shown after the typed text */
  ghost?: string;
  rows: readonly ListRow[];
  selected: number;
  onPick: (index: number, newPane: NewPane) => void;
  /** the pointer moved onto a row (ListBox.onHover) */
  onHover?: (index: number) => void;
  /** a button of `ListRow.actions` was clicked */
  onAction?: (index: number, action: string) => void;
  /** a hint line under the list: the keys of the selected row */
  footer?: ReactNode;
  /** shown with the error glyph under the input */
  error?: string | null;
  /** shown when there are no rows: a line, with the keys that fix it where there are any */
  empty?: ReactNode;
  /** dialogs opened from the overlay (rename) */
  children?: ReactNode;
}

export function ListOverlay({ label, size, text, onText, ghost, rows, selected, onPick, onHover, onAction, footer, error, empty, children }: ListOverlayProps) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const pick = useRef(onPick);
  pick.current = onPick;
  const stablePick = useCallback((i: number, newPane: NewPane) => pick.current(i, newPane), []);
  const hover = useRef(onHover);
  hover.current = onHover;
  const stableHover = useCallback((i: number) => hover.current?.(i), []);
  const act = useRef(onAction);
  act.current = onAction;
  const stableAction = useCallback((i: number, a: string) => act.current?.(i, a), []);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  return (
    <div
      className="k-scrim pal-scrim"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // focus goes back to the opener; the click itself must not move it to <body>
        e.preventDefault();
        dismiss();
      }}
    >
      <div className="pal k-overlay" data-size={size} role="dialog" aria-label={label}>
        <div className="pal-input-row">
          <label className="pal-input-label t-label" htmlFor={id}>
            {label}
          </label>
          <div className="pal-input-wrap">
            {ghost && (
              <span className="pal-ghost t-palette-input" aria-hidden="true">
                <span className="pal-ghost-typed">{text}</span>
                {ghost}
              </span>
            )}
            <input
              ref={input}
              id={id}
              className="pal-input t-palette-input"
              type="text"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              role="combobox"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-activedescendant={selected >= 0 ? `${id}-row-${selected}` : undefined}
              value={text}
              onChange={(e) => onText(e.target.value)}
            />
          </div>
        </div>
        {error && (
          <div className="pal-error t-ui" role="alert">
            <Glyph state="error" />
            {error}
          </div>
        )}
        {rows.length > 0 ? (
          <div id={`${id}-list`}>
            <ListBox rows={rows} selected={selected} onPick={stablePick} onHover={stableHover} onAction={onAction ? stableAction : undefined} id={`${id}-row`} label={label} />
          </div>
        ) : (
          empty && <div className="pal-empty t-row">{empty}</div>
        )}
        {rows.length > 0 && footer && <div className="pal-empty pal-footer t-ui">{footer}</div>}
      </div>
      {children}
    </div>
  );
}
