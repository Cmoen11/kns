// Per-pane doc state that the eager action handlers, the pane guard and the header read. Small
// and free of CodeMirror: the lazy DocView chunk fills `controllers` when a doc pane mounts.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { engine } from "../../keys";
import type { KeyEventLike } from "../../keys/chord";
import type { PaneId } from "../../types";
import type { SearchMode } from "./search-match";
import type { FluxOwner } from "./yaml-helpers";

export interface ReviewState {
  dryRun: "running" | "ok" | "error";
  /** the API error of the dry run or the apply */
  message: string | null;
  warnings: readonly string[];
  /** version = the object changed (rebase); fieldManager = another manager owns a field (force) */
  conflict: "version" | "fieldManager" | null;
  flux: FluxOwner | null;
  /** the Argo CD Application that applied the object (`Application ns/app`), when Flux did not */
  argo?: string | null;
  /** user override of split/unified; null = by width */
  split: boolean | null;
  /** secret values shown in the diff */
  revealed: boolean;
  applying: boolean;
  before: string;
  after: string;
}

export interface DocUi {
  loading: boolean;
  loadError: string | null;
  dirty: boolean;
  secret: boolean;
  /** the search input is open */
  searchInput: boolean;
  query: string;
  searchMode: SearchMode;
  searchError: string | null;
  matches: number;
  /** 0-based index of the current match, -1 = none */
  current: number;
  /** a selection exists (line selection or a character range) */
  selection: boolean;
  cursors: number;
  /** inline API error bar */
  apiError: string | null;
  diffGutter: boolean;
  /** number of revealed secret keys */
  revealed: number;
  discardAsk: boolean;
  review: ReviewState | null;
  /** RBAC answer for patch on this object; null = not known yet */
  canEdit: boolean | null;
  /** vim keys are attached to this pane's editor */
  vim: boolean;
  /** vim's half-typed command ("2d"), shown in the pane header */
  vimKeys: string;
  /** "fold all" is on (the toolbar's pressed state) */
  folded: boolean;
}

export const EMPTY_UI: DocUi = Object.freeze({
  loading: false, loadError: null, dirty: false, secret: false, searchInput: false, query: "", searchMode: "text" as SearchMode,
  searchError: null, matches: 0, current: -1, selection: false, cursors: 1, apiError: null, diffGutter: false, revealed: 0,
  discardAsk: false, review: null, canEdit: null, vim: false, vimKeys: "", folded: false,
});

const store = createStore<Record<PaneId, DocUi>>(() => ({}));

export const getUi = (pane: PaneId | null | undefined): DocUi => (pane && store.getState()[pane]) || EMPTY_UI;

export function patchUi(pane: PaneId, patch: Partial<DocUi>): void {
  const all = store.getState();
  const cur = all[pane] ?? EMPTY_UI;
  let changed = false;
  for (const k of Object.keys(patch) as (keyof DocUi)[]) {
    if (cur[k] !== patch[k]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  store.setState({ ...all, [pane]: { ...cur, ...patch } }, true);
  // `when` / `enabled` of the doc actions read this state
  engine.invalidate();
}

export function patchReview(pane: PaneId, patch: Partial<ReviewState>): void {
  const r = getUi(pane).review;
  if (r) patchUi(pane, { review: { ...r, ...patch } });
}

export function clearUi(pane: PaneId): void {
  const all = store.getState();
  if (!(pane in all)) return;
  const next = { ...all };
  delete next[pane];
  store.setState(next, true);
  engine.invalidate();
}

export function useDocUi<T>(pane: PaneId, select: (ui: DocUi) => T): T {
  return useStore(store, (s) => select(s[pane] ?? EMPTY_UI));
}

/** What the action handlers call. Implemented by the lazy controller (controller.ts). */
export interface DocController {
  move(lines: number): void;
  page(dir: 1 | -1): void;
  edge(end: "top" | "bottom"): void;
  openSearch(): void;
  setQuery(text: string): void;
  applySearch(): void;
  cancelSearch(): void;
  cycleSearchMode(): void;
  closeSearch(): void;
  searchStep(delta: 1 | -1): void;
  selectLines(): void;
  selectChars(dir: "Left" | "Right" | "Up" | "Down"): void;
  clearSelection(): void;
  copy(): void;
  foldToggle(): void;
  foldAll(): void;
  revealToggle(): void;
  revealKey(): void;
  refresh(): void;
  review(): void;
  toggleDiffGutter(): void;
  selectNextOccurrence(): void;
  addCursor(dir: 1 | -1): void;
  moveLine(dir: 1 | -1): void;
  leave(): void;
  /** leaves the edit at once (asks when dirty): vim's :q and a click on the leave button */
  quit(): void;
  discard(): void;
  stay(): void;
  apply(): void;
  backToEdit(): void;
  toggleSplit(): void;
  rebase(): void;
  revealReview(): void;
  suspendFlux(): void;
  /** vim wants Esc: insert or visual mode, a half-typed command, or a search highlight */
  vimBusy(): boolean;
  /** a vim editor holds the DOM focus: the vim layer is pushed */
  vimFocused(): boolean;
  /** Esc is vim's right now: a vim editor has focus and is busy, or it is a dirty EDIT buffer (leave is :w / :q) */
  vimOwnsEsc(): boolean;
  /** a chord bound to vim.keys goes to vim right now; false for the ones the app keeps (Ctrl+B, Ctrl+F, Ctrl+W outside insert) */
  vimTakes(chord: string | undefined): boolean;
  /** Esc for vim: to vim while it is busy; in an idle dirty EDIT buffer it closes the search or the extra cursors */
  vimEscape(e: KeyEventLike | undefined): void;
  /** hands vim a key the key engine took (the keydown itself, or `fallback` like "<Esc>") */
  vimKey(e: KeyEventLike | undefined, fallback?: string): void;
}

export const controllers = new Map<PaneId, DocController>();

/** When a pane's doc entry was opened in edit mode by an action (as opposed to restored from disk). */
export const freshEdits = new Map<PaneId, number>();
