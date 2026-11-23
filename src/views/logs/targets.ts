// Pure helpers that turn a logs view into stream requests: which (pod, container) pairs to open,
// what `since` means for the API, and the stable text markers of the pod gutter.
import type { LogQuery, PodRef } from "../../ipc/types";
import type { LogSince, LogsView, ObjectRef } from "../../types";

/** lines fetched per stream when attaching with `tail` */
export const TAIL_LINES = 500;
/** a merged stream covers at most this many pods (§12.4) */
export const MAX_PODS = 8;

export const SINCE_SECONDS: Record<Exclude<LogSince, "tail" | "head">, number> = {
  "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600,
};
/** keys 2..6 (§5.4) */
export const SINCE_BY_DIGIT: Record<number, LogSince> = { 2: "1m", 3: "5m", 4: "15m", 5: "30m", 6: "1h" };

/** The range part of a LogQuery. `head` has no API form: it reads from the start. */
export function sinceQuery(since: LogSince): Pick<LogQuery, "tailLines" | "sinceSeconds"> {
  if (since === "tail") return { tailLines: TAIL_LINES };
  if (since === "head") return {};
  return { sinceSeconds: SINCE_SECONDS[since] };
}

/** A resolved target: what the stream manager needs, with the context. */
export interface StreamConfig {
  context: string;
  target: { by: "object"; ref: ObjectRef } | { by: "selector"; namespace: string; selector: string } | { by: "objects"; refs: ObjectRef[] };
  container: string;
  since: LogSince;
  previous: boolean;
}

export function streamConfig(view: LogsView, context: string | null): StreamConfig | null {
  if (!context || view.target.by === "paneSelection") return null;
  return { context, target: view.target, container: view.container, since: view.since, previous: view.previous };
}

const refKey = (r: ObjectRef): string => `${r.gvr.group}|${r.gvr.resource}|${r.namespace ?? ""}|${r.name}`;

const targetKey = (t: StreamConfig["target"]): string =>
  t.by === "object"
    ? `o|${refKey(t.ref)}`
    : t.by === "objects"
      ? `m|${t.refs.map(refKey).sort().join(";")}`
      : `s|${t.namespace}|${t.selector}`;

/** Short name of a target for notes and crumbs: `web-7d9f8`, `3 objects`, `app=web`. */
export function targetName(t: StreamConfig["target"]): string {
  if (t.by === "object") return t.ref.name;
  if (t.by === "objects") return t.refs.length === 1 ? t.refs[0].name : `${t.refs.length} objects`;
  return t.selector;
}

/** Merged logs (plan-features §2.10a): the target for marked rows; duplicates dropped, order kept. */
export function objectsTarget(refs: readonly ObjectRef[]): { by: "objects"; refs: ObjectRef[] } {
  const seen = new Set<string>();
  const out: ObjectRef[] = [];
  for (const r of refs) {
    const k = refKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ gvr: r.gvr, namespace: r.namespace, name: r.name, ...(r.uid ? { uid: r.uid } : {}) });
  }
  return { by: "objects", refs: out };
}

/** Pods of several resolves as one list, each pod once (first seen wins). */
export function unionPods(lists: readonly (readonly PodRef[])[]): PodRef[] {
  const seen = new Set<string>();
  const out: PodRef[] = [];
  for (const list of lists) {
    for (const p of list) {
      const k = `${p.namespace}/${p.name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

/** Identity of a stream set: a change of any part restarts the streams. */
export const streamKey = (c: StreamConfig): string =>
  [c.context, targetKey(c.target), c.container, c.since, c.previous ? "p" : ""].join("\u0001");

/** The same, without the target: a change of only the target keeps the buffer (follow link). */
export const settingsKey = (c: StreamConfig): string => [c.context, c.container, c.since, c.previous ? "p" : ""].join("\u0001");

export type ContainerKind = "container" | "init" | "ephemeral";

export interface SourceSpec {
  namespace: string;
  pod: string;
  container: string;
  kind: ContainerKind;
}

export const sourceKey = (s: { namespace: string; pod: string; container: string }): string => `${s.namespace}/${s.pod}/${s.container}`;

function containersOf(pod: PodRef): { name: string; kind: ContainerKind }[] {
  return [
    ...pod.initContainers.map((name) => ({ name, kind: "init" as const })),
    ...pod.containers.map((name) => ({ name, kind: "container" as const })),
    ...pod.ephemeralContainers.map((name) => ({ name, kind: "ephemeral" as const })),
  ];
}

/** One source per (pod, container) for the chosen container ("*" = all, init and ephemeral included). */
export function expandSources(pods: readonly PodRef[], container: string, maxPods = MAX_PODS): { sources: SourceSpec[]; skippedPods: number } {
  const sorted = [...pods].sort((a, b) => (a.namespace + "/" + a.name < b.namespace + "/" + b.name ? -1 : 1));
  const used = sorted.slice(0, maxPods);
  const sources: SourceSpec[] = [];
  for (const pod of used) {
    for (const c of containersOf(pod)) {
      if (container === "*" || c.name === container) sources.push({ namespace: pod.namespace, pod: pod.name, container: c.name, kind: c.kind });
    }
  }
  return { sources, skippedPods: sorted.length - used.length };
}

export interface ContainerChoice {
  value: string;
  label: string;
}

/** Choices of the container picker: all, then every container name once, init and ephemeral labelled. */
export function containerChoices(pods: readonly PodRef[]): ContainerChoice[] {
  const seen = new Map<string, ContainerKind>();
  for (const pod of pods) for (const c of containersOf(pod)) if (!seen.has(c.name)) seen.set(c.name, c.kind);
  const order: ContainerKind[] = ["container", "init", "ephemeral"];
  const out: ContainerChoice[] = [{ value: "*", label: "All containers" }];
  for (const kind of order) {
    for (const [name, k] of seen) if (k === kind) out.push({ value: name, label: kind === "container" ? name : `${name} (${kind})` });
  }
  return out;
}

/** The first regular container, for "one container" when none was chosen before. */
export const defaultContainer = (pods: readonly PodRef[]): string | undefined => pods.find((p) => p.containers.length > 0)?.containers[0];

/** Stable text marker per pod in first-seen order: a..z, A..Z, then numbers. Never colour. */
export function markerFor(index: number): string {
  if (index < 26) return String.fromCharCode(97 + index);
  if (index < 52) return String.fromCharCode(65 + index - 26);
  return String(index - 51);
}

/** Shortens with an ellipsis in the middle, keeping both ends (generated pod suffixes matter). */
export function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…".slice(0, max);
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

/** widest pod or container name in the gutter, in characters */
export const GUTTER_MAX = 24;
/** a container name next to a pod name is cut to this */
const CONTAINER_MAX = 10;

/**
 * What the gutter shows: the container when one pod has several, the pod (with its marker) when
 * several pods have one container each, both otherwise.
 */
export type GutterMode = "none" | "container" | "pod" | "both";

export function gutterMode(pods: number, sources: number): GutterMode {
  if (sources <= 1) return "none";
  if (pods <= 1) return "container";
  return sources > pods ? "both" : "pod";
}

/** Width of the gutter in characters for these sources. */
export function gutterWidth(mode: GutterMode, sources: readonly { pod: string; container: string }[]): number {
  if (mode === "none") return 0;
  const widest = (len: (s: { pod: string; container: string }) => number) => sources.reduce((w, s) => Math.max(w, len(s)), 0);
  if (mode === "container") return Math.min(GUTTER_MAX, widest((s) => s.container.length));
  const pod = Math.min(GUTTER_MAX, widest((s) => s.pod.length));
  // marker + space + pod [+ slash + container]
  return mode === "pod" ? 2 + pod : 2 + pod + 1 + Math.min(CONTAINER_MAX, widest((s) => s.container.length));
}

/** Gutter text of a source, at most `width` characters: `main`, `a web-7d9…x2kq` or `a web-7d9…x2kq/main`. */
export function sourceLabel(mode: GutterMode, marker: string, pod: string, container: string, width: number): string {
  if (mode === "none") return "";
  if (mode === "container") return middleEllipsis(container, width);
  if (mode === "pod") return `${marker} ${middleEllipsis(pod, Math.max(1, width - 2))}`;
  const c = middleEllipsis(container, CONTAINER_MAX);
  return `${marker} ${middleEllipsis(pod, Math.max(1, width - 3 - c.length))}/${c}`;
}
