// Diagnosis, timeline, traps, sparklines, reach, relations (docs/plan-features.md §3 C1–C3).
// Owner C (C1 writes all of C's types). C1 refined Evidence `diff` (optional refs) and
// Diagnosis.redactions; C2/C3 refine their fields together with contract/diag.rs.
import type { EventRow, ObjRef } from "../types";
import type { RedactionReport } from "./pack";

export type Severity = "error" | "warn" | "info";

export type Evidence =
  | { type: "object"; ref: ObjRef }
  | { type: "logLine"; pod: string; container: string; previous: boolean; ts: string; text: string }
  | { type: "event"; event: EventRow }
  /** the changed fields, one `path: value` per line; the refs name both objects (Enter opens the diff view) */
  | { type: "diff"; left: string; right: string; leftRef?: ObjRef; rightRef?: ObjRef }
  | { type: "field"; ref: ObjRef; path: string; value: string };

export interface Finding {
  severity: Severity;
  /** cluster-derived text: cleaned and redacted in Rust */
  title: string;
  detail?: string;
  evidence: Evidence[];
}

export interface Diagnosis {
  ref: ObjRef;
  findings: Finding[];
  /** what was checked, for the "no known cause found" state */
  checked: string[];
  /** RFC3339 */
  at: string;
  /** what the Redactor masked (set by Rust) */
  redactions?: RedactionReport;
}

export type TimelineSource = "event" | "replicaSet" | "container" | "hpa" | "flux" | "journal";

export interface TimelineRow {
  /** RFC3339 */
  at: string;
  source: TimelineSource;
  what: string;
  ref?: ObjRef;
  severity?: Severity;
}

export type TrapTrigger = "restart" | "oomKilled" | "crashLoop" | "notReady" | "evicted";

export interface TrapOpts {
  /** RFC3339; absent = until disarmed or kns quits */
  until?: string;
  triggers: TrapTrigger[];
}

export interface Trap {
  id: string;
  ref: ObjRef;
  armedAt: string;
  until?: string;
  triggers: TrapTrigger[];
  fired: { at: string; bundleId: string }[];
}

export interface JournalStatus {
  contexts: { context: string; on: boolean; rows: number; bytes: number }[];
}

export interface PodSample {
  /** ms since epoch */
  at: number;
  cpuMilli: number;
  memBytes: number;
}

export interface PodSeries {
  namespace: string;
  name: string;
  samples: PodSample[];
}

export interface ReachStep {
  name: string;
  /** null = could not be decided */
  ok: boolean | null;
  detail: string;
}

export interface ReachCheck {
  from: ObjRef;
  to: ObjRef;
  port?: number | string;
  steps: ReachStep[];
  ok: boolean | null;
}

export interface ReachProbeResult {
  ok: boolean;
  /** what ran, for the human (the tool and its target; the script itself is fixed in Rust) */
  command: string;
  /** cleaned and redacted tool output */
  output: string;
  /** "nc" | "wget" | "bash"; absent: nothing ran */
  tool?: string;
  /** the probe could not run here (no exec right, no shell, no tool): offer a debug container */
  needsDebug: boolean;
}

export type RelationKind = "self" | "owner" | "owned" | "traffic" | "uses";

export interface RelationNode {
  ref: ObjRef;
  kind: string;
  relation: RelationKind;
  status?: string;
  children: RelationNode[];
}

export interface DiagBackend {
  diagnose(ref: ObjRef): Promise<Diagnosis>;
  timeline(ref: ObjRef, sinceMinutes: number): Promise<TimelineRow[]>;
  journalSet(context: string, on: boolean): Promise<void>;
  journalStatus(): Promise<JournalStatus>;
  trapArm(ref: ObjRef, opts: TrapOpts): Promise<Trap>;
  trapList(): Promise<Trap[]>;
  trapDisarm(id: string): Promise<void>;
  /** redacted markdown of an incident bundle */
  bundleGet(id: string): Promise<string>;
  podMetricsHistory(context: string, namespace?: string): Promise<PodSeries[]>;
  reach(from: ObjRef, to: ObjRef, port?: number | string): Promise<ReachCheck>;
  reachProbe(from: ObjRef, to: ObjRef, port: number | string): Promise<ReachProbeResult>;
  relations(ref: ObjRef): Promise<RelationNode>;
}
