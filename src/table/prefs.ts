// Per-kind column preferences (docs/ux.md §12.2 overrides, §12.4 sort memory): order, hidden,
// pinned, widths and the last user sort, keyed by GVR. Owns the persisted `columns` file.
import { useStore } from "zustand";
import { PERSIST_KEYS, persistedStore, type PersistedSlice } from "../store/persist";
import type { ColumnPrefs, Sort } from "../types";

type State = PersistedSlice<"columns">;

const MAX_KINDS = 500;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 200) : []);

export const EMPTY_PREFS: ColumnPrefs = Object.freeze({ order: [], hidden: [], pinned: [], widths: {} }) as ColumnPrefs;

export function sanitizeSort(v: unknown): Sort | undefined {
  return isObj(v) && typeof v.column === "string" && v.column !== "" && typeof v.desc === "boolean" ? { column: v.column, desc: v.desc } : undefined;
}

export function sanitizePrefs(raw: unknown): ColumnPrefs | null {
  if (!isObj(raw)) return null;
  const widths: Record<string, number> = {};
  if (isObj(raw.widths)) {
    for (const [k, w] of Object.entries(raw.widths)) {
      if (typeof w === "number" && Number.isFinite(w) && w >= 24 && w <= 2000) widths[k] = Math.round(w);
    }
  }
  const out: ColumnPrefs = { order: strings(raw.order), hidden: strings(raw.hidden), pinned: strings(raw.pinned), widths };
  const sort = sanitizeSort(raw.sort);
  if (sort) out.sort = sort;
  return out;
}

export function sanitizeColumns(data: unknown): State {
  const columns: Record<string, ColumnPrefs> = {};
  const src = isObj(data) && isObj(data.columns) ? data.columns : {};
  let n = 0;
  for (const [key, raw] of Object.entries(src)) {
    const p = sanitizePrefs(raw);
    if (p && n++ < MAX_KINDS) columns[key] = p;
  }
  return { columns };
}

export const columnsStore = persistedStore<State>({
  key: PERSIST_KEYS.columns,
  version: 1,
  defaults: () => ({ columns: {} }),
  sanitize: sanitizeColumns,
});

export const getPrefs = (key: string): ColumnPrefs => columnsStore.getState().columns[key] ?? EMPTY_PREFS;
export const usePrefs = (key: string): ColumnPrefs => useStore(columnsStore, (s) => s.columns[key] ?? EMPTY_PREFS);

export function updatePrefs(key: string, fn: (p: ColumnPrefs) => ColumnPrefs): void {
  columnsStore.setState((s) => {
    const cur = s.columns[key] ?? EMPTY_PREFS;
    const next = fn(cur);
    return next === cur ? s : { columns: { ...s.columns, [key]: next } };
  });
}

/** `columns.reset`: back to the kind defaults; the sort memory stays. */
export function resetPrefs(key: string): void {
  columnsStore.setState((s) => {
    const cur = s.columns[key];
    if (!cur) return s;
    const columns = { ...s.columns };
    if (cur.sort) columns[key] = { ...EMPTY_PREFS, sort: cur.sort };
    else delete columns[key];
    return { columns };
  });
}
