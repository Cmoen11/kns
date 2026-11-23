// Sort keys and comparison for table cells (docs/ux.md §12.4). Pure.
import { parseAge } from "./age";

export type SortKind = "text" | "num" | "duration" | "ratio";
export type SortKey = number | string | null;

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const QUANTITY: Record<string, number> = {
  m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
};

/** `250m`, `64Mi`, `5 (2m ago)`, `12%`, `3` -> number; null when the text does not start with a number. */
export function parseNumber(text: string): number | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|[mkMGT])?(?![A-Za-z])/.exec(text);
  if (!m) return null;
  return Number(m[1]) * (m[2] ? QUANTITY[m[2]] : 1);
}

/** The value a cell sorts by. null sorts last in both directions. */
export function sortKey(text: string, kind: SortKind): SortKey {
  const t = text.trim();
  if (t === "" || t === "<none>" || t === "<unknown>") return null;
  switch (kind) {
    case "num":
      return parseNumber(t) ?? t;
    case "duration":
      return parseAge(t) ?? t;
    case "ratio": {
      const m = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
      // not ready first when ascending: by fraction, then by size
      return m ? (Number(m[2]) === 0 ? 0 : Number(m[1]) / Number(m[2])) + Number(m[2]) * 1e-6 : t;
    }
    default:
      return t;
  }
}

/** Numbers before strings, null last. */
export function compareKeys(a: SortKey, b: SortKey): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number") return typeof b === "number" ? a - b : -1;
  if (typeof b === "number") return 1;
  return collator.compare(a, b);
}

export interface Sortable {
  /** primary key (the sorted column) */
  key: SortKey;
  namespace: string;
  name: string;
}

/**
 * Comparator for one sort: the column key (reversed with `desc`, nulls always last), then
 * namespace and name ascending, so the order is total and stable.
 */
export function comparator(desc: boolean): (a: Sortable, b: Sortable) => number {
  return (a, b) => {
    if (a.key !== b.key) {
      if (a.key === null) return 1;
      if (b.key === null) return -1;
      const c = compareKeys(a.key, b.key);
      if (c !== 0) return desc ? -c : c;
    }
    return collator.compare(a.namespace, b.namespace) || collator.compare(a.name, b.name);
  };
}

/** The kind default (§12.4): NAME, with NAMESPACE first in all namespaces. */
export function defaultComparator(a: Sortable, b: Sortable): number {
  return collator.compare(a.namespace, b.namespace) || collator.compare(a.name, b.name);
}
