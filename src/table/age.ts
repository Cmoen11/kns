// kubectl-style durations (docs/ux.md §12.3): `45s`, `5m30s`, `3h12m`, `2d4h`, `1y30d`.
// Pure; mirrors k8s.io/apimachinery duration.HumanDuration.

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
const YEAR = 365 * DAY;

/** Formats a non-negative number of seconds the way kubectl prints AGE. */
export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const s = Math.max(0, Math.floor(seconds));
  if (s < 2 * MIN) return `${s}s`;
  const m = Math.floor(s / MIN);
  if (m < 10) {
    const rest = s % MIN;
    return rest === 0 ? `${m}m` : `${m}m${rest}s`;
  }
  if (m < 3 * 60) return `${m}m`;
  const h = Math.floor(s / HOUR);
  if (h < 8) {
    const rest = m % 60;
    return rest === 0 ? `${h}h` : `${h}h${rest}m`;
  }
  if (h < 48) return `${h}h`;
  const d = Math.floor(s / DAY);
  if (h < 8 * 24) {
    const rest = h % 24;
    return rest === 0 ? `${d}d` : `${d}d${rest}h`;
  }
  if (h < 2 * 365 * 24) return `${d}d`;
  const y = Math.floor(s / YEAR);
  if (h < 8 * 365 * 24) {
    const rest = d % 365;
    return rest === 0 ? `${y}y` : `${y}y${rest}d`;
  }
  return `${y}y`;
}

/** Seconds since an RFC3339 timestamp, or null when it is missing or unreadable. */
export function ageSeconds(created: string | undefined, nowMs: number): number | null {
  if (!created) return null;
  const t = Date.parse(created);
  return Number.isNaN(t) ? null : Math.max(0, (nowMs - t) / 1000);
}

const UNIT: Record<string, number> = { s: 1, m: MIN, h: HOUR, d: DAY, y: YEAR, ms: 0.001 };

/** Parses `2d4h`, `45s`, `5m30s` back to seconds (for sorting duration cells). null = not a duration. */
export function parseAge(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  let total = 0;
  let pos = 0;
  const re = /(\d+(?:\.\d+)?)(ms|[smhdy])/gy;
  for (;;) {
    re.lastIndex = pos;
    const m = re.exec(t);
    if (!m) break;
    total += Number(m[1]) * UNIT[m[2]];
    pos = re.lastIndex;
  }
  return pos === t.length && pos > 0 ? total : null;
}

/**
 * How often ages must be recomputed so no visible value is stale: every second while a row shows
 * seconds (younger than 10 minutes), else every 30s.
 */
export function tickPeriodMs(youngestSeconds: number | null): number {
  return youngestSeconds !== null && youngestSeconds < 10 * MIN ? 1000 : 30000;
}
