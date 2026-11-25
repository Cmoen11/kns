// Context tabs (docs/ux.md §2.4, §8.2): the titlebar is the tab strip, one tab per open kube
// context, like a browser's. The window's context is the active tab. A tab not on screen stays
// warm: connection, table watches and shells keep running. Everything about a context lives on
// its tab (state, protected, read-only, cluster and version in the tooltip, a right-click menu),
// so the rest of the titlebar stays free.
import { closeTab, switchContext, useCluster, useConn } from "../store/cluster";
import { contextDetail } from "../store/context-label";
import { useTabs } from "../store/layout";
import { useSettings } from "../store/settings";
import { actionTip, Glyph, Icon, keepFocus, openMenu, runAction, tip, useActionState, type GlyphState, type MenuEntry } from "../ui";

function connGlyph(status: string): GlyphState | null {
  if (status === "offline") return "error";
  if (status === "connecting") return "progress";
  return null;
}

/** Right-click on a tab. The close key only shows on the active tab's row: it closes the active tab. */
const tabMenu = (name: string, active: boolean): MenuEntry[] => [
  { action: "tab.close", label: `Close ${name}`, args: [name], binding: active ? undefined : -1 },
  { action: "tab.closeOthers", label: "Close other tabs", args: [name] },
  "|",
  { action: "context.pick", label: "Open a context…" },
];

function Tab({ name, active }: { name: string; active: boolean }) {
  const status = useConn(name, (c) => c.status);
  const info = useConn(name, (c) => c.info);
  const meta = useCluster((s) => s.contexts.find((c) => c.name === name));
  const flags = useSettings((s) => s.contexts[name]);
  const glyph = flags?.protected ? "warn" : connGlyph(status);
  const cluster = info?.cluster ?? meta?.cluster;
  const user = info?.user ?? meta?.user;
  const facts = [
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
      data-active={active ? "" : undefined}
      data-protected={flags?.protected ? "" : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu({ at: { x: e.clientX, y: e.clientY }, items: tabMenu(name, active) });
      }}
    >
      <button
        type="button"
        className="ctx-tab-main"
        tabIndex={-1}
        {...tip(facts.length > 0 ? `${name} · ${facts.join(" · ")}` : name)}
        onMouseDown={keepFocus}
        onClick={() => void switchContext(name)}
        onAuxClick={(e) => {
          if (e.button === 1) void closeTab(name);
        }}
      >
        {glyph && <Glyph state={glyph} />}
        <span className="ctx-tab-name">{name}</span>
        {flags?.readOnly && <span className="ctx-tab-flag t-label">RO</span>}
      </button>
      <button
        type="button"
        className="ctx-tab-close"
        tabIndex={-1}
        aria-label={`Close ${name}`}
        {...(active ? actionTip("tab.close", `Close ${name}`) : tip(`Close ${name}`))}
        onMouseDown={keepFocus}
        onClick={() => void closeTab(name)}
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
  const shown = tabs.length > 0 ? tabs : windowCtx ? [windowCtx] : [];
  return (
    <>
      <span className="ctx-tabs" role="tablist" aria-label="Contexts">
        {shown.map((t) => (
          <Tab key={t} name={t} active={t === windowCtx} />
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
          pane · {focused}
        </span>
      )}
    </>
  );
}
