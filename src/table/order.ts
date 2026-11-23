// Row order while a table is live (docs/ux.md §12.3): "the cursor row never moves on screen
// because of data". Existing rows keep their place when values change; rows that left are dropped;
// new rows go to their sort position only where that cannot push the cursor row (below it, or off
// screen), else they are appended and counted as UNSORTED. Pure.

export interface OrderState {
  /** uids in display order */
  readonly order: readonly string[];
  /** how many trailing entries were appended out of sort position */
  readonly unsorted: number;
}

export const EMPTY_ORDER: OrderState = { order: [], unsorted: 0 };

/** A full sort: user sort, refresh, first sync, filter change. */
export function sortAll(uids: readonly string[], cmp: (a: string, b: string) => number): OrderState {
  return { order: [...uids].sort(cmp), unsorted: 0 };
}

export interface ReconcileInput {
  prev: OrderState;
  /** every uid that should be shown now, in source order */
  visible: readonly string[];
  cmp: (a: string, b: string) => number;
  cursor: string | null;
  /** first and last row index on screen (in prev.order); null = unknown, treat all as on screen */
  window: { first: number; last: number } | null;
}

/** First index in the (roughly sorted) list whose item sorts after `uid`. */
function insertionIndex(list: readonly string[], uid: string, cmp: (a: string, b: string) => number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmp(list[mid], uid) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Applies one data frame to the order. Returns `prev` itself when nothing changed. */
export function reconcile({ prev, visible, cmp, cursor, window }: ReconcileInput): OrderState {
  const want = new Set(visible);
  const have = new Set(prev.order);
  let removed = false;
  const boundary = prev.order.length - prev.unsorted;
  const sorted: string[] = [];
  const appended: string[] = [];
  let first = window?.first ?? 0;
  let last = window?.last ?? Number.POSITIVE_INFINITY;
  for (let i = 0; i < prev.order.length; i++) {
    const uid = prev.order[i];
    if (!want.has(uid)) {
      removed = true;
      // the screen window follows the rows that stay (scroll anchoring)
      if (window && i < boundary) {
        if (i < window.first) first--;
        if (i <= window.last) last--;
      }
      continue;
    }
    (i < boundary ? sorted : appended).push(uid);
  }
  const fresh: string[] = [];
  for (const uid of visible) if (!have.has(uid)) fresh.push(uid);
  if (!removed && fresh.length === 0) return prev;

  let cursorIdx = cursor === null ? -1 : sorted.indexOf(cursor);
  for (const uid of fresh) {
    const pos = insertionIndex(sorted, uid, cmp);
    const below = pos > cursorIdx;
    const offScreen = window !== null && (pos < first || pos > last + 1);
    if (cursorIdx < 0 || below || offScreen) {
      sorted.splice(pos, 0, uid);
      if (pos <= cursorIdx) cursorIdx++;
      if (pos < first) {
        first++;
        last++;
      } else if (pos <= last) last++;
    } else appended.push(uid);
  }
  return { order: appended.length > 0 ? [...sorted, ...appended] : sorted, unsorted: appended.length };
}

/**
 * Where the cursor goes when its row is gone: the row that took its index (§12.3), clamped.
 * Returns the uid, or null for an empty table.
 */
export function cursorAfterRemoval(order: readonly string[], previousIndex: number): string | null {
  if (order.length === 0) return null;
  return order[Math.max(0, Math.min(previousIndex, order.length - 1))];
}
