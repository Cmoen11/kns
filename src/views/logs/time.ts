// Kubelet timestamps (RFC3339Nano) and their local-time display.

export interface Stamp {
  /** epoch milliseconds */
  ms: number;
  /** nanoseconds below the millisecond, 0..999999 */
  sub: number;
}

const RFC3339 = /^(\d{4})-(\d\d)-(\d\d)[Tt ](\d\d):(\d\d):(\d\d)(?:[.,](\d+))?(Z|z|[+-]\d\d:?\d\d)?$/;

/** Parses an RFC3339 timestamp with up to nanosecond precision; null when it is not one. */
export function parseStamp(ts: string): Stamp | null {
  const m = RFC3339.exec(ts);
  if (!m) return null;
  const frac = ((m[7] ?? "") + "000000000").slice(0, 9);
  let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +frac.slice(0, 3));
  const zone = m[8];
  if (zone && zone !== "Z" && zone !== "z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    ms -= sign * (+digits.slice(0, 2) * 60 + +digits.slice(2, 4)) * 60_000;
  }
  return Number.isNaN(ms) ? null : { ms, sub: +frac.slice(3) };
}

export const compareStamps = (a: Stamp, b: Stamp): number => (a.ms !== b.ms ? a.ms - b.ms : a.sub - b.sub);

const two = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const three = (n: number) => (n < 10 ? `00${n}` : n < 100 ? `0${n}` : `${n}`);

/** Minutes east of UTC for the machine's zone at that instant (follows DST). */
export const localOffset = (ms: number): number => -new Date(ms).getTimezoneOffset();

/**
 * `HH:MM:SS.mmm` (or `HH:MM:SS`) in local time. `offsetMinutes` is minutes east of UTC and
 * defaults to the machine's zone; tests pass it explicitly.
 */
export function formatClock(ms: number, opts: { offsetMinutes?: number; millis?: boolean } = {}): string {
  if (!Number.isFinite(ms)) return opts.millis === false ? "--:--:--" : "--:--:--.---";
  const offset = opts.offsetMinutes ?? localOffset(ms);
  const d = new Date(ms + offset * 60_000);
  const hms = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
  return opts.millis === false ? hms : `${hms}.${three(d.getUTCMilliseconds())}`;
}

/** width of the timestamp gutter in characters */
export const CLOCK_CHARS = 12;

/** `sinceSeconds` that covers everything after `lastMs`, with a second of overlap for the dedupe. */
export function sinceSecondsFrom(lastMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((nowMs - lastMs) / 1000) + 1);
}
