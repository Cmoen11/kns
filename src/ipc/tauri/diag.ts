// Tauri mapping of DiagBackend (contract/diag.ts). Owner C; diagnose.rs, timeline.rs, journal.rs,
// trap.rs, history.rs, reach.rs, relations.rs.
import type { DiagBackend } from "../types";
import { call } from "./call";

export const diagTauri: DiagBackend = {
  diagnose: (objRef) => call("diagnose", { objRef }),
  timeline: (objRef, sinceMinutes) => call("timeline", { objRef, sinceMinutes }),
  journalSet: (context, on) => call("journal_set", { context, on }),
  journalStatus: () => call("journal_status"),
  trapArm: (objRef, opts) => call("trap_arm", { objRef, opts }),
  trapList: () => call("trap_list"),
  trapDisarm: (id) => call("trap_disarm", { id }),
  bundleGet: (id) => call("bundle_get", { id }),
  podMetricsHistory: (context, namespace) => call("pod_metrics_history", { context, namespace }),
  reach: (from, to, port) => call("reach", { from, to, port }),
  reachProbe: (from, to, port) => call("reach_probe", { from, to, port }),
  relations: (objRef) => call("relations", { objRef }),
};
