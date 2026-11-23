// The `reach` view's pure model (docs/plan-features.md §3 C3): `:reach` arguments, the row list
// (chain steps, then the probe and its result, then "debug instead"), and the copy text.
// No DOM, no stores: tested in c3-model.test.ts.
import type { ReachCheck, ReachProbeResult, ReachStep } from "../ipc/types";
import type { Gvr, ObjectRef, ReachView } from "../types";

export const SVC_GVR: Gvr = { group: "", version: "v1", resource: "services" };
export const POD_GVR: Gvr = { group: "", version: "v1", resource: "pods" };

const LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const PORT_NAME = /^[a-z0-9]([-a-z0-9]{0,13}[a-z0-9])?$/;

export const isPod = (r: ObjectRef | null | undefined): boolean => !!r && r.gvr.group === "" && r.gvr.resource === "pods";

/** A port as typed: a number 1–65535 or a port name; null when neither. */
export function parsePort(s: string): number | string | null {
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n >= 1 && n <= 65535 ? n : null;
  }
  return PORT_NAME.test(s) ? s : null;
}

/**
 * `:reach web`, `web:80`, `web:http`, `svc/web 80`, `web.other-ns:5432`, `pod/web-1 8080`.
 * The namespace defaults to the source pod's. Returns the view's `to` and `port`, or why not.
 */
export function parseReachArgs(args: readonly string[], defaultNs: string): { to: ObjectRef; port?: number | string } | string {
  const words = args.map((a) => a.trim()).filter(Boolean);
  if (words.length === 0) return "name a Service: :reach web:80";
  if (words.length > 2) return ":reach takes a target and an optional port";
  let target = words[0];
  let gvr = SVC_GVR;
  const slash = /^(svc|service|services|po|pod|pods)\/(.*)$/.exec(target);
  if (slash) {
    gvr = slash[1].startsWith("po") ? POD_GVR : SVC_GVR;
    target = slash[2];
  }
  let portText: string | undefined = words[1];
  const colon = target.lastIndexOf(":");
  if (colon >= 0) {
    if (portText !== undefined) return "give the port once (web:80 or web 80)";
    portText = target.slice(colon + 1);
    target = target.slice(0, colon);
  }
  let [name, namespace = defaultNs, ...rest] = target.split(".");
  // `web.ns.svc` / `web.ns.svc.cluster.local`, as written in an env var
  if (rest.length && rest[0] === "svc") rest = [];
  if (rest.length) return `not a Service address: ${target}`;
  name = name ?? "";
  if (!LABEL.test(name)) return `not a valid name: ${name || "(empty)"}`;
  if (!LABEL.test(namespace)) return `not a valid namespace: ${namespace}`;
  let port: number | string | undefined;
  if (portText !== undefined) {
    const p = parsePort(portText);
    if (p === null) return `not a port: ${portText}`;
    port = p;
  }
  if (gvr === POD_GVR && port === undefined) return "a pod target needs a port: :reach pod/web-1 8080";
  return { to: { gvr, namespace, name }, port };
}

export const refText = (r: ObjectRef): string => `${r.gvr.resource === "services" ? "svc" : r.gvr.resource === "pods" ? "pod" : r.gvr.resource}/${r.name}${r.namespace ? ` (${r.namespace})` : ""}`;

export const reachTitle = (v: Pick<ReachView, "from" | "to" | "port">): string =>
  `${refText(v.from)} → ${v.to.gvr.resource === "services" ? "svc" : "pod"}/${v.to.name}${v.port !== undefined ? `:${v.port}` : ""}`;

export type ProbeState =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; result: ReachProbeResult }
  | { state: "error"; message: string };

export type ReachRow =
  | { type: "step"; key: string; step: ReachStep }
  /** Enter runs the probe (asks first) */
  | { type: "probe"; key: string; label: string; disabled?: string }
  | { type: "result"; key: string; result: ReachProbeResult }
  | { type: "probeError"; key: string; message: string }
  /** Enter offers a debug container on the source pod */
  | { type: "debug"; key: string };

/** The overall verdict in words. */
export function verdict(c: ReachCheck): { glyph: "ok" | "error" | "warn"; text: string } {
  if (c.ok === true) return { glyph: "ok", text: "reachable by the static checks" };
  if (c.ok === false) {
    const first = c.steps.find((s) => s.ok === false);
    return { glyph: "error", text: first ? `not reachable: ${first.name}` : "not reachable" };
  }
  return { glyph: "warn", text: "undecided: some steps could not be checked" };
}

export function reachRows(c: ReachCheck | null, probe: ProbeState, canProbe: true | string): ReachRow[] {
  if (!c) return [];
  const rows: ReachRow[] = c.steps.map((step, i) => ({ type: "step", key: `s${i}`, step }));
  const port = c.port;
  const disabled = port === undefined || port === null ? "no port to probe" : canProbe === true ? undefined : canProbe;
  if (probe.state === "running") rows.push({ type: "probe", key: "probe", label: "probing from inside the pod…", disabled: "probe running" });
  else rows.push({ type: "probe", key: "probe", label: probe.state === "idle" ? "probe from inside the pod" : "probe again", disabled });
  if (probe.state === "done") rows.push({ type: "result", key: "result", result: probe.result });
  if (probe.state === "error") rows.push({ type: "probeError", key: "probeError", message: probe.message });
  if ((probe.state === "done" && probe.result.needsDebug) || probe.state === "error" || (canProbe !== true && probe.state === "idle")) rows.push({ type: "debug", key: "debug" });
  return rows;
}
