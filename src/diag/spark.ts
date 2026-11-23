// Sparklines for the wide pods view (docs/plan-features.md §3 C2, D8). The samples live in Rust
// (history.rs, fed by the podMetrics poll); the pods table already polls podMetrics every 15 s
// while it shows metrics, so this module seeds each pod's series once from
// `podMetricsHistory` (survives a reload) and then appends the sample of every new metrics map
// the table renders with. No timer of its own: nothing runs while no pods table polls.
//
// The cell is text: one block character per 15 s slot (▁▂▃▄▅▆▇█) of memory, scaled to the pod's
// own peak in the window, with `·` for a slot without a sample (polling stopped, metrics-server
// hiccup): the gap marker.
import type { PodMetric, PodSample, PodSeries } from "../ipc/types";

export const SLOT_MS = 15_000;
/** Slots shown (5 minutes). */
export const SLOTS = 20;
const KEEP = 240;
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
export const GAP = "·";

/**
 * The text of a series ending at `nowMs`: `SLOTS` slots, oldest left. Slots before the first
 * sample are blank (padding), empty slots after it are gaps. Pure.
 */
export function sparkText(samples: readonly PodSample[], nowMs: number, slots = SLOTS, pick: (s: PodSample) => number = (s) => s.memBytes): string {
  // one token per sample, plus a gap token per missed slot: polls jitter, so a gap is a distance
  // of more than 1.5 slots between samples (or since the last one), not an empty time bucket
  const recent = samples.filter((s) => s.at > nowMs - (slots + 1) * SLOT_MS && s.at <= nowMs + SLOT_MS);
  if (recent.length === 0) return "";
  const tokens: (number | null)[] = [];
  const gaps = (dt: number) => (dt > 1.5 * SLOT_MS ? Math.min(slots, Math.round(dt / SLOT_MS) - 1) : 0);
  let prev: number | null = null;
  for (const s of recent) {
    if (prev !== null) for (let g = gaps(s.at - prev); g > 0; g--) tokens.push(null);
    tokens.push(pick(s));
    prev = s.at;
  }
  if (prev !== null) for (let g = gaps(nowMs - prev); g > 0; g--) tokens.push(null);
  const shown = tokens.slice(-slots);
  const values = shown.filter((b): b is number => b !== null);
  if (values.length === 0) return GAP.repeat(shown.length).padStart(slots, " ");
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min;
  // a flat series sits low; otherwise min..max over the block heights
  const text = shown.map((b) => (b === null ? GAP : BLOCKS[span <= 0 ? 0 : Math.round(((b - min) / span) * (BLOCKS.length - 1))])).join("");
  return text.padStart(slots, " ");
}

/** Peak memory in the window, for sorting the column. */
export function sparkPeak(samples: readonly PodSample[], nowMs: number, slots = SLOTS): number | null {
  const start = nowMs - slots * SLOT_MS;
  let peak: number | null = null;
  for (const s of samples) if (s.at > start) peak = Math.max(peak ?? 0, s.memBytes);
  return peak;
}

/** Appends `sample` unless the last one is within 10 s (same rule as history.rs); keeps 240. */
export function appendSample(series: PodSample[], sample: PodSample): PodSample[] {
  const last = series[series.length - 1];
  if (last && sample.at - last.at < 10_000) return series;
  const next = [...series, sample];
  return next.length > KEEP ? next.slice(next.length - KEEP) : next;
}

/** Merges a seed from Rust under what was appended locally (by time, deduplicated). */
export function mergeSeed(local: readonly PodSample[], seed: readonly PodSample[]): PodSample[] {
  const byAt = new Map<number, PodSample>();
  for (const s of seed) byAt.set(s.at, s);
  for (const s of local) byAt.set(s.at, s);
  const out = [...byAt.values()].sort((a, b) => a.at - b.at);
  // the 10 s rule again, now across both sources
  const kept: PodSample[] = [];
  for (const s of out) {
    const last = kept[kept.length - 1];
    if (!last || s.at - last.at >= 10_000) kept.push(s);
  }
  return kept.length > KEEP ? kept.slice(kept.length - KEEP) : kept;
}

// ── the store (module state; the table re-renders on each metrics map anyway) ──

type MetricsMap = ReadonlyMap<string, PodMetric>;

const series = new Map<string, PodSample[]>();
const seen = new WeakSet<MetricsMap>();
const seeded = new Set<string>();
let loader: ((context: string) => Promise<PodSeries[]>) | null = null;
let contextOf: () => string | null = () => null;

/** Wired by register(): how to read Rust's history and the current context. */
export function configureSpark(load: (context: string) => Promise<PodSeries[]>, context: () => string | null): void {
  loader = load;
  contextOf = context;
}

const key = (context: string, metricKey: string) => `${context}\u0001${metricKey}`;

function seed(context: string): void {
  if (seeded.has(context) || !loader) return;
  seeded.add(context);
  loader(context).then(
    (list) => {
      for (const s of list) {
        const k = key(context, `${s.namespace}/${s.name}`);
        series.set(k, mergeSeed(series.get(k) ?? [], s.samples));
      }
    },
    () => seeded.delete(context),
  );
}

/** Records the samples of a metrics map the first time it is seen (one map per 15 s poll). */
export function observeMetrics(metrics: MetricsMap, nowMs = Date.now()): void {
  if (seen.has(metrics)) return;
  seen.add(metrics);
  const context = owner.get(metrics) ?? contextOf();
  if (!context) return;
  seed(context);
  for (const [mk, m] of metrics) {
    const k = key(context, mk);
    series.set(k, appendSample(series.get(k) ?? [], { at: nowMs, cpuMilli: m.cpuMilli, memBytes: m.memBytes }));
  }
}

/**
 * The context a metrics map was read from (a table pane in another context, §8.3); maps without
 * one belong to the current context.
 */
const owner = new WeakMap<object, string>();
export function tagMetrics(metrics: MetricsMap, context: string): void {
  owner.set(metrics, context);
}

/** The samples of one pod (`metricKey` = `namespace/name`) in the context of `metrics` (default: the current one). */
export function samplesOf(metricKey: string, metrics?: MetricsMap | null): readonly PodSample[] {
  const context = (metrics && owner.get(metrics)) ?? contextOf();
  return context ? (series.get(key(context, metricKey)) ?? NONE) : NONE;
}
const NONE: readonly PodSample[] = [];

/** Tests only. */
export function resetSpark(): void {
  series.clear();
  seeded.clear();
  loader = null;
  contextOf = () => null;
}
