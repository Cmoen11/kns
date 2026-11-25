// The complete default keymap of docs/ux.md §5.4, as data. This file is the only place a default
// key is written. Every row starts with built:false; a feature flips it by registering a handler
// (registerActions). Deviations from the spec table are listed in docs/frontend.md.
//
// Notation (see parseBindings): alternatives ' | ', sequence chords separated by spaces,
// 'Mod' = Ctrl on Windows / Cmd on macOS, 'leader' = the pane.leader binding.
// `mac` is only given when it differs from the Windows column after the Mod substitution.
import type { Opens, Tier } from "../types";

export interface RowOpts {
  /** macOS bindings when they differ */
  mac?: string;
  tier?: Tier;
  opens?: Opens;
  write?: boolean;
  /** hint-row priority (lower first) */
  hint?: number;
  /** `:` command words; the rest of the line is passed as ctx.args */
  command?: string;
  /** human-readable condition */
  when?: string;
  /** runs on key auto-repeat */
  repeat?: boolean;
  /** macOS menu path */
  menu?: string;
  /** this row only adds bindings (in its own scope) to another action */
  alias?: string;
}

export interface Row<I extends string = string> extends RowOpts {
  id: I;
  /** space-separated scope ids */
  scope: string;
  keys: string;
  /** short lowercase label for hints, palette and help */
  label: string;
  group: string;
}

let group = "";
function g(name: string): void {
  group = name;
}
function a<const I extends string>(id: I, scope: string, keys: string, label: string, o: RowOpts = {}): Row<I> {
  return { id, scope, keys, label, group, ...o };
}
/** 'Mod+1 | Mod+2 | ...' */
function digits(prefix: string, from = 1, to = 9): string {
  const out: string[] = [];
  for (let d = from; d <= to; d++) out.push(`${prefix}${d}`);
  return out.join(" | ");
}

const NAV = "table containers list logs doc";
const OPEN_BESIDE = "table containers list palette picker command";

function rows() {
  return [
    (g("Global"), a("palette.open", "global", "Mod+K | Mod+Shift+P | leader p", "palette", { opens: "view", menu: "View/Command Palette" })),
    a("command.open", "pane", ":", "command", { opens: "view" }),
    a("filter.open", "table containers list logs doc", "/ | Mod+F", "filter", { hint: 90 }),
    a("help.overlay", "global", "? | F1", "help", { hint: 99, menu: "Help/Keyboard Shortcuts" }),
    a("update.command", "global", "", "check for updates", { command: "update", menu: "Help/Check for Updates" }),
    a("menu.open", "global", "Shift+F10 | Menu", "menu", { mac: "Shift+F10" }),
    a("context.pick", "global", "Mod+Shift+K", "context", { opens: "dialog", command: "ctx" }),
    // Ctrl+Tab goes to the shell in TERM (§5.3); the leader forms work everywhere
    a("tab.next", "global", "Ctrl+Tab | leader Tab", "next context tab", { command: "tab next" }),
    a("tab.previous", "global", "Ctrl+Shift+Tab | leader Shift+Tab", "previous context tab", { command: "tab prev" }),
    a("tab.close", "global", "Ctrl+F4 | leader X", "close context tab", { mac: "Ctrl+Cmd+W | leader X", command: "tab close" }),
    a("tab.closeOthers", "global", "", "close other context tabs", { command: "tab only" }),
    a("context.alias", "global", "", "context alias", { command: "ctx alias", opens: "dialog" }),
    a("context.pickPane", "global", "leader C", "context, this pane", { opens: "dialog", command: "pane ctx" }),
    a("context.protect", "global", "", "protect context", { command: "protect", opens: "dialog" }),
    a("namespace.pick", "global", "Mod+N | leader n", "namespace", { opens: "dialog", command: "ns" }),
    a("namespace.pickAllPanes", "global", "Mod+Shift+N", "namespace, all panes", { opens: "dialog" }),
    // organisation catalog (docs/catalog.md)
    a("catalog.open", "global", "", "catalog choose|reload|forget|me <email>", { command: "catalog" }),
    a("catalog.team", "global", "", "team scope <team,...>|-", { command: "team" }),
    a("catalog.env", "global", "", "same view in environment <env>", { command: "env" }),
    a("deploys.open", "global", "", "deploys of this namespace's system", { command: "deploys", opens: "view" }),
    a("deploys.compare", "deploys", "o", "compare on GitHub", { hint: 10 }),
    a("deploys.reload", "deploys", "r", "read the ops repository again", { hint: 11 }),
    a("namespace.all", "table.namespaced", "0", "all namespaces"),
    a("namespace.favN", "table.namespaced", digits(""), "namespace 1-9"),
    a("namespace.use", "k.namespaces", "u", "use namespace", { hint: 10 }),
    a("aliases.show", "global", "Mod+Shift+A", "aliases", { command: "alias" }),
    a("home.open", "global", "", "home", { command: "home" }),
    a("flux.notReady", "global", "", "flux not ready", { command: "flux!" }),
    a("pf.open", "global", "", "port-forwards", { command: "pf" }),
    a("messages.open", "global", "", "errors", { command: "errors" }),
    a("conn.reconnect", "global", "F5", "reconnect", { command: "reconnect" }),
    a("hints.toggle", "global", "Mod+E", "toggle hints"),
    a("settings.open", "global", "Mod+,", "settings", { command: "settings", menu: "App/Settings" }),
    a("ui.zoomIn", "global", "Mod++", "zoom in"),
    a("ui.zoomOut", "global", "Mod+-", "zoom out"),
    a("ui.zoomReset", "global", "Mod+0", "reset zoom"),
    a("ui.zoom", "global", "", "zoom 85|100|110|125|150", { command: "ui" }),
    a("undo.lastAction", "pane", "Mod+Z", "undo", { when: "an undo toast is live" }),
    a("toast.dismiss", "global", "Mod+Shift+X", "dismiss messages"),
    a("window.fullscreen", "global", "F11", "fullscreen", { mac: "Ctrl+Cmd+F" }),
    a("window.close", "global", "", "close window", { mac: "Cmd+Shift+W" }),
    a("app.quit", "global", "Alt+F4", "quit", { mac: "Cmd+Q", command: "q" }),
    a("app.readOnly", "global", "", "read-only on|off", { command: "ro" }),
    a("app.killSwitch", "global", "", "kill on|off", { command: "kill", opens: "dialog" }),
    a("app.theme", "global", "", "theme claude", { command: "theme" }),
    a("app.mode", "global", "", "mode system|lys|mork", { command: "mode" }),
    a("app.density", "global", "", "rows 20|28", { command: "rows" }),

    (g("Favourites"), a("fav.picker", "pane", "'", "favourites", { opens: "view", hint: 85 })),
    a("fav.viewN", "global", digits("Mod+"), "favourite view 1-9", { opens: "view" }),
    a("fav.layoutN", "global", digits("Alt+"), "layout 1-9", { mac: digits("Alt+Cmd+") }),
    a("fav.layoutPrevious", "global", "Alt+0", "previous layout", { mac: "Alt+Cmd+0" }),
    a("fav.saveView", "global", "Mod+Shift+S", "save view", { opens: "dialog" }),
    a("fav.saveLayout", "global", "Mod+Shift+L", "save layout", { opens: "dialog", command: "layout save" }),

    (g("Panes"), a("pane.leader", "global", "Mod+.", "pane command")),
    a("pane.newPrefixRight", "pane", "+", "new pane", { hint: 80 }),
    a("pane.newPrefixDown", "newpane", "+", "below"),
    a("open.newPaneRight", OPEN_BESIDE, "Mod+Enter", "open right", { opens: "view" }),
    a("open.newPaneDown", OPEN_BESIDE, "Alt+Enter", "open below", { opens: "view" }),
    a("pane.splitRight", "global", "leader r", "split right", { command: "split r" }),
    a("pane.splitDown", "global", "leader d", "split down", { command: "split d" }),
    a("pane.focusLeft", "global", "Alt+Left | Alt+h | leader h | leader Left", "focus left", { mac: "Alt+Cmd+Left | Alt+h | leader h | leader Left" }),
    a("pane.focusDown", "global", "Alt+Down | Alt+j | leader j | leader Down", "focus down", { mac: "Alt+Cmd+Down | Alt+j | leader j | leader Down" }),
    a("pane.focusUp", "global", "Alt+Up | Alt+k | leader k | leader Up", "focus up", { mac: "Alt+Cmd+Up | Alt+k | leader k | leader Up" }),
    a("pane.focusRight", "global", "Alt+Right | Alt+l | leader l | leader Right", "focus right", { mac: "Alt+Cmd+Right | Alt+l | leader l | leader Right" }),
    a("pane.next", "global", "F6", "next pane"),
    a("pane.previous", "global", "Shift+F6", "previous pane"),
    a("pane.nextTab", "pane", "Tab", "next pane", { alias: "pane.next" }),
    a("pane.previousTab", "pane", "Shift+Tab", "previous pane", { alias: "pane.previous" }),
    a("pane.last", "global", "leader leader", "last pane"),
    a("pane.focusN", "global", digits("leader "), "pane 1-9"),
    a("pane.moveLeft", "global", "leader H", "move left"),
    a("pane.moveDown", "global", "leader J", "move down"),
    a("pane.moveUp", "global", "leader K", "move up"),
    a("pane.moveRight", "global", "leader L", "move right"),
    a("pane.moveMode", "global", "leader m", "move mode"),
    a("move.targetLeft", "move", "h | Left", "target left"),
    a("move.targetDown", "move", "j | Down", "target down"),
    a("move.targetUp", "move", "k | Up", "target up"),
    a("move.targetRight", "move", "l | Right", "target right"),
    a("move.insertLeft", "move", "H", "insert left"),
    a("move.insertDown", "move", "J", "insert below"),
    a("move.insertUp", "move", "K", "insert above"),
    a("move.insertRight", "move", "L", "insert right"),
    a("move.swap", "move", "Enter", "swap", { hint: 1 }),
    a("move.cancel", "move", "Esc", "cancel", { hint: 2 }),
    a("pane.resizeLeft", "global", "Alt+Shift+Left", "resize left", { mac: "Ctrl+Cmd+Left", repeat: true }),
    a("pane.resizeDown", "global", "Alt+Shift+Down", "resize down", { mac: "Ctrl+Cmd+Down", repeat: true }),
    a("pane.resizeUp", "global", "Alt+Shift+Up", "resize up", { mac: "Ctrl+Cmd+Up", repeat: true }),
    a("pane.resizeRight", "global", "Alt+Shift+Right", "resize right", { mac: "Ctrl+Cmd+Right", repeat: true }),
    a("pane.resizeMode", "global", "leader a", "resize mode"),
    a("resize.stepLeft", "resize", "Left | h", "left", { repeat: true }),
    a("resize.stepDown", "resize", "Down | j", "down", { repeat: true }),
    a("resize.stepUp", "resize", "Up | k", "up", { repeat: true }),
    a("resize.stepRight", "resize", "Right | l", "right", { repeat: true }),
    a("resize.fineLeft", "resize", "Shift+Left | H", "fine left", { repeat: true }),
    a("resize.fineDown", "resize", "Shift+Down | J", "fine down", { repeat: true }),
    a("resize.fineUp", "resize", "Shift+Up | K", "fine up", { repeat: true }),
    a("resize.fineRight", "resize", "Shift+Right | L", "fine right", { repeat: true }),
    a("resize.done", "resize", "Enter | Esc", "done", { hint: 1 }),
    a("pane.zoom", "global", "Mod+Shift+Enter | leader z", "zoom pane"),
    a("pane.equalize", "global", "leader =", "equalize"),
    a("pane.equalizeAll", "global", "leader 0", "equalize all"),
    a("pane.flipSplit", "global", "leader t", "flip split"),
    a("pane.followToggle", "global", "leader f", "follow", { when: "not a shell pane" }),
    a("pane.fitToTable", "global", "leader i", "fit to table", { tier: "P1" }),
    a("pane.close", "global", "Mod+W | leader x", "close pane", { command: "close" }),
    a("pane.closeOthers", "global", "leader o", "close others", { command: "only", opens: "dialog" }),
    a("pane.reopenClosed", "global", "Mod+Shift+T | leader u", "reopen pane"),

    (g("Navigation"), a("nav.down", NAV, "j | Down", "down", { repeat: true })),
    a("nav.up", NAV, "k | Up", "up", { repeat: true }),
    a("nav.scrollLeft", "table", "Left", "scroll left", { repeat: true }),
    a("nav.scrollRight", "table", "Right", "scroll right", { repeat: true }),
    a("nav.scrollLeftH", "table.scrollhl", "h", "scroll left", { alias: "nav.scrollLeft", repeat: true }),
    a("nav.scrollRightL", "table.scrollhl", "l", "scroll right", { alias: "nav.scrollRight", repeat: true }),
    a("nav.top", NAV, "g | Home", "top"),
    a("nav.bottom", "table containers list doc", "G | End", "bottom"),
    a("nav.pageUp", NAV, "PgUp | Ctrl+Up", "page up", { mac: "PgUp | Ctrl+B", repeat: true }),
    a("nav.pageDown", NAV, "PgDn | Ctrl+Down", "page down", { mac: "PgDn | Ctrl+F", repeat: true }),
    a("nav.open", "table containers list", "Enter", "open", { opens: "view", hint: 5 }),
    a("nav.crumbUp", "pane", "Backspace", "parent"),
    a("history.back", "pane", ", | [", "history back"),
    a("history.forward", "pane", ". | ]", "history forward"),
    a("history.last", "pane", "-", "last view"),
    // The Esc ladder (§4.2): same key, resolved by scope then by this declaration order through
    // each handler's `when`: search.close, select.clear, mark.clear, filter.clear, nav.back.
    a("filter.clear", "pane", "Esc", "clear filter", { when: "filter or faults chips exist" }),
    a("nav.back", "pane", "Esc", "back", { when: "view stack deeper than 1" }),

    (g("Table"), a("filter.cycleMode", "filter.input search.input", "Tab", "mode")),
    a("filter.clearText", "filter.input", "Ctrl+U", "clear text"),
    a("filter.chipFocusLeft", "filter.input", "Left", "previous chip", { when: "the input is empty" }),
    a("filter.chipFocusRight", "filter.input", "Right", "next chip", { when: "the input is empty" }),
    a("filter.chipRemove", "filter.input", "Backspace", "remove chip", { when: "the input is empty" }),
    a("filter.apply", "filter.input search.input", "Enter", "apply", { hint: 1 }),
    a("filter.cancel", "filter.input search.input", "Esc", "cancel", { hint: 2 }),
    a("filter.faults", "table", "!", "faults"),
    a("view.refresh", "pane", "Mod+R", "refresh"),
    a("view.wide", "table", "*", "wide"),
    a("view.stripNs", "table", "", "hide namespace prefix", { command: "prefix" }),
    a("view.columns", "table", "Mod+Shift+M", "columns", { opens: "dialog" }),
    a("columns.moveDown", "columns", "j", "down", { repeat: true }),
    a("columns.moveUp", "columns", "k", "up", { repeat: true }),
    a("columns.toggle", "columns", "Space", "show/hide", { hint: 1 }),
    a("columns.pin", "columns", "p", "pin", { hint: 2 }),
    a("columns.reorderDown", "columns", "J", "move down", { hint: 3 }),
    a("columns.reorderUp", "columns", "K", "move up", { hint: 4 }),
    a("columns.fit", "columns", "f", "fit", { hint: 5 }),
    a("columns.reset", "columns", "r", "reset", { hint: 6 }),
    a("columns.close", "columns", "Esc | Enter", "close", { hint: 7 }),
    a("column.narrower", "table columns", "<", "narrower", { repeat: true }),
    a("column.wider", "table columns", ">", "wider", { repeat: true }),
    a("view.saveToFile", "table logs text", "Mod+S", "save to file", { tier: "P1" }),
    a("sort.name", "table", "N", "sort by name"),
    a("sort.age", "table", "A", "sort by age"),
    a("sort.status", "table", "S", "sort by status"),
    a("sort.namespace", "table.allns", "P", "sort by namespace"),
    a("sort.selectedColumn", "table", "O", "sort by column"),
    a("column.selectLeft", "table", "Shift+Left", "select column left"),
    a("column.selectRight", "table", "Shift+Right", "select column right"),
    a("column.hide", "table", "", "hide column", { command: "hidecol" }),
    a("mark.toggle", "table", "Space", "mark"),
    a("mark.range", "table", "Shift+Space | Shift+Down | Shift+Up", "mark range", { repeat: true }),
    a("mark.all", "table", "Mod+A", "mark all"),
    a("mark.clear", "table", "Esc", "clear marks", { when: "marks exist" }),
    a("copy.name", "table containers", "c", "copy name"),
    a("copy.namespace", "table", "n", "copy namespace"),
    a("copy.cell", "table", "Mod+C", "copy cell"),

    (g("Resource"), a("res.describe", "table containers", "d", "describe", { opens: "view", hint: 30 })),
    a("res.yaml", "table", "y", "yaml", { opens: "view", hint: 31 }),
    a("res.edit", "table doc", "e", "edit", { opens: "view", hint: 32 }),
    a("res.delete", "table", "Ctrl+Backspace | Delete", "delete", { mac: "Cmd+Backspace", write: true, opens: "dialog" }),
    a("pod.kill", "k.pods", "Mod+Shift+Backspace", "kill", { write: true, opens: "dialog", when: "kill switch is on" }),
    // `timeline`: logs at the row's time (C2 registers it for that view kind)
    a("res.logs", "can.logs timeline", "l", "logs", { opens: "view", hint: 33 }),
    a("res.logsPrevious", "can.logs", "p", "previous logs", { opens: "view" }),
    a("pod.shell", "can.shell", "s", "shell", { opens: "view", hint: 34 }),
    a("pod.attach", "can.shell", "a", "attach", { opens: "view", tier: "P1" }),
    a("workload.scale", "can.scale", "s", "scale", { write: true, opens: "dialog", hint: 20 }),
    a("workload.restart", "can.restart", "r", "restart", { write: true, hint: 21 }),
    a("workload.setImage", "can.setImage", "i", "set image", { write: true, opens: "dialog", tier: "P1" }),
    a("deploy.replicaSets", "k.deployments", "z", "replicasets", { opens: "view" }),
    a("rs.rollback", "k.replicasets", "Mod+L", "rollback", { write: true, opens: "dialog", tier: "P1" }),
    a("cronjob.trigger", "k.cronjobs", "t", "trigger", { write: true, hint: 20 }),
    a("cronjob.suspend", "k.cronjobs", "s", "suspend", { write: true, hint: 21 }),
    a("pf.start", "can.forward", "F", "port-forward", { opens: "dialog" }),
    a("pf.list", "can.forward", "f", "forwards", { opens: "view" }),
    a("pf.stop", "portforwards", "Ctrl+Backspace | Delete", "stop", { mac: "Cmd+Backspace", hint: 10 }),
    a("pf.copyAddress", "portforwards", "c", "copy address", { hint: 11 }),
    a("pf.openBrowser", "portforwards", "o", "open in browser", { hint: 12 }),
    a("secret.decode", "k.secrets", "x", "decode", { opens: "view", hint: 10 }),
    a("res.usedBy", "can.usedBy", "u", "used by", { opens: "view", tier: "P1" }),
    a("res.owner", "table", "J", "owner", { opens: "view" }),
    a("pod.node", "k.pods", "o", "node", { opens: "view" }),
    a("res.warp", "table", "w", "warp", { tier: "P2" }),
    a("node.cordon", "k.nodes", "c", "cordon", { write: true, tier: "P1" }),
    a("node.uncordon", "k.nodes", "u", "uncordon", { write: true, tier: "P1" }),
    a("node.drain", "k.nodes", "r", "drain", { write: true, opens: "dialog", tier: "P1" }),
    a("pod.transfer", "k.pods", "t", "transfer", { opens: "dialog", tier: "P1" }),
    a("pod.sanitize", "k.pods", "z", "sanitize", { write: true, opens: "dialog", tier: "P1" }),

    (g("Flux"), a("flux.reconcile", "flux", "R", "reconcile", { write: true, hint: 10 })),
    a("flux.suspendResume", "flux", "T", "suspend", { write: true, hint: 11 }),
    a("flux.reconcileWithSource", "flux", "Mod+Shift+R", "reconcile with source", { write: true, command: "reconcile source" }),
    a("flux.trace", "flux.managed", "Q", "trace", { tier: "P1" }),

    (g("Argo CD"), a("argo.refresh", "argo", "R", "refresh", { write: true, hint: 10, command: "refresh" })),
    a("argo.sync", "argo.app", "Y", "sync", { write: true, hint: 11, command: "sync" }),
    a("argo.hardRefresh", "argo.app", "Mod+Shift+R", "hard refresh", { write: true, command: "refresh hard" }),

    (g("Logs"), a("logs.autoscroll", "logs", "s", "autoscroll", { hint: 10 })),
    a("logs.wrap", "logs", "w", "wrap", { hint: 11 }),
    a("logs.timestamps", "logs", "t", "timestamps", { hint: 12 }),
    a("logs.fullscreen", "logs", "f", "zoom pane", { alias: "pane.zoom" }),
    a("logs.tail", "logs", "0", "tail"),
    a("logs.head", "logs", "1", "head"),
    a("logs.since", "logs", digits("", 2, 6), "since 1m-1h"),
    a("logs.mark", "logs", "m", "mark"),
    a("logs.clear", "logs", "C", "clear"),
    a("logs.allContainers", "logs", "a", "all containers"),
    a("logs.copy", "logs", "c", "copy", { hint: 14 }),
    a("logs.previous", "logs", "p", "previous", { hint: 13 }),
    a("logs.containerPicker", "logs", "o", "container", { opens: "dialog" }),
    a("logs.expandLine", "logs", "Enter", "expand line"),
    a("logs.filterLines", "logs search.input", "F | Shift+Enter", "filter lines", { when: "a logs pane" }),
    a("logs.resumeFollow", "logs", "End | G", "follow"),
    a("search.next", "logs doc", "n", "next match"),
    a("search.previous", "logs doc", "N", "previous match"),
    a("search.close", "logs doc", "Esc", "close search", { when: "the search bar is open" }),
    a("select.lines", "logs doc", "v", "select lines"),
    a("select.chars", "doc", "Shift+Left | Shift+Right | Shift+Up | Shift+Down", "select text", { repeat: true }),
    a("select.clear", "logs doc", "Esc", "clear selection", { when: "a line selection exists" }),

    (g("Document"), a("doc.managedFields", "doc.yaml", "m", "managed fields")),
    a("doc.wrap", "doc", "w", "wrap", { hint: 12 }),
    a("doc.copy", "doc", "c | Mod+C", "copy", { hint: 11 }),
    a("doc.foldToggle", "doc", "z", "fold"),
    a("doc.foldAll", "doc", "Z", "fold all"),
    a("doc.format", "doc", "Y", "yaml/json"),
    a("secret.revealToggle", "doc.secret", "x", "reveal", { hint: 10 }),
    a("secret.revealKey", "doc.secret", "Enter", "reveal key"),

    (g("Editor"), a("editor.review", "edit", "Mod+S", "review", { hint: 1 })),
    a("editor.diffGutter", "edit", "Mod+Shift+D", "diff gutter"),
    a("editor.find", "edit", "Mod+F", "find", { hint: 3 }),
    a("editor.findNext", "edit", "F3 | Ctrl+G", "find next", { mac: "Cmd+G" }),
    a("editor.replace", "edit", "Ctrl+H", "replace", { mac: "Cmd+Shift+F", tier: "P1" }),
    a("editor.selectNextOccurrence", "edit", "Mod+D", "select next occurrence"),
    a("editor.addCursorAbove", "edit", "Ctrl+Shift+Up", "cursor above", { mac: "Ctrl+Alt+Up" }),
    a("editor.addCursorBelow", "edit", "Ctrl+Shift+Down", "cursor below", { mac: "Ctrl+Alt+Down" }),
    a("editor.moveLineUp", "edit", "Ctrl+Shift+PgUp", "move line up", { mac: "Alt+Up" }),
    a("editor.moveLineDown", "edit", "Ctrl+Shift+PgDn", "move line down", { mac: "Alt+Down" }),
    a("editor.foldToggle", "edit", "Mod+Shift+O", "fold"),
    a("editor.foldAll", "edit", "Mod+Shift+U", "fold all"),
    a("editor.wrap", "edit review", "Alt+Z", "wrap"),
    a("editor.copy", "edit", "Mod+Shift+C", "copy selection or all"),
    a("editor.leave", "edit", "Esc", "leave edit", { hint: 2 }),
    a("editor.discardConfirm", "dialog.discard", "Enter", "discard"),
    a("editor.stay", "dialog.discard", "Esc", "keep editing"),

    // Vim keys in the doc editors (src/views/doc). The `vim` scope is a layer that is live while a
    // vim editor has DOM focus: plain keys go to vim, these two hand over keys the app would keep.
    (g("Vim"), a("app.vim", "global", "", "vim keys on|off", { command: "vim" })),
    a("vim.escape", "vim", "Esc", "vim: leave mode", { when: "vim is in insert or visual mode or has pending keys, or the edit has unsaved changes" }),
    // Windows: Ctrl+B (sidebar) and Ctrl+F (search) stay the app's, and Ctrl+W is vim's only while
    // typing (vimTakesChord in src/views/doc/vim-state.ts). macOS: the app's are ⌘ chords, so vim has them all.
    a("vim.keys", "vim", "Ctrl+R | Ctrl+D | Ctrl+U | Ctrl+O | Ctrl+W", "vim: redo, scroll, jump back; delete word while typing", {
      mac: "Ctrl+R | Ctrl+D | Ctrl+U | Ctrl+O | Ctrl+B | Ctrl+F | Ctrl+W",
      repeat: true,
    }),

    (g("Review"), a("review.apply", "review", "Enter", "apply", { write: true, hint: 1 })),
    a("review.back", "review", "Esc", "back to edit", { hint: 2 }),
    a("review.toggleSplit", "review", "Tab", "split/unified", { hint: 3 }),
    a("review.rebase", "review.conflict", "r", "rebase", { hint: 0 }),
    a("review.revealSecret", "review.secret", "x", "reveal", { hint: 4 }),
    a("review.suspendFlux", "review.flux", "T", "suspend flux", { write: true, hint: 5 }),

    (g("Terminal"), a("terminal.copy", "term term.placeholder", "Ctrl+Shift+C | Ctrl+Insert", "copy", { mac: "Cmd+C" })),
    a("terminal.paste", "term", "Ctrl+Shift+V | Shift+Insert", "paste", { mac: "Cmd+V" }),
    a("terminal.scrollPageUp", "term", "Shift+PgUp", "page up", { mac: "Cmd+Shift+Up", repeat: true }),
    a("terminal.scrollPageDown", "term", "Shift+PgDn", "page down", { mac: "Cmd+Shift+Down", repeat: true }),
    a("terminal.search", "term", "Ctrl+Shift+F", "search", { mac: "Cmd+F" }),
    a("terminal.copyMode", "term", "Ctrl+Shift+Space", "copy mode", { mac: "Cmd+Shift+Space", hint: 1 }),
    a("copy.down", "copy", "j", "down", { repeat: true }),
    a("copy.up", "copy", "k", "up", { repeat: true }),
    a("copy.top", "copy", "g", "top"),
    a("copy.bottom", "copy", "G", "bottom"),
    a("copy.search", "copy", "/", "search"),
    a("copy.select", "copy", "v", "select", { hint: 1 }),
    a("copy.yank", "copy", "y", "copy", { hint: 2 }),
    a("copy.leave", "copy", "Esc", "leave", { hint: 3 }),
    a("terminal.reconnect", "term.placeholder", "Enter", "reconnect", { hint: 1 }),
    a("terminal.container", "term term.placeholder", "Ctrl+Shift+O", "container", { mac: "Cmd+Shift+O", opens: "dialog" }),
    a("terminal.end", "term", "Ctrl+Shift+D", "end session", { mac: "Cmd+Shift+D", opens: "dialog" }),

    (g("Overlays"), a("list.down", "olist", "Down", "down", { repeat: true })),
    a("list.up", "olist", "Up", "up", { repeat: true }),
    a("list.accept", "olist", "Enter", "accept"),
    a("list.close", "olist", "Esc", "close"),
    a("palette.complete", "palette command picker", "Tab", "complete"),
    a("picker.rename", "picker.fav picker.ctx", "F2", "rename"),
    a("picker.delete", "picker.fav", "Mod+Shift+Backspace", "delete"),
    a("picker.moveSlotUp", "picker.fav", "Shift+Up", "slot up"),
    a("picker.moveSlotDown", "picker.fav", "Shift+Down", "slot down"),
    a("picker.toggleNsFavourite", "picker.ns", "Mod+D", "favourite"),
    a("picker.toggleProtected", "picker.ctx", "Mod+T", "protected"),

    (g("Dialog"), a("dialog.confirm", "dialog", "Enter", "confirm")),
    a("dialog.cancel", "dialog", "Esc", "cancel"),
    a("dialog.nextField", "dialog", "Tab", "next field"),
    a("dialog.previousField", "dialog", "Shift+Tab", "previous field"),
    a("dialog.radioUp", "dialog", "Up", "previous option", { when: "a radio group has focus" }),
    a("dialog.radioDown", "dialog", "Down", "next option", { when: "a radio group has focus" }),
    a("dialog.toggle", "dialog", "Space", "toggle", { when: "a checkbox has focus" }),

    (g("Settings"), a("settings.moveDown", "settings", "j | Down", "down", { repeat: true })),
    a("settings.moveUp", "settings", "k | Up", "up", { repeat: true }),
    a("settings.change", "settings", "Enter | Space", "change", { hint: 1 }),
    a("settings.cyclePrev", "settings", "Left", "previous option"),
    a("settings.cycleNext", "settings", "Right", "next option"),
    a("settings.filter", "settings", "/", "filter", { hint: 90 }),
    a("keymap.rebind", "settings.keymap", "Enter", "rebind", { hint: 1 }),
    a("keymap.clear", "settings.keymap", "Backspace", "unbind", { hint: 2 }),
    a("keymap.reset", "settings.keymap", "r", "reset", { hint: 3 }),
    a("keymap.resetAll", "global", "", "reset all keys", { command: "keys reset", opens: "dialog" }),

    // Side panels (src/sidepanels). Each global action has a Ctrl+Shift+letter chord or a leader
    // sequence, so it also works from a live terminal; Mod+B / Mod+J are the familiar extras.
    (g("Side panels"), a("sidebar.toggle", "global", "Mod+B | Mod+Shift+B", "toggle context sidebar", { command: "sidebar" })),
    a("sidebar.focus", "global", "Mod+Shift+E | leader b", "focus context sidebar"),
    a("activity.toggle", "global", "Mod+J | Mod+Shift+J", "toggle activity panel", { command: "activity" }),
    a("activity.focus", "global", "Mod+Shift+Y | leader v", "focus activity panel"),
    a("side.down", "side", "j | Down", "down", { repeat: true }),
    a("side.up", "side", "k | Up", "up", { repeat: true }),
    a("side.top", "side", "g | Home", "top"),
    a("side.bottom", "side", "G | End", "bottom"),
    a("side.activate", "side", "Enter", "open", { hint: 1 }),
    a("side.nextSection", "side", "Tab", "next section", { hint: 20 }),
    a("side.previousSection", "side", "Shift+Tab", "previous section"),
    a("side.collapse", "side", "h | Left", "collapse section"),
    a("side.expand", "side", "l | Right", "expand section"),
    a("side.narrower", "side", "<", "narrower", { repeat: true }),
    a("side.wider", "side", ">", "wider", { repeat: true }),
    a("side.leave", "side", "Esc", "back to pane", { hint: 30 }),
    a("sidebar.filter", "side.ctx", "/", "filter", { hint: 10 }),
    a("activity.stop", "side.activity", "x | Delete", "stop", { hint: 2 }),
    a("activity.copyAddress", "side.activity", "c", "copy", { hint: 3 }),
    a("activity.openBrowser", "side.activity", "o", "open in browser", { hint: 4 }),
    a("activity.stopAll", "side.activity", "X", "stop all in group", { hint: 5, opens: "dialog" }),
    a("activity.clearFinished", "side.activity", "C", "clear", { hint: 6 }),
    // status colours (src/status): namespace health in the sidebar, faults views, the action log
    a("health.nsFaults", "side.ctx", "!", "show faults of namespace", { hint: 11, opens: "view" }),
    a("sidebar.problemsFirst", "side.ctx", "s", "problems first", { hint: 12 }),
    a("health.faults", "global", "", "faults in all namespaces", { command: "faults", opens: "view" }),

    // ── Feature rows of docs/plan-features.md §2.7. All unbuilt until their package registers a
    // handler (src/features.pending.ts lists them per package). Deviations from the §2.7 table:
    // diff.split is `t` only (Tab is pane.next in the diff chain), logs.goToPod is `O` (`o` is the
    // container picker), hub.help has the command `tools help` (every action needs a key or command).
    (g("Tools"), a("hub.open", "global", "Mod+Shift+H | leader g", "tools", { command: "tools", opens: "view" })),
    a("hub.detail", "hub", "i", "details", { hint: 2 }),
    a("hub.help", "pane", "", "help for this tool", { command: "tools help" }),

    (g("Debug"), a("res.why", "table containers", "W", "why", { command: "why", opens: "view", hint: 35 })),
    a("why.copy", "why", "c", "copy findings", { hint: 10 }),
    a("res.timeline", "table", "H", "timeline", { command: "timeline", opens: "view" }),
    a("res.trap", "table", "", "trap", { command: "trap", opens: "dialog" }),
    a("trap.list", "global", "", "traps", { command: "traps", opens: "view" }),
    a("trap.disarm", "traps", "x | Delete", "disarm", { hint: 10 }),
    a("journal.toggle", "global", "", "event journal on/off", { command: "journal" }),
    a("res.reach", "k.pods", "", "can it reach", { command: "reach", opens: "view" }),
    a("res.relations", "table", "", "relations", { command: "relations", opens: "view" }),
    a("relations.collapse", "relations", "h | Left", "collapse", { hint: 10 }),
    a("relations.expand", "relations", "l | Right", "expand", { hint: 11 }),
    a("pod.debug", "k.pods containers", "B", "debug container", { write: true, opens: "dialog", command: "debug" }),
    a("res.kubectl", "global", "", "copy as kubectl", { command: "kubectl" }),
    a("snippet.run", "global", "", "run snippet", { command: "x" }),
    a("pod.mirrord", "k.pods", "", "copy mirrord command", { command: "mirrord" }),

    (g("Diff"), a("res.diff", "table", "D", "diff marked", { command: "diff", opens: "view" })),
    a("diff.managedFields", "diff", "m", "managed fields", { hint: 12 }),
    a("diff.split", "diff", "t", "split/unified", { hint: 10 }),
    a("diff.nextHunk", "diff", "n", "next change", { hint: 11 }),
    a("diff.prevHunk", "diff", "N", "previous change"),
    a("doc.fieldOwners", "doc.yaml", "O", "field owners", { command: "owners" }),
    a("doc.driftOnly", "doc.yaml", "", "drift only", { command: "drift" }),

    (g("Logs"), a("logs.structured", "logs", "J", "structured", { hint: 15 })),
    a("logs.patterns", "logs", "P", "patterns", { command: "patterns", opens: "view", hint: 16 }),
    a("logs.goToPod", "logs", "O", "go to pod of line", { opens: "view" }),
    a("patterns.errorsOnly", "patterns", "!", "errors only", { hint: 10 }),

    (g("Local dev"), a("dev.picker", "global", "leader e", "dev sets", { command: "dev", opens: "view" })),
    a("picker.devDown", "picker.dev", "Mod+Shift+Backspace", "stop set"),
    a("picker.devEdit", "picker.dev", "F2", "edit set", { opens: "view" }),
    a("dev.fromWorkload", "can.env", "E", "dev from workload", { command: "env", opens: "view" }),
    a("dev.up", "devsets", "u", "start set", { hint: 10 }),
    a("dev.down", "devsets", "x", "stop set", { hint: 11 }),
    a("dev.edit", "devsets", "e", "edit set", { hint: 12 }),
    a("dev.delete", "devsets", "Ctrl+Backspace | Delete", "delete set", { mac: "Cmd+Backspace", opens: "dialog", hint: 13 }),
    a("env.toggleKey", "env", "Space", "include/exclude", { hint: 10 }),
    a("env.reveal", "env", "x", "reveal value", { hint: 11 }),
    a("env.export", "env", "Mod+S", "export…", { opens: "dialog", hint: 12 }),
    a("env.copyAs", "env", "c", "copy as…", { opens: "dialog", hint: 13 }),
    a("env.saveSet", "env", "s", "save as dev set", { opens: "dialog", hint: 14 }),
    a("pf.copyUrl", "portforwards", "C", "copy connection string", { opens: "dialog", hint: 13 }),

    (g("Agents"), a("res.pack", "global", "leader c", "copy for agent", { command: "pack", opens: "view" })),
    a("text.copy", "text", "c", "copy", { hint: 10 }),
    a("text.dropSection", "text", "Space", "drop section", { hint: 11 }),
    a("mcp.command", "global", "", "MCP server", { command: "mcp" }),
    a("agents.open", "global", "", "agents", { command: "agents", opens: "view" }),
    a("agents.connect", "agents", "a", "connect an agent…", { opens: "dialog", hint: 10 }),
    a("agents.revoke", "agents", "x", "revoke client", { opens: "dialog", hint: 11 }),
    a("agents.stopServer", "agents", "X", "stop MCP server", { hint: 12 }),
    a("proposals.next", "global", "leader y", "review agent request", { command: "proposals", opens: "dialog" }),
  ];
}

export const KEYMAP_ROWS = rows();

/** Every action id of the default keymap (alias rows included). */
export type ActionId = (typeof KEYMAP_ROWS)[number]["id"];

/**
 * k9s-mode preset (§5.7): full replacement lists, layered between the defaults and the user's
 * overrides. "Ctrl" is the physical Control key on both platforms.
 */
export const K9S_PRESET: Partial<Record<ActionId, { win?: string; mac?: string }>> = {
  "res.delete": { win: "Ctrl+Backspace | Delete | Ctrl+D", mac: "Cmd+Backspace | Ctrl+D" },
  "pod.kill": { win: "Ctrl+Shift+Backspace | Ctrl+K", mac: "Cmd+Shift+Backspace | Ctrl+K" },
  "palette.open": { win: "Ctrl+Shift+P | leader p" },
  "view.wide": { win: "* | Ctrl+W", mac: "* | Ctrl+W" },
  "pane.close": { win: "leader x" },
  "aliases.show": { win: "Ctrl+A", mac: "Cmd+Shift+A | Ctrl+A" },
  "mark.all": { win: "Ctrl+Shift+A" },
  "filter.faults": { win: "! | Ctrl+Z", mac: "! | Ctrl+Z" },
  "undo.lastAction": { win: "Ctrl+Shift+Z" },
  "nav.pageDown": { win: "PgDn | Ctrl+Down | Ctrl+F" },
  "nav.pageUp": { win: "PgUp | Ctrl+Up | Ctrl+B" },
  "filter.open": { win: "/" },
  "mark.range": { win: "Shift+Space | Shift+Down | Shift+Up | Ctrl+Space", mac: "Shift+Space | Shift+Down | Shift+Up | Ctrl+Space" },
  "filter.clear": { win: "Esc | Ctrl+U | Ctrl+Q", mac: "Esc | Ctrl+U | Ctrl+Q" },
  // Ctrl+B is page up in k9s
  "sidebar.toggle": { win: "Ctrl+Shift+B" },
};

/**
 * Bindings that deliberately share a key inside one scope chain. Each group is resolved in
 * declaration order through the handlers' `when` predicates (the Esc ladder of §4.2), or by the
 * more specific scope winning (`c` is cordon on nodes once built, §5.4).
 * The collision test fails for any shared key that is not listed here.
 */
export const INTENTIONAL_SHARED: readonly (readonly ActionId[])[] = [
  ["search.close", "select.clear", "mark.clear", "filter.clear", "nav.back"],
  ["node.cordon", "copy.name"],
];

/** Chords that can never be reassigned (§5.4). The OS chords are also never intercepted. */
export const RESERVED_CHORDS = ["Esc"] as const;
export const OS_CHORDS = { win: ["Alt+F4"], mac: ["Cmd+Q", "Cmd+H", "Cmd+M"] } as const;
