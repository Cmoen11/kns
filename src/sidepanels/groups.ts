// Activity panel groups (docs/plan-features.md §2.9): features add a section of their own to the
// activity panel (agent requests, rollouts, traps, debug pods, agents, journal) without editing it.
// Eager and tiny: register() calls run at startup, the lazy panel reads the list when it mounts.
import type { PanelRow } from "./model";

export interface GroupRows {
  rows: readonly PanelRow[];
  /** the number after the title; default rows.length */
  count?: number;
  /** headers: X stops everything in the group */
  stopAll?: () => unknown;
  /** C and the header's clear button empty the group; shown only when given */
  clear?: () => unknown;
}

export interface ActivityGroup {
  /** section id: unique, and not one of the built-in sections (BUILTIN_ORDER) */
  id: string;
  label: string;
  /**
   * Position among the sections: Port-forwards 10, Shells 30, Log streams 40, Operations 100,
   * Connection 110, Recent 120. Below 100 renders before Operations; 5 is above everything.
   */
  order: number;
  /**
   * Called at the top level of ActivityPanel on every render, in registration order (a hook: it
   * may use stores). Return stable references (memoize the rows), or the panel rebuilds its row
   * list on every render. A group with no rows renders nothing, not even its header.
   */
  useRows: () => GroupRows;
}

/** The built-in sections of ActivityPanel.tsx and their order. */
export const BUILTIN_ORDER = { forwards: 10, sessions: 30, logs: 40, operations: 100, health: 110, recent: 120 } as const;

let groups: ActivityGroup[] = [];
let closed = false;

/**
 * Adds a group (a later one with the same id replaces it). Call from a feature's register(), before
 * the first render: the panel calls every group's hook at its top level, so the list must not
 * change once it has mounted. Throws after that.
 */
export function registerActivityGroup(g: ActivityGroup): void {
  if (closed) throw new Error(`registerActivityGroup("${g.id}"): the activity panel has mounted; register in register()`);
  if (g.id in BUILTIN_ORDER) throw new Error(`registerActivityGroup: "${g.id}" is a built-in section`);
  groups = [...groups.filter((x) => x.id !== g.id), g];
}

/** The registered groups, in registration order. The first call closes registration. */
export function activityGroups(): readonly ActivityGroup[] {
  closed = true;
  return groups;
}

export const groupsClosed = (): boolean => closed;

/** Tests only: forget every group and reopen registration. */
export function resetActivityGroups(): void {
  groups = [];
  closed = false;
}

/** One section of the panel before layout: a built-in section or a group. */
export interface SectionSpec {
  id: string;
  label: string;
  order: number;
  items: readonly PanelRow[];
  extra?: Partial<PanelRow>;
  /** groups: no header when there are no items */
  hideEmpty?: boolean;
}

/** A group's rows as a section (its rows carry the group id as their section). */
export function groupSection(g: ActivityGroup, data: GroupRows): SectionSpec {
  return {
    id: g.id,
    label: g.label,
    order: g.order,
    items: data.rows.map((r) => (r.section === g.id ? r : { ...r, section: g.id })),
    extra: { count: data.count ?? data.rows.length, stopAll: data.stopAll, clearable: data.clear !== undefined, clear: data.clear },
    hideEmpty: true,
  };
}

/**
 * The flat row list: sections sorted by order (stable, so equal orders keep their given order), a
 * header per section, its rows unless folded. Pure.
 */
export function layoutSections(
  sections: readonly SectionSpec[],
  collapsed: Readonly<Record<string, boolean>>,
  headerKey: (id: string) => string,
): PanelRow[] {
  const out: PanelRow[] = [];
  const sorted = sections.map((s, i) => ({ s, i })).sort((a, b) => a.s.order - b.s.order || a.i - b.i);
  for (const { s } of sorted) {
    if (s.hideEmpty && s.items.length === 0) continue;
    const folded = collapsed[s.id] ?? false;
    out.push({ key: headerKey(s.id), section: s.id, header: true, collapsed: folded, label: s.label, count: s.items.length, ...s.extra });
    if (!folded) out.push(...s.items);
  }
  return out;
}
