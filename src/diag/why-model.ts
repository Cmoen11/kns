// The `why` view's pure model (docs/plan-features.md §3 C1): which kinds have rules, the flat row
// list (a finding, then its evidence), where Enter on evidence goes, and the copy text.
// No DOM, no stores: tested in why-model.test.ts.
import type { Diagnosis, Evidence, Finding, ObjRef } from "../ipc/types";
import type { DiffView, DocView, Gvr, LogsView, ObjectRef, ViewState } from "../types";

/** The kinds src-tauri/src/diagnose.rs has rules for (`target_of`); keep the two lists equal. */
const WHY_KINDS: readonly (readonly [string, string])[] = [
  ["", "pods"],
  ["apps", "deployments"],
  ["apps", "statefulsets"],
  ["apps", "daemonsets"],
  ["apps", "replicasets"],
  ["", "services"],
  ["networking.k8s.io", "ingresses"],
  ["batch", "jobs"],
  ["batch", "cronjobs"],
];

/** Every `*.toolkit.fluxcd.io` kind (Kustomization, HelmRelease, sources): `target_of` matches the suffix. */
const FLUX_SUFFIX = ".toolkit.fluxcd.io";

export const canWhy = (gvr: Gvr | undefined): boolean =>
  !!gvr && (gvr.group.endsWith(FLUX_SUFFIX) || WHY_KINDS.some(([g, r]) => gvr.group === g && gvr.resource === r));

export const WHY_SCOPE_REASON = "why knows pods, workloads, Services, Ingresses, Jobs, CronJobs and Flux objects";

export type WhyRow =
  | { type: "finding"; key: string; finding: number; data: Finding }
  | { type: "evidence"; key: string; finding: number; index: number; data: Evidence }
  /** "no known cause found": where to look next (describe, logs, events) */
  | { type: "next"; key: string; label: string; view: ViewState };

const EVENTS_GVR: Gvr = { group: "", version: "v1", resource: "events" };

/** Where to look when no rule matched: describe, the logs (pods and workloads), the events of the object. */
export function nextSteps(ref: ObjRef): { label: string; view: ViewState }[] {
  const r = toView(ref);
  const what = refLabel(ref);
  const out: { label: string; view: ViewState }[] = [{ label: `describe ${what}`, view: doc(r, "describe") }];
  const logless = ref.gvr.resource === "services" || ref.gvr.resource === "ingresses" || ref.gvr.resource === "cronjobs" || ref.gvr.group.endsWith(FLUX_SUFFIX);
  if (!logless) {
    out.push({
      label: `logs of ${what}`,
      view: { kind: "logs", target: { by: "object", ref: r }, container: "*", since: "tail", previous: false, wrap: false, timestamps: false, filterLines: false },
    });
  }
  out.push({
    label: `events of ${what}`,
    view: { kind: "table", gvr: EVENTS_GVR, namespace: ref.namespace ?? "*", filters: [{ mode: "fuzzy", text: ref.name }], faultsOnly: false, sort: null, wide: false },
  });
  return out;
}

/** One row per finding, followed by its evidence rows; without findings, the next steps. */
export function whyRows(d: Diagnosis | null | undefined): WhyRow[] {
  if (!d) return [];
  if (d.findings.length === 0) return nextSteps(d.ref).map((s, i) => ({ type: "next", key: `n${i}`, ...s }));
  const out: WhyRow[] = [];
  d.findings.forEach((f, i) => {
    out.push({ type: "finding", key: `f${i}`, finding: i, data: f });
    f.evidence.forEach((e, j) => out.push({ type: "evidence", key: `f${i}e${j}`, finding: i, index: j, data: e }));
  });
  return out;
}

export const clampCursor = (i: number, n: number): number => (n === 0 ? 0 : Math.min(n - 1, Math.max(0, i)));

/** The index of the next (dir 1) or previous (dir -1) finding row from `from`, or `from`. */
export function nextFinding(rows: readonly WhyRow[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (rows[i].type === "finding") return i;
  return from;
}

const toView = (r: ObjRef): ObjectRef => ({ gvr: r.gvr, namespace: r.namespace, name: r.name });

const doc = (ref: ObjectRef, format: DocView["format"]): DocView => ({ kind: "doc", ref, format, mode: "view", managedFields: false, wrap: false });

/** A regex that matches `text` literally (the logs search takes `re`). */
export const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Longest piece of a log line used as the search that lands on it. */
const MATCH_MAX = 120;

export interface EvidenceEnv {
  /** kind (or plural, short name) → its gvr; an event's involved object is named by kind */
  resolve: (kind: string) => { gvr: Gvr; namespaced: boolean } | undefined;
}

/**
 * Where Enter on an evidence row goes: log line → the logs of that container (previous run when
 * the line is from it) searched for that line; event → describe of its object; diff → the diff
 * view of the two objects; field → the object's YAML; object → its describe. Null when there is
 * nothing to open (a diff without refs, an event of an unknown kind).
 */
export function evidenceTarget(e: Evidence, base: ObjRef, env: EvidenceEnv): ViewState | null {
  switch (e.type) {
    case "object":
      return doc(toView(e.ref), "describe");
    case "field":
      return doc(toView(e.ref), "yaml");
    case "logLine": {
      const pod: ObjectRef = { gvr: { group: "", version: "v1", resource: "pods" }, namespace: base.namespace, name: e.pod };
      const text = e.text.trim().slice(0, MATCH_MAX);
      const view: LogsView = {
        kind: "logs",
        target: { by: "object", ref: pod },
        container: e.container || "*",
        since: "tail",
        previous: e.previous,
        wrap: false,
        timestamps: true,
        filterLines: false,
      };
      if (text) view.match = { mode: "re", text: escapeRe(text) };
      return view;
    }
    case "event": {
      const r = e.event.objectKind ? env.resolve(e.event.objectKind) : undefined;
      if (!r || !e.event.objectName) return null;
      return doc({ gvr: r.gvr, namespace: r.namespaced ? (e.event.namespace ?? base.namespace) : undefined, name: e.event.objectName }, "describe");
    }
    case "diff": {
      if (!e.leftRef || !e.rightRef) return null;
      const v: DiffView = { kind: "diff", left: { ref: toView(e.leftRef) }, right: { ref: toView(e.rightRef) }, managedFields: false, split: false };
      return v;
    }
  }
}

/** The context an evidence row's target lives in (it must be the current one to open it). */
export function evidenceContext(e: Evidence, base: ObjRef): string {
  if (e.type === "object" || e.type === "field") return e.ref.context;
  if (e.type === "diff") return e.rightRef?.context ?? base.context;
  return base.context;
}

/** What Enter on a finding row does: follow its first evidence that opens something. */
export function findingTarget(f: Finding, base: ObjRef, env: EvidenceEnv): { evidence: number; view: ViewState } | null {
  for (let i = 0; i < f.evidence.length; i++) {
    const view = evidenceTarget(f.evidence[i], base, env);
    if (view) return { evidence: i, view };
  }
  return null;
}

export const kindTag = (e: Evidence): string =>
  e.type === "logLine" ? (e.previous ? "log (previous)" : "log") : e.type === "object" ? e.ref.gvr.resource.replace(/s$/, "") : e.type;

/** The one-line text of an evidence row (also the copy text). */
export function evidenceText(e: Evidence): string {
  switch (e.type) {
    case "object":
      return `${e.ref.namespace ? `${e.ref.namespace}/` : ""}${e.ref.name}`;
    case "field":
      return e.value === "" ? e.path : `${e.path} = ${e.value}`;
    case "logLine":
      return `${e.container}${e.ts ? ` ${e.ts}` : ""}  ${e.text}`;
    case "event":
      return `${e.event.type} ${e.event.reason}${e.event.count > 1 ? ` ×${e.event.count}` : ""}: ${e.event.message}`;
    case "diff": {
      const n = e.right.split("\n").filter(Boolean).length;
      return `${n} field${n === 1 ? "" : "s"} changed${e.leftRef && e.rightRef ? `: ${e.leftRef.name} → ${e.rightRef.name}` : ""}`;
    }
  }
}

const SEV: Record<Finding["severity"], string> = { error: "ERROR", warn: "WARN", info: "INFO" };

export const refLabel = (r: ObjRef): string => `${r.gvr.resource.replace(/s$/, "")}/${r.name}${r.namespace ? ` (${r.namespace})` : ""}`;

/** Plain text of the findings, for `c` (copy findings). Rust already redacted every field. */
export function findingsText(d: Diagnosis): string {
  const lines = [`why ${refLabel(d.ref)} · context ${d.ref.context} · ${d.at}`];
  if (d.findings.length === 0) {
    lines.push("", "No known cause found.", `Checked: ${d.checked.join(", ")}`);
    return lines.join("\n");
  }
  for (const f of d.findings) {
    lines.push("", `${SEV[f.severity]}  ${f.title}`);
    if (f.detail) lines.push(`  ${f.detail}`);
    for (const e of f.evidence) {
      if (e.type === "diff") {
        lines.push(`  - diff: ${evidenceText(e)}`);
        for (const l of e.left.split("\n")) if (l) lines.push(`      - ${l}`);
        for (const l of e.right.split("\n")) if (l) lines.push(`      + ${l}`);
      } else lines.push(`  - ${kindTag(e)}: ${evidenceText(e)}`);
    }
  }
  lines.push("", `Checked: ${d.checked.join(", ")}`);
  if (d.redactions && d.redactions.count > 0) lines.push(`Redacted ${d.redactions.count} value${d.redactions.count === 1 ? "" : "s"}.`);
  return lines.join("\n");
}

/** Header count: `2 findings`, or nothing while loading. */
export function countLabel(d: Diagnosis | null): string {
  if (!d) return "";
  const n = d.findings.filter((f) => f.severity !== "info").length;
  return n === 0 ? (d.findings.length ? `${d.findings.length} note${d.findings.length === 1 ? "" : "s"}` : "no cause") : `${n} finding${n === 1 ? "" : "s"}`;
}
