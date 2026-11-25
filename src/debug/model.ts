// Pure logic of feature F (docs/plan-features.md §3 F): image references, shell quoting, the
// kubectl template map, the mirrord command and snippet matching. No stores, no DOM.
import type { Gvr } from "../ipc/types";
import type { ObjectRef, ViewState } from "../types";

// ── images ─────────────────────────────────────────────────────────────────

/** A plausible image reference: no whitespace or control characters, at most 255 characters. */
export function validImage(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return s.length > 0 && s.length <= 255 && !/[\s\x00-\x1f\x7f]/.test(s);
}

/**
 * What the node pulls: `busybox:1.37.0` → `docker.io/library/busybox:1.37.0`, `nicolaka/netshoot:v0.13`
 * → `docker.io/nicolaka/netshoot:v0.13`; a reference with a registry host stays as written. No tag
 * and no digest means `:latest`.
 */
export function fullImage(ref: string): string {
  const s = ref.trim();
  const slash = s.indexOf("/");
  const first = slash < 0 ? "" : s.slice(0, slash);
  const hasHost = slash >= 0 && (first.includes(".") || first.includes(":") || first === "localhost");
  let out = hasHost ? s : slash < 0 ? `docker.io/library/${s}` : `docker.io/${s}`;
  const last = out.slice(out.lastIndexOf("/") + 1);
  if (!last.includes(":") && !out.includes("@")) out += ":latest";
  return out;
}

/** Floating tags pull whatever is current; worth a warning next to the full reference. */
export const floatingTag = (ref: string): boolean => /:latest$/.test(fullImage(ref));

// ── shell quoting ──────────────────────────────────────────────────────────

// `@` (splatting) and `,` (array) mean something unquoted in PowerShell, so they are quoted
const SAFE = /^[A-Za-z0-9._/:=%+^-]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;
// PowerShell also ends a single-quoted string at the typographic quotes U+2018-U+201B
const PS_QUOTES = /[‘-‛]/;

/**
 * One argument for a pasted command line: as is when it is plain, else in single quotes (the same
 * in bash, zsh and PowerShell). Null for a value with a `'` or a control character: there is no
 * quoting that pastes the same in every shell, so the command is not offered.
 */
export function shq(s: string): string | null {
  if (s === "") return "''";
  if (CONTROL.test(s) || PS_QUOTES.test(s) || s.includes("'")) return null;
  return SAFE.test(s) ? s : `'${s}'`;
}

/** `argv` joined for pasting, or null when one argument cannot be quoted. */
export function commandLine(argv: readonly string[]): string | null {
  const out: string[] = [];
  for (const a of argv) {
    const q = shq(a);
    if (q === null) return null;
    out.push(q);
  }
  return out.join(" ");
}

// ── kubectl ────────────────────────────────────────────────────────────────

/** An object as kubectl names it, plus the context it lives in. */
export interface KubeTarget {
  context: string;
  gvr: Gvr;
  namespace?: string;
  name: string;
  /** the container a shell, logs or debug action used */
  container?: string;
}

/** What an action left behind that the command needs (a picked image, the replica count). */
export interface KubeExtra {
  image?: string;
  copy?: boolean;
  replicas?: number;
  suspend?: boolean;
  /** RFC3339, for the Flux reconcile annotation; tests pass a fixed one */
  now?: string;
}

const CORE_LIKE = new Set(["", "apps", "batch"]);

/** `pods`, `deployments`, `kustomizations.kustomize.toolkit.fluxcd.io`: unambiguous for kubectl. */
export function resourceArg(gvr: Gvr): string {
  return CORE_LIKE.has(gvr.group) ? gvr.resource : `${gvr.resource}.${gvr.group}`;
}

const LOGGABLE = new Set(["pods", "deployments", "statefulsets", "daemonsets", "replicasets", "jobs"]);

/** `--context x -n ns` (no `-n` for cluster-scoped objects). */
function scope(t: Pick<KubeTarget, "context" | "namespace">): string[] {
  return ["--context", t.context, ...(t.namespace ? ["-n", t.namespace] : [])];
}

/** `kubectl <argv> <scope>`, the scope before a `--` (what follows it is the remote command). */
function withScope(argv: readonly string[], flags: readonly string[]): string | null {
  const i = argv.indexOf("--");
  return commandLine(i < 0 ? ["kubectl", ...argv, ...flags] : ["kubectl", ...argv.slice(0, i), ...flags, ...argv.slice(i)]);
}

const obj = (t: KubeTarget): string[] => [resourceArg(t.gvr), t.name];
const slashed = (t: KubeTarget): string => `${resourceArg(t.gvr)}/${t.name}`;
const isPod = (t: KubeTarget): boolean => t.gvr.group === "" && t.gvr.resource === "pods";
const container = (t: KubeTarget): string[] => (t.container ? ["-c", t.container] : []);
const logsArg = (t: KubeTarget): string => (isPod(t) ? t.name : slashed(t));
const suspendJson = (on: boolean): string => JSON.stringify({ spec: { suspend: on } });

type Template = (t: KubeTarget, x: KubeExtra) => string[] | null;

/**
 * Action id → kubectl argv (after `kubectl`, without `--context`/`-n`). Every built ops action is
 * either here or in NO_KUBECTL (test). A template may decline (null) for a kind it cannot express.
 */
export const KUBECTL_TEMPLATES: Readonly<Record<string, Template>> = {
  "res.describe": (t) => ["describe", ...obj(t)],
  "res.yaml": (t) => ["get", ...obj(t), "-o", "yaml"],
  "res.edit": (t) => ["edit", ...obj(t)],
  "res.logs": (t) => (LOGGABLE.has(t.gvr.resource) ? ["logs", logsArg(t), ...container(t), "--tail=200", "-f"] : null),
  "res.logsPrevious": (t) => (LOGGABLE.has(t.gvr.resource) ? ["logs", logsArg(t), ...container(t), "--previous"] : null),
  "pod.shell": (t) => ["exec", "-it", logsArg(t), ...container(t), "--", "sh"],
  "pod.attach": (t) => ["attach", "-it", logsArg(t), ...container(t)],
  "pf.start": (t) => ["port-forward", slashed(t), "LOCAL:REMOTE"],
  "res.delete": (t) => ["delete", ...obj(t)],
  "pod.kill": (t) => ["delete", ...obj(t), "--grace-period=0", "--force"],
  "workload.scale": (t, x) => ["scale", slashed(t), `--replicas=${x.replicas ?? "REPLICAS"}`],
  "workload.restart": (t) => ["rollout", "restart", slashed(t)],
  "cronjob.trigger": (t) => ["create", "job", `--from=cronjob/${t.name}`, `${t.name}-manual`],
  "cronjob.suspend": (t, x) => ["patch", ...obj(t), "--type=merge", "-p", suspendJson(x.suspend ?? true)],
  "flux.reconcile": (t, x) => ["annotate", "--overwrite", ...obj(t), `reconcile.fluxcd.io/requestedAt=${x.now ?? new Date().toISOString()}`],
  "flux.reconcileWithSource": (t, x) => ["annotate", "--overwrite", ...obj(t), `reconcile.fluxcd.io/requestedAt=${x.now ?? new Date().toISOString()}`],
  "flux.suspendResume": (t, x) => ["patch", ...obj(t), "--type=merge", "-p", suspendJson(x.suspend ?? true)],
  "argo.refresh": (t) =>
    ["annotate", "--overwrite", ...obj(t), t.gvr.resource === "applicationsets" ? "argocd.argoproj.io/application-set-refresh=true" : "argocd.argoproj.io/refresh=normal"],
  "argo.hardRefresh": (t) => ["annotate", "--overwrite", ...obj(t), "argocd.argoproj.io/refresh=hard"],
  "argo.sync": (t) => ["patch", ...obj(t), "--type=merge", "-p", '{"operation":{"initiatedBy":{"username":"kns"},"sync":{"prune":false}}}'],
  "node.cordon": (t) => ["cordon", t.name],
  "node.uncordon": (t) => ["uncordon", t.name],
  "pod.debug": (t, x) =>
    x.copy
      ? ["debug", t.name, "-it", `--copy-to=${t.name}-debug`, `--image=${x.image ?? "busybox"}`, "--share-processes"]
      : ["debug", "-it", t.name, `--image=${x.image ?? "busybox"}`, ...(t.container ? [`--target=${t.container}`] : [])],
};

/** Built actions that only navigate inside kns: `:kubectl` falls back to the view's command. */
export const NO_KUBECTL: ReadonlySet<string> = new Set(["res.owner", "pod.node", "deploy.replicaSets"]);

/** `kubectl …` for an action on an object, or null (no template, unquotable value). */
export function kubectlFor(action: string, t: KubeTarget, extra: KubeExtra = {}): string | null {
  const tpl = KUBECTL_TEMPLATES[action];
  const argv = tpl?.(t, extra);
  if (!argv) return null;
  const clusterScoped = action === "node.cordon" || action === "node.uncordon";
  return withScope(argv, scope(clusterScoped ? { context: t.context } : t));
}

const refTarget = (context: string, ref: ObjectRef, c?: string): KubeTarget => ({
  context, gvr: ref.gvr, namespace: ref.namespace, name: ref.name, container: c && c !== "*" ? c : undefined,
});

/**
 * `kubectl …` that shows what a view shows, or null for views without an equivalent (why, diff,
 * env, the hub). `cursor` is the table's cursor row (unused for the list itself).
 */
export function kubectlForView(view: ViewState, context: string): string | null {
  switch (view.kind) {
    case "table": {
      const ns = view.namespace === "*" ? ["-A"] : view.namespace ? ["-n", view.namespace] : [];
      const label = view.filters.find((f) => f.mode === "label");
      const selector = label && label.mode === "label" ? ["-l", label.selector] : [];
      return commandLine(["kubectl", "get", resourceArg(view.gvr), ...selector, ...(view.wide ? ["-o", "wide"] : []), "--context", context, ...ns]);
    }
    case "containers":
      return kubectlFor("res.describe", refTarget(context, view.pod));
    case "doc": {
      const t = refTarget(context, view.ref);
      if (view.mode === "edit") return kubectlFor("res.edit", t);
      if (view.format === "describe") return kubectlFor("res.describe", t);
      if (view.format === "json") return commandLine(["kubectl", "get", ...obj(t), "-o", "json", ...scope(t)]);
      // a secret's decoded view: the YAML (values base64), never a decoding pipeline
      return kubectlFor("res.yaml", t);
    }
    case "logs": {
      if (view.target.by !== "object") return null;
      const t = refTarget(context, view.target.ref, view.container);
      if (!LOGGABLE.has(t.gvr.resource)) return null;
      const since = view.since === "tail" || view.since === "head" ? ["--tail=200"] : [`--since=${view.since}`];
      const flags = [...(view.previous ? ["--previous"] : ["-f"]), ...(view.timestamps ? ["--timestamps"] : []), ...since];
      return commandLine(["kubectl", "logs", logsArg(t), ...container(t), ...(view.container === "*" ? ["--all-containers"] : []), ...flags, ...scope(t)]);
    }
    case "shell":
    case "attach": {
      if (view.target.by !== "object") return null;
      return kubectlFor(view.kind === "shell" ? "pod.shell" : "pod.attach", refTarget(context, view.target.ref, view.container));
    }
    default:
      return null;
  }
}

// ── mirrord ────────────────────────────────────────────────────────────────

export const MIRRORD_PLACEHOLDER = "YOUR_COMMAND";

/**
 * `mirrord exec --context <ctx> --target pod/<name>[/container/<c>] --target-namespace <ns> -- <cmd>`.
 * kns only copies it; mirrord itself is never started from kns.
 */
export function mirrordCommand(t: KubeTarget, cmd: readonly string[] = []): string | null {
  const target = `pod/${t.name}${t.container ? `/container/${t.container}` : ""}`;
  return commandLine([
    "mirrord", "exec", "--context", t.context, "--target", target,
    ...(t.namespace ? ["--target-namespace", t.namespace] : []),
    "--", ...(cmd.length ? cmd : [MIRRORD_PLACEHOLDER]),
  ]);
}

// ── snippets ───────────────────────────────────────────────────────────────

export interface Snippet {
  /** unique: `:x <id>` runs it */
  id: string;
  title: string;
  /** passed to `sh -c` */
  command: string;
  /** substrings of the container image (lowercase); none = fits every container */
  images?: readonly string[];
  builtIn?: boolean;
}

const KAFKA = ["kafka", "redpanda"];
/** Tries the usual script locations of apache/kafka, bitnami/kafka and confluent images. */
const kafkaTool = (tool: string, args: string): string =>
  `for p in /opt/kafka/bin/${tool}.sh /opt/bitnami/kafka/bin/${tool}.sh ${tool} ${tool}.sh; do ` +
  `if command -v "$p" >/dev/null 2>&1; then exec "$p" ${args}; fi; done; echo "${tool} not found in this image" >&2; exit 127`;

/** Script paths and tool presence per image are [verify] (plan §6): raw output is shown either way. */
export const BUILT_IN_SNIPPETS: readonly Snippet[] = [
  { id: "env", title: "Environment (sorted)", command: "env | sort", builtIn: true },
  { id: "resolv", title: "DNS config (/etc/resolv.conf)", command: "cat /etc/resolv.conf", builtIn: true },
  { id: "ps", title: "Processes", command: "ps aux 2>/dev/null || ps", builtIn: true },
  { id: "df", title: "Disk usage", command: "df -h", builtIn: true },
  {
    id: "psql", title: "psql: databases", images: ["postgres", "postgis", "timescale", "cloudnative-pg"], builtIn: true,
    command: `PGPASSWORD="\${POSTGRES_PASSWORD:-}" psql -U "\${POSTGRES_USER:-postgres}" -d "\${POSTGRES_DB:-postgres}" -c '\\l'`,
  },
  {
    id: "psql-tables", title: "psql: tables", images: ["postgres", "postgis", "timescale", "cloudnative-pg"], builtIn: true,
    command: `PGPASSWORD="\${POSTGRES_PASSWORD:-}" psql -U "\${POSTGRES_USER:-postgres}" -d "\${POSTGRES_DB:-postgres}" -c '\\dt+'`,
  },
  {
    id: "redis-cli", title: "redis-cli: keyspace", images: ["redis", "valkey", "keydb"], builtIn: true,
    command: `redis-cli \${REDIS_PASSWORD:+-a "$REDIS_PASSWORD" --no-auth-warning} INFO keyspace`,
  },
  { id: "kafka-topics", title: "Kafka: topics", images: KAFKA, builtIn: true, command: kafkaTool("kafka-topics", "--bootstrap-server localhost:9092 --list") },
  { id: "kafka-groups", title: "Kafka: consumer groups", images: KAFKA, builtIn: true, command: kafkaTool("kafka-consumer-groups", "--bootstrap-server localhost:9092 --list") },
];

export const validSnippetId = (s: string): boolean => /^[a-z0-9][a-z0-9-]{0,39}$/.test(s);

/** Does `s` fit a container with this image? Generic snippets fit every container. */
export function snippetFits(s: Snippet, image: string): boolean {
  if (!s.images || s.images.length === 0) return true;
  const img = image.toLowerCase();
  return s.images.some((m) => img.includes(m));
}

/**
 * The snippets offered for a container: user snippets override built-ins with the same id; the
 * ones made for this image first, then the generic ones, each group in list order.
 */
export function snippetsFor(user: readonly Snippet[], image: string): Snippet[] {
  const ids = new Set(user.map((s) => s.id));
  const all = [...user, ...BUILT_IN_SNIPPETS.filter((s) => !ids.has(s.id))];
  const fits = all.filter((s) => snippetFits(s, image));
  return [...fits.filter((s) => s.images?.length), ...fits.filter((s) => !s.images?.length)];
}

/** `:x <id>` lookup among every snippet (also ones made for other images: the user asked by name). */
export function findSnippet(user: readonly Snippet[], id: string): Snippet | undefined {
  return user.find((s) => s.id === id) ?? BUILT_IN_SNIPPETS.find((s) => s.id === id);
}

/** Parses `:x save <id> <command…>` / `:x rm <id>` / `:x <id>` / `:x`. */
export type SnippetCommand =
  | { kind: "pick" }
  | { kind: "run"; id: string }
  | { kind: "save"; id: string; command: string }
  | { kind: "remove"; id: string }
  | { kind: "error"; message: string };

export function parseSnippetArgs(args: readonly string[]): SnippetCommand {
  const [first, second, ...rest] = args;
  if (!first) return { kind: "pick" };
  if (first === "save") {
    if (!second || !validSnippetId(second)) return { kind: "error", message: "usage: :x save <name> <command>  (name: a-z 0-9 -)" };
    const command = rest.join(" ").trim();
    if (!command) return { kind: "error", message: "usage: :x save <name> <command>" };
    if (command.length > 4096) return { kind: "error", message: "command too long" };
    return { kind: "save", id: second, command };
  }
  if (first === "rm") {
    if (!second) return { kind: "error", message: "usage: :x rm <name>" };
    return { kind: "remove", id: second };
  }
  return { kind: "run", id: first };
}

/** The text of a snippet run's header line: `exit 0 · 412 ms · redacted 2 values`. */
export function runSummary(r: { exitCode?: number; message?: string; truncated: boolean; millis: number; redactions: { count: number } }): string {
  const parts = [r.exitCode !== undefined ? `exit ${r.exitCode}` : (r.message ?? "no exit status")];
  if (r.exitCode !== undefined && r.message) parts.push(r.message);
  parts.push(r.millis < 1000 ? `${r.millis} ms` : `${(r.millis / 1000).toFixed(1)} s`);
  if (r.truncated) parts.push("truncated");
  if (r.redactions.count > 0) parts.push(`redacted ${r.redactions.count} value${r.redactions.count === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

// ── persisted tools store (src/debug/store.ts) ─────────────────────────────

export interface ToolsState {
  snippets: Snippet[];
  /** most recent first, at most 5 */
  recentImages: string[];
}

export const MAX_RECENT = 5;
export const MAX_SNIPPETS = 100;

export function sanitizeTools(data: unknown): ToolsState {
  const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const snippets: Snippet[] = [];
  for (const s of Array.isArray(d.snippets) ? d.snippets : []) {
    const r = s as Record<string, unknown>;
    if (typeof r.id !== "string" || !validSnippetId(r.id) || typeof r.command !== "string" || !r.command.trim() || r.command.length > 4096) continue;
    if (snippets.some((x) => x.id === r.id)) continue;
    const images = Array.isArray(r.images) ? r.images.filter((i): i is string => typeof i === "string" && i.length > 0 && i.length <= 100).map((i) => i.toLowerCase()) : undefined;
    snippets.push({
      id: r.id,
      title: typeof r.title === "string" && r.title.trim() ? r.title.slice(0, 80) : r.id,
      command: r.command,
      ...(images && images.length ? { images } : {}),
    });
    if (snippets.length >= MAX_SNIPPETS) break;
  }
  const recentImages = (Array.isArray(d.recentImages) ? d.recentImages : [])
    .filter((i): i is string => typeof i === "string" && validImage(i))
    .slice(0, MAX_RECENT);
  return { snippets, recentImages };
}
