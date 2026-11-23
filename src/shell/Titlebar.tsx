// Titlebar (docs/ux.md §2.4): 32px, a drag region except for its controls. Window controls stay
// native: on macOS the traffic lights overlay the left 78px; on Windows the OS caption is used.
import { contextDetail } from "../store/context-label";
import { useSyncExternalStore } from "react";
import { registry, type ActionId } from "../actions";
import { isTauri } from "../ipc";
import { platform } from "../keys";
import { useCluster } from "../store/cluster";
import { useWorkspace } from "../store/layout";
import { useSettings } from "../store/settings";
import { viewOf } from "../store/workspace";
import { ActionButton, actionTip, Glyph, Icon, keepFocus, Keys, menuAnchor, openMenu, runAction, tip, useActionState } from "../ui";
import { useShell } from "./slots";
import { WINDOW_MENU } from "./window-menu";

/** True once a feature registered a handler for the action (principle 12: no dead controls). */
export function useBuilt(id: ActionId): boolean {
  return useSyncExternalStore(registry.subscribe, () => registry.get(id)?.built ?? false);
}

/**
 * A titlebar switcher (context, namespace): the current value with a caret; a click opens the
 * picker of its action. Plain text until that action is built or while it does not apply.
 */
function Trigger({ action, className, children, title }: { action: ActionId; className: string; children: React.ReactNode; title: string }) {
  const state = useActionState(action);
  if (!state.present) {
    return (
      <span className={className} data-tauri-drag-region>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`titlebar-switch ${className}`}
      tabIndex={-1}
      {...actionTip(action, title, state.reason)}
      aria-disabled={!state.enabled || undefined}
      onMouseDown={keepFocus}
      onClick={() => runAction(action)}
    >
      <span className="titlebar-switch-text">{children}</span>
      <Icon name="caret" />
    </button>
  );
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
  // the focused pane's context (§8.3): the one keys act on, its flags and its protected line.
  // When it is not the window's, the window's context follows in muted text.
  const windowCtx = useCluster((s) => s.context);
  const focusedCtx = useWorkspace((ws) => (ws ? (ws.panes[ws.focused]?.context ?? null) : null));
  const context = focusedCtx ?? windowCtx;
  const info = useCluster((s) => (context ? (s.conns[context]?.info ?? null) : s.info));
  const meta = useCluster((s) => s.contexts.find((c) => c.name === context));
  const flags = useSettings((s) => (context ? s.contexts[context] : undefined));
  const namespace = useWorkspace((ws) => {
    const v = ws ? viewOf(ws, ws.focused) : undefined;
    return v?.kind === "table" ? v.namespace : null;
  });
  const items = useShell((s) => s.items);
  const cluster = info?.cluster ?? meta?.cluster;
  const user = info?.user ?? meta?.user;

  return (
    <header className="titlebar" data-tauri-drag-region data-mac={platform === "mac" && isTauri ? "" : undefined} data-protected={flags?.protected ? "" : undefined}>
      <div className="titlebar-group" data-tauri-drag-region>
        {items
          .filter((i) => i.area === "titlebar-left")
          .map((i) => (
            <span key={i.id} className="titlebar-item" data-item={i.id}>
              <i.component />
            </span>
          ))}
        <Trigger action="context.pick" className="titlebar-context t-crumb" title="Switch context">
          {context ?? "no context"}
        </Trigger>
        {focusedCtx && focusedCtx !== windowCtx && (
          <span className="titlebar-window t-ui" data-tauri-drag-region title="The focused pane is in another context than the window">
            pane · window {windowCtx}
          </span>
        )}
        {cluster && (
          <span className="titlebar-cluster t-ui" data-tauri-drag-region title={`${cluster} / ${user}`}>
            {contextDetail(cluster, user ?? "")}
          </span>
        )}
        {info?.serverVersion && (
          <span className="titlebar-version t-ui" data-tauri-drag-region>
            {info.serverVersion}
          </span>
        )}
        {namespace !== null && (
          <Trigger action="namespace.pick" className="titlebar-namespace t-ui" title="Switch namespace of the focused pane">
            {namespace === "*" ? "all namespaces" : namespace}
          </Trigger>
        )}
      </div>

      <div className="titlebar-centre" data-tauri-drag-region>
        <PaletteField />
      </div>

      <div className="titlebar-group titlebar-right" data-tauri-drag-region>
        {flags?.readOnly && (
          <span className="titlebar-flag t-label" data-tauri-drag-region>
            READ ONLY
          </span>
        )}
        {flags?.protected && (
          <span className="titlebar-flag t-label" data-tauri-drag-region>
            <Glyph state="warn" />
            PROTECTED
          </span>
        )}
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
