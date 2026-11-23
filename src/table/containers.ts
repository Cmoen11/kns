// Rows of the containers view (docs/ux.md §12.5), built from the pod object's spec and status.
// Pure. Order is spec order: init, then containers, then ephemeral.
// Crash card (docs/plan-features.md §3 C1, owner C1): LAST (exit code and reason of the last
// termination), LIVED (how long that instance ran), DIED (how long ago it ended).
import type { Column, Json, Row } from "../ipc/types";
import { formatAge } from "./age";

const col = (name: string, type = "string"): Column => ({ name, type, format: "", description: "", priority: 0 });

export const CONTAINER_COLUMNS: readonly Column[] = [
  col("Name"), col("State"), col("Ready", "boolean"), col("Restarts", "integer"), col("Type"), col("Image"), col("Ports"),
  col("Last"), col("Lived"), col("Died"),
];

const SIGNALS: Readonly<Record<number, string>> = {
  1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT", 7: "SIGBUS", 8: "SIGFPE", 9: "SIGKILL",
  11: "SIGSEGV", 13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM",
};

/** The signal behind an exit code above 128 (`137` → `SIGKILL`), else undefined. */
export function signalOf(code: number): string | undefined {
  if (code <= 128 || code >= 160) return undefined;
  return SIGNALS[code - 128] ?? `signal ${code - 128}`;
}

/** What an exit code usually means (the same table as src-tauri/src/diagnose.rs exit_meaning). */
export function exitMeaning(code: number): string {
  switch (code) {
    case 0: return "exited normally";
    case 1: return "application error";
    case 2: return "misuse of a shell builtin or bad arguments";
    case 126: return "command found but not executable";
    case 127: return "command not found (entrypoint or PATH)";
    case 137: return "SIGKILL: killed by the OOM killer or after the grace period";
    case 139: return "SIGSEGV: segmentation fault";
    case 143: return "SIGTERM: asked to stop";
  }
  const sig = signalOf(code);
  if (sig) return `killed by ${sig}`;
  return code < 0 ? "container runtime error" : "application-defined exit code";
}

/** The LAST cell: `137 OOMKilled`, `1 Error`, `143 SIGTERM` (the reason, else the signal). */
export function exitLabel(code: number, reason?: string): string {
  const word = reason && reason !== "Error" ? reason : (signalOf(code) ?? reason ?? (code === 0 ? "Completed" : "Error"));
  return `${code} ${word}`;
}

export interface Crash {
  code: number;
  reason?: string;
  /** seconds the instance ran */
  lived?: number;
  /** RFC3339 end of the instance */
  finishedAt?: string;
}

const secondsBetween = (a: string | undefined, b: string | undefined): number | undefined => {
  const x = a ? Date.parse(a) : NaN;
  const y = b ? Date.parse(b) : NaN;
  return Number.isFinite(x) && Number.isFinite(y) ? Math.max(0, Math.round((y - x) / 1000)) : undefined;
};

/** The last termination worth showing: `lastState.terminated`, else a failed current one. */
export function lastCrash(status: Json | undefined): Crash | undefined {
  const s = obj(status);
  const pick = (t: Obj | null): Crash | undefined => {
    if (!t) return undefined;
    const code = typeof t.exitCode === "number" ? t.exitCode : 0;
    return { code, reason: str(t.reason), lived: secondsBetween(str(t.startedAt), str(t.finishedAt)), finishedAt: str(t.finishedAt) };
  };
  const last = pick(obj(obj(s?.lastState)?.terminated));
  if (last) return last;
  const now = pick(obj(obj(s?.state)?.terminated));
  return now && (now.code !== 0 || now.reason === "OOMKilled") ? now : undefined;
}

/** The three crash-card cells; empty strings when the container never stopped. */
export function crashCells(status: Json | undefined, nowMs: number): [string, string, string] {
  const c = lastCrash(status);
  if (!c) return ["", "", ""];
  const died = c.finishedAt ? Date.parse(c.finishedAt) : NaN;
  return [
    exitLabel(c.code, c.reason),
    c.lived === undefined ? "" : formatAge(c.lived),
    Number.isFinite(died) ? formatAge(Math.max(0, Math.round((nowMs - died) / 1000))) : "",
  ];
}

type Obj = { [k: string]: Json };
const obj = (v: Json | undefined): Obj | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : null);
const list = (v: Json | undefined): Obj[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Obj => x !== null) : []);
const str = (v: Json | undefined): string | undefined => (typeof v === "string" ? v : undefined);

function stateOf(status: Obj | undefined): { word: string; since?: string } {
  const state = obj(status?.state);
  const running = obj(state?.running);
  if (running) return { word: "Running", since: str(running.startedAt) };
  const waiting = obj(state?.waiting);
  if (waiting) return { word: str(waiting.reason) ?? "Waiting" };
  const terminated = obj(state?.terminated);
  if (terminated) {
    const code = typeof terminated.exitCode === "number" ? terminated.exitCode : 0;
    return { word: code === 0 ? "Completed" : (str(terminated.reason) ?? "Error"), since: str(terminated.startedAt) };
  }
  return { word: "Waiting" };
}

function ports(c: Obj): string {
  return list(c.ports)
    .map((p) => (typeof p.containerPort === "number" ? `${p.containerPort}/${str(p.protocol) ?? "TCP"}` : ""))
    .filter(Boolean)
    .join(",");
}

/**
 * One row per container of the pod. An unreadable object gives no rows. DIED is relative to
 * `nowMs`; the view re-reads the pod whenever its table row changes (restarts, status).
 */
export function containerRows(pod: Json, nowMs: number = Date.now()): Row[] {
  const p = obj(pod);
  const spec = obj(p?.spec);
  const status = obj(p?.status);
  const meta = obj(p?.metadata);
  if (!spec) return [];
  const namespace = str(meta?.namespace);
  const created = str(meta?.creationTimestamp);
  const out: Row[] = [];
  const add = (type: "init" | "ctr" | "eph", specs: Json | undefined, statuses: Json | undefined) => {
    const byName = new Map<string, Obj>();
    for (const s of list(statuses)) if (typeof s.name === "string") byName.set(s.name, s);
    for (const c of list(specs)) {
      const name = str(c.name);
      if (!name) continue;
      const s = byName.get(name);
      const state = stateOf(s);
      out.push({
        uid: `${type}/${name}`,
        name,
        namespace,
        created: state.since ?? created,
        cells: [name, state.word, s?.ready === true, typeof s?.restartCount === "number" ? s.restartCount : 0, type, str(c.image) ?? "", ports(c), ...crashCells(s, nowMs)],
      });
    }
  };
  add("init", spec.initContainers, status?.initContainerStatuses);
  add("ctr", spec.containers, status?.containerStatuses);
  add("eph", spec.ephemeralContainers, status?.ephemeralContainerStatuses);
  return out;
}
