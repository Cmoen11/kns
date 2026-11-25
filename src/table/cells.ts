// Cell text access. Rows keep their identity while unchanged (store/tables), so the per-row string
// conversion is cached on the row object and costs nothing on frames where the row did not change.
import { observeMetrics, samplesOf, sparkPeak, sparkText } from "../diag/spark";
import type { Json, PodMetric, Row } from "../ipc/types";
import { ageSeconds, formatAge } from "./age";
import type { ColSpec } from "./columns";
import type { SortKey } from "./sort";
import { sortKey } from "./sort";
import type { Status } from "./status";

export function cellText(c: Json | undefined): string {
  if (c === null || c === undefined) return "";
  if (typeof c === "string") return c;
  if (typeof c === "number" || typeof c === "boolean") return String(c);
  try {
    return JSON.stringify(c);
  } catch {
    return "";
  }
}

const texts = new WeakMap<Row, string[]>();
/** The row's cells as strings (cached per row object). */
export function textsOf(row: Row): string[] {
  let t = texts.get(row);
  if (!t) {
    t = row.cells.map(cellText);
    texts.set(row, t);
  }
  return t;
}

const searchable = new WeakMap<Row, string[]>();
/** What a filter matches against: every cell plus the namespace. */
export function searchTexts(row: Row): string[] {
  let t = searchable.get(row);
  if (!t) {
    t = row.namespace ? [...textsOf(row), row.namespace] : textsOf(row);
    searchable.set(row, t);
  }
  return t;
}

export const metricKey = (namespace: string | undefined, name: string): string => `${namespace ?? ""}/${name}`;
export const formatCpu = (milli: number): string => `${Math.round(milli)}m`;
export const formatMem = (bytes: number): string => `${Math.round(bytes / 1048576)}Mi`;

/**
 * A name without its namespace prefix (`companyadmin-api` in `companyadmin` → `api`). A name that
 * is only the prefix, or the namespace itself, stays whole.
 */
export function stripNamespace(name: string, namespace: string | undefined): string {
  if (!namespace) return name;
  const prefix = `${namespace}-`;
  return name.length > prefix.length && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

export interface CellContext {
  nowMs: number;
  /** the name column shows names without their namespace prefix (setting) */
  stripNs?: boolean;
  metrics: ReadonlyMap<string, PodMetric> | null;
  statusOf: (row: Row) => Status | null;
}

/** The text a column shows for a row. */
export function columnText(row: Row, spec: ColSpec, ctx: CellContext): string {
  const s = spec.source;
  switch (s.by) {
    case "cell": {
      const text = s.index < 0 ? row.name : (textsOf(row)[s.index] ?? "");
      return ctx.stripNs && spec.role === "name" ? stripNamespace(text, row.namespace) : text;
    }
    case "namespace":
      return row.namespace ?? "";
    case "age": {
      const sec = ageSeconds(row.created, ctx.nowMs);
      return sec === null ? (textsOf(row)[spec.index] ?? "") : formatAge(sec);
    }
    case "status":
      return ctx.statusOf(row)?.word ?? (textsOf(row)[spec.index] ?? "");
    case "cpu": {
      const m = ctx.metrics?.get(metricKey(row.namespace, row.name));
      return m ? formatCpu(m.cpuMilli) : "";
    }
    case "mem": {
      const m = ctx.metrics?.get(metricKey(row.namespace, row.name));
      return m ? formatMem(m.memBytes) : "";
    }
    case "spark": {
      // C2: memory of the last 5 minutes; the samples ride on the metrics poll
      if (!ctx.metrics) return "";
      observeMetrics(ctx.metrics);
      return sparkText(samplesOf(metricKey(row.namespace, row.name), ctx.metrics), Math.max(ctx.nowMs, Date.now()));
    }
  }
}

/** The value a column sorts a row by. */
export function columnSortKey(row: Row, spec: ColSpec, ctx: CellContext): SortKey {
  const s = spec.source;
  if (s.by === "age") {
    const sec = ageSeconds(row.created, ctx.nowMs);
    if (sec !== null) return sec;
  }
  if (s.by === "cpu") return ctx.metrics?.get(metricKey(row.namespace, row.name))?.cpuMilli ?? null;
  if (s.by === "mem") return ctx.metrics?.get(metricKey(row.namespace, row.name))?.memBytes ?? null;
  if (s.by === "spark") return sparkPeak(samplesOf(metricKey(row.namespace, row.name), ctx.metrics), ctx.nowMs);
  return sortKey(columnText(row, spec, ctx), spec.sort);
}
