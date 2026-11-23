// Bulk runner for writes on marked rows (docs/ux.md §14, research.md §5.9): bounded concurrency,
// one result per item, never throws. Pure: no imports from the app.

export interface ItemResult<T, R> {
  item: T;
  ok: boolean;
  value?: R;
  error?: unknown;
}

export const BULK_CONCURRENCY = 6;

/** Runs `fn` over `items`, at most `concurrency` at a time. Results keep the order of `items`. */
export async function runBulk<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency = BULK_CONCURRENCY,
): Promise<ItemResult<T, R>[]> {
  const results = new Array<ItemResult<T, R>>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      const item = items[i];
      try {
        results[i] = { item, ok: true, value: await fn(item, i) };
      } catch (error) {
        results[i] = { item, ok: false, error };
      }
    }
  }
  const n = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

/** Text of a BackendError-like rejection. A 403 always reads "Forbidden: ...". */
export function errorText(e: unknown): string {
  const b = (typeof e === "object" && e !== null ? e : {}) as { code?: unknown; reason?: unknown; message?: unknown };
  const message = typeof b.message === "string" && b.message !== "" ? b.message : typeof e === "string" ? e : String(e);
  if (b.code === 403 || b.reason === "Forbidden") return /^forbidden/i.test(message) ? message : `Forbidden: ${message}`;
  if (b.code === 404 || b.reason === "NotFound") return /not found/i.test(message) ? message : `Not found: ${message}`;
  return message;
}

export interface Summary {
  kind: "ok" | "error";
  text: string;
  done: number;
  failed: number;
}

const MAX_FAILURE_LINES = 6;

/**
 * One message for a finished operation. `done` is the past-tense verb ("Deleted"), `noun` the
 * kind in lowercase ("pod"). With one item the name is used; failures are listed per item.
 */
export function summarize<T>(
  done: string,
  noun: string,
  results: readonly ItemResult<T, unknown>[],
  nameOf: (item: T) => string,
  detail?: string,
): Summary {
  const failed = results.filter((r) => !r.ok);
  const okCount = results.length - failed.length;
  const tail = detail ? ` ${detail}` : "";
  if (failed.length === 0) {
    const text = results.length === 1 ? `${done} ${noun} ${nameOf(results[0].item)}${tail}` : `${done} ${okCount} ${plural(noun)}${tail}`;
    return { kind: "ok", text, done: okCount, failed: 0 };
  }
  if (results.length === 1) {
    return { kind: "error", text: `${noun} ${nameOf(failed[0].item)}: ${errorText(failed[0].error)}`, done: 0, failed: 1 };
  }
  const lines = failed.slice(0, MAX_FAILURE_LINES).map((r) => `${nameOf(r.item)}: ${errorText(r.error)}`);
  if (failed.length > MAX_FAILURE_LINES) lines.push(`and ${failed.length - MAX_FAILURE_LINES} more`);
  return {
    kind: "error",
    text: `${done} ${okCount} of ${results.length} ${plural(noun)}${tail}; ${failed.length} failed: ${lines.join("; ")}`,
    done: okCount,
    failed: failed.length,
  };
}

export function plural(noun: string): string {
  if (/(s|x|ch|sh)$/.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}
