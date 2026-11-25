// Context tabs (docs/ux.md §2.4, §8.2): the titlebar is the tab strip, one tab per open kube
// context, like a browser's. The window's context is the active tab. A tab not on screen stays
// warm: connection, table watches and shells keep running. Everything about a context lives on
// its tab (state, protected, read-only, alias, cluster and version in the tooltip, a right-click
// menu), so the rest of the titlebar stays free. Tabs reorder by dragging.
import { useRef } from "react";
import { closeTab, switchContext, useCluster, useConn } from "../store/cluster";
import { contextDetail } from "../store/context-label";
import { moveTab, useTabs } from "../store/layout";
import { useContextName, useSettings } from "../store/settings";
import { actionTip, Glyph, Icon, keepFocus, openMenu, runAction, tip, useActionState, type GlyphState, type MenuEntry } from "../ui";

function connGlyph(status: string): GlyphState | null {
  if (status === "offline") return "error";
  if (status === "connecting") return "progress";
  return null;
}

/** Right-click on a tab. The close key only shows on the active tab's row: it closes the active tab. */
const tabMenu = (context: string, label: string, active: boolean): MenuEntry[] => [
  { action: "context.alias", label: "Rename…", args: [`@${context}`] },
  "|",
  { action: "tab.close", label: `Close ${label}`, args: [context], binding: active ? undefined : -1 },
  { action: "tab.closeOthers", label: "Close other tabs", args: [context] },
  "|",
  { action: "context.pick", label: "Open a context…" },
];

/** A press that moves this far is a drag, not a click. */
const DRAG_PX = 4;

interface Drag {
  context: string;
  startX: number;
  moved: boolean;
}

/**
 * Drag to reorder: the tab follows the pointer through the strip, swapping places as it crosses a
 * neighbour's middle, like a browser's. A drag swallows the click that ends it.
 */
function useTabDrag(strip: React.RefObject<HTMLElement | null>) {
  const drag = useRef<Drag | null>(null);
  const swallow = useRef(false);
  const onPointerDown = (context: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { context, startX: e.clientX, moved: false };
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (!d.moved && Math.abs(ev.clientX - d.startX) < DRAG_PX) return;
      d.moved = true;
      strip.current?.setAttribute("data-dragging", "");
      const tabs = [...(strip.current?.querySelectorAll<HTMLElement>(".ctx-tab") ?? [])];
      for (const t of tabs) t.toggleAttribute("data-drag", t.dataset.context === d.context);
      let index = 0;
      for (const t of tabs) {
        const r = t.getBoundingClientRect();
        if (t.dataset.context !== d.context && ev.clientX > r.left + r.width / 2) index++;
      }
      moveTab(d.context, index);
    };
    const up = () => {
      if (drag.current?.moved) swallow.current = true;
      drag.current = null;
      strip.current?.removeAttribute("data-dragging");
      for (const t of strip.current?.querySelectorAll<HTMLElement>(".ctx-tab[data-drag]") ?? []) t.removeAttribute("data-drag");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  /** true once for the click that ends a drag */
  const swallowed = () => {
    const s = swallow.current;
    swallow.current = false;
    return s;
  };
  return { onPointerDown, swallowed };
}

function Tab({ context, active, drag }: { context: string; active: boolean; drag: ReturnType<typeof useTabDrag> }) {
  const status = useConn(context, (c) => c.status);
  const info = useConn(context, (c) => c.info);
  const meta = useCluster((s) => s.contexts.find((c) => c.name === context));
  const flags = useSettings((s) => s.contexts[context]);
  const label = useContextName(context);
  const glyph = flags?.protected ? "warn" : connGlyph(status);
  const cluster = info?.cluster ?? meta?.cluster;
  const user = info?.user ?? meta?.user;
  const facts = [
    // an aliased tab names its kubeconfig context first
    label !== context ? context : null,
    cluster ? contextDetail(cluster, user ?? "") : null,
    info?.serverVersion,
    status === "connected" ? null : status,
    flags?.protected ? "protected" : null,
    flags?.readOnly ? "read only" : null,
  ].filter(Boolean);
  return (
    <span
      className="ctx-tab"
      role="tab"
      aria-selected={active}
      data-context={context}
      data-active={active ? "" : undefined}
      data-protected={flags?.protected ? "" : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu({ at: { x: e.clientX, y: e.clientY }, items: tabMenu(context, label, active) });
      }}
    >
      <button
        type="button"
        className="ctx-tab-main"
        tabIndex={-1}
        {...tip(facts.length > 0 ? `${label} · ${facts.join(" · ")}` : label)}
        onMouseDown={keepFocus}
        onPointerDown={drag.onPointerDown(context)}
        onClick={() => {
          if (!drag.swallowed()) void switchContext(context);
        }}
        onDoubleClick={() => runAction("context.alias", { args: [`@${context}`] })}
        onAuxClick={(e) => {
          if (e.button === 1) void closeTab(context);
        }}
      >
        {glyph && <Glyph state={glyph} />}
        <span className="ctx-tab-name">{label}</span>
        {flags?.readOnly && <span className="ctx-tab-flag t-label">RO</span>}
      </button>
      <button
        type="button"
        className="ctx-tab-close"
        tabIndex={-1}
        aria-label={`Close ${label}`}
        {...(active ? actionTip("tab.close", `Close ${label}`) : tip(`Close ${label}`))}
        onMouseDown={keepFocus}
        onClick={() => void closeTab(context)}
      >
        <Icon name="close" />
      </button>
    </span>
  );
}

/**
 * The tab strip. `focused` is the focused pane's context: when a pane in another context has the
 * focus, a muted `pane · <context>` follows the strip, so keys never act on a cluster out of sight.
 */
export function ContextTabs({ focused }: { focused: string | null }) {
  const tabs = useTabs();
  const windowCtx = useCluster((s) => s.context);
  const pick = useActionState("context.pick");
  const focusedProtected = useSettings((s) => (focused ? s.contexts[focused]?.protected : false));
  const focusedName = useContextName(focused ?? "");
  const strip = useRef<HTMLSpanElement>(null);
  const drag = useTabDrag(strip);
  const shown = tabs.length > 0 ? tabs : windowCtx ? [windowCtx] : [];
  return (
    <>
      <span className="ctx-tabs" role="tablist" aria-label="Contexts" ref={strip}>
        {shown.map((t) => (
          <Tab key={t} context={t} active={t === windowCtx} drag={drag} />
        ))}
        {shown.length === 0 && <span className="ctx-tab-empty t-ui">no context</span>}
        {pick.present && (
          <button
            type="button"
            className="k-abtn ctx-tab-add"
            tabIndex={-1}
            aria-label="Open a context"
            aria-disabled={!pick.enabled || undefined}
            {...actionTip("context.pick", "Open a context", pick.reason)}
            onMouseDown={keepFocus}
            onClick={() => runAction("context.pick")}
          >
            <Icon name="plus" />
          </button>
        )}
      </span>
      {focused && windowCtx && focused !== windowCtx && (
        <span className="titlebar-window t-ui" data-tauri-drag-region title="The focused pane shows another context than its tab">
          {focusedProtected && <Glyph state="warn" />}
          pane · {focusedName}
        </span>
      )}
    </>
  );
}
