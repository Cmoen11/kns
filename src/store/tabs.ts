// Context tabs (docs/ux.md §8.2), the pure part. A tab is a kube context the window keeps open:
// its workspace stays warm (connection, table watches, shells) while another tab is on screen.
// The window's context is always one of the tabs. Closing a tab keeps its saved workspace, so
// opening it again lands where you were; only the warm state ends.

/** Open tabs at most: the one on screen plus five warm ones (memory and API-server load). */
export const MAX_TABS = 6;

/** `tabs` with `context` in it: unchanged when it is open, else inserted right after `after`. */
export function withTab(tabs: readonly string[], context: string, after?: string | null): string[] {
  if (tabs.includes(context)) return [...tabs];
  const at = after ? tabs.indexOf(after) : -1;
  if (at < 0) return [...tabs, context];
  return [...tabs.slice(0, at + 1), context, ...tabs.slice(at + 1)];
}

export const withoutTab = (tabs: readonly string[], context: string): string[] => tabs.filter((t) => t !== context);

/** The tab `delta` steps from `current` in strip order, wrapping (Ctrl+Tab, Ctrl+Shift+Tab). */
export function stepTab(tabs: readonly string[], current: string | null, delta: number): string | null {
  if (tabs.length === 0) return null;
  const at = current ? tabs.indexOf(current) : -1;
  if (at < 0) return tabs[0];
  return tabs[(((at + delta) % tabs.length) + tabs.length) % tabs.length];
}

/**
 * The tab to show when `closing` (the one on screen) closes: the most recently used other tab,
 * else its right neighbour, else its left one. Null when it is the last tab.
 */
export function afterClose(tabs: readonly string[], closing: string, mru: readonly string[]): string | null {
  const rest = withoutTab(tabs, closing);
  if (rest.length === 0) return null;
  for (const m of mru) if (m !== closing && rest.includes(m)) return m;
  const at = tabs.indexOf(closing);
  return tabs[at + 1] ?? tabs[at - 1] ?? rest[0];
}

/**
 * The tab that makes room when one more opens and `max` are open: the least recently used one
 * that is not on screen, preferring tabs whose live sessions would not end. Null when there is room.
 */
export function tabToEvict(
  tabs: readonly string[],
  current: string | null,
  mru: readonly string[],
  hasLive: (context: string) => boolean,
  max = MAX_TABS,
): string | null {
  if (tabs.length < max) return null;
  const rank = (t: string) => {
    const i = mru.indexOf(t);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const candidates = tabs.filter((t) => t !== current).sort((a, b) => rank(b) - rank(a));
  return candidates.find((t) => !hasLive(t)) ?? candidates[0] ?? null;
}

/** Moves `context` to the front of the most-recently-used list. */
export const touch = (mru: readonly string[], context: string): string[] => [context, ...mru.filter((m) => m !== context)];

/** Tabs as restored: only contexts with a saved workspace, without repeats, and always `current`. */
export function sanitizeTabs(raw: unknown, current: string | null, has: (context: string) => boolean): string[] {
  const out: string[] = [];
  if (Array.isArray(raw)) for (const t of raw) if (typeof t === "string" && has(t) && !out.includes(t)) out.push(t);
  const kept = out.slice(0, MAX_TABS);
  if (current && !kept.includes(current)) kept.splice(Math.min(kept.length, MAX_TABS - 1), 1, current);
  return kept;
}
