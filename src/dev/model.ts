// Pure logic of the dev-set and env views (docs/plan-features.md §3 B-dev). No DOM, no stores.
import type { Dependency, DevForward, DevSet, DevSetDraft, EnvReport, EnvRow, EnvSpec, Forward, ForwardTarget, Gvr, Rewrite } from "../ipc/types";
import { cleanUntrusted } from "../ui/untrusted";

// ── env view ──

/** Keys a local process can get: field / resourceField refs only exist in the pod. */
export const exportable = (r: EnvRow): boolean => r.source !== "field" && r.source !== "resourceField";

/** The keys included at first: every exportable key, secrets too (the human sees and unticks them). */
export function initialIncluded(report: EnvReport, spec?: EnvSpec): Set<string> {
  const keys = report.rows.filter(exportable).map((r) => r.key);
  if (!spec) return new Set(keys);
  const secrets = new Set(spec.includeSecrets ?? []);
  return new Set(
    report.rows
      .filter(exportable)
      .filter((r) => (spec.include ? spec.include.includes(r.key) : true) && !(spec.exclude ?? []).includes(r.key))
      .filter((r) => r.source !== "secret" || secrets.has(r.key) || spec.includeSecrets === undefined)
      .map((r) => r.key),
  );
}

/** `14 keys · 9 from secrets · 3 dependencies · 1 side-effect warning`. */
export function summary(report: EnvReport): string {
  const secrets = report.rows.filter((r) => r.source === "secret").length;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const parts = [plural(report.rows.length, "key"), `${secrets} from secrets`, plural(report.deps.length, "dependency").replace("dependencys", "dependencies")];
  if (report.warnings.length > 0) parts.push(plural(report.warnings.length, "side-effect warning"));
  return parts.join(" · ");
}

/** The forward a rewrite of this hit points at, from the dependencies' suggestions (or the set's). */
function localFor(hit: { service: string; namespace: string; port: number }, deps: readonly Dependency[], set?: DevSet): number | undefined {
  if (set) {
    const rw = set.rewrites.find((r) => r.match.service === hit.service && r.match.namespace === hit.namespace && r.match.port === hit.port);
    return rw ? set.forwards.find((f) => f.key === rw.to.forward)?.localPort : undefined;
  }
  return deps.find((d) => d.service.name === hit.service && d.service.namespace === hit.namespace && d.port === hit.port)?.suggestedForward.localPort;
}

/**
 * The value a local process would get, after the rewrites: spans of a shown value replaced by
 * `localhost:<p>`; a secret (no value, no span) shows where it would point. null: unchanged.
 */
export function rewrittenText(row: EnvRow, deps: readonly Dependency[], set?: DevSet): string | null {
  if (row.hits.length === 0) return null;
  if (row.value !== undefined && row.hits.every((h) => h.span)) {
    let out = row.value;
    let changed = false;
    for (const h of [...row.hits].sort((a, b) => (b.span?.[0] ?? 0) - (a.span?.[0] ?? 0))) {
      const p = localFor(h, deps, set);
      if (p === undefined || !h.span) continue;
      out = `${out.slice(0, h.span[0])}localhost:${p}${out.slice(h.span[1])}`;
      changed = true;
    }
    return changed ? out : null;
  }
  const targets = row.hits.map((h) => localFor(h, deps, set)).filter((p): p is number => p !== undefined);
  return targets.length > 0 ? targets.map((p) => `localhost:${p}`).join(", ") : null;
}

/** The env spec the view stands for: include list, ticked secrets, overrides. */
export function specOf(report: EnvReport, workload: { gvr: Gvr; namespace: string; name: string }, included: ReadonlySet<string>, format: EnvSpec["format"], overrides = report.overrides): EnvSpec {
  const rows = report.rows.filter(exportable);
  const all = rows.every((r) => included.has(r.key));
  return {
    workload,
    container: report.container,
    include: all ? undefined : rows.filter((r) => included.has(r.key)).map((r) => r.key),
    includeSecrets: rows.filter((r) => r.source === "secret" && included.has(r.key)).map((r) => r.key),
    overrides: overrides.length > 0 ? overrides : undefined,
    format,
  };
}

/** A set from the env view: the suggested forwards and rewrites of every dependency (`s`). */
export function draftFromReport(name: string, context: string, report: EnvReport, spec: EnvSpec, autoStart: boolean, id?: string): DevSetDraft {
  return {
    id,
    name,
    context,
    forwards: report.deps.map((d) => d.suggestedForward),
    rewrites: report.deps.map((d) => d.suggestedRewrite),
    env: spec,
    autoStart,
  };
}

/** `s` in the env view of an existing set: only its env, name and start-with-kns change; its
 * forwards and rewrites (made by `:dev save`, ports adjusted) stay as they are. */
export function draftUpdate(set: DevSet, spec: EnvSpec, name: string, autoStart: boolean): DevSetDraft {
  return { id: set.id, name, context: set.context, forwards: set.forwards, rewrites: set.rewrites, env: spec, autoStart, connSecrets: set.connSecrets };
}

/** A set name from a workload name: `orders-dev`. */
export function suggestName(workload: string): string {
  const base = workload.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36);
  return `${base || "set"}-dev`;
}

export const validSetName = (s: string): boolean => /^[a-z0-9-]{1,40}$/.test(s);

/** `:dev save <name>`: the running forwards that belong to no set become one. */
export function draftFromForwards(name: string, context: string, forwards: readonly Forward[]): DevSetDraft {
  const taken = new Set<string>();
  const key = (f: Forward): string => {
    const base = (f.label ?? f.target.name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "fwd";
    let k = base;
    for (let i = 2; taken.has(k); i++) k = `${base}-${i}`;
    taken.add(k);
    return k;
  };
  return {
    name,
    context,
    forwards: forwards
      .filter((f) => f.context === context && f.devSet === undefined)
      .map((f): DevForward => ({ key: key(f), target: f.target, remotePort: f.remotePort, localPort: f.localPort, pin: true, label: f.label })),
    rewrites: [],
    autoStart: false,
  };
}

// ── dev sets ──

export const approved = (s: DevSet): boolean => s.approvedHash === s.hash;

/** `agent: claude-code · not approved`, `mine`. Agent names are untrusted. */
export function originText(s: DevSet): string {
  if (s.origin.by === "agent") return `agent: ${cleanUntrusted(s.origin.client, 40)}${approved(s) ? "" : " · not approved"}`;
  return approved(s) ? "mine" : "mine · not approved";
}

export function targetText(t: ForwardTarget): string {
  if (t.kind === "pod") return `pod/${t.name}`;
  if (t.kind === "service") return `svc/${t.name}`;
  return `${t.gvr.resource}/${t.name}`;
}

/** `svc/kafka:9094 → 127.0.0.1:9094 (pinned)`. */
export const forwardLine = (f: DevForward): string =>
  `${f.key}: ${targetText(f.target)}${f.target.kind === "pod" ? "" : `.${f.target.namespace}`}:${f.remotePort} → 127.0.0.1:${f.localPort}${f.pin ? " (pinned)" : ""}`;

/** `kafka.kafka:9092 → localhost:9094 (kafka)`. */
export function rewriteLine(r: Rewrite, forwards: readonly DevForward[]): string {
  const to = forwards.find((f) => f.key === r.to.forward);
  return `${r.match.service}.${r.match.namespace}:${r.match.port} → ${to ? `localhost:${to.localPort}` : "?"} (${r.to.forward})${r.envKey ? ` in ${r.envKey}` : ""}`;
}

/** What changed since the approved snapshot, as lines (`+ forward …`, `- rewrite …`, `~ env …`). */
export function diffLines(set: DevSet): string[] {
  const snap = set.approvedSnapshot;
  if (!snap || approved(set)) return [];
  const out: string[] = [];
  const fl = (fs: readonly DevForward[]) => fs.map(forwardLine);
  const rl = (s: Pick<DevSet, "rewrites" | "forwards">) => s.rewrites.map((r) => rewriteLine(r, s.forwards));
  const before = new Set([...fl(snap.forwards), ...rl(snap)]);
  const now = new Set([...fl(set.forwards), ...rl(set)]);
  for (const l of now) if (!before.has(l)) out.push(`+ ${l}`);
  for (const l of before) if (!now.has(l)) out.push(`- ${l}`);
  if (snap.context !== set.context) out.push(`~ context ${snap.context} → ${set.context}`);
  if (JSON.stringify(snap.env ?? null) !== JSON.stringify(set.env ?? null)) out.push("~ env spec changed");
  if (snap.autoStart !== set.autoStart) out.push(`~ start with kns: ${set.autoStart ? "on" : "off"}`);
  return out;
}

/** Secret-sourced keys an export of this set may include (by name, for the approval checkboxes). */
export function secretKeysOf(report: EnvReport | null): string[] {
  return report ? report.rows.filter((r) => r.source === "secret").map((r) => r.key) : [];
}

/** `orders-dev up · 3 forwards` for the status hook and the bottom row. */
export function statusText(sets: readonly DevSet[], running: readonly string[], forwards: readonly Forward[]): string | null {
  const up = sets.filter((s) => running.includes(s.id));
  if (up.length === 0) return null;
  if (up.length === 1) {
    const n = forwards.filter((f) => f.devSet === up[0].id).length;
    return `${up[0].name} up · ${n} forward${n === 1 ? "" : "s"}`;
  }
  return `${up.length} sets up`;
}

/** `:dev up|down|save <name>|names on|off` → what to do. */
export type DevCommand =
  | { kind: "picker" }
  | { kind: "up" | "down"; name?: string }
  | { kind: "save"; name?: string }
  /** `:dev names on [port]` / `:dev names off` (B2 name proxy) */
  | { kind: "names"; on: boolean; port?: number }
  | { kind: "error"; message: string };

export function parseDevCommand(args: readonly string[]): DevCommand {
  const [verb, arg, extra] = args;
  if (verb === undefined) return { kind: "picker" };
  if (verb === "names" && arg === "on" && extra !== undefined && args.length === 3) {
    const port = /^\d{1,5}$/.test(extra) ? Number(extra) : NaN;
    return port >= 1024 && port <= 65535 ? { kind: "names", on: true, port } : { kind: "error", message: `the name proxy port is 1024-65535, not "${extra}"` };
  }
  if (extra !== undefined) return { kind: "error", message: "usage: :dev up|down|save <name> | names on [port]|off" };
  if (verb === "up" || verb === "down") return { kind: verb, name: arg };
  if (verb === "save") return arg === undefined || validSetName(arg) ? { kind: "save", name: arg } : { kind: "error", message: `a set name is 1-40 of a-z 0-9 -, not "${arg}"` };
  if (verb === "names" && (arg === "on" || arg === "off")) return { kind: "names", on: arg === "on" };
  return { kind: "error", message: "usage: :dev up|down|save <name> | names on [port]|off" };
}
