// Row model of the tool views (home, aliases, messages, settings): a flat list of group labels
// and items, filtered by text and walked by a cursor that skips the labels. Pure.

export interface GroupRow {
  type: "group";
  key: string;
  label: string;
}

export interface ItemRow {
  type: "item";
  /** stable across re-renders: the cursor follows the key, not the index */
  key: string;
  /** left-aligned cells; the first is the name, the rest are muted. Untrusted text. */
  cells: readonly string[];
  /** right-aligned value (settings) */
  value?: string;
  /** key bindings shown as chips (keymap rows) */
  keys?: readonly (readonly string[])[];
  /** status glyph before the cells (messages) */
  glyph?: "ok" | "warn" | "error" | "done";
  /** what `/` matches; default: cells and value */
  search?: string;
  /** full text for the tooltip when the row truncates */
  title?: string;
  /** Enter (nav.open); `newPane` comes from the `+` prefix */
  open?: (newPane: "right" | "down" | null) => void;
  /** Enter / Space in settings */
  change?: () => void;
  /** Left / Right in settings */
  cycle?: (dir: 1 | -1) => void;
  /** keymap rows: the action whose bindings the row edits */
  actionId?: string;
  /** settings: how the pointer changes the value. toggle = one button, choice = previous / value / next */
  control?: "toggle" | "choice";
  /** keymap rows: the keys differ from the default (reset has something to do) */
  edited?: boolean;
}

export type ListRow = GroupRow | ItemRow;

const searchText = (r: ItemRow): string => (r.search ?? `${r.cells.join(" ")} ${r.value ?? ""}`).toLowerCase();

/** Items that contain every word of `text` (case-insensitive); a group stays while it has items. */
export function filterRows(rows: readonly ListRow[], text: string): readonly ListRow[] {
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return rows;
  const out: ListRow[] = [];
  let group: GroupRow | null = null;
  for (const r of rows) {
    if (r.type === "group") {
      group = r;
      continue;
    }
    const hay = searchText(r);
    if (!terms.every((t) => hay.includes(t))) continue;
    if (group) {
      out.push(group);
      group = null;
    }
    out.push(r);
  }
  return out;
}

export const countItems = (rows: readonly ListRow[]): number => {
  let n = 0;
  for (const r of rows) if (r.type === "item") n++;
  return n;
};

/** Index of the first item at or after `from` (dir 1) or at or before it (dir -1); -1 when none. */
export function nearestItem(rows: readonly ListRow[], from: number, dir: 1 | -1): number {
  for (let i = from; i >= 0 && i < rows.length; i += dir) if (rows[i].type === "item") return i;
  return -1;
}

/** The item `delta` items away from `from`, clamped to the first and last item. */
export function moveCursor(rows: readonly ListRow[], from: number, delta: number): number {
  if (rows.length === 0) return -1;
  const dir = delta < 0 ? -1 : 1;
  let at = from < 0 ? nearestItem(rows, 0, 1) : from;
  if (at < 0) return -1;
  for (let left = from < 0 ? Math.abs(delta) - 1 : Math.abs(delta); left > 0; left--) {
    const next = nearestItem(rows, at + dir, dir);
    if (next < 0) break;
    at = next;
  }
  return at;
}

/** Where the cursor is: the row with `key`, else the first item. */
export function cursorIndex(rows: readonly ListRow[], key: string | null): number {
  if (key !== null) {
    const i = rows.findIndex((r) => r.type === "item" && r.key === key);
    if (i >= 0) return i;
  }
  return nearestItem(rows, 0, 1);
}
