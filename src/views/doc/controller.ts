// The doc pane's controller: owns the CodeMirror view, loads the document for the pane's
// ViewState, and runs the edit -> review -> apply flow (docs/ux.md §13.1, §13.2). Lazy chunk.
import { addCursorAbove, addCursorBelow, moveLineDown, moveLineUp, selectCharLeft, selectCharRight, selectLineDown, selectLineUp } from "@codemirror/commands";
import { foldAll, foldCode, foldedRanges, unfoldAll, unfoldCode } from "@codemirror/language";
import { selectNextOccurrence } from "@codemirror/search";
import { EditorSelection, EditorState, Text, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import {
  backend, canGoBack, confirm, engine, paneContext, flash, goBack, kindName, objectFacts, replaceView, resolveResource,
  setPaneScope, toObjRef, toast,
} from "../../foundation";
import type { Json } from "../../ipc/types";
import type { KeyEventLike } from "../../keys/chord";
import { platform } from "../../keys/instance";
import { recordAction } from "../../store/actionlog";
import { contextFlags, getSettings, settingsStore } from "../../store/settings";
import { gvrKey } from "../../store/aliases";
import type { DocView, PaneId, ViewState } from "../../types";
import { diffConf, diffExt, editorExtensions, setErrorLines, setSearch, vimConf, wrapConf, wrapExt, type DocFormat } from "./cm";
import { describe } from "./describe";
import { deleteDraft, draftKey, loadDraft, saveDraft } from "./drafts";
import { conflictMarkerLines, merge3 } from "./merge3";
import { SEARCH_MODES, findMatches, matchAtOrAfter, stepMatch, type Match } from "./search-match";
import { clearUi, controllers, freshEdits, getUi, patchReview, patchUi, type DocController } from "./session";
import type { VimHost } from "./vim";
import { PROMPT_LAYER, vimLayer, vimOwnsEscape, vimTakesChord } from "./vim-state";
import {
  classifyConflict, errorLines, errorText, fluxOwner, maskSecretPair, parseSecretEdit, secretDoc, secretManifest, toJsonText,
  yamlSyntaxError, type Decoded,
} from "./yaml-helpers";

const POLL_MS = 5000;
const DRAFT_MS = 500;
/** REVIEW is split at this pane width and above (§13.2). */
export const SPLIT_MIN = 720;
/** how long an "opened in edit by an action" mark stays valid (covers StrictMode's double mount) */
const FRESH_MS = 3000;

// Vim keys: the library is its own chunk, fetched the first time a doc pane exists while the
// setting is on. Until it has arrived the editors behave as without vim.
type VimModule = typeof import("./vim");
let vimMod: VimModule | null = null;
let vimLoading: Promise<VimModule> | null = null;
const loadVim = (): Promise<VimModule> =>
  (vimLoading ??= import("./vim").then(
    (m) => (vimMod = m),
    (e: unknown) => {
      // a failed fetch is not kept: the next editor (or toggle) tries again
      vimLoading = null;
      throw e;
    },
  ));

const contentKey = (v: DocView): string =>
  `${gvrKey(v.ref.gvr)}|${v.ref.namespace ?? ""}|${v.ref.name}|${v.format}|${v.managedFields ? 1 : 0}`;
const textOf = (s: string): Text => Text.of(s.split("\n"));
const asDoc = (v: DocView) => (x: ViewState): ViewState => (x.kind === "doc" ? v : x);

export class Controller implements DocController {
  private readonly cm: EditorView;
  private view: DocView;
  private focused: boolean;
  private visible: boolean;
  private disposed = false;
  /** bumped by every load and request; a response with an older token is dropped */
  private token = 0;
  private wantKey = "";
  private shownKey = "";
  /** the buffer is an edit buffer (mode edit or review) */
  private editing = false;
  /**
   * The edit buffer differs from what was loaded. The controller's own copy of `DocUi.dirty`:
   * what decides whether leaving asks first must not depend on a UI store that a remount clears.
   */
  private bufDirty = false;
  private original = "";
  private originalText: Text = Text.empty;
  private obj: Json | null = null;
  private decoded: Decoded | null = null;
  private readonly revealed = new Set<string>();
  private keyOfLine: (string | null)[] = [];
  private returnTo: { format: DocFormat; managedFields: boolean } | "back" = "back";
  private manifest = "";
  private secretDiff: { plain: { before: string; after: string }; masked: { before: string; after: string } } | null = null;
  private anchorLine: number | null = null;
  private matches: Match[] = [];
  private prevQuery = "";
  private foldedAll = false;
  private draft: string | null = null;
  private poll: ReturnType<typeof setTimeout> | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private searchFrame = 0;
  /** vim is attached to the current editor state */
  private vimOn = false;
  private popLayer: (() => void) | null = null;
  private layerKey = "";
  private readonly paneEl: HTMLElement | null;
  private readonly unsubSettings: () => void;
  /**
   * The pane's kube context (§8.3), read once: a pane changes context only by restarting its
   * history, which remounts this controller, so a load or apply never lands in another cluster.
   */
  private readonly context: string;

  constructor(private readonly pane: PaneId, private readonly host: HTMLElement, view: DocView, focused: boolean, visible: boolean) {
    this.context = paneContext(pane);
    this.view = view;
    this.focused = focused;
    this.visible = visible;
    this.cm = new EditorView({ parent: host, state: this.state("", false) });
    this.paneEl = host.closest<HTMLElement>(".pane");
    host.addEventListener("focusin", this.onFocusIn);
    host.addEventListener("focusout", this.onFocusOut);
    this.paneEl?.addEventListener("focus", this.onPaneFocus);
    this.unsubSettings = settingsStore.subscribe((s, prev) => {
      if (s.vim !== prev.vim) this.applyVim();
    });
    controllers.set(pane, this);
    this.applyVim();
    patchUi(pane, { secret: view.format === "secret" });
    if (view.mode === "view") void this.load(false);
    else if (Date.now() - (freshEdits.get(pane) ?? 0) < FRESH_MS) void this.beginEdit();
    else this.restore();
  }

  destroy(): void {
    this.disposed = true;
    this.token++;
    if (this.poll) clearTimeout(this.poll);
    if (this.draftTimer) clearTimeout(this.draftTimer);
    cancelAnimationFrame(this.searchFrame);
    this.unsubSettings();
    this.host.removeEventListener("focusin", this.onFocusIn);
    this.host.removeEventListener("focusout", this.onFocusOut);
    this.paneEl?.removeEventListener("focus", this.onPaneFocus);
    this.syncLayer(null);
    vimMod?.setVimHost(this.cm, null);
    // a closed pane keeps its draft (§4.6); secrets have no draft key
    if (this.editing && this.draft && this.bufDirty) saveDraft(this.draft, this.cm.state.doc.toString());
    if (controllers.get(this.pane) === this) {
      controllers.delete(this.pane);
      clearUi(this.pane);
      setPaneScope(this.pane, null);
    }
    this.cm.destroy();
  }

  /** Called after every render with the pane's current entry. */
  sync(view: DocView, focused: boolean, visible: boolean): void {
    const prev = this.view;
    const wasFocused = this.focused;
    this.view = view;
    this.focused = focused;
    this.visible = visible;
    if (view.wrap !== prev.wrap) this.cm.dispatch({ effects: wrapConf.reconfigure(wrapExt(view.wrap)) });
    if (prev.mode === "view" && view.mode === "edit") {
      this.returnTo = { format: prev.format, managedFields: prev.managedFields };
      void this.beginEdit();
    } else if (view.mode === "view" && (prev.mode !== "view" || contentKey(view) !== this.wantKey)) {
      void this.load(false);
    }
    // revealed values re-mask when the pane loses focus (§13.1)
    if (wasFocused && !focused && view.mode === "view" && this.revealed.size > 0) {
      this.revealed.clear();
      this.renderSecret();
    }
    if (focused && view.mode === "edit" && (!wasFocused || prev.mode === "review") && this.editing) this.cm.focus();
    // with vim the read-only views keep DOM focus in the editor too
    else if (this.vimOn && focused && !wasFocused && view.mode === "view") this.focusHome(true);
    this.syncLayer();
    this.schedulePoll();
  }

  // ── state and loading ────────────────────────────────────────────────────

  private state(text: string, editable: boolean): EditorState {
    this.vimOn = getSettings().vim && vimMod !== null;
    return EditorState.create({
      doc: text,
      extensions: editorExtensions({ format: this.view.format, editable, wrap: this.view.wrap, vim: this.vimExt(), onUpdate: this.onUpdate }),
    });
  }

  // ── vim keys (optional; vim.ts) ──────────────────────────────────────────

  private vimExt(): Extension {
    return this.vimOn && vimMod ? vimMod.vimExtension() : [];
  }

  /** Follows the `vim` setting, live: loads the chunk, reconfigures the open editor, moves focus. */
  private applyVim(): void {
    if (this.disposed) return;
    const want = getSettings().vim;
    if (want && !vimMod) {
      loadVim().then(
        () => this.applyVim(),
        (e) => flash(`vim keys did not load: ${errorText(e)}`, "warn"),
      );
      return;
    }
    if (want) vimMod!.setVimHost(this.cm, this.vimHost);
    patchUi(this.pane, { vim: want, vimKeys: "" });
    if (want === this.vimOn) return;
    this.vimOn = want;
    this.cm.dispatch({ effects: vimConf.reconfigure(this.vimExt()) });
    // the editor takes DOM focus with vim, the pane frame takes a read-only view back without it
    this.focusHome(true);
    this.syncLayer();
  }

  private readonly vimHost: VimHost = {
    changed: () => {
      if (this.disposed) return;
      const st = this.vimOn && vimMod ? vimMod.vimState(this.cm) : null;
      patchUi(this.pane, { vim: this.vimOn, vimKeys: st && !st.insertMode ? (st.status ?? "").slice(0, 12) : "" });
      this.syncLayer();
    },
    write: () => {
      if (this.view.mode !== "edit" || !this.editing) return flash("not editing: :e starts an edit");
      engine.run("editor.review", { source: "command" });
    },
    quit: (force) => {
      if (this.view.mode === "edit" && this.editing) {
        if (force) this.discard();
        else this.quit();
      } else if (canGoBack(this.pane)) goBack(this.pane);
      else engine.run("pane.close", { source: "command" });
    },
    edit: () => {
      engine.run("res.edit", { source: "command" });
    },
    setting: (arg) => {
      engine.run("app.vim", { source: "command", args: arg ? [arg] : [] });
    },
  };

  vimBusy(): boolean {
    return this.vimOn && !!vimMod && vimMod.isBusy(this.cm);
  }
  /**
   * Esc belongs to vim while it has something to leave. From an idle normal mode the pane gets
   * it, as without vim (back, or leave a clean edit); a dirty edit keeps it with vim, so
   * Esc Esc :w Enter can never reach the discard dialog (vimOwnsEscape in vim-state.ts).
   */
  vimOwnsEsc(): boolean {
    if (!vimMod || !this.vimFocused()) return false;
    return vimOwnsEscape({ busy: vimMod.isBusy(this.cm), edit: this.view.mode === "edit" && this.editing, dirty: this.bufDirty });
  }
  /** Whether a chord of vim.keys is vim's right now (vimTakesChord): the app keeps its own. */
  vimTakes(chord: string | undefined): boolean {
    if (!this.vimOn || !vimMod) return false;
    return vimTakesChord(chord, vimMod.vimState(this.cm)?.mode, platform === "mac");
  }
  /** A vim editor holds the DOM focus (its layer is pushed): vim.keys and vim.escape are live. */
  vimFocused(): boolean {
    return this.vimOn && this.layerKey.startsWith("vim|");
  }
  vimEscape(e: KeyEventLike | undefined): void {
    if (!this.vimOn || !vimMod) return;
    if (vimMod.isBusy(this.cm)) return vimMod.sendKey(this.cm, e, "<Esc>");
    if (this.view.mode !== "edit") return;
    // idle normal mode in a dirty EDIT: the pane's Esc ladder without its last step
    const ui = getUi(this.pane);
    if (ui.searchInput || ui.query) return this.closeSearch();
    const sel = this.cm.state.selection;
    if (sel.ranges.length > 1) {
      this.cm.dispatch({ selection: EditorSelection.single(sel.main.anchor, sel.main.head) });
      return;
    }
    flash("unsaved changes · :w review · :q leave (asks) · :q! discard");
  }
  vimKey(e: KeyEventLike | undefined, fallback?: string): void {
    if (this.vimOn && vimMod) vimMod.sendKey(this.cm, e, fallback);
  }

  /** DOM focus belongs in the editor: EDIT always, the read-only views only with vim. */
  private editorFocus(): boolean {
    const ui = getUi(this.pane);
    // the discard dialog is modal: a click on its scrim must not hand focus (and keys) to the buffer
    if (ui.review !== null || ui.discardAsk) return false;
    if (this.view.mode === "edit") return this.editing;
    return this.vimOn && this.view.mode === "view" && ui.loadError === null;
  }

  private readonly onFocusIn = (e: FocusEvent): void => this.syncLayer(e.target as Element | null);
  private readonly onFocusOut = (e: FocusEvent): void => this.syncLayer(e.relatedTarget as Element | null);
  /** With vim the pane frame hands its focus on (a click on the header, an overlay that closed). */
  private readonly onPaneFocus = (e: FocusEvent): void => {
    if (e.target === this.paneEl && this.vimOn && this.editorFocus()) this.cm.focus();
  };

  /**
   * The key-routing rule (vim-state.ts): while a vim editor holds DOM focus its layer is on the
   * scope stack, so plain keys reach vim; vim's command line has a stricter layer of its own.
   */
  private syncLayer(active: Element | null = document.activeElement): void {
    let layer = null;
    if (!this.disposed && this.vimOn && active && this.cm.dom.contains(active) && !getUi(this.pane).discardAsk) {
      if (active.closest(".cm-vim-panel")) layer = PROMPT_LAYER;
      else if (this.cm.contentDOM.contains(active)) layer = vimLayer(vimMod?.vimState(this.cm)?.mode, this.view.mode === "edit" ? "EDIT" : "NORMAL");
    }
    const key = layer ? `${layer === PROMPT_LAYER ? "prompt" : "vim"}|${layer.mode}` : "";
    if (key === this.layerKey) return;
    this.popLayer?.();
    this.popLayer = layer ? engine.pushScope(layer) : null;
    this.layerKey = key;
  }

  private reset(text: string, editable: boolean): void {
    // Leaving EDIT: drop DOM focus and the DOM selection first, or CodeMirror reads the stale
    // DOM selection back into the new state and the line cursor lands at the end.
    if (!editable && this.host.contains(document.activeElement)) {
      this.cm.contentDOM.blur();
      window.getSelection()?.removeAllRanges();
    }
    this.cm.setState(this.state(text, editable));
    this.cm.scrollDOM.scrollTop = 0;
    this.anchorLine = null;
    this.foldedAll = false;
    this.matches = [];
    patchUi(this.pane, { selection: false, cursors: 1, apiError: null, diffGutter: false, matches: 0, current: -1, folded: false });
    if (getUi(this.pane).query) this.runSearch(false);
  }

  /** Replaces the text with the smallest change, so the scroll position and cursor stay. */
  private replaceDoc(text: string): void {
    const old = this.cm.state.doc.toString();
    if (old === text) return;
    const min = Math.min(old.length, text.length);
    let p = 0;
    while (p < min && old.charCodeAt(p) === text.charCodeAt(p)) p++;
    let s = 0;
    while (s < min - p && old.charCodeAt(old.length - 1 - s) === text.charCodeAt(text.length - 1 - s)) s++;
    this.cm.dispatch({ changes: { from: p, to: old.length - s, insert: text.slice(p, text.length - s) } });
  }

  private readonly onUpdate = (u: ViewUpdate): void => {
    if (u.docChanged) {
      if (this.editing) {
        this.bufDirty = !u.state.doc.eq(this.originalText);
        patchUi(this.pane, { dirty: this.bufDirty });
        this.scheduleDraft();
      }
      if (getUi(this.pane).query) this.scheduleSearch(false);
    }
    if (u.selectionSet || u.docChanged) {
      const sel = u.state.selection;
      patchUi(this.pane, { selection: this.anchorLine !== null || sel.ranges.some((r) => !r.empty), cursors: sel.ranges.length });
    }
  };

  private async fetchText(view: DocView): Promise<string> {
    const context = this.context;
    const ref = toObjRef(view.ref, context);
    switch (view.format) {
      case "yaml":
        return backend.getYaml(ref, { managedFields: view.managedFields });
      case "json":
        return toJsonText(await backend.getJson(ref), view.managedFields);
      case "describe": {
        const [obj, events] = await Promise.all([
          backend.getJson(ref),
          backend.listEvents({ context, namespace: ref.namespace, ref }).catch(() => null),
        ]);
        return describe(obj, events, Date.now());
      }
      case "secret": {
        this.decoded = await backend.decodeSecret(ref);
        const d = secretDoc(this.decoded, this.revealed);
        this.keyOfLine = d.keyOfLine;
        return d.text;
      }
    }
  }

  /** Loads the document of the current entry. `keep` refreshes in place (scroll and cursor stay). */
  private async load(keep: boolean): Promise<void> {
    const view = this.view;
    const key = contentKey(view);
    const token = ++this.token;
    if (key !== this.shownKey) this.revealed.clear();
    this.wantKey = key;
    if (!keep) patchUi(this.pane, { loading: true, secret: view.format === "secret" });
    try {
      const text = await this.fetchText(view);
      if (token !== this.token || this.disposed) return;
      if (keep && this.shownKey === key && !this.editing) this.replaceDoc(text);
      else {
        this.editing = false;
        this.reset(text, false);
      }
      this.shownKey = key;
      patchUi(this.pane, { loading: false, loadError: null, revealed: this.revealed.size });
      this.focusHome();
      this.checkAccess(view);
    } catch (e) {
      if (token !== this.token || this.disposed) return;
      // a failed background refresh keeps what is shown
      if (keep && this.shownKey === key) return;
      this.editing = false;
      this.reset("", false);
      this.shownKey = "";
      patchUi(this.pane, { loading: false, loadError: errorText(e) });
    }
  }

  private checkAccess(view: DocView): void {
    const context = this.context;
    const ref = toObjRef(view.ref, context);
    backend.canI({ context, verb: "patch", gvr: ref.gvr, namespace: ref.namespace, name: ref.name }).then(
      (ok) => {
        if (!this.disposed && this.view.ref === view.ref) patchUi(this.pane, { canEdit: ok });
      },
      () => undefined,
    );
  }

  private schedulePoll(): void {
    if (this.poll) clearTimeout(this.poll);
    this.poll = null;
    // describe carries live events and status; it refreshes in place while it is on screen
    if (this.disposed || !this.visible || this.view.mode !== "view" || this.view.format !== "describe") return;
    this.poll = setTimeout(() => {
      this.poll = null;
      const again = () => this.schedulePoll();
      if (getUi(this.pane).loading) again();
      else void this.load(true).then(again);
    }, POLL_MS);
  }

  /** A doc entry that comes back in edit or review (restart, reopened pane) is shown as view (§3.6). */
  private restore(): void {
    const view = this.view;
    const format: DocFormat = view.format === "secret" ? "secret" : "yaml";
    replaceView(this.pane, asDoc({ ...view, mode: "view", format }));
    if (format === "secret") return;
    void loadDraft(draftKey(this.context, view.ref)).then((d) => {
      if (d && !this.disposed) flash(`draft from ${new Date(d.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} kept · edit to resume`);
    });
  }

  /** Puts DOM focus where the mode wants it. `fromPane`: also take it from this pane's header input. */
  private focusHome(fromPane = false): void {
    if (!this.focused || this.disposed) return;
    const a = document.activeElement;
    // never steal focus from an input or dialog that holds it
    const mine = fromPane ? this.host.closest(".pane") : this.host;
    if (a && a !== document.body && !mine?.contains(a)) return;
    if (this.editorFocus()) this.cm.focus();
    else this.host.closest<HTMLElement>(".pane")?.focus({ preventScroll: true });
  }

  // ── navigation, selection, folding (view mode) ───────────────────────────

  private headLine(): number {
    return this.cm.state.doc.lineAt(this.cm.state.selection.main.head).number;
  }

  private goLine(n: number, dir: 1 | -1 = 1): void {
    const doc = this.cm.state.doc;
    n = Math.max(1, Math.min(doc.lines, n));
    // step over folded lines in the direction of travel
    for (let guard = 0; guard < 100; guard++) {
      const pos = doc.line(n).from;
      let hidden: { from: number; to: number } | null = null;
      foldedRanges(this.cm.state).between(pos, pos, (from, to) => {
        if (from < pos && pos <= to) hidden = { from, to };
      });
      if (!hidden) break;
      const h: { from: number; to: number } = hidden;
      const next = dir === 1 ? doc.lineAt(h.to).number + 1 : doc.lineAt(h.from).number;
      if (next > doc.lines) {
        n = doc.lineAt(h.from).number;
        break;
      }
      n = next;
    }
    const line = doc.line(n);
    let selection: { anchor: number; head?: number };
    if (this.anchorLine !== null) {
      const a = doc.line(Math.min(this.anchorLine, doc.lines));
      selection = n >= a.number ? { anchor: a.from, head: line.to } : { anchor: a.to, head: line.from };
    } else selection = { anchor: line.from };
    this.cm.dispatch({ selection, effects: EditorView.scrollIntoView(line.from, { y: "nearest", yMargin: 32 }) });
  }

  move(lines: number): void {
    this.goLine(this.headLine() + lines, lines < 0 ? -1 : 1);
  }
  page(dir: 1 | -1): void {
    const page = Math.max(1, Math.floor(this.cm.scrollDOM.clientHeight / this.cm.defaultLineHeight) - 2);
    this.goLine(this.headLine() + dir * page, dir);
  }
  edge(end: "top" | "bottom"): void {
    this.goLine(end === "top" ? 1 : this.cm.state.doc.lines, end === "top" ? -1 : 1);
  }

  selectLines(): void {
    if (this.anchorLine !== null) return this.clearSelection();
    this.anchorLine = this.headLine();
    this.goLine(this.anchorLine);
  }
  selectChars(dir: "Left" | "Right" | "Up" | "Down"): void {
    this.anchorLine = null;
    ({ Left: selectCharLeft, Right: selectCharRight, Up: selectLineUp, Down: selectLineDown })[dir](this.cm);
  }
  clearSelection(): void {
    this.anchorLine = null;
    const head = this.cm.state.selection.main.head;
    this.cm.dispatch({ selection: { anchor: this.cm.state.doc.lineAt(head).from } });
    patchUi(this.pane, { selection: false });
  }

  copy(): void {
    const state = this.cm.state;
    const ranges = state.selection.ranges.filter((r) => !r.empty);
    const text = ranges.length ? ranges.map((r) => state.sliceDoc(r.from, r.to)).join("\n") : state.doc.toString();
    const what = ranges.length ? `copied ${text.split("\n").length} lines` : "copied the document";
    navigator.clipboard.writeText(text).then(
      () => flash(what),
      () => flash("copy failed: clipboard not available", "warn"),
    );
  }

  foldToggle(): void {
    if (!unfoldCode(this.cm)) foldCode(this.cm);
  }
  foldAll(): void {
    if (this.foldedAll) unfoldAll(this.cm);
    else foldAll(this.cm);
    this.foldedAll = !this.foldedAll;
    patchUi(this.pane, { folded: this.foldedAll });
  }

  // ── secrets (view mode) ──────────────────────────────────────────────────

  private renderSecret(): void {
    if (!this.decoded || this.editing) return;
    const d = secretDoc(this.decoded, this.revealed);
    this.keyOfLine = d.keyOfLine;
    this.replaceDoc(d.text);
    patchUi(this.pane, { revealed: this.revealed.size });
  }
  revealToggle(): void {
    if (!this.decoded) return;
    if (this.revealed.size > 0) this.revealed.clear();
    else for (const [k, v] of Object.entries(this.decoded)) if (v !== null) this.revealed.add(k);
    this.renderSecret();
  }
  revealKey(): void {
    const key = this.keyOfLine[this.headLine() - 1];
    if (!key || !this.decoded || this.decoded[key] === null) return;
    if (!this.revealed.delete(key)) this.revealed.add(key);
    this.renderSecret();
  }

  refresh(): void {
    if (this.view.mode === "view") void this.load(true);
  }

  // ── search ───────────────────────────────────────────────────────────────

  openSearch(): void {
    this.prevQuery = getUi(this.pane).query;
    patchUi(this.pane, { searchInput: true });
  }
  setQuery(text: string): void {
    patchUi(this.pane, { query: text });
    this.scheduleSearch(true);
  }
  private scheduleSearch(jump: boolean): void {
    cancelAnimationFrame(this.searchFrame);
    this.searchFrame = requestAnimationFrame(() => this.runSearch(jump));
  }
  private runSearch(jump: boolean): void {
    if (this.disposed) return;
    const ui = getUi(this.pane);
    const r = findMatches(this.cm.state.doc.toString(), ui.query, ui.searchMode);
    this.matches = r.matches;
    const current = matchAtOrAfter(r.matches, this.cm.state.selection.main.from);
    this.cm.dispatch({ effects: setSearch.of({ matches: r.matches, current }) });
    patchUi(this.pane, { matches: r.matches.length, current, searchError: r.error ?? null });
    if (jump && current >= 0) this.showMatch(current, false);
  }
  private showMatch(i: number, select: boolean): void {
    const m = this.matches[i];
    if (!m) return;
    this.anchorLine = null;
    this.cm.dispatch({
      selection: select && this.editing ? { anchor: m.from, head: m.to } : { anchor: m.from },
      effects: [setSearch.of({ matches: this.matches, current: i }), EditorView.scrollIntoView(m.from, { y: "center" })],
    });
    patchUi(this.pane, { current: i });
  }
  applySearch(): void {
    const ui = getUi(this.pane);
    if (!ui.searchInput) return;
    cancelAnimationFrame(this.searchFrame);
    this.runSearch(true);
    if (ui.query && this.matches.length === 0 && !getUi(this.pane).searchError) flash("no matches");
    patchUi(this.pane, { searchInput: false });
    this.focusHome(true);
  }
  cancelSearch(): void {
    patchUi(this.pane, { query: this.prevQuery, searchInput: false });
    this.runSearch(false);
    this.focusHome(true);
  }
  closeSearch(): void {
    patchUi(this.pane, { query: "", searchInput: false });
    this.runSearch(false);
    this.focusHome(true);
  }
  cycleSearchMode(): void {
    const mode = getUi(this.pane).searchMode;
    patchUi(this.pane, { searchMode: SEARCH_MODES[(SEARCH_MODES.indexOf(mode) + 1) % SEARCH_MODES.length] });
    this.runSearch(true);
  }
  searchStep(delta: 1 | -1): void {
    const ui = getUi(this.pane);
    if (!ui.query) return this.openSearch();
    if (this.matches.length === 0) return flash("no matches");
    this.showMatch(stepMatch(this.matches.length, ui.current, delta), true);
  }

  // ── edit ─────────────────────────────────────────────────────────────────

  private async beginEdit(): Promise<void> {
    const view = this.view;
    const token = ++this.token;
    const context = this.context;
    const stale = () => token !== this.token || this.disposed;
    const fail = (message: string) => {
      patchUi(this.pane, { loading: false });
      flash(message, "warn");
      this.exitEdit();
    };
    if (contextFlags(context).readOnly) return fail("read-only mode");
    patchUi(this.pane, { loading: true, secret: view.format === "secret" });
    try {
      const ref = toObjRef(view.ref, context);
      const allowed = await backend.canI({ context, verb: "patch", gvr: ref.gvr, namespace: ref.namespace, name: ref.name }).catch(() => true);
      if (stale()) return;
      if (!allowed) {
        patchUi(this.pane, { canEdit: false });
        return fail(`no permission to edit ${view.ref.gvr.resource}`);
      }
      let text: string;
      if (view.format === "secret") {
        // entering EDIT is a reveal; nothing of this buffer is ever written to disk
        [this.decoded, this.obj] = await Promise.all([backend.decodeSecret(ref), backend.getJson(ref)]);
        text = secretDoc(this.decoded, "all", { edit: true }).text;
        this.draft = null;
      } else {
        text = await backend.getYaml(ref, { managedFields: false });
        this.draft = draftKey(context, view.ref);
      }
      if (stale()) return;
      let buffer = text;
      if (this.draft) {
        const d = await loadDraft(this.draft);
        if (stale()) return;
        if (d && d.text !== text) {
          const at = new Date(d.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const resume = await confirm({
            tier: 1, title: "Resume draft", body: `An unsaved draft of ${view.ref.name} from ${at} was kept.`,
            confirmLabel: "Resume", cancelLabel: "Open server version",
          });
          if (stale()) return;
          // Esc is safe: declining keeps the draft until the next edit replaces it
          if (resume) buffer = d.text;
        }
      }
      this.original = text;
      this.originalText = textOf(text);
      this.editing = true;
      this.shownKey = "";
      this.wantKey = "";
      this.reset(buffer, true);
      this.bufDirty = buffer !== text;
      patchUi(this.pane, { loading: false, loadError: null, dirty: this.bufDirty, revealed: 0 });
      if (this.focused) this.cm.focus();
    } catch (e) {
      if (!stale()) fail(errorText(e));
    }
  }

  private scheduleDraft(): void {
    if (!this.draft) return;
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      if (!this.draft || !this.editing) return;
      if (this.bufDirty) saveDraft(this.draft, this.cm.state.doc.toString());
      else deleteDraft(this.draft);
    }, DRAFT_MS);
  }

  private setErrors(lines: readonly number[], message: string | null): void {
    const first = lines[0];
    const doc = this.cm.state.doc;
    this.cm.dispatch({
      effects: [
        setErrorLines.of(lines),
        ...(first && first <= doc.lines ? [EditorView.scrollIntoView(doc.line(first).from, { y: "nearest", yMargin: 32 })] : []),
      ],
    });
    patchUi(this.pane, { apiError: message });
  }

  toggleDiffGutter(): void {
    const on = !getUi(this.pane).diffGutter;
    this.cm.dispatch({ effects: diffConf.reconfigure(diffExt(on ? this.original : null)) });
    patchUi(this.pane, { diffGutter: on });
  }
  selectNextOccurrence(): void {
    selectNextOccurrence(this.cm);
  }
  addCursor(dir: 1 | -1): void {
    (dir === 1 ? addCursorBelow : addCursorAbove)(this.cm);
  }
  moveLine(dir: 1 | -1): void {
    (dir === 1 ? moveLineDown : moveLineUp)(this.cm);
  }

  /** Esc in EDIT (§4.2): the search bar, then extra cursors, then leave (asking when dirty). */
  leave(): void {
    const ui = getUi(this.pane);
    if (ui.searchInput || ui.query) return this.closeSearch();
    const sel = this.cm.state.selection;
    if (sel.ranges.length > 1) {
      this.cm.dispatch({ selection: EditorSelection.single(sel.main.anchor, sel.main.head) });
      return;
    }
    if (this.bufDirty) patchUi(this.pane, { dirty: true, discardAsk: true });
    else this.exitEdit();
  }
  /** Leaves the edit without the Esc ladder (vim's :q, a click on the leave button): asks when dirty. */
  quit(): void {
    if (this.view.mode !== "edit" || !this.editing) return;
    if (getUi(this.pane).searchInput) this.cancelSearch();
    if (this.bufDirty) patchUi(this.pane, { dirty: true, discardAsk: true });
    else this.exitEdit();
  }
  discard(): void {
    if (this.draft) deleteDraft(this.draft);
    this.exitEdit();
  }
  stay(): void {
    patchUi(this.pane, { discardAsk: false });
    this.cm.focus();
  }

  private exitEdit(): void {
    this.editing = false;
    this.token++;
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = null;
    this.secretDiff = null;
    this.bufDirty = false;
    patchUi(this.pane, { dirty: false, review: null, discardAsk: false, apiError: null, diffGutter: false });
    setPaneScope(this.pane, null);
    if (this.returnTo === "back" && canGoBack(this.pane)) {
      goBack(this.pane);
      return;
    }
    const secret = this.view.format === "secret";
    const to = this.returnTo === "back" ? { format: (secret ? "secret" : "yaml") as DocFormat, managedFields: false } : this.returnTo;
    replaceView(this.pane, asDoc({ ...this.view, mode: "view", format: to.format, managedFields: to.managedFields }));
  }

  // ── review and apply ─────────────────────────────────────────────────────

  review(): void {
    if (this.view.mode === "edit" && this.editing) void this.startReview();
  }

  private async startReview(): Promise<void> {
    const text = this.cm.state.doc.toString();
    const secret = this.view.format === "secret";
    const markers = conflictMarkerLines(text);
    if (markers.length) return this.setErrors(markers, "resolve the conflict markers before review");
    let before = this.original;
    let after = text;
    if (secret) {
      let values: Record<string, string>;
      try {
        values = parseSecretEdit(text);
      } catch (e) {
        return this.setErrors([(e as { line?: number }).line ?? 1], errorText(e));
      }
      this.manifest = secretManifest(this.obj, values, this.decoded ?? {});
      this.secretDiff = { plain: { before, after }, masked: maskSecretPair(parseSecretEdit(this.original), values) };
      ({ before, after } = this.secretDiff.masked);
    } else {
      const syntax = yamlSyntaxError(text);
      if (syntax) return this.setErrors([syntax.line], syntax.message);
      this.manifest = text;
    }
    this.setErrors([], null);
    const flux = fluxOwner(secret ? this.manifest : this.original);
    const split = getUi(this.pane).review?.split ?? null;
    patchUi(this.pane, {
      review: { dryRun: "running", message: null, warnings: [], conflict: null, flux, split, revealed: false, applying: false, before, after },
    });
    setPaneScope(this.pane, { conflict: false, fluxManaged: flux !== null });
    replaceView(this.pane, asDoc({ ...this.view, mode: "review" }));
    this.host.closest<HTMLElement>(".pane")?.focus({ preventScroll: true });
    const token = ++this.token;
    try {
      const res = await backend.applyYaml(this.context, this.manifest, { dryRun: true });
      if (token !== this.token || this.disposed) return;
      patchReview(this.pane, { dryRun: "ok", message: null, warnings: res.warnings, conflict: null });
    } catch (e) {
      if (token !== this.token || this.disposed) return;
      this.reviewFailed(e);
    }
  }

  private reviewFailed(e: unknown): void {
    const conflict = classifyConflict(e);
    const message = errorText(e);
    patchReview(this.pane, { dryRun: "error", message, conflict, applying: false });
    setPaneScope(this.pane, { conflict: conflict === "version", fluxManaged: getUi(this.pane).review?.flux != null });
    // marked in the edit buffer, so the offending lines show after Esc
    if (!conflict && this.view.format !== "secret") this.setErrors(errorLines(this.manifest, message), message);
  }

  async apply(): Promise<void> {
    const r = getUi(this.pane).review;
    if (!r || r.applying) return;
    const context = this.context;
    const ref = this.view.ref;
    const facts = { kind: kindName(ref), name: ref.name, namespace: ref.namespace, context };
    const force = r.conflict === "fieldManager";
    if (force) {
      const ok = await confirm({
        tier: 1, title: "Force apply",
        body: `Another field manager owns fields in this change. Forcing takes them over. ${r.message ?? ""}`,
        facts: objectFacts(facts), confirmLabel: "Force apply",
      });
      if (!ok) return;
    }
    if (contextFlags(context).protected) {
      const ok = await confirm({
        tier: 2, title: `Apply edit of ${facts.kind}`, typeToConfirm: ref.name,
        facts: objectFacts({ ...facts, protected: true }), confirmLabel: "Apply",
      });
      if (!ok) return;
    }
    if (this.disposed || !getUi(this.pane).review) return;
    patchReview(this.pane, { applying: true });
    const token = ++this.token;
    try {
      const res = await backend.applyYaml(context, this.manifest, force ? { force: true } : {});
      if (this.disposed) return;
      toast({ kind: "ok", text: `Applied ${facts.kind} ${ref.name}` });
      // the action log: names only, never the manifest (it may hold a secret)
      recordAction({ text: `applied ${facts.kind.toLowerCase()} ${ref.name}`, write: true, context, namespace: ref.namespace, target: { kind: "object", gvr: ref.gvr, namespace: ref.namespace, name: ref.name } });
      for (const w of res.warnings) toast({ kind: "warn", text: w });
      if (token !== this.token) return;
      if (this.draft) deleteDraft(this.draft);
      this.exitEdit();
    } catch (e) {
      // a Secret's apply error may echo a value (mutate.rs does not redact): only the kind of failure then
      recordAction({ text: `apply ${facts.kind.toLowerCase()} ${ref.name} failed`, state: "error", error: ref.gvr.resource === "secrets" ? "see the review for details" : errorText(e), write: true, context, namespace: ref.namespace, target: { kind: "object", gvr: ref.gvr, namespace: ref.namespace, name: ref.name } });
      if (token !== this.token || this.disposed) return;
      this.reviewFailed(e);
    }
  }

  backToEdit(): void {
    this.token++;
    patchUi(this.pane, { review: null });
    setPaneScope(this.pane, null);
    replaceView(this.pane, asDoc({ ...this.view, mode: "edit" }));
  }

  toggleSplit(): void {
    const r = getUi(this.pane).review;
    if (r) patchReview(this.pane, { split: !(r.split ?? this.host.parentElement!.clientWidth >= SPLIT_MIN) });
  }

  revealReview(): void {
    const r = getUi(this.pane).review;
    if (!r || !this.secretDiff) return;
    const revealed = !r.revealed;
    patchReview(this.pane, { revealed, ...(revealed ? this.secretDiff.plain : this.secretDiff.masked) });
  }

  /** Replays the edit onto the new server version (§13.2 step 6). */
  async rebase(): Promise<void> {
    const view = this.view;
    if (!getUi(this.pane).review) return;
    const token = ++this.token;
    const stale = () => token !== this.token || this.disposed;
    patchReview(this.pane, { dryRun: "running", message: null });
    try {
      const ref = toObjRef(view.ref, this.context);
      let fresh: string;
      if (view.format === "secret") {
        [this.decoded, this.obj] = await Promise.all([backend.decodeSecret(ref), backend.getJson(ref)]);
        fresh = secretDoc(this.decoded, "all", { edit: true }).text;
      } else fresh = await backend.getYaml(ref, { managedFields: false });
      if (stale()) return;
      const merged = merge3(this.original, this.cm.state.doc.toString(), fresh);
      this.original = fresh;
      this.originalText = textOf(fresh);
      this.replaceDoc(merged.text);
      this.bufDirty = merged.text !== fresh;
      patchUi(this.pane, { dirty: this.bufDirty });
      if (getUi(this.pane).diffGutter) this.cm.dispatch({ effects: diffConf.reconfigure(diffExt(fresh)) });
      if (merged.conflicts > 0) {
        this.backToEdit();
        this.setErrors(conflictMarkerLines(merged.text), `${merged.conflicts} overlapping change${merged.conflicts > 1 ? "s" : ""}: resolve the marked blocks`);
      } else if (merged.text === fresh) {
        toast({ kind: "info", text: "Nothing left to apply: the server already has these changes" });
        if (this.draft) deleteDraft(this.draft);
        this.exitEdit();
      } else await this.startReview();
    } catch (e) {
      if (!stale()) this.reviewFailed(e);
    }
  }

  async suspendFlux(): Promise<void> {
    const owner = getUi(this.pane).review?.flux;
    if (!owner) return;
    const res = resolveResource(owner.resource, this.context);
    if (!res) return flash(`${owner.resource} is not served by this cluster`, "warn");
    const context = this.context;
    const ref = { context, gvr: res.gvr, namespace: owner.namespace, name: owner.name };
    if (contextFlags(context).protected) {
      const ok = await confirm({
        tier: 2, title: `Suspend ${res.kind}`, typeToConfirm: owner.name, confirmLabel: "Suspend",
        facts: objectFacts({ kind: res.kind, name: owner.name, namespace: owner.namespace, context, protected: true }),
      });
      if (!ok) return;
    }
    try {
      await backend.patchObject(ref, { spec: { suspend: true } }, "merge");
      if (this.disposed) return;
      toast({ kind: "ok", text: `Suspended ${res.kind} ${owner.name}`, undo: () => backend.patchObject(ref, { spec: { suspend: false } }, "merge") });
      patchReview(this.pane, { flux: null });
      setPaneScope(this.pane, { conflict: getUi(this.pane).review?.conflict === "version", fluxManaged: false });
    } catch (e) {
      toast({ kind: "error", text: errorText(e) });
    }
  }
}
