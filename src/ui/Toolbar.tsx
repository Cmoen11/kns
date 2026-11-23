// A compact row of action buttons (mouse parity, docs/frontend.md §17). Declared as a list of
// action ids; groups are separated by "|". When the row is too narrow the buttons that do not fit
// move into a "more" menu, so nothing is ever unreachable and nothing shifts.
import { memo, useLayoutEffect, useRef, useState } from "react";
import type { ActionId } from "../actions/registry";
import type { PaneId } from "../types";
import { ActionButton } from "./ActionButton";
import { keepFocus, usePaneId } from "./action-state";
import { Icon, type IconName } from "./Glyph";
import { menuAnchor, openMenu, type MenuEntry } from "./menu";
import { tip } from "./Tooltip";

export interface ToolbarAction {
  action: ActionId;
  icon?: IconName | null;
  label?: string;
  showLabel?: boolean;
  args?: readonly string[];
  /** toggle state (wrap on, follow on) */
  active?: boolean;
  /** runs before the action (move the cursor) */
  before?: () => void;
  /** keep it (disabled) while the action is absent */
  keep?: boolean;
  /** stays with the item before it (a segmented control): in the bar together, or in "more" together */
  join?: boolean;
}

/** A button that opens a small menu of actions (presets: "since 5m", "tail"). Its rows are actions like any other. */
export interface ToolbarMenu {
  menu: readonly MenuEntry[];
  /** tooltip and accessible name */
  label: string;
  /** visible text (the current choice); without it the icon alone */
  text?: string;
  icon?: IconName;
}

/** An action id, a "|" separator, an action with options, or a menu button. */
export type ToolbarItem = ActionId | "|" | ToolbarAction | ToolbarMenu;

export interface ToolbarProps {
  items: readonly ToolbarItem[];
  /** accessible name */
  label?: string;
  /** default: the pane the toolbar is rendered in */
  pane?: PaneId | null;
  className?: string;
}

const isMenu = (it: ToolbarItem): it is ToolbarMenu => typeof it === "object" && "menu" in it;
const joined = (it: ToolbarItem | undefined): boolean => typeof it === "object" && "join" in it && it.join === true;
/** Item indexes in runs: an item with `join` is in the run of the item before it. */
function runs(items: readonly ToolbarItem[]): number[][] {
  const out: number[][] = [];
  items.forEach((it, i) => {
    if (i > 0 && joined(it)) out[out.length - 1].push(i);
    else out.push([i]);
  });
  return out;
}
const entry = (it: ToolbarItem): ToolbarAction | null => (it === "|" || isMenu(it) ? null : typeof it === "string" ? { action: it } : it);

/**
 *   <Toolbar items={["logs.autoscroll", { action: "logs.wrap", active: view.wrap }, "|", "logs.copy"]} />
 */
export const Toolbar = memo(function Toolbar({ items, label = "Actions", pane, className }: ToolbarProps) {
  const box = useRef<HTMLDivElement>(null);
  const own = usePaneId();
  const target = pane === undefined ? own : pane;
  // index of the first item that wrapped out of the one visible row; items.length = all fit
  const [cut, setCut] = useState(items.length);

  // keyed on the count, not the array: callers pass inline arrays, and the observers see the rest
  const count = items.length;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      let next = count;
      for (const c of el.children) {
        const h = c as HTMLElement;
        // on a later row (a short item, like a separator, sits a little below the top of the first)
        // ... or the first of a row too narrow for it: it stays on row one, clipped
        if (h.offsetTop >= el.clientHeight || h.getBoundingClientRect().right > el.getBoundingClientRect().right + 1) {
          next = Math.min(next, Number(h.dataset.tb));
          break;
        }
      }
      setCut((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // a button whose text changes ("Leave edit" to "Discard", the time range) changes width at
    // the same count: every child is observed too
    const watch = () => {
      for (const c of el.children) ro.observe(c);
    };
    watch();
    // buttons appear and disappear with the action state
    const mo = new MutationObserver(() => {
      watch();
      measure();
    });
    mo.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [count]);

  const more = (e: { currentTarget: Element }) => {
    const rest: MenuEntry[] = [];
    for (const it of items.slice(cut)) {
      if (isMenu(it)) {
        rest.push(...it.menu);
        continue;
      }
      // the groups stay groups in the menu (openMenu drops a rule that ends up first, last or doubled)
      if (it === "|") {
        rest.push("|");
        continue;
      }
      const a = entry(it);
      if (a) rest.push({ action: a.action, label: a.label, args: a.args, before: a.before });
    }
    openMenu({ at: menuAnchor(e.currentTarget), items: rest, pane: target });
  };

  const item = (i: number) => {
    const it = items[i];
    if (isMenu(it)) {
      return (
        <button
          key={`menu:${i}`}
          type="button"
          className="k-abtn"
          tabIndex={-1}
          {...tip(it.label)}
          aria-label={it.label}
          aria-haspopup="menu"
          data-tb={i}
          onMouseDown={keepFocus}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            openMenu({ at: menuAnchor(e.currentTarget), items: it.menu, pane: target });
          }}
        >
          {it.icon && <Icon name={it.icon} />}
          {it.text !== undefined && <span className="k-abtn-label t-ui">{it.text}</span>}
          <Icon name="caret" />
        </button>
      );
    }
    const a = entry(it);
    if (!a) return <span key={i} className="k-toolbar-sep" data-tb={i} aria-hidden="true" />;
    return (
      <ActionButton
        key={`${a.action}:${i}`}
        action={a.action}
        icon={a.icon}
        label={a.label}
        showLabel={a.showLabel}
        args={a.args}
        active={a.active}
        before={a.before}
        keep={a.keep}
        pane={target}
        data-tb={i}
      />
    );
  };

  return (
    <div className={className ? `k-toolbar ${className}` : "k-toolbar"} role="toolbar" aria-label={label}>
      <div className="k-toolbar-items" ref={box}>
        {runs(items).map((run) =>
          run.length === 1 ? (
            item(run[0])
          ) : (
            // one flex item: it wraps out of the row (into "more") as a whole
            <span key={`join:${run[0]}`} className="k-toolbar-join" data-tb={run[0]}>
              {run.map(item)}
            </span>
          ),
        )}
      </div>
      {cut < items.length && (
        <button type="button" className="k-abtn k-toolbar-more" tabIndex={-1} {...tip("More actions")} aria-label="More actions" aria-haspopup="menu" onMouseDown={keepFocus} onClick={more}>
          <Icon name="more" />
        </button>
      )}
    </div>
  );
});
