// Cell "heat" (status colour on the cells that explain a fault, docs/ux.md §9.5): READY when the
// row is failing and not every container is ready, RESTARTS when the count is high or the last
// restart was recent, and the faint row tint of failing rows. Pure.
import { isFault, leadingInt, parseRatio, type Status } from "./status";

export type Heat = "warn" | "error";

/** restarts at or above this count are warm */
export const RESTARTS_HOT = 5;
/** a restart this recent (seconds) is warm, whatever the count */
export const RECENT_RESTART_SEC = 600;

const UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** `5 (2m ago)` / `3 (75s ago)` / `1 (2d3h ago)` -> seconds since the last restart, or null. */
export function lastRestartSec(text: string): number | null {
  const m = /\((\d+)([smhd])(?:\d+[smh])?\s+ago\)/.exec(text);
  return m ? Number(m[1]) * UNIT[m[2]] : null;
}

/** The heat of one cell. `column` is the column id (lowercased server name). */
export function cellHeat(column: string, text: string, status: Status | null): Heat | undefined {
  if (column === "ready") {
    if (!isFault(status)) return undefined;
    const r = parseRatio(text);
    return r && r[0] < r[1] ? (status!.state === "error" ? "error" : "warn") : undefined;
  }
  if (column === "restarts") {
    const n = leadingInt(text) ?? 0;
    if (n <= 0) return undefined;
    const ago = lastRestartSec(text);
    if (n >= RESTARTS_HOT * 4 && ago !== null && ago < RECENT_RESTART_SEC) return "error";
    if (n >= RESTARTS_HOT || (ago !== null && ago < RECENT_RESTART_SEC)) return "warn";
  }
  return undefined;
}

/** The row tint: failing rows only (warn / error), never muted ones. */
export function rowTint(status: Status | null, muted: boolean): Heat | undefined {
  if (muted || !isFault(status)) return undefined;
  return status!.state === "error" ? "error" : "warn";
}
