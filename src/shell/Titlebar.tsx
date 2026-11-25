// Titlebar (docs/ux.md §2.4): 32px, a drag region except for its controls. Window controls stay
// native: on macOS the traffic lights overlay the left 84pt of a 48pt row (shell.css); on Windows the OS caption is used.
import { useSyncExternalStore } from "react";
import { registry, type ActionId } from "../actions";
import { isTauri } from "../ipc";
import { platform } from "../keys";
import { useCluster } from "../store/cluster";
import { useWorkspace } from "../store/layout";
import { useSettings } from "../store/settings";
import { ActionButton, actionTip, Icon, keepFocus, Keys, menuAnchor, openMenu, runAction, tip, useActionState } from "../ui";
import { ContextTabs } from "./ContextTabs";
import { useShell } from "./slots";
import { WINDOW_MENU } from "./window-menu";

/** True once a feature registered a handler for the action (principle 12: no dead controls). */
export function useBuilt(id: ActionId): boolean {
  return useSyncExternalStore(registry.subscribe, () => registry.get(id)?.built ?? false);
}

/** The palette field: looks like a search box, a click opens the palette. */
function PaletteField() {
  const state = useActionState("palette.open");
  if (!state.present) return null;
  return (
    <button type="button" className="titlebar-palette t-ui" tabIndex={-1} aria-label="Search or run" aria-disabled={!state.enabled || undefined} {...actionTip("palette.open", "Search or run", state.reason)} onMouseDown={keepFocus} onClick={() => runAction("palette.open")}>
      <Icon name="search" />
      <span className="titlebar-palette-text">Search or run</span>
      <Keys action="palette.open" />
    </button>
  );
}

/** The titlebar's "more" menu. */

export function Titlebar() {
  // the focused pane's context (§8.3): the one keys act on, and so the one whose protected line
  // the titlebar draws. The tabs carry every other fact about a context (§2.4).
  const windowCtx = useCluster((s) => s.context);
  const focusedCtx = useWorkspace((ws) => (ws ? (ws.panes[ws.focused]?.context ?? null) : null));
  const context = focusedCtx ?? windowCtx;
  const flags = useSettings((s) => (context ? s.contexts[context] : undefined));
  const items = useShell((s) => s.items);

  return (
    <header className="titlebar" data-tauri-drag-region data-mac={platform === "mac" && isTauri ? "" : undefined} data-protected={flags?.protected ? "" : undefined}>
      <div className="titlebar-group titlebar-tabs" data-tauri-drag-region>
        {items
          .filter((i) => i.area === "titlebar-left")
          .map((i) => (
            <span key={i.id} className="titlebar-item" data-item={i.id}>
              <i.component />
            </span>
          ))}
        {/* §8.2: the titlebar is the tab strip, one tab per open context */}
        <ContextTabs focused={context} />
      </div>

      <div className="titlebar-centre" data-tauri-drag-region>
        <PaletteField />
      </div>

      <div className="titlebar-group titlebar-right" data-tauri-drag-region>
        {/* window-level buttons: every one is an action, so the tooltip teaches its key */}
        <span className="titlebar-buttons">
          <ActionButton action="home.open" />
          <ActionButton action="fav.picker" keep />
          <ActionButton action="help.overlay" />
          <ActionButton action="settings.open" />
          {/* window actions without a button of their own, so none of them is keyboard-only */}
          <button
            type="button"
            className="k-abtn"
            tabIndex={-1}
            {...tip("More window actions")}
            aria-label="More window actions"
            aria-haspopup="menu"
            onMouseDown={keepFocus}
            onClick={(e) => openMenu({ at: menuAnchor(e.currentTarget), items: WINDOW_MENU })}
          >
            <Icon name="more" />
          </button>
        </span>
        {items
          .filter((i) => i.area === "titlebar")
          .map((i) => (
            <span key={i.id} className="titlebar-item" data-item={i.id}>
              <i.component />
            </span>
          ))}
      </div>
    </header>
  );
}
