// State of one patterns pane, outside React so the eager actions (j/k, Enter, !, Mod+R) reach it.
// The view mounts it, feeds it mining results and renders from its version counter.
import { focusedPane, paneView } from "../../foundation";
import type { PaneId, PatternsView } from "../../types";
import { visiblePatterns, type Pattern } from "./patterns";

export type PreviousState = "none" | "loading" | "ready" | "empty" | "skipped";

export class PatternsModel {
  patterns: readonly Pattern[] = [];
  /** lines the last result covered */
  lines = 0;
  /** the cursor row's template: kept across re-mines */
  cursorKey: string | null = null;
  errorsOnly = false;
  mining = false;
  progress: { done: number; total: number } | null = null;
  previous: PreviousState = "none";
  previousLines = 0;
  /** texts of the previous run, kept while the pane lives (the source may leave and come back) */
  previousTexts: string[] | null = null;
  /** the source pane closed or shows something else: the table is frozen */
  closed = false;
  /** the miner fell back to the UI thread */
  mainThread = false;
  /** set by the view: re-mine now */
  refresh: () => void = () => {};

  private version = 0;
  private subs = new Set<() => void>();

  constructor(readonly pane: PaneId, readonly source: PaneId) {}

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
  getVersion = (): number => this.version;
  touch(): void {
    this.version++;
    for (const fn of [...this.subs]) fn();
  }

  get rows(): readonly Pattern[] {
    return visiblePatterns(this.patterns, this.errorsOnly);
  }

  get cursor(): number {
    const rows = this.rows;
    if (rows.length === 0) return -1;
    const i = this.cursorKey === null ? -1 : rows.findIndex((p) => p.template === this.cursorKey);
    return i >= 0 ? i : 0;
  }

  current(): Pattern | undefined {
    const i = this.cursor;
    return i >= 0 ? this.rows[i] : undefined;
  }

  moveTo(index: number): void {
    const rows = this.rows;
    if (rows.length === 0) return;
    const i = Math.max(0, Math.min(rows.length - 1, index));
    this.cursorKey = rows[i].template;
    this.touch();
  }
  move(delta: number): void {
    this.moveTo(this.cursor + delta);
  }

  setResult(patterns: readonly Pattern[], lines: number): void {
    this.patterns = patterns;
    this.lines = lines;
    this.mining = false;
    this.progress = null;
    this.touch();
  }
}

const models = new Map<PaneId, PatternsModel>();

export function acquirePatterns(pane: PaneId, source: PaneId): PatternsModel {
  let m = models.get(pane);
  if (!m || m.source !== source) models.set(pane, (m = new PatternsModel(pane, source)));
  return m;
}
/** (Re)registers a mounted model: StrictMode's effect replay releases it once in between. */
export function holdPatterns(pane: PaneId, m: PatternsModel): void {
  models.set(pane, m);
}
export function releasePatterns(pane: PaneId, m: PatternsModel): void {
  if (models.get(pane) === m) models.delete(pane);
}

export interface FocusedPatterns {
  pane: PaneId;
  view: PatternsView;
  m: PatternsModel;
}

export function focusedPatterns(): FocusedPatterns | null {
  const pane = focusedPane();
  if (!pane) return null;
  const view = paneView(pane);
  const m = models.get(pane);
  return view?.kind === "patterns" && m ? { pane, view, m } : null;
}
