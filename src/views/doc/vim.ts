// Vim keys for the doc editors (@replit/codemirror-vim). Its own lazy chunk: the controller
// imports it only while the `vim` setting is on. Everything that touches the library is here.
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { Vim, getCM, vim } from "@replit/codemirror-vim";
import type { KeyEventLike } from "../../keys/chord";
import { exBang, vimBusy, type VimStateLike } from "./vim-state";

/** What an editor's owner (the doc controller) does for vim. */
export interface VimHost {
  /** vim's mode or pending keys changed */
  changed(): void;
  /** :w  - the review and apply flow of editor.review */
  write(): void;
  /** :q  - leave the edit (asking when dirty), or go back / close the pane; :q! discards */
  quit(force: boolean): void;
  /** :e  - start editing */
  edit(): void;
  /** :vim [on|off]  - the app's vim setting (the way out of vim from inside a vim editor) */
  setting(arg: string): void;
}

const hosts = new WeakMap<EditorView, VimHost>();
export function setVimHost(view: EditorView, host: VimHost | null): void {
  if (host) hosts.set(view, host);
  else hosts.delete(view);
}

interface Adapter {
  cm6: EditorView;
  state: { vim?: VimStateLike; vimPlugin?: { query?: unknown; handleKey(e: unknown, view: EditorView): boolean } };
  on(type: string, fn: () => void): void;
  off(type: string, fn: () => void): void;
}
const adapter = (view: EditorView): Adapter | null => getCM(view) as unknown as Adapter | null;

const EVENTS = ["vim-mode-change", "vim-keypress", "vim-command-done", "dialog"];

// setState and every reconfigure build a new vim adapter, so the listeners live in a plugin that
// is rebuilt with it (it sits after vim() in the same extension).
const tracker = ViewPlugin.fromClass(
  class {
    private readonly cm: Adapter | null;
    private readonly notify: () => void;
    constructor(view: EditorView) {
      this.cm = adapter(view);
      this.notify = () => hosts.get(view)?.changed();
      for (const e of EVENTS) this.cm?.on(e, this.notify);
      // the new adapter starts in normal mode
      queueMicrotask(this.notify);
    }
    destroy() {
      for (const e of EVENTS) this.cm?.off(e, this.notify);
      queueMicrotask(this.notify);
    }
  },
);

const plain = (e: KeyEventLike) => ({
  key: e.key, code: e.code, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey,
  preventDefault() {}, stopPropagation() {},
});

// AltGr characters ($ { } [ ] @ on a Norwegian layout). Windows reports AltGr as Ctrl+Alt, which
// the library reads as <C-A-$> and drops, and a read-only view gets no text input to fall back on.
// Outside insert mode the produced character is handed to vim as a plain key (the same rule as
// the app key engine, docs/ux.md §5.1 rule 4). Runs before vim(): it sits first in the extension.
const altGr = EditorView.domEventHandlers({
  keydown(e, view) {
    if ([...e.key].length !== 1 || e.metaKey) return false;
    if (!(e.getModifierState("AltGraph") || (e.ctrlKey && e.altKey))) return false;
    const cm = adapter(view);
    if (!cm?.state.vimPlugin || !cm.state.vim || cm.state.vim.insertMode) return false;
    cm.state.vimPlugin.handleKey({ ...plain(e), ctrlKey: false, altKey: false }, view);
    return true;
  },
});

/** vim(), the tracker, and a tabindex so the read-only (not contenteditable) views take focus. */
export const vimExtension = (): Extension => [altGr, vim(), tracker, EditorView.contentAttributes.of({ tabindex: "0" })];

/** vim's state for this editor, or null when vim is not attached to it. */
export const vimState = (view: EditorView): VimStateLike | null => adapter(view)?.state.vim ?? null;

export function isBusy(view: EditorView): boolean {
  const cm = adapter(view);
  return !!cm && vimBusy(cm.state.vim, !!cm.state.vimPlugin?.query);
}

/**
 * Hands vim a key the app's key engine took first (Esc, Ctrl+R ...), as the keydown it was.
 * Without an event (the action was run from the palette) `fallback` is sent, e.g. "<Esc>".
 */
export function sendKey(view: EditorView, e: KeyEventLike | undefined, fallback?: string): void {
  const cm = adapter(view);
  if (!cm) return;
  if (e && cm.state.vimPlugin) {
    cm.state.vimPlugin.handleKey(plain(e), view);
  } else if (fallback) {
    Vim.handleKey(cm as never, fallback, "user");
  }
  hosts.get(view)?.changed();
}

// ── once per app: ex commands and the yank hook (Vim is a global singleton) ─────────────────

type Ex = (cm: { cm6: EditorView }, params: { argString?: string }) => void;
// vim closes its prompt and refocuses the editor after the command returns: act after that
const later = (cm: { cm6: EditorView }, fn: (h: VimHost) => void) => {
  const host = hosts.get(cm.cm6);
  if (host) setTimeout(() => fn(host), 0);
};
const write: Ex = (cm) => later(cm, (h) => h.write());
const quit: Ex = (cm, p) => later(cm, (h) => h.quit(exBang(p.argString)));
const edit: Ex = (cm) => later(cm, (h) => h.edit());
const defineEx = Vim.defineEx as unknown as (name: string, prefix: string, fn: Ex) => void;
defineEx("write", "w", write);
defineEx("quit", "q", quit);
// applying is the last step of the review, and a finished apply leaves the edit by itself
defineEx("wq", "wq", write);
defineEx("xit", "x", write);
defineEx("edit", "e", edit);
defineEx("vim", "vim", (cm, p) => later(cm, (h) => h.setting((p.argString ?? "").trim())));

// `y` also reaches the system clipboard (deletes do not), like the app's own copy
const registers = Vim.getRegisterController();
const pushText = registers.pushText.bind(registers);
registers.pushText = (name, operator, text, linewise, blockwise) => {
  pushText(name, operator, text, linewise, blockwise);
  if (operator === "yank" && !name) navigator.clipboard?.writeText(text).catch(() => undefined);
};
