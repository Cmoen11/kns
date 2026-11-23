// Log streams. Owner E (docs/plan-features.md §3 E): `sinceTime`/`parse` on LogQuery,
// `level`/`fields`/`msg` on LogLine (parsed in Rust, src-tauri/src/logparse.rs).
// Rust mirror: src-tauri/src/contract/logs.rs.
import type { Unsubscribe } from "../types";

export interface LogQuery {
  context: string;
  /** one stream is opened per (pod, container) */
  targets: { namespace: string; pod: string; container: string }[];
  follow: boolean;
  tailLines?: number;
  sinceSeconds?: number;
  /** RFC3339; wins over `sinceSeconds` (the API takes only one of them) */
  sinceTime?: string;
  previous?: boolean;
  /** detect JSON / logfmt / a leading level word per line and fill `level`, `msg`, `fields` */
  parse?: boolean;
}

/** Normalised level, ordered: trace < debug < info < warn < error < fatal. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface LogLine {
  /** RFC3339Nano timestamp from the kubelet */
  ts: string;
  pod: string;
  container: string;
  text: string;
  /** only with `parse`: the detected level */
  level?: LogLevel;
  /** only with `parse`: the message of a JSON / logfmt line (or the text after a level word) */
  msg?: string;
  /** only with `parse`: the other keys, in line order; at most 32 pairs, values at most 1 KiB */
  fields?: [string, string][];
}

export type LogEvent =
  | { type: "lines"; lines: LogLine[] }
  | { type: "end"; pod: string; container: string }
  | { type: "error"; pod: string; container: string; message: string };

export interface LogsBackend {
  streamLogs(query: LogQuery, onEvent: (e: LogEvent) => void): Unsubscribe;
}
