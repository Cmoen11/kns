// Context tabs in the titlebar (docs/ux.md §8.2). One tab per open kube context; the window's
// context is the active tab. A tab that is not on screen stays warm: connection, table watches
// and shells keep running. With a single tab the strip is the plain context switcher it was.
import { closeTab, switchContext, useCluster, useConn } from "../store/cluster";
import { useTabs } from "../store/layout";
import { useSettings } from "../store/settings";
import { actionTip, Glyph, Icon, keepFocus, runAction, tip, useActionState, type GlyphState } from "../ui";

function connGlyph(status: string): GlyphState | null {
  if (status === "offline") return "error";
  if (status === "connecting") return "progress";
  return null;
}

function Tab({ name, active }: { name: string; active: boolean }) {
  const status = useConn(name, (c) => c.status);
  const flags = useSettings((s) => s.contexts[name]);
  const pick = useActionState("context.pick");
  const glyph = connGlyph(status);
  const open = () => (active ? pick.present && runAction("context.pick") : void switchContext(name));
  return (
    <span className="ctx-tab" role="tab" aria-selected={active} data-active={active ? "" : undefined} data-protected={flags?.protected ? "" : undefined}>
      <button
        type="button"
        className="ctx-tab-main t-crumb"
        tabIndex={-1}
        {...(active ? actionTip("context.pick", "Switch context", pick.reason) : tip(`Go to ${name}`))}
        onMouseDown={keepFocus}
        onClick={open}
        onAuxClick={(e) => {
          if (e.button === 1) void closeTab(name);
        }}
      >
        {flags?.protected && <Glyph state="warn" />}
        {glyph && glyph !== "progress" && <Glyph state={glyph} />}
        <span className="ctx-tab-name">{name}</span>
        {flags?.readOnly && <span className="ctx-tab-flag t-label">RO</span>}
        {active && <Icon name="caret" />}
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

/** The tab strip; `focused` is the focused pane's context, named after the strip when it is foreign. */
export function ContextTabs({ focused, single }: { focused: string | null; single: React.ReactNode }) {
  const tabs = useTabs();
  const windowCtx = useCluster((s) => s.context);
  const pick = useActionState("context.pick");
  if (tabs.length < 2) return <>{single}</>;
  return (
    <>
      <span className="ctx-tabs" role="tablist" aria-label="Context tabs">
        {tabs.map((t) => (
          <Tab key={t} name={t} active={t === windowCtx} />
        ))}
        {pick.present && (
          <button type="button" className="k-abtn ctx-tab-add" tabIndex={-1} aria-label="Open a context tab" {...actionTip("context.pick", "Open a context tab", pick.reason)} onMouseDown={keepFocus} onClick={() => runAction("context.pick")}>
            <Icon name="plus" />
          </button>
        )}
      </span>
      {focused && focused !== windowCtx && (
        <span className="titlebar-window t-ui" data-tauri-drag-region title="The focused pane is in another context than its tab">
          pane · {focused}
        </span>
      )}
    </>
  );
}
