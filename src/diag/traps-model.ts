// Pure parts of traps and the journal (docs/plan-features.md §3 C2): labels, the rows of the
// `traps` view, the trap dialog's choices, `:journal` arguments, the status lines.
import type { JournalStatus, Trap, TrapTrigger } from "../ipc/types";

export const TRIGGERS: readonly { value: TrapTrigger; label: string }[] = [
  { value: "restart", label: "a container restarts" },
  { value: "oomKilled", label: "a container is OOMKilled" },
  { value: "crashLoop", label: "it goes into CrashLoopBackOff" },
  { value: "notReady", label: "a pod stops being ready" },
  { value: "evicted", label: "a pod is evicted" },
];
export const DEFAULT_TRIGGERS: readonly TrapTrigger[] = ["restart", "oomKilled", "crashLoop"];

export const TRIGGER_WORD: Record<TrapTrigger, string> = {
  restart: "restart",
  oomKilled: "OOMKilled",
  crashLoop: "CrashLoopBackOff",
  notReady: "not ready",
  evicted: "evicted",
};

export type Duration = "15m" | "1h" | "4h" | "24h" | "open";
export const DURATIONS: readonly { value: Duration; label: string }[] = [
  { value: "15m", label: "15 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "4h", label: "4 hours" },
  { value: "24h", label: "24 hours" },
  { value: "open", label: "until disarmed or kns quits" },
];
const DURATION_MS: Record<Exclude<Duration, "open">, number> = { "15m": 15 * 60_000, "1h": 3_600_000, "4h": 4 * 3_600_000, "24h": 24 * 3_600_000 };

/** `until` for a duration choice (RFC3339), or undefined. */
export const untilFor = (d: Duration, nowMs = Date.now()): string | undefined => (d === "open" ? undefined : new Date(nowMs + DURATION_MS[d]).toISOString());

/** Kinds a trap can watch (Rust: pods, workloads, Services). */
export const TRAP_KINDS = new Set(["pods", "deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "services"]);

export const trapTargetLabel = (t: Trap): string => `${t.ref.gvr.resource.replace(/s$/, "")}/${t.ref.name}${t.ref.namespace ? ` (${t.ref.namespace})` : ""}`;

/** `restart, OOMKilled · until 11:20 · fired 2×` */
export function trapDetail(t: Trap): string {
  const parts = [t.triggers.map((x) => TRIGGER_WORD[x]).join(", ")];
  if (t.until) parts.push(`until ${new Date(t.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  parts.push(t.fired.length ? `fired ${t.fired.length}×` : "armed");
  return parts.join(" · ");
}

export type TrapRow =
  | { type: "trap"; key: string; trap: Trap }
  | { type: "bundle"; key: string; trap: Trap; bundleId: string; at: string };

/** Each trap, then its bundles newest first. */
export function trapRows(traps: readonly Trap[]): TrapRow[] {
  const out: TrapRow[] = [];
  for (const t of traps) {
    out.push({ type: "trap", key: t.id, trap: t });
    for (const f of [...t.fired].reverse()) out.push({ type: "bundle", key: `${t.id}/${f.bundleId}`, trap: t, bundleId: f.bundleId, at: f.at });
  }
  return out;
}

/** The bundle Enter opens on a row: its own, or the trap's newest. */
export function rowBundle(row: TrapRow | undefined): string | null {
  if (!row) return null;
  if (row.type === "bundle") return row.bundleId;
  return row.trap.fired[row.trap.fired.length - 1]?.bundleId ?? null;
}

/** `:journal` (toggle), `:journal on`, `:journal off`; null: not understood. */
export function parseJournalArg(args: readonly string[], on: boolean): boolean | null {
  const a = args[0]?.toLowerCase();
  if (!a || a === "toggle") return !on;
  if (a === "on") return true;
  if (a === "off") return false;
  return null;
}

export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** Hub status: `on for default` / `on for 2 contexts`. */
export function journalStatusText(contexts: JournalStatus["contexts"]): string | null {
  const on = contexts.filter((c) => c.on);
  if (on.length === 0) return null;
  return on.length === 1 ? `on for ${on[0].context}` : `on for ${on.length} contexts`;
}

export function trapStatusText(traps: readonly Trap[]): string | null {
  if (traps.length === 0) return null;
  const fired = traps.reduce((n, t) => n + t.fired.length, 0);
  return `${traps.length} armed${fired ? ` · fired ${fired}×` : ""}`;
}
