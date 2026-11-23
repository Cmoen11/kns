// Vim mode, the parts that need no CodeMirror: what vim is doing right now, read from the
// library's own state object, and what the app shows for it. Pure, so the key-routing rule is
// unit-tested without a DOM. The rule (docs/frontend.md §2, "Vim keys"):
//   - a doc editor with vim on and DOM focus pushes LAYERS.vim (below: "chords+esc"): plain and
//     named keys are vim's; Ctrl/Alt/Cmd chords, F-keys and the leader stay with the app;
//   - Esc is vim's while vimBusy() holds (`vim.escape`); from an idle normal mode it is the pane's,
//     as without vim: back in a read-only view, leave in a clean EDIT. A dirty EDIT keeps it
//     with vim (vimOwnsEscape): leaving that is :w, :q or :q!;
//   - of the chords vim.keys hands to vim, the app keeps Ctrl+B (sidebar), Ctrl+F (search) and,
//     outside insert mode, Ctrl+W (close pane): vimTakesChord;
//   - vim's `:` and `/` prompt is a text input with its own strict layer (PROMPT_LAYER).
import { LAYERS, type ModeBadge, type ScopeLayer } from "../../actions/scopes";

/** The fields of the library's per-editor vim state that the app reads. */
export interface VimStateLike {
  insertMode?: boolean;
  visualMode?: boolean;
  /** "normal" | "insert" | "replace" | "visual" | "visual line" | "visual block" */
  mode?: string;
  /** keys typed so far of an unfinished command */
  status?: string;
  inputState?: {
    keyBuffer?: readonly unknown[];
    operator?: unknown;
    prefixRepeat?: readonly unknown[];
    motionRepeat?: readonly unknown[];
    registerName?: unknown;
  };
}

/**
 * True when Esc means something to vim: it is in insert, replace or visual mode, a command is
 * half typed (count, operator, register, multi-key), or a `/` search highlight is showing.
 * Then `vim.escape` takes Esc; an idle normal mode leaves it to the app (vimOwnsEscape).
 */
export function vimBusy(vim: VimStateLike | null | undefined, highlight = false): boolean {
  if (!vim) return false;
  if (vim.insertMode || vim.visualMode || highlight) return true;
  const i = vim.inputState;
  if (!i) return false;
  return (
    (i.keyBuffer?.length ?? 0) > 0 || i.operator != null || (i.prefixRepeat?.length ?? 0) > 0 ||
    (i.motionRepeat?.length ?? 0) > 0 || i.registerName != null
  );
}

const BADGES: Record<string, ModeBadge> = {
  insert: "INSERT", replace: "REPLACE", visual: "VISUAL", "visual line": "V-LINE", "visual block": "V-BLOCK",
};

/** The bottom-row badge: vim's mode when it is not normal, else the pane's own (NORMAL or EDIT). */
export const vimBadge = (mode: string | undefined, base: ModeBadge): ModeBadge => BADGES[mode ?? ""] ?? base;

/** The layer of an editor that has focus. Its badge is fixed at push: push again when it changes. */
export const vimLayer = (mode: string | undefined, base: ModeBadge): ScopeLayer => ({ ...LAYERS.vim, mode: vimBadge(mode, base) });

/**
 * vim's command line owns every key but the global Ctrl/Alt/Cmd chords; Esc and Enter included.
 * The pane's own chords (Ctrl+S review, Ctrl+D next occurrence) do not act on the buffer behind it.
 */
export const PROMPT_LAYER: ScopeLayer = { scopes: [], below: "global-chords", mode: "COMMAND" };

/** `:q!` */
export const exBang = (argString: string | undefined): boolean => (argString ?? "").trim().startsWith("!");

/**
 * Who gets Esc while a vim editor has focus. vim, while it has something to leave (`busy`). From
 * an idle normal mode the pane gets it, as without vim: back in a read-only view, leave in a
 * clean EDIT. A dirty EDIT is the one exception: there an idle Esc stays with vim (it closes the
 * search or extra cursors, else says how to leave), because the pane's next step would be the
 * discard dialog, where `Esc Esc :w Enter` would discard the edit. Leaving a dirty edit is
 * :w (review), :q (asks) or :q!.
 */
export function vimOwnsEscape(s: { busy: boolean; edit: boolean; dirty: boolean }): boolean {
  return s.busy || (s.edit && s.dirty);
}

/** Chords the app owns on Windows (the sidebar, the search): never vim's there, also when a user binds them to `vim.keys`. */
const APP_CHORDS: ReadonlySet<string> = new Set(["Ctrl+B", "Ctrl+F"]);
/** vim modes in which text is typed */
const TYPING_MODES: ReadonlySet<string> = new Set(["insert", "replace"]);

/**
 * Whether a chord bound to `vim.keys` goes to vim. The app keeps the ones its own pane shortcuts
 * use (src/actions/keymap-data.ts), so they work in a vim editor as everywhere else:
 *   - Ctrl+B is the context sidebar and Ctrl+F the search, in every vim mode. vim's page up and
 *     down are Ctrl+U / Ctrl+D and PgUp / PgDn;
 *   - Ctrl+W closes the pane, except while typing (insert, replace), where it deletes a word.
 * Everything else bound to vim.keys (Ctrl+R, Ctrl+D, Ctrl+U, Ctrl+O) is vim's. Without a chord
 * (the hint row, the palette) the action is simply there. On macOS (`mac`) the app's shortcuts
 * are ⌘ chords, so every Ctrl chord of vim.keys is vim's: Ctrl+B / Ctrl+F page, Ctrl+W deletes a
 * word or starts a window command.
 */
export function vimTakesChord(chord: string | undefined, mode: string | undefined, mac = false): boolean {
  if (chord === undefined || mac) return true;
  if (APP_CHORDS.has(chord)) return false;
  if (chord === "Ctrl+W") return TYPING_MODES.has(mode ?? "");
  return true;
}
