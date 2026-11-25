// One pane: header (§11.1) + the registered view for its current history entry. Memoized on
// primitives, so resizing, focusing another pane or data in another pane never re-renders it.
import { Component, Fragment, memo, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { useEngineValue } from "../keys";
import { useConn } from "../store/cluster";
import { focusPane, navEpoch, useMixedContexts, usePaneContext, usePaneView, useWorkspace } from "../store/layout";
import { useContextName, useSettings } from "../store/settings";
import { leafIds } from "../store/layout-tree";
import { faultsText, usePaneFaults, usePaneStatus, type PaneWatch } from "../store/pane-status";
import type { PaneId, ViewState } from "../types";
import {
  ActionButton, actionTip, EmptyState, Glyph, Icon, keepFocus, menuAnchor, Nodelinje, openMenu, PaneContext, runAction, tip, Toolbar, useActionState,
  type MenuEntry, type NodelinjeState,
} from "../ui";
import { crumbsOf, subscribeViews, toolbarOf, viewComponent, viewRegistryVersion, type Crumb } from "../views/registry";
import { useDraftLabel } from "../views/doc/open-draft";
import { cleanUntrusted } from "../ui/untrusted";
import { goToCrumb } from "./crumbs";
import { PaneSlotContext, type PaneSlots } from "./slots";
import { startHeaderDrag } from "./drag";

/** The pane menu: the "more" button of the header, and a right-click on the header. */
const PANE_MENU: readonly MenuEntry[] = [
  "history.back", "history.forward", "nav.crumbUp",
  "|", "pane.splitRight", "pane.splitDown", "pane.zoom", "pane.equalize", "pane.flipSplit",
  "|", "pane.moveLeft", "pane.moveRight", "pane.moveUp", "pane.moveDown",
  "|", "pane.followToggle", "pane.reopenClosed", "pane.closeOthers", "pane.close",
];

type ActionCrumb = Crumb & { action: NonNullable<Crumb["action"]> };

/** Long crumbs (object names) are the ones that truncate; short ones stay whole (panes.css). */
const crumbClass = (label: string): string => (label.length > 8 ? "pane-crumb pane-crumb-long" : "pane-crumb");

/** A crumb that runs an action for its pane: the namespace picker, the palette for another resource. */
function CrumbAction({ pane, crumb }: { pane: PaneId; crumb: ActionCrumb }) {
  const state = useActionState(crumb.action, { pane, args: crumb.args });
  if (!state.present) return <span className={crumbClass(crumb.label)}>{crumb.label}</span>;
  return (
    <button
      type="button"
      className={`${crumbClass(crumb.label)} pane-crumb-pick`}
      tabIndex={-1}
      {...actionTip(crumb.action, undefined, state.reason)}
      aria-disabled={!state.enabled || undefined}
      onMouseDown={keepFocus}
      onClick={() => runAction(crumb.action, { pane, args: crumb.args })}
    >
      <span className="pane-crumb-text">{crumb.label}</span>
      <Icon name="caret" />
    </button>
  );
}

const WATCH: Record<PaneWatch, { glyph: NodelinjeState; word: string }> = {
  live: { glyph: "live", word: "live" },
  syncing: { glyph: "reconnecting", word: "syncing" },
  reconnecting: { glyph: "reconnecting", word: "reconnecting" },
  stale: { glyph: "stale", word: "paused" },
  forbidden: { glyph: "stale", word: "forbidden" },
  error: { glyph: "stale", word: "error" },
};

/** A crashing view shows its error in the pane; the rest of the window keeps working. */
class ViewBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) return <EmptyState compact>This view failed: {this.state.error.message}</EmptyState>;
    return this.props.children;
  }
}

/**
 * The pane's kube context, first crumb, while panes of more than one context are on screen
 * (§8.3). A click picks another context for this pane (leader C). A protected context shows the
 * warn glyph; the pane frame then also draws the protected line (panes.css).
 */
function ContextCrumb({ pane, context, protectedCtx }: { pane: PaneId; context: string; protectedCtx: boolean }) {
  const status = useConn(context, (c) => c.status);
  const name = useContextName(context);
  const state = useActionState("context.pickPane", { pane });
  const label = (
    <>
      {protectedCtx && <Glyph state="warn" />}
      <span className="pane-crumb-text">{name}</span>
    </>
  );
  const why = status === "offline" ? "offline" : protectedCtx ? "protected context" : undefined;
  if (!state.present) return <span className="pane-crumb pane-ctx">{label}</span>;
  return (
    <button
      type="button"
      className="pane-crumb pane-crumb-pick pane-ctx"
      data-status={status}
      tabIndex={-1}
      {...actionTip("context.pickPane", undefined, why)}
      onMouseDown={keepFocus}
      onClick={() => runAction("context.pickPane", { pane })}
    >
      {label}
      <Icon name="caret" />
    </button>
  );
}

function Missing({ view }: { view: ViewState }) {
  return <EmptyState compact>No view is registered for "{view.kind}".</EmptyState>;
}

interface HeaderProps {
  id: PaneId;
  index: number;
  view: ViewState;
  zoomed: boolean;
  setChips: (el: HTMLElement | null) => void;
  setToolbar: (el: HTMLElement | null) => void;
  setLabels: (el: HTMLElement | null) => void;
  setCount: (el: HTMLElement | null) => void;
}

const PaneHeader = memo(function PaneHeader({ id, index, view, zoomed, setChips, setToolbar, setLabels, setCount }: HeaderProps) {
  // the pane number shows only in PANE mode (§11.1)
  const leader = useEngineValue((e) => e.snapshot().leader);
  const link = useWorkspace((ws) => ws?.panes[id]?.link);
  const sourceIndex = useWorkspace((ws) => (ws && link?.source ? leafIds(ws.root).indexOf(link.source) + 1 : 0));
  const status = usePaneStatus(id);
  const faults = usePaneFaults(id);
  // a pane opened by an agent's show_in_kns, and an agent's draft in EDIT (plan-features §2.8, §2.10a)
  const agent = useWorkspace((ws) => ws?.panes[id]?.agent);
  const draft = useDraftLabel(id, view);
  const mixed = useMixedContexts();
  const context = usePaneContext(id);
  const protectedCtx = useSettings((s) => s.contexts[context]?.protected ?? false);
  const crumbs = crumbsOf(view);
  const toolbar = toolbarOf(view);
  const open = (c: Crumb, e: MouseEvent) => {
    if (!c.view) return;
    const beside = e.ctrlKey || e.metaKey ? (e.shiftKey ? "down" : "right") : null;
    goToCrumb(id, c.view, beside);
  };
  // the pane menu: under the "more" button, or where the header was right-clicked
  const paneMenu = (at: { x: number; y: number }) => openMenu({ at, items: PANE_MENU, pane: id });
  const onContextMenu = (e: MouseEvent) => {
    if (e.target instanceof HTMLInputElement) return; // a filter or command input keeps the native menu
    e.preventDefault();
    paneMenu({ x: e.clientX, y: e.clientY });
  };
  const watch = status.watch ? WATCH[status.watch] : null;
  return (
    <header className="pane-header" onContextMenu={onContextMenu} onPointerDown={(e) => startHeaderDrag(e.nativeEvent, id, e.currentTarget)}>
      {leader && <span className="pane-index t-ui">{index}</span>}
      <span className="pane-nav pane-reveal">
        <ActionButton action="history.back" keep />
        <ActionButton action="history.forward" keep />
      </span>
      <nav className="pane-crumbs t-crumb" aria-label="Breadcrumbs">
        {mixed && context && (
          <>
            <ContextCrumb pane={id} context={context} protectedCtx={protectedCtx} />
            <span className="pane-crumb-sep" aria-hidden="true">/</span>
          </>
        )}
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="pane-crumb-sep" aria-hidden="true">/</span>}
            {c.action ? (
              <CrumbAction pane={id} crumb={c as ActionCrumb} />
            ) : c.view ? (
              <button type="button" className={crumbClass(c.label)} tabIndex={-1} {...tip(`Go to ${c.label}`)} onMouseDown={keepFocus} onClick={(e) => open(c, e)}>
                {c.label}
              </button>
            ) : (
              <span className={crumbClass(c.label)}>{c.label}</span>
            )}
          </Fragment>
        ))}
      </nav>
      {/* directly after the crumbs: the toolbar's left edge only moves with the crumbs (a
          navigation). Chips, labels and the count come and go to its right, so when it overflows
          it gives up buttons at its right end and never moves the one under the pointer */}
      {toolbar.length > 0 && (
        <span className="pane-toolbar pane-reveal">
          <Toolbar items={toolbar} />
        </span>
      )}
      <span className="pane-slot pane-toolbar pane-reveal" ref={setToolbar} />
      <span className="pane-slot pane-chips" ref={setChips} />
      <span className="pane-fill" />
      {zoomed && <span className="pane-tag t-label">ZOOM</span>}
      {agent && <span className="pane-tag t-label" dir="ltr">AGENT · {cleanUntrusted(agent, 40)}</span>}
      {draft && <span className="pane-tag t-label" dir="ltr">{draft}</span>}
      {sourceIndex > 0 && link && (
        <span className="pane-link">
          <span className="t-ui">← {sourceIndex}</span>
          {link.follow && <span className="pane-tag t-label">FOLLOW</span>}
        </span>
      )}
      <span className="pane-slot pane-labels t-label" ref={setLabels} />
      <span className="pane-slot pane-count t-ui" ref={setCount} />
      {faults && (
        // faulty rows in this table: glyph + count in the status hue; `!` (FAULTS) shows only them
        <span className="pane-faults t-ui num" data-state={faults.error > 0 ? "error" : "warn"} {...tip(faultsText(faults), { reason: "! shows only these rows" })}>
          <Glyph state={faults.error > 0 ? "error" : "warn"} />
          {faults.error + faults.warn}
          <span className="sr-only">{faultsText(faults)}</span>
        </span>
      )}
      {watch && (
        <span className="pane-watch" data-watch={status.watch ?? undefined} {...tip(watch.word, { reason: status.message })}>
          <Nodelinje state={watch.glyph} />
          <span className="sr-only">{watch.word}</span>
        </span>
      )}
      <span className="pane-ops pane-reveal">
        <ActionButton action="pane.splitRight" className="pane-op-wide" />
        <ActionButton action="pane.splitDown" className="pane-op-wide" />
        <ActionButton action="pane.zoom" className="pane-op-wide" active={zoomed} />
        <button type="button" className="k-abtn" tabIndex={-1} {...tip("Pane menu")} aria-label="Pane menu" aria-haspopup="menu" onMouseDown={keepFocus} onClick={(e) => paneMenu(menuAnchor(e.currentTarget))}>
          <Icon name="more" />
        </button>
        <ActionButton action="pane.close" />
      </span>
    </header>
  );
});

export interface PaneProps {
  id: PaneId;
  /** 1-based pane number */
  index: number;
  focused: boolean;
  /** false while folded away or zoomed out */
  visible: boolean;
  zoomed: boolean;
}

export const Pane = memo(function Pane({ id, index, focused, visible, zoomed }: PaneProps) {
  const view = usePaneView(id);
  useSyncExternalStore(subscribeViews, viewRegistryVersion);
  const el = useRef<HTMLElement>(null);
  const epoch = navEpoch(id);
  const [chips, setChips] = useState<HTMLElement | null>(null);
  const [labels, setLabels] = useState<HTMLElement | null>(null);
  const [count, setCount] = useState<HTMLElement | null>(null);
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  const slots = useMemo<PaneSlots>(() => ({ chips, toolbar, labels, count }), [chips, toolbar, labels, count]);
  // §8.3: with panes of several contexts on screen, a protected one draws its line on the pane
  const mixed = useMixedContexts();
  const context = usePaneContext(id);
  const protectedCtx = useSettings((s) => s.contexts[context]?.protected ?? false);

  // DOM focus follows pane focus, unless a view, input or dialog already holds it. Child effects
  // run first, so a view that focuses its own element (terminal, editor) wins.
  useEffect(() => {
    const node = el.current;
    if (!focused || !visible || !node) return;
    const a = document.activeElement;
    if (node.contains(a)) return;
    if (!a || a === document.body || a.closest(".pane")) node.focus({ preventScroll: true });
    // also after a history move: a click that opened a view leaves focus on <body> when the
    // clicked element (a home row) is unmounted with its view
  }, [focused, visible, epoch]);

  if (!view) return null;
  const View = viewComponent(view.kind);
  const label = [mixed ? context : "", ...crumbsOf(view).map((c) => c.label)].filter(Boolean).join(" / ");
  return (
    <section
      ref={el}
      className="pane"
      role="region"
      aria-label={`Pane ${index}: ${label}`}
      tabIndex={-1}
      data-focused={focused || undefined}
      data-protected={(mixed && protectedCtx) || undefined}
      data-context={mixed ? context : undefined}
      onPointerDownCapture={focused ? undefined : () => focusPane(id)}
    >
      {/* PaneContext: every ActionButton below (also through the header portals) acts on this pane */}
      <PaneContext.Provider value={id}>
        <PaneHeader id={id} index={index} view={view} zoomed={zoomed} setChips={setChips} setToolbar={setToolbar} setLabels={setLabels} setCount={setCount} />
        <div className="pane-body">
          <PaneSlotContext.Provider value={slots}>
            {/* remounted per history move (push, back, forward), not per edit of the entry */}
            <ViewBoundary key={`${view.kind}:${navEpoch(id)}`}>
              <Suspense fallback={null}>
                {View ? <View pane={id} view={view} focused={focused} visible={visible} /> : <Missing view={view} />}
              </Suspense>
            </ViewBoundary>
          </PaneSlotContext.Provider>
        </div>
      </PaneContext.Provider>
    </section>
  );
});
