// The action log, the pure part (status-colors package): what one Recent entry is, how a record
// is cleaned and capped, and how the persisted log is validated. Text is untrusted (cluster errors,
// object names) and is cleaned here once, before it is stored or shown; never a secret value: the
// callers pass names and verbs, not payloads.
import type { Gvr } from "../types";
import { cleanUntrusted } from "../ui/untrusted";

export type LogState = "ok" | "info" | "warn" | "error";

/** Where Enter on an entry goes. Plain data: it survives a restart. */
export type LogTarget =
  /** the object's row in its table */
  | { kind: "object"; gvr: Gvr; namespace?: string; name: string }
  /** the object's logs */
  | { kind: "logs"; gvr: Gvr; namespace?: string; name: string }
  /** the forward's row in the port-forwards view (by id while it lives) */
  | { kind: "forward"; id: string }
  | { kind: "devset"; id: string }
  /** a namespace: the focused table switches to it */
  | { kind: "namespace"; namespace: string }
  /** a tool view without an object */
  | { kind: "view"; view: "portforwards" | "devsets" | "traps" | "agents" | "messages" };

export interface LogEntry {
  id: number;
  /** ms epoch */
  at: number;
  state: LogState;
  /** one line: "scaled deployment web 1 → 2", "forward svc/web :8080 failed" */
  text: string;
  /** the cleaned error of a failed action */
  error?: string;
  namespace?: string;
  /** a cluster write (the "Cluster writes" setting records only these) */
  write: boolean;
  target?: LogTarget;
}

export interface RecordInput {
  text: string;
  state?: LogState;
  error?: string;
  namespace?: string;
  write?: boolean;
  target?: LogTarget;
  /** default: the window's context */
  context?: string;
}

export type LogSetting = "all" | "writes" | "off";

/** entries kept per context */
export const LOG_CAP = 100;
/** contexts kept (least recently written go first) */
export const CONTEXT_CAP = 20;
export const TEXT_MAX = 200;
export const ERROR_MAX = 400;

export const shouldRecord = (setting: LogSetting, write: boolean): boolean => setting === "all" || (setting === "writes" && write);

const clean = (s: string | undefined, max: number): string | undefined => {
  if (s === undefined) return undefined;
  const c = cleanUntrusted(s, max).trim();
  return c === "" ? undefined : c;
};

/** A record as it is stored: cleaned, capped, defaults filled. */
export function toEntry(input: RecordInput, id: number, at: number): LogEntry {
  const e: LogEntry = { id, at, state: input.state ?? (input.error ? "error" : "ok"), text: clean(input.text, TEXT_MAX) ?? "", write: input.write ?? false };
  const error = clean(input.error, ERROR_MAX);
  if (error) e.error = error;
  const ns = clean(input.namespace, 253);
  if (ns) e.namespace = ns;
  if (input.target) e.target = input.target;
  return e;
}

/** Appends (oldest first) and drops the oldest beyond the cap. */
export function append(list: readonly LogEntry[], e: LogEntry, cap = LOG_CAP): LogEntry[] {
  const next = [...list, e];
  if (next.length > cap) next.splice(0, next.length - cap);
  return next;
}

export interface LogData {
  /** context -> entries, oldest first */
  byContext: Record<string, LogEntry[]>;
  /** context -> last write (ms), for the context cap */
  touched: Record<string, number>;
}

export const emptyLog = (): LogData => ({ byContext: {}, touched: {} });

/** Keeps the CONTEXT_CAP most recently written contexts. */
export function capContexts(d: LogData, cap = CONTEXT_CAP): LogData {
  const names = Object.keys(d.byContext);
  if (names.length <= cap) return d;
  const keep = new Set(names.sort((a, b) => (d.touched[b] ?? 0) - (d.touched[a] ?? 0)).slice(0, cap));
  const out = emptyLog();
  for (const n of keep) {
    out.byContext[n] = d.byContext[n];
    if (d.touched[n] !== undefined) out.touched[n] = d.touched[n];
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const STATES: readonly LogState[] = ["ok", "info", "warn", "error"];
const str = (v: unknown): v is string => typeof v === "string";

function sanitizeGvr(v: unknown): Gvr | null {
  if (!isObj(v) || !str(v.group) || !str(v.version) || !str(v.resource)) return null;
  return { group: v.group, version: v.version, resource: v.resource };
}

function sanitizeTarget(v: unknown): LogTarget | undefined {
  if (!isObj(v) || !str(v.kind)) return undefined;
  switch (v.kind) {
    case "object":
    case "logs": {
      const gvr = sanitizeGvr(v.gvr);
      if (!gvr || !str(v.name)) return undefined;
      return { kind: v.kind, gvr, name: v.name, ...(str(v.namespace) ? { namespace: v.namespace } : {}) };
    }
    case "forward":
    case "devset":
      return str(v.id) ? { kind: v.kind, id: v.id } : undefined;
    case "namespace":
      return str(v.namespace) ? { kind: "namespace", namespace: v.namespace } : undefined;
    case "view":
      return ["portforwards", "devsets", "traps", "agents", "messages"].includes(v.view as string) ? { kind: "view", view: v.view as "portforwards" } : undefined;
  }
  return undefined;
}

/** Validates the persisted log entry by entry; anything unusable is dropped, text is cleaned again. */
export function sanitizeLog(data: unknown): LogData {
  const out = emptyLog();
  if (!isObj(data) || !isObj(data.byContext)) return out;
  for (const [ctx, list] of Object.entries(data.byContext).slice(0, CONTEXT_CAP * 2)) {
    if (!Array.isArray(list)) continue;
    const entries: LogEntry[] = [];
    for (const raw of list.slice(-LOG_CAP)) {
      if (!isObj(raw) || typeof raw.id !== "number" || typeof raw.at !== "number" || !str(raw.text)) continue;
      const state = STATES.includes(raw.state as LogState) ? (raw.state as LogState) : "info";
      entries.push(
        toEntry(
          { text: raw.text, state, error: str(raw.error) ? raw.error : undefined, namespace: str(raw.namespace) ? raw.namespace : undefined, write: raw.write === true, target: sanitizeTarget(raw.target) },
          raw.id,
          raw.at,
        ),
      );
    }
    out.byContext[ctx] = entries;
    const t = isObj(data.touched) ? data.touched[ctx] : undefined;
    if (typeof t === "number") out.touched[ctx] = t;
  }
  return capContexts(out);
}

/** The highest id in the log (ids continue from it after a restart). */
export const maxId = (d: LogData): number => Object.values(d.byContext).reduce((m, l) => l.reduce((x, e) => Math.max(x, e.id), m), 0);

/** One line for the clipboard: text, error, namespace and time. */
export function entryLine(e: LogEntry): string {
  const parts = [new Date(e.at).toISOString(), e.text];
  if (e.namespace) parts.push(`(${e.namespace})`);
  if (e.error) parts.push(`: ${e.error}`);
  return parts.join(" ");
}
