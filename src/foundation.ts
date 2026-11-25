// The foundation API for feature directories (docs/frontend.md §9). Import from here; everything
// a feature needs to open views, read the selection, talk to the cluster and plug into the chrome
// is re-exported, so features never reach into each other.

// views and history
export {
  openView, replaceView, patchView, goBack, goForward, goLast, canGoBack, canGoForward,
  setNamespace, setNamespaceAllPanes, paneNamespace,
  focusedPane, useFocusedPane, paneView, usePaneView, paneState, paneOrder, paneIndex,
  getWorkspace, useWorkspace, setWorkspace,
  focusPane, splitPane, closePane, closeOtherPanes, reopenPane, toggleZoom, toggleFollow, liveSessions,
  openWorkspaces, openTabs, useTabs, allLiveSessions,
  paneContext, focusedContext, openInContext, openPaneInContext, usePaneContext, focusedIsForeign, setPaneContext, useMixedContexts, workspaceContexts,
  type OpenOptions,
} from "./store/layout";
export { tableView, currentView, CORE_PODS, CORE_EVENTS, CORE_NAMESPACES } from "./store/workspace";

// view registry
export {
  registerView, setPaneScope, crumbsOf, titleOf, defaultCrumbs, tableKindOf, kindName,
  type ViewProps, type ViewDef, type ViewOf, type Crumb,
} from "./views/registry";

export { registerViewActions } from "./views/view-actions";

// per-pane selection
export {
  setSelection, getSelection, useSelection, selectionTargets, subscribeSelection, toObjRef, sameRef,
  type PaneSelection,
} from "./store/selection";

// cluster
export {
  useCluster, getCluster, windowContext, switchContext, closeTab, stepTab, reconnect, refreshContexts, connOf, useConn, ensureConnected,
  resolveResource, resourceFor, kindOf, useResource, useDiscovery, useNamespaces, namespaceNames,
  type ClusterState, type ContextConn,
} from "./store/cluster";
export { gvrKey, sameGvr, isFluxGroup, type AliasMap } from "./store/aliases";

// live tables
export { useTable, tables, tableKey, type TableSnapshot, type TableDelta, type Lease, type UseTableOptions } from "./store/tables";

// pane chrome
export { PaneSlot, PaneToolbar, type PaneSlotName } from "./panes/slots";
export { setPaneStatus, usePaneStatus, type PaneStatus, type PaneWatch } from "./store/pane-status";
export { registerPaneGuard, type LiveSession, type PaneGuard } from "./store/guards";
export { useLeaderPanel, leaderItems, WHICH_KEY_DELAY_MS, type LeaderItem, type LeaderPanel } from "./panes/leader";

// window chrome
export { registerShellItem, registerOverlay, showOverlay, closeOverlay, isOverlayOpen, type OverlayProps, type ShellItem } from "./shell/slots";
export { useBuilt } from "./shell/Titlebar";
export { flash } from "./store/status";
export { zoomFactor } from "./store/appearance";

// re-exports of the F1 layer, for one-stop imports
export { backend } from "./ipc";
export { registerActions, registry, LAYERS, type ActionContext, type ActionId } from "./actions";
export { engine, useScopeLayer, useBindings, useHints, useAvailableActions, useKeyState } from "./keys";
export {
  toast, toasts, confirm, objectFacts, announce,
  BarInput, Button, Checkbox, Dialog, EmptyState, Facts, Field, FilterChip, Glyph, Hint, KeyChip, Keys, Literal, RadioGroup, Tabs,
} from "./ui";
// pointer controls (docs/frontend.md §17)
export {
  ActionButton, ActionHint, Toolbar, Icon, ACTION_ICONS, openMenu, menuAnchor, runAction, actionState, useActionState, actionTitle, keepFocus,
  usePaneId, PaneContext, tip, actionTip,
  type ActionButtonProps, type ToolbarItem, type ToolbarAction, type MenuEntry, type MenuRequest, type IconName, type ActionState,
} from "./ui";
export { getSettings, setSettings, useSettings, settingsStore, contextFlags, setContextFlags } from "./store/settings";
export { isTauri } from "./ipc";
export { layoutStore } from "./store/layout";
// the action log (Recent in the activity panel): one call per thing the human did or that happened
export { recordAction, type LogTarget, type RecordInput } from "./store/actionlog";
