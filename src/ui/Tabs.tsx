// Tab strip (docs/ux.md §11.10): fold and zoom. Items are "index + last crumb"; the active item
// has --k-text and a 2px accent underline. Keys are the registry's (leader + index, F6); a click
// selects a tab and, with onClose, each tab has a close button.
import { memo } from "react";
import { keepFocus } from "./action-state";
import type { ActionId } from "../actions/registry";
import { Glyph, Icon } from "./Glyph";
import { actionTip, clipTip, tip } from "./Tooltip";

export interface TabItem {
  id: string;
  /** pane index shown before the label */
  index?: number;
  /** untrusted text, rendered as text */
  label: string;
  /** a status hint: the pane shows failing rows (glyph in the tab, the label keeps its colour) */
  state?: "warn" | "error";
  /** what the hint means (tooltip reason) */
  stateText?: string;
}

export interface TabsProps {
  items: readonly TabItem[];
  active: string;
  onSelect: (id: string) => void;
  /** adds a close button to every tab */
  onClose?: (id: string) => void;
  /** label of the close buttons (tooltip and accessible name) */
  closeTitle?: string;
  /** the action the close buttons run: its key is shown in their tooltip */
  closeAction?: ActionId;
  /** accessible name of the strip */
  label: string;
}

export const Tabs = memo(function Tabs({ items, active, onSelect, onClose, closeTitle = "Close", closeAction, label }: TabsProps) {
  return (
    <div className="k-tabs" role="tablist" aria-label={label}>
      {items.map((it) => (
        <span key={it.id} className="k-tab-wrap" data-selected={it.id === active || undefined}>
          <button
            type="button"
            role="tab"
            className="k-tab t-ui"
            aria-selected={it.id === active}
            {...(it.stateText ? tip(it.label, { plain: true, reason: it.stateText }) : clipTip(it.label))}
            // one tab stop for the strip; pane focus moves with the registry's keys
            tabIndex={-1}
            onMouseDown={keepFocus}
            onClick={() => onSelect(it.id)}
          >
            {it.index !== undefined && <span>{it.index}</span>}
            {it.state && <Glyph state={it.state} />}
            <span className="k-tab-label">{it.label}</span>
          </button>
          {onClose && (
            <button type="button" className="k-abtn k-tab-close" tabIndex={-1} {...(closeAction ? actionTip(closeAction, closeTitle) : tip(closeTitle))} aria-label={`${closeTitle}: ${it.label}`} onMouseDown={keepFocus} onClick={() => onClose(it.id)}>
              <Icon name="close" />
            </button>
          )}
        </span>
      ))}
    </div>
  );
});
