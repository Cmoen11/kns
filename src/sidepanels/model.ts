// The row model both side panels share, and the pure cursor moves on it. A panel is one flat list:
// a header row per section, then that section's rows unless it is collapsed.
import type { GlyphState } from "../ui";

export type Side = "left" | "right";

export interface PanelRow {
  /** stable across re-renders: the cursor follows the key, not the index */
  key: string;
  section: string;
  /** a section header: Enter folds it */
  header?: boolean;
  /** headers: the section is folded */
  collapsed?: boolean;
  /** headers: the number after the title */
  count?: number;

  // ── what the row shows (all text is untrusted and rendered as text) ──
  label: string;
  /** second line, muted */
  detail?: string;
  /** right-aligned muted text on the first line (slot, state word) */
  trailing?: string;
  /** a timestamp: the trailing text is its age (12s, 4m), ticking by itself without a new row list */
  since?: number;
  glyph?: GlyphState;
  /** the current context / namespace: gutter square */
  current?: boolean;
  /** Etikett labels: PROTECTED, READ ONLY */
  labels?: readonly string[];
  /** shown muted; activating says why */
  disabled?: string;
  /** a failed / warning entry (Recent): stays marked in its status hue, the detail line too */
  tone?: "error" | "warn";
  /** context sidebar: the namespace whose health badge the row shows (`*` = the total) */
  health?: string;
  /** headers: a tooltip on the trailing text (cleaned text) */
  trailingTip?: string;

  /** context sidebar: signs in for this context (`aws sso login`); the row shows a button */
  login?: { run: () => unknown; busy: boolean; hint: string };

  // ── what the keys do on it ──
  /** Enter / click */
  activate?: () => unknown;
  /** focus stays in the panel after activate (nothing to jump to) */
  stay?: boolean;
  /** x / Delete */
  stop?: () => unknown;
  /** c */
  copy?: () => unknown;
  /** o */
  open?: () => unknown;
  /** headers: X stops everything in the section */
  stopAll?: () => unknown;
  /** headers: the section can be emptied (Finished: C); shows the clear button */
  clearable?: boolean;
  /** headers of feature groups (groups.ts): what C / the clear button runs; absent = the Finished history */
  clear?: () => unknown;
}

export const headerKey = (section: string): string => `h:${section}`;

export interface Cursor {
  key: string;
  /** where the row was, used when the key is gone (a stopped forward) */
  index: number;
}

/** Index of the cursor row: by key, else the old index clamped, else the first row. -1 when empty. */
export function cursorIndex(rows: readonly PanelRow[], cursor: Cursor | null): number {
  if (rows.length === 0) return -1;
  if (!cursor) return 0;
  const i = rows.findIndex((r) => r.key === cursor.key);
  return i >= 0 ? i : Math.min(Math.max(0, cursor.index), rows.length - 1);
}

export function moveBy(rows: readonly PanelRow[], cursor: Cursor | null, delta: number): number {
  const i = cursorIndex(rows, cursor);
  return i < 0 ? -1 : Math.min(rows.length - 1, Math.max(0, i + delta));
}

/**
 * Tab / Shift+Tab: the next section header, or going back first the header of the cursor's own
 * section and then the one before. Stays put at the ends.
 */
export function jumpSection(rows: readonly PanelRow[], cursor: Cursor | null, dir: 1 | -1): number {
  const i = cursorIndex(rows, cursor);
  if (i < 0) return -1;
  for (let j = i + dir; j >= 0 && j < rows.length; j += dir) if (rows[j].header) return j;
  return i;
}

/** Case-insensitive substring match on any of the texts; an empty query matches everything. */
export function matches(query: string, ...texts: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return texts.some((t) => t !== undefined && t.toLowerCase().includes(q));
}

export const MIN_WIDTH = 180;
export const MAX_WIDTH = 480;
export const WIDTH_STEP = 16;
export const DEFAULT_WIDTH: Record<Side, number> = { left: 240, right: 260 };
/** below this window width the panels overlay the panes and hide when focus leaves them */
export const NARROW_PX = 900;

export const clampWidth = (w: number, side: Side): number =>
  Number.isFinite(w) ? Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w))) : DEFAULT_WIDTH[side];

export interface PanelPrefs {
  open: boolean;
  width: number;
  /** section id -> folded */
  collapsed: Record<string, boolean>;
}
export type SidePrefs = Record<Side, PanelPrefs>;

export const defaultPrefs = (): SidePrefs => ({
  left: { open: false, width: DEFAULT_WIDTH.left, collapsed: {} },
  right: { open: false, width: DEFAULT_WIDTH.right, collapsed: {} },
});

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates persisted prefs field by field; anything unusable falls back to the default. */
export function sanitizePrefs(data: unknown): SidePrefs {
  const out = defaultPrefs();
  if (!isObj(data)) return out;
  for (const side of ["left", "right"] as const) {
    const p = data[side];
    if (!isObj(p)) continue;
    if (typeof p.open === "boolean") out[side].open = p.open;
    if (typeof p.width === "number") out[side].width = clampWidth(p.width, side);
    if (isObj(p.collapsed)) {
      const collapsed: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(p.collapsed).slice(0, 32)) if (typeof v === "boolean") collapsed[k] = v;
      out[side].collapsed = { ...out[side].collapsed, ...collapsed };
    }
  }
  return out;
}

/** Compact duration: 12s, 4m, 3h, 2d. */
export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
