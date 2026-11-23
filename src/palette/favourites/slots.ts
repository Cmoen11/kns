// Slot logic for favourites (docs/ux.md §7) and namespace slots (§8.1). Pure.
import type { NsSlot, Slot } from "../../types";

export const SLOTS: readonly Slot[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
export const isSlot = (n: unknown): n is Slot => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 9;

/** Parses "3" -> 3; anything else is undefined. */
export function parseSlot(text: string | undefined): Slot | undefined {
  if (text === undefined || !/^[1-9]$/.test(text.trim())) return undefined;
  return Number(text.trim()) as Slot;
}

interface Slotted {
  id: string;
  name: string;
  slot?: Slot;
}

/** The lowest slot no item holds, or undefined when all nine are taken. */
export function nextFreeSlot(items: readonly Slotted[]): Slot | undefined {
  const used = new Set(items.map((i) => i.slot));
  return SLOTS.find((s) => !used.has(s));
}

export const occupant = <T extends Slotted>(items: readonly T[], slot: Slot | undefined, except?: string): T | undefined =>
  slot === undefined ? undefined : items.find((i) => i.slot === slot && i.id !== except);

const withSlot = <T extends Slotted>(item: T, slot: Slot | undefined): T => {
  if (item.slot === slot) return item;
  const { slot: _old, ...rest } = item;
  return (slot === undefined ? rest : { ...rest, slot }) as T;
};

/**
 * Adds or replaces an item (by id). When its slot is taken, the old occupant stays in the list
 * without a slot (§7.1).
 */
export function upsert<T extends Slotted>(items: readonly T[], item: T): T[] {
  const out = items.filter((i) => i.id !== item.id).map((i) => (item.slot !== undefined && i.slot === item.slot ? withSlot(i, undefined) : i));
  const at = items.findIndex((i) => i.id === item.id);
  if (at < 0) out.push(item);
  else out.splice(at, 0, item);
  return out;
}

/**
 * Shift+Up / Shift+Down in the picker: moves an item to the neighbouring slot number. An item
 * without a slot takes the first free one (up) or the last free one (down). Moving onto an
 * occupied slot swaps the two. Slots do not wrap.
 */
export function moveSlot<T extends Slotted>(items: readonly T[], id: string, delta: 1 | -1): T[] {
  const item = items.find((i) => i.id === id);
  if (!item) return items as T[];
  let target: Slot | undefined;
  if (item.slot === undefined) {
    const used = new Set(items.map((i) => i.slot));
    const free = SLOTS.filter((s) => !used.has(s));
    target = delta < 0 ? free[0] : free[free.length - 1];
    if (target === undefined) return items as T[];
  } else {
    const next = item.slot + delta;
    if (!isSlot(next)) return items as T[];
    target = next;
  }
  const from = item.slot;
  return items.map((i) => (i.id === id ? withSlot(i, target) : i.slot === target ? withSlot(i, from) : i));
}

export const removeItem = <T extends Slotted>(items: readonly T[], id: string): T[] => items.filter((i) => i.id !== id);

export const renameItem = <T extends Slotted>(items: readonly T[], id: string, name: string): T[] =>
  items.map((i) => (i.id === id ? { ...i, name } : i));

/** Case-insensitive lookup by name; an exact-case match wins. */
export function findByName<T extends Slotted>(items: readonly T[], name: string): T | undefined {
  const n = name.trim();
  return items.find((i) => i.name === n) ?? items.find((i) => i.name.toLowerCase() === n.toLowerCase());
}

// ── namespace slots (§8.1) ───────────────────────────────────────────────────

/** Always nine entries; index 0 is slot 1. */
export function normalizeNsSlots(slots: readonly NsSlot[] | undefined): NsSlot[] {
  const out: NsSlot[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < 9; i++) {
    const s = slots?.[i] ?? null;
    if (s && typeof s.name === "string" && s.name !== "" && !seen.has(s.name)) {
      seen.add(s.name);
      out.push({ name: s.name, pinned: s.pinned === true });
    } else out.push(null);
  }
  return out;
}

/** The slot number (1..9) of a namespace, or 0. */
export const nsSlotOf = (slots: readonly NsSlot[], name: string): number => slots.findIndex((s) => s?.name === name) + 1;

/** Most recently used first, without duplicates, capped. */
export function touchRecent(recent: readonly string[], name: string, cap = 30): string[] {
  return [name, ...recent.filter((n) => n !== name)].slice(0, cap);
}

/**
 * The slot a new namespace goes into: the lowest free one; with all nine taken, the least recently
 * used unpinned one. -1 when every slot is pinned. `recent` is most recent first.
 */
function slotFor(slots: readonly NsSlot[], recent: readonly string[]): number {
  const free = slots.findIndex((s) => s === null);
  if (free >= 0) return free;
  let pick = -1;
  let worst = -1;
  slots.forEach((s, i) => {
    if (!s || s.pinned) return;
    const at = recent.indexOf(s.name);
    const age = at < 0 ? Number.MAX_SAFE_INTEGER : at;
    if (age > worst) {
      worst = age;
      pick = i;
    }
  });
  return pick;
}

/**
 * A namespace was used. Slots do not shift: a namespace that has a slot keeps it; one without a
 * slot fills the lowest free number, or replaces the least recently used unpinned slot in place.
 * No other number moves. `recent` is the order before this use.
 */
export function noteNamespace(slots: readonly NsSlot[], recent: readonly string[], name: string): NsSlot[] {
  const cur = normalizeNsSlots(slots);
  if (name === "" || name === "*" || nsSlotOf(cur, name) > 0) return cur;
  const at = slotFor(cur, recent);
  if (at < 0) return cur;
  cur[at] = { name, pinned: false };
  return cur;
}

/**
 * Ctrl/Cmd+D in the picker: pins or unpins the namespace's slot. A namespace without a slot gets
 * one (same rule as noteNamespace) and is pinned. Unchanged when all nine slots are pinned.
 */
export function togglePin(slots: readonly NsSlot[], recent: readonly string[], name: string): NsSlot[] {
  const cur = normalizeNsSlots(slots);
  if (name === "" || name === "*") return cur;
  let at = nsSlotOf(cur, name) - 1;
  if (at >= 0) {
    const s = cur[at] as { name: string; pinned: boolean };
    cur[at] = { name, pinned: !s.pinned };
    return cur;
  }
  at = slotFor(cur, recent);
  if (at < 0) return cur;
  cur[at] = { name, pinned: true };
  return cur;
}
