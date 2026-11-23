// Home sections (docs/plan-features.md §2.10a): features add a section of rows to the home view
// (I: tools, B-dev: dev sets, C2: traps) without editing it. Rows, not components, so a section is
// walked, filtered and opened with the same keys and clicks as the rest of home.
import type { ItemRow } from "./list-model";

export interface HomeSection {
  id: string;
  /** group label shown above the rows */
  label: string;
  /** after home's own sections, lower first */
  order: number;
  /**
   * Called at the top level of HomeView on every render (a hook: it may use stores). Return a
   * stable array (memoize it). No rows: the section is not shown. Row keys are prefixed with the
   * section id by HomeView, so they never clash with home's own.
   */
  useRows: () => readonly ItemRow[];
}

let sections: HomeSection[] = [];
let closed = false;

/** Adds a section (a later one with the same id replaces it). Call from register(); throws after home has mounted. */
export function registerHomeSection(s: HomeSection): void {
  if (closed) throw new Error(`registerHomeSection("${s.id}"): home has mounted; register in register()`);
  sections = [...sections.filter((x) => x.id !== s.id), s].sort((a, b) => a.order - b.order);
}

/** The sections by order. The first call closes registration (HomeView calls their hooks). */
export function homeSections(): readonly HomeSection[] {
  closed = true;
  return sections;
}

/** Tests only. */
export function resetHomeSections(): void {
  sections = [];
  closed = false;
}
