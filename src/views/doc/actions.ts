// Doc view actions (docs/ux.md §5.4: Resource, Document, Editor, Review). Small and eager: keys
// must work before the CodeMirror chunk loads, so handlers only open views or call the focused
// pane's controller (session.ts), which the lazy DocView registers.
import type { ActionContext } from "../../actions";
import {
  focusedContext, flash, focusedPane, getSelection, openView, paneView, patchView, registerActions, registerViewActions, replaceView,
  selectionTargets,
} from "../../foundation";
import { contextFlags, getSettings, setSettings } from "../../store/settings";
import type { DocView, ObjectRef } from "../../types";
import { controllers, freshEdits, getUi, type DocController, type DocUi } from "./session";

const ctl = (): DocController | undefined => {
  const pane = focusedPane();
  return pane ? controllers.get(pane) : undefined;
};
const ui = (): DocUi => getUi(focusedPane());
const doc = (): DocView | undefined => {
  const v = paneView();
  return v?.kind === "doc" ? v : undefined;
};
const ready = (): true | string => (ctl() && !ui().loading ? true : "loading");
/** A click on a button or a menu row. Vim owns the keys of a focused vim editor, not the mouse. */
const byHand = (ctx: ActionContext): boolean => ctx.source === "pointer" || ctx.source === "menu";
const FORMATS = ["describe", "yaml", "json"] as const;
const call = (fn: (c: DocController) => void) => ({ run: () => { const c = ctl(); if (c) fn(c); }, enabled: ready });

export const isSecret = (ref: ObjectRef): boolean => ref.gvr.group === "" && ref.gvr.resource === "secrets";

/** The object a resource action applies to: the cursor row, or the object the focused view shows. */
function target(): ObjectRef | null {
  const pane = focusedPane();
  if (!pane) return null;
  const v = paneView(pane);
  if (v?.kind === "doc") return v.ref;
  if (v?.kind === "containers") return v.pod;
  return getSelection(pane).focused ?? selectionTargets(pane)[0] ?? null;
}
const hasTarget = (): true | string => (target() ? true : "no row selected");

function open(ctx: ActionContext, format: DocView["format"], mode: DocView["mode"] = "view"): void {
  const ref = target();
  if (!ref) return;
  const pinned = mode === "edit" || format === "secret";
  const pane = openView(
    { kind: "doc", ref, format, mode, managedFields: false, wrap: false },
    { newPane: ctx.newPane, ...(pinned ? { follow: false } : {}) },
  );
  if (pane && mode === "edit") freshEdits.set(pane, Date.now());
}

function toggleWrap(): void {
  const pane = focusedPane();
  const v = doc();
  if (pane && v) patchView(pane, "doc", { wrap: !v.wrap });
}

function canEdit(): true | string {
  if (contextFlags(focusedContext()).readOnly) return "read-only mode";
  const v = doc();
  if (!v) return hasTarget();
  if (ui().canEdit === false) return `no permission to edit ${v.ref.gvr.resource}`;
  return ready();
}

registerActions({
  "res.describe": { run: (ctx) => open(ctx, "describe"), enabled: hasTarget },
  "res.yaml": { run: (ctx) => open(ctx, "yaml"), enabled: hasTarget },
  "secret.decode": { run: (ctx) => open(ctx, "secret"), enabled: hasTarget },
  "res.edit": {
    enabled: canEdit,
    run: (ctx) => {
      const pane = focusedPane();
      const v = doc();
      // in a doc pane, `e` turns the same pane into the YAML (or secret) editor
      if (pane && v && !ctx.newPane) replaceView(pane, { ...v, mode: "edit", format: isSecret(v.ref) ? "secret" : "yaml", managedFields: false });
      else {
        const ref = target();
        if (ref) open(ctx, isSecret(ref) ? "secret" : "yaml", "edit");
      }
    },
  },

  // document (view mode)
  "doc.wrap": toggleWrap,
  "doc.managedFields": () => {
    const pane = focusedPane();
    const v = doc();
    if (pane && v) patchView(pane, "doc", { managedFields: !v.managedFields });
  },
  "doc.format": {
    enabled: () => (doc()?.format === "secret" ? "a secret has no YAML or JSON view here" : true),
    // no argument: the key's yaml/json toggle; an argument (a toolbar segment, `:`): that format
    run: (ctx) => {
      const pane = focusedPane();
      const v = doc();
      if (!pane || !v) return;
      const arg = ctx.args[0];
      const to = FORMATS.find((f) => f === arg);
      if (arg !== undefined && !to) return flash("Usage: describe | yaml | json", "warn");
      const format = to ?? (v.format === "yaml" ? "json" : "yaml");
      if (format !== v.format) patchView(pane, "doc", { format });
    },
  },
  "doc.copy": call((c) => c.copy()),
  "doc.foldToggle": call((c) => c.foldToggle()),
  "doc.foldAll": call((c) => c.foldAll()),
  "secret.revealToggle": call((c) => c.revealToggle()),
  "secret.revealKey": call((c) => c.revealKey()),

  // editor (EDIT)
  "editor.review": call((c) => c.review()),
  "editor.diffGutter": call((c) => c.toggleDiffGutter()),
  // also in a focused vim editor: Ctrl+F stays the app's search there (vimTakesChord)
  "editor.find": call((c) => c.openSearch()),
  "editor.findNext": call((c) => c.searchStep(1)),
  "editor.selectNextOccurrence": call((c) => c.selectNextOccurrence()),
  "editor.addCursorAbove": call((c) => c.addCursor(-1)),
  "editor.addCursorBelow": call((c) => c.addCursor(1)),
  "editor.moveLineUp": call((c) => c.moveLine(-1)),
  "editor.moveLineDown": call((c) => c.moveLine(1)),
  "editor.foldToggle": call((c) => c.foldToggle()),
  "editor.foldAll": call((c) => c.foldAll()),
  // the document's wrap and copy, reachable in EDIT (and wrap in REVIEW) where `w` and `c` are text
  "editor.wrap": toggleWrap,
  "editor.copy": call((c) => c.copy()),
  // with vim keys Esc leaves a clean edit from an idle normal mode, as without vim; a dirty one
  // is left with :w / :q (vim.escape has Esc there: vimOwnsEscape)
  // a click (toolbar, mode badge, menu) leaves at once like :q, asking when dirty: no Esc ladder
  "editor.leave": {
    run: (ctx) => (byHand(ctx) ? ctl()?.quit() : ctl()?.leave()),
    when: (ctx) => !!ctl() && (byHand(ctx) || !ctl()?.vimOwnsEsc()),
  },
  "editor.discardConfirm": () => ctl()?.discard(),
  "editor.stay": () => ctl()?.stay(),

  // vim keys: the setting, and the two actions of the vim layer (vim-state.ts has the rule)
  "app.vim": (ctx) => {
    const arg = ctx.args[0];
    if (arg !== undefined && arg !== "on" && arg !== "off") return flash("Usage: :vim on|off", "warn");
    const vim = arg === undefined ? !getSettings().vim : arg === "on";
    setSettings({ vim });
    flash(vim ? "vim keys on in editors · :w review · :q leave · :e edit" : "vim keys off");
  },
  // Esc belongs to vim while it has something to leave, and in a dirty EDIT; otherwise the pane gets it (back, leave)
  "vim.escape": { when: () => ctl()?.vimOwnsEsc() === true, run: (ctx) => ctl()?.vimEscape(ctx.event) },
  // chords the key engine or the webview would keep from vim. The app keeps the ones its own pane
  // shortcuts use (Ctrl+B sidebar, Ctrl+F search, Ctrl+W close pane outside insert mode): for
  // those this declines and the key falls through to its action (vimTakesChord)
  "vim.keys": {
    when: (ctx) => ctl()?.vimTakes(ctx.chord) !== false,
    run: (ctx) => {
      if (ctx.event) ctl()?.vimKey(ctx.event);
      else flash("press the key in the editor");
    },
  },

  // review
  "review.apply": {
    run: () => ctl()?.apply(),
    enabled: () => {
      const r = ui().review;
      if (!r) return "no review";
      if (r.applying) return "applying";
      if (r.dryRun === "running") return "dry run still running";
      if (r.dryRun === "error" && r.conflict !== "fieldManager") return r.conflict === "version" ? "the object changed: rebase first" : "the dry run failed";
      return true;
    },
  },
  "review.back": () => ctl()?.backToEdit(),
  "review.toggleSplit": () => ctl()?.toggleSplit(),
  "review.rebase": () => ctl()?.rebase(),
  "review.revealSecret": () => ctl()?.revealReview(),
  "review.suspendFlux": () => ctl()?.suspendFlux(),
});

// Ids that other views implement too (table, logs): dispatched by the focused pane's view kind.
// These bindings are live in the doc's view mode only; EDIT and REVIEW have their own scopes.
registerViewActions(["doc"], {
  "nav.down": call((c) => c.move(1)),
  "nav.up": call((c) => c.move(-1)),
  "nav.top": call((c) => c.edge("top")),
  "nav.bottom": call((c) => c.edge("bottom")),
  "nav.pageUp": call((c) => c.page(-1)),
  "nav.pageDown": call((c) => c.page(1)),
  "view.refresh": { run: () => ctl()?.refresh(), when: () => doc()?.mode === "view", enabled: ready },
  "filter.open": call((c) => c.openSearch()),
  "filter.apply": () => ctl()?.applySearch(),
  "filter.cancel": () => ctl()?.cancelSearch(),
  "filter.cycleMode": () => ctl()?.cycleSearchMode(),
  "search.next": { run: () => ctl()?.searchStep(1), when: () => ui().query !== "" },
  "search.previous": { run: () => ctl()?.searchStep(-1), when: () => ui().query !== "" },
  "search.close": { run: () => ctl()?.closeSearch(), when: () => ui().query !== "" },
  "select.lines": call((c) => c.selectLines()),
  "select.chars": {
    enabled: ready,
    run: (ctx) => {
      const dir = /(Left|Right|Up|Down)$/.exec(ctx.chord ?? "")?.[1] as "Left" | "Right" | "Up" | "Down" | undefined;
      if (dir) ctl()?.selectChars(dir);
    },
  },
  "select.clear": { run: () => ctl()?.clearSelection(), when: () => ui().selection },
});
