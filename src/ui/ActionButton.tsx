// A button bound to an action id (mouse parity, docs/frontend.md §17). It shows the registry's
// state live (absent, disabled + reason), its tooltip is the label and the key from the live keymap, and a
// click runs the action through the engine with source "pointer". It never takes keyboard focus.
import { memo, type MouseEvent, type ReactNode } from "react";
import { registry, type ActionId } from "../actions/registry";
import type { PaneId } from "../types";
import { keepFocus, runAction, useActionState, usePaneId, useShownBinding } from "./action-state";
import { Icon, type IconName } from "./Glyph";
import { KeyChip } from "./KeyChip";
import { actionTip } from "./Tooltip";

/** Default icons, so a toolbar can be declared as a list of action ids. No entry = the label is shown. */
export const ACTION_ICONS: Partial<Record<ActionId, IconName>> = {
  "history.back": "back",
  "history.forward": "forward",
  "nav.crumbUp": "up",
  "pane.splitRight": "split-right",
  "pane.splitDown": "split-down",
  "pane.zoom": "zoom",
  "pane.close": "close",
  "menu.open": "more",
  "palette.open": "search",
  "fav.picker": "star",
  "fav.saveView": "star",
  "help.overlay": "help",
  "settings.open": "settings",
  "home.open": "home",
  "view.refresh": "refresh",
  "view.columns": "columns",
  "filter.open": "filter",
  "res.logs": "logs",
  "res.logsPrevious": "history",
  "res.describe": "describe",
  "res.yaml": "yaml",
  "res.edit": "edit",
  "res.delete": "delete",
  "pod.shell": "shell",
  "pf.start": "forwardPort",
  "workload.scale": "scale",
  "workload.restart": "refresh",
  "doc.copy": "copy",
  "doc.wrap": "wrap",
  "doc.format": "yaml",
  "logs.wrap": "wrap",
  "logs.timestamps": "clock",
  "logs.resumeFollow": "follow",
  "logs.autoscroll": "follow",
  "logs.previous": "history",
  "logs.containerPicker": "container",
  "logs.copy": "copy",
  "terminal.copy": "copy",
  "terminal.search": "search",
  "terminal.reconnect": "refresh",
  "secret.revealToggle": "eye",
  "review.apply": "check",
  "copy.name": "copy",
  // feature actions (docs/plan-features.md §2.10a); absent until built
  "hub.open": "tools",
  "hub.help": "help",
  "res.why": "why",
  "why.copy": "copy",
  "res.timeline": "timeline",
  "res.diff": "diff",
  "pod.debug": "bug",
  "res.trap": "trap",
  "trap.list": "trap",
  "trap.disarm": "stop",
  "res.relations": "relations",
  "res.reach": "reach",
  "res.pack": "pack",
  "res.kubectl": "copy",
  "text.copy": "copy",
  "logs.patterns": "pattern",
  "logs.structured": "columns",
  "dev.picker": "env",
  "dev.fromWorkload": "env",
  "dev.up": "play",
  "dev.down": "stop",
  "dev.delete": "delete",
  "env.copyAs": "copy",
  "env.reveal": "eye",
  "pf.copyUrl": "copy",
  "mcp.command": "plug",
  "agents.open": "agent",
  "agents.connect": "plug",
  "proposals.next": "agent",
};

export interface ActionButtonProps {
  action: ActionId;
  /** default: ACTION_ICONS[action]; null = no icon. Without an icon the label is shown */
  icon?: IconName | null;
  /** overrides the registry label (tooltip, accessible name, visible text) */
  label?: string;
  /** show the label next to the icon */
  showLabel?: boolean;
  /** show the key chip after the label (empty states, dialogs) */
  showKeys?: boolean;
  /** words passed as ctx.args, like a `:` command */
  args?: readonly string[];
  /** open beside; default: Ctrl/⌘+click = right, with Shift = down, for actions that open a view */
  newPane?: "right" | "down" | null;
  /** the pane it acts on; default: the pane it is rendered in (PaneContext), else the focused pane */
  pane?: PaneId | null;
  /** runs after the pane took focus and before the action: move the cursor to the clicked row */
  before?: () => void;
  /** toggle state (wrap on, follow on): aria-pressed + the pressed look */
  active?: boolean;
  /** keep the button (disabled) while the action is absent, so a fixed row of buttons never shifts */
  keep?: boolean;
  /** false: no tooltip unless it is disabled (the label and the key are already on the button) */
  tooltip?: boolean;
  className?: string;
  children?: ReactNode;
  "data-tb"?: number;
}

function Chip({ action }: { action: ActionId }) {
  const b = useShownBinding(action);
  return b ? <KeyChip binding={b} /> : null;
}

export const ActionButton = memo(function ActionButton(props: ActionButtonProps) {
  const { action, label, showLabel, showKeys, args, newPane, before, active, keep, tooltip = true, className, children } = props;
  const own = usePaneId();
  const pane = props.pane === undefined ? own : props.pane;
  const state = useActionState(action, { pane, args, newPane });
  if (!state.present && !keep) return null;
  const def = registry.target(action);
  const name = label ?? def?.label ?? action;
  const disabled = !state.present || !state.enabled;
  const icon = props.icon === null ? undefined : (props.icon ?? ACTION_ICONS[action]);
  const reason = state.present ? state.reason : "not available here";
  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    const beside = newPane !== undefined ? newPane : def?.opens === "view" && (e.ctrlKey || e.metaKey) ? (e.shiftKey ? "down" : "right") : null;
    runAction(action, { pane, args, newPane: beside, before });
  };
  return (
    <button
      type="button"
      className={className ? `k-abtn ${className}` : "k-abtn"}
      tabIndex={-1}
      {...(tooltip || reason ? actionTip(action, name, reason) : undefined)}
      aria-label={name}
      aria-disabled={disabled || undefined}
      aria-pressed={active === undefined ? undefined : active}
      data-disabled={disabled || undefined}
      data-action={action}
      data-tb={props["data-tb"]}
      onMouseDown={keepFocus}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      {icon && <Icon name={icon} />}
      {(showLabel || !icon) && !children && <span className="k-abtn-label t-ui">{name}</span>}
      {children}
      {showKeys && <Chip action={action} />}
    </button>
  );
});

/**
 * An action as inline text: key chip + label, clickable. For the "one-key fix" of an empty state
 * and other prose that names a next step.
 *
 *   <ActionHint action="filter.clear" label="clear the filter" />
 */
export function ActionHint({ action, label, args, pane }: { action: ActionId; label?: string; args?: readonly string[]; pane?: PaneId | null }) {
  const text = label ?? registry.target(action)?.label ?? action;
  return (
    <ActionButton action={action} label={label} args={args} pane={pane} className="k-ahint" icon={null} keep tooltip={false}>
      <Chip action={action} />
      <span className="k-abtn-label">{text}</span>
    </ActionButton>
  );
}
