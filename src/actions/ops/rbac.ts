// A small cache over backend.canI for RBAC-aware disabling (docs/ux.md §14, research.md §5.11).
// Advisory only: an unknown answer counts as allowed and every write still handles a 403.
// Pure factory; the app instance lives in access.ts.

export interface AccessKey {
  context: string;
  verb: string;
  group: string;
  resource: string;
  version: string;
  subresource?: string;
  namespace?: string;
}

export interface AccessCache {
  /** true / false when known and fresh; undefined when unknown (a lookup is started once). */
  check(key: AccessKey): boolean | undefined;
  /** Drops everything (context switch, reconnect). */
  clear(): void;
  size(): number;
}

export interface AccessCacheOptions {
  canI: (key: AccessKey) => Promise<boolean>;
  /** called when an answer arrived that differs from what check() returned before */
  onChange: () => void;
  now?: () => number;
  ttlMs?: number;
  max?: number;
}

export const ACCESS_TTL_MS = 60_000;

export const accessKeyText = (k: AccessKey): string =>
  `${k.context}|${k.verb}|${k.group}/${k.resource}${k.subresource ? `/${k.subresource}` : ""}|${k.namespace ?? ""}`;

export function createAccessCache(opts: AccessCacheOptions): AccessCache {
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlMs ?? ACCESS_TTL_MS;
  const max = opts.max ?? 500;
  const known = new Map<string, { allowed: boolean; at: number }>();
  const pending = new Set<string>();
  let generation = 0;

  function lookup(id: string, key: AccessKey): void {
    if (pending.has(id)) return;
    pending.add(id);
    const gen = generation;
    opts.canI(key).then(
      (allowed) => {
        pending.delete(id);
        if (gen !== generation) return;
        const prev = known.get(id);
        if (known.size >= max && !prev) known.clear();
        known.set(id, { allowed, at: now() });
        // unknown counted as allowed, so only a change to or from "denied" is news
        if ((prev?.allowed ?? true) !== allowed) opts.onChange();
      },
      () => {
        // the review itself failed (offline, forbidden): stay advisory, retry on a later check
        pending.delete(id);
      },
    );
  }

  return {
    check(key) {
      const id = accessKeyText(key);
      const hit = known.get(id);
      if (hit && now() - hit.at < ttl) return hit.allowed;
      lookup(id, key);
      // a stale answer is still the best guess while the refresh runs
      return hit?.allowed;
    },
    clear() {
      generation++;
      known.clear();
      pending.clear();
    },
    size: () => known.size,
  };
}
