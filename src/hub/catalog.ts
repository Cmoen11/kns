// The tools catalog (docs/plan-features.md §2.10): one entry per tool of the Tools hub, the basics
// included. Data only (no components): the hub (I), the palette's "Tools" source, `hub.open` and
// `hub.help` read it. Written by A2; owned by I afterwards.
//
// Keys and mouse paths are not written here: the hub derives them live from the keymap and the
// pointer registries (ROW_ACTIONS, ROW_MENU, BULK_ACTIONS, toolbars, WINDOW_MENU) through `actions`.
import { registry, type ActionId } from "../actions";
import type { ToolId, ViewKind, ViewState } from "../types";
import type { IconName } from "../ui/Glyph";

export type { ToolId };

export type ToolGroup = "Basics" | "Debug" | "Logs" | "Diff" | "Local dev" | "Agents";
export const TOOL_GROUPS: readonly ToolGroup[] = ["Basics", "Debug", "Logs", "Diff", "Local dev", "Agents"];

/** What "Try it" needs from the current object (src/store/current.ts). */
export type TryNeeds = "row" | "twoMarks" | "pod" | "podRow" | "workload" | "logsPane" | "yamlPane" | "envPane" | "pfPane" | "none";

export interface ToolEntry {
  id: ToolId;
  title: string;
  group: ToolGroup;
  /** one line, at most 80 characters */
  summary: string;
  /** structured help, rendered as DOM by the hub; at most 4 sentences each */
  help: { answers: string; notFor?: string; safety?: string; example?: string };
  /** the actions that start it, most direct first */
  actions: readonly ActionId[];
  /** `:` lines that start it (each parses in the `:` resolver; `<name>` is a placeholder) */
  commands: readonly string[];
  /** "Try it" on the current object; `writes`: only opens the action's own dialog */
  try?: { action: ActionId; needs: TryNeeds; writes?: boolean; label?: string };
  /** docs/tools.md#<anchor> */
  doc: string;
  /** view kinds that belong to this tool (context-aware hub.open, hub.help) */
  kinds?: readonly ViewKind[];
  /** the glyph of its hub row (default: by group) */
  icon?: IconName;
  /** true once the tool works: its first action is built, or its feature called setToolBuilt */
  built: () => boolean;
}

// ── built state ────────────────────────────────────────────────────────────

const flagged = new Set<ToolId>();
const flagSubs = new Set<() => void>();
/**
 * For tools whose work has no action of their own (crash card, sparklines, merged logs, rollout
 * watch, names): the feature calls this from its register() once it is built.
 */
export function setToolBuilt(id: ToolId, built = true): void {
  if (built === flagged.has(id)) return;
  if (built) flagged.add(id);
  else flagged.delete(id);
  notify();
}
const notify = () => {
  for (const fn of [...flagSubs]) fn();
};
/** Fires when setToolBuilt, registerTool or registerToolStatus changes something (registry changes: registry.subscribe). */
export function subscribeToolBuilt(fn: () => void): () => void {
  flagSubs.add(fn);
  return () => flagSubs.delete(fn);
}

const byAction = (id: ActionId) => () => registry.get(id)?.built ?? false;
const byFlag = (id: ToolId) => () => flagged.has(id);

/** An entry as written: `doc` defaults to docs/tools.md#<id>, `built` to the first action (or the flag). */
export type ToolSpec = Omit<ToolEntry, "built" | "doc"> & { builtBy?: "flag"; doc?: string; built?: () => boolean };
function tool(s: ToolSpec): ToolEntry {
  const { builtBy, doc, built, ...rest } = s;
  const isBuilt = built ?? (builtBy === "flag" || s.actions.length === 0 ? byFlag(s.id) : byAction(s.actions[0]));
  return { ...rest, doc: doc ?? `docs/tools.md#${s.id}`, built: isBuilt };
}

// ── entries ────────────────────────────────────────────────────────────────

const entries: ToolEntry[] = [
  // Basics: the features kns already has
  tool({
    id: "palette", title: "Command palette", group: "Basics",
    summary: "Find and run anything: resources, actions, favourites, contexts, panes",
    help: {
      answers: "Type part of a name to open a resource, run an action or jump to a pane. A `:` prefix takes commands, `>` lists actions with their keys.",
      example: "Ctrl+K, type `po`, Enter: the pods table.",
    },
    actions: ["palette.open", "command.open"],
    commands: [],
    try: { action: "palette.open", needs: "none" },
  }),
  tool({
    id: "panes", title: "Panes and layouts", group: "Basics",
    summary: "Split, zoom, move and close panes; open anything beside the current one",
    help: {
      answers: "Every view lives in a pane. Press `+` before a key to open its view beside the current pane instead of in place.",
      example: "`+ d` on a pod row: describe opens to the right and follows the cursor. In the context picker, `Ctrl+Enter` opens the same view beside it in another context (staging next to prod).",
    },
    actions: ["pane.splitRight", "pane.splitDown", "pane.zoom", "pane.close", "pane.closeOthers", "pane.moveMode", "context.pickPane"],
    commands: [":split r", ":split d", ":close", ":only", ":pane ctx"],
    try: { action: "pane.splitRight", needs: "none" },
  }),
  tool({
    id: "logs", title: "Logs", group: "Basics",
    summary: "Stream a pod's or a workload's logs, with search, time range and wrap",
    help: {
      answers: "Shows the logs of the row under the cursor, following new lines. `p` shows the previous container's logs after a restart.",
      example: "`l` on deploy/web, then `/` to search.",
    },
    actions: ["res.logs", "res.logsPrevious"],
    commands: [],
    try: { action: "res.logs", needs: "row" },
    kinds: ["logs"],
  }),
  tool({
    id: "shell", title: "Shell", group: "Basics",
    summary: "A terminal inside a container, in a pane",
    help: {
      answers: "Opens a shell in the pod under the cursor. The session lives as long as its pane.",
      safety: "Commands run in the container with its permissions; closing the pane ends the session after asking.",
    },
    actions: ["pod.shell", "pod.attach"],
    commands: [],
    try: { action: "pod.shell", needs: "pod" },
    kinds: ["shell", "attach"],
  }),
  tool({
    id: "describe-edit", title: "Describe, YAML and edit", group: "Basics",
    summary: "Read an object as describe text or YAML, edit it with a review before apply",
    help: {
      answers: "`d` describes, `y` shows YAML, `e` edits. Saving an edit shows a diff and a server dry run before anything is applied.",
      safety: "Apply is a cluster write: protected contexts ask for the name, read-only contexts refuse.",
    },
    actions: ["res.describe", "res.yaml", "res.edit"],
    commands: [],
    try: { action: "res.describe", needs: "row" },
    kinds: ["doc"],
  }),
  tool({
    id: "port-forward", title: "Port-forward", group: "Basics",
    summary: "Reach a pod or service port on localhost",
    help: {
      answers: "`F` forwards a local port to the row under the cursor. On a Service or workload the forward follows a ready pod and survives restarts and rollouts on the same local port (`waiting` while no pod is ready). Running forwards are in the activity panel and `:pf`; `o` opens one in the browser.",
      safety: "Forwards bind to loopback only; anything on your machine can use them while they run.",
    },
    actions: ["pf.start", "pf.open"],
    commands: [":pf"],
    try: { action: "pf.start", needs: "row" },
    kinds: ["portforwards"],
  }),
  tool({
    id: "favourites", title: "Favourites", group: "Basics",
    summary: "Save views and layouts, recall them by slot",
    help: {
      answers: "Saves the current table (or the whole layout) under a name and a slot. Ctrl+1..9 recalls a view, Alt+1..9 a layout.",
    },
    actions: ["fav.picker", "fav.saveView", "fav.saveLayout"],
    commands: [":layout save"],
    try: { action: "fav.picker", needs: "none" },
  }),
  // status colours package (src/status)
  tool({
    id: "ns-health", title: "Namespace health", group: "Basics",
    summary: "Failing pods and degraded workloads per namespace, at a glance",
    help: {
      answers: "Each namespace in the context sidebar shows a badge with the number of faulty pods and workloads, the titlebar the total. A click on a badge (or `!` on the row) opens that namespace with FAULTS on: pods, or the faulty workload kind when only workloads are wrong.",
      notFor: "Application errors that leave Kubernetes healthy; Warning events are not counted.",
      example: "Badge `3` on `kns-spike`: `!` shows crashy, oomy and pullfail.",
    },
    actions: ["health.faults", "health.nsFaults", "sidebar.problemsFirst"],
    commands: [":faults"],
    try: { action: "health.faults", needs: "none" },
    icon: "fault",
  }),
  tool({
    id: "action-log", title: "Recent (action log)", group: "Basics",
    summary: "What you did and what happened, newest first, a jump away",
    help: {
      answers: "The Recent group of the activity panel lists scales, restarts, deletes, applies, forwards, dev sets, shells, logs, snippets, agent requests and traps for the current context. Enter jumps to where it happened; failures stay marked with their error.",
      safety: "Names and verbs only, never secret values or manifests; the setting Action log chooses what is recorded.",
      example: "Scale web to 2, then `Ctrl+Shift+Y`: `scaled deployment web 1 → 2`, Enter selects its row.",
    },
    actions: ["activity.focus", "activity.toggle", "activity.copyAddress", "activity.clearFinished"],
    commands: [":activity"],
    try: { action: "activity.focus", needs: "none" },
    icon: "history",
  }),
  tool({
    id: "status-colors", title: "Status colours", group: "Basics",
    summary: "One palette for ok, in progress, warning, error; shape and word too",
    help: {
      answers: "Status glyphs, READY and RESTARTS cells, forwards, toasts, pane watches and the connection use the same hues in every theme. A faint tint marks failing table rows.",
      notFor: "Decoration: a healthy table stays calm, only the small glyph is coloured.",
      example: "Settings, Status colours: Quiet keeps only warnings and errors in colour; Row tint turns the tint off.",
    },
    actions: ["settings.open"],
    commands: [],
    try: { action: "settings.open", needs: "none" },
    builtBy: "flag",
    icon: "settings",
  }),

  tool({
    id: "filter", title: "Filter and faults", group: "Basics",
    summary: "Narrow a table by text, regex, labels; show only rows with problems",
    help: {
      answers: "`/` filters the rows of the focused table; Tab switches fuzzy, regex and label modes. `!` keeps only rows that are not healthy.",
    },
    actions: ["filter.open", "filter.faults"],
    commands: [],
    try: { action: "filter.open", needs: "row" },
  }),
  // Debug
  tool({
    id: "why", title: "Why is this broken?", group: "Debug",
    summary: "Findings with evidence for a pod, workload, Service, Ingress, Job or Flux object",
    help: {
      answers: "Reads status, events, probes, endpoints and owners and explains what is wrong, each finding with the lines that prove it. Works on pods, workloads, Services, Ingresses (missing Service, port or TLS Secret, Certificate not Ready), Jobs and CronJobs, and Flux Kustomizations, HelmReleases and sources. Enter on a finding follows its evidence.",
      notFor: "Application bugs that leave Kubernetes healthy; read the logs for those.",
      example: "`W` on pod/crashy in kns-spike: CrashLoopBackOff, exit code 1, last log lines.",
    },
    actions: ["res.why"],
    commands: [":why"],
    try: { action: "res.why", needs: "row" },
    kinds: ["why"],
  }),
  tool({
    id: "crash", title: "Crash card", group: "Debug",
    summary: "Last exit code, reason and restarts per container, in the containers view",
    help: {
      answers: "The containers view shows why each container last stopped (exit code, OOMKilled, signal) and when, without opening describe.",
      example: "Enter on an `oomy` pod in kns-spike: OOMKilled, limit 32Mi.",
    },
    actions: [],
    commands: [],
    try: { action: "nav.open", needs: "podRow", label: "containers" },
    kinds: ["containers"],
    builtBy: "flag",
  }),
  tool({
    id: "timeline", title: "Timeline", group: "Debug",
    summary: "Events, restarts, rollouts and status changes of an object, in order",
    help: {
      answers: "Puts events, rollouts (image changes), pod starts and terminations, HPA scaling and Flux revisions of an object, its owners and its pods on one time axis. Enter describes a row's object; `l` opens the pod's logs at that time.",
      notFor: "History the API no longer has (events live about an hour) unless the event journal was on.",
      example: "H on deploy/web in kns-spike after a new image: the ReplicaSet row names the change, then the pods restart.",
    },
    actions: ["res.timeline"],
    commands: [":timeline"],
    try: { action: "res.timeline", needs: "row" },
    kinds: ["timeline"],
  }),
  tool({
    id: "journal", title: "Event journal", group: "Debug",
    summary: "Keep cluster events on disk per context, beyond the API's hour",
    help: {
      answers: "Records Warning events per context while kns runs (7 days, 20 MB), so the timeline can show what happened yesterday. :journal toggles it for the current context; :journal on|off.",
      safety: "One watch per connected context costs a little network while kns is open; rows are redacted, local and never leave the machine.",
    },
    actions: ["journal.toggle"],
    commands: [":journal"],
  }),
  tool({
    id: "trap", title: "Trap", group: "Debug",
    summary: "Wait for a crash or a condition, capture logs and events when it happens",
    help: {
      answers: "Watches the pods of a pod, workload or Service for a restart, OOMKill, CrashLoopBackOff, not ready or eviction; when it fires kns saves an incident bundle (diagnosis, events, log tails, samples, pod YAML) and notifies you. :traps lists them; Enter opens a bundle.",
      safety: "Changes nothing in the cluster and runs only while kns is open. Bundles are redacted (best effort) and stay on this machine.",
    },
    actions: ["res.trap", "trap.list"],
    commands: [":trap", ":traps"],
    try: { action: "res.trap", needs: "row", writes: true },
    kinds: ["traps"],
  }),
  tool({
    id: "sparklines", title: "Sparklines", group: "Debug",
    summary: "CPU and memory of the last minutes as a small graph per pod",
    help: {
      answers: "The wide pods view has a SPARK column: memory of the last 5 minutes per pod from the samples of the CPU/MEM poll, with a dot for a missed sample, so a climb is visible without opening anything.",
      notFor: "Long-term metrics; that is the job of your monitoring stack. Needs metrics-server.",
    },
    actions: [],
    commands: [],
    try: { action: "view.wide", needs: "podRow", label: "wide view" },
    builtBy: "flag",
  }),
  tool({
    id: "reach", title: "Can it reach?", group: "Debug",
    summary: "Can this pod talk to that Service: policies, ports, endpoints, a probe",
    help: {
      answers: "Checks NetworkPolicies, Service ports and ready endpoints between two objects, then optionally probes the connection from inside the pod.",
      safety: "The probe runs a fixed command in the pod (an exec) and asks first.",
    },
    actions: ["res.reach"],
    commands: [":reach"],
    try: { action: "res.reach", needs: "pod" },
    kinds: ["reach"],
  }),
  tool({
    id: "relations", title: "Relations", group: "Debug",
    summary: "What owns this object, what it owns, what selects and mounts it",
    help: {
      answers: "A tree from the object to its owners, children, Services, ConfigMaps, Secrets and Flux source. Enter opens a node.",
    },
    actions: ["res.relations"],
    commands: [":relations"],
    try: { action: "res.relations", needs: "row" },
    kinds: ["relations"],
  }),
  tool({
    id: "rollout", title: "Rollout watch", group: "Debug",
    summary: "Follow a rollout to the end: new pods, readiness, stuck steps",
    help: {
      answers: "After a restart, scale or image change kns follows the rollout in the activity panel and says when it is done or stuck.",
    },
    actions: [],
    commands: [],
    builtBy: "flag",
  }),
  tool({
    id: "debug", title: "Debug container", group: "Debug",
    summary: "Attach a debug container with tools to a running pod, or debug a copy",
    help: {
      answers: "Adds an ephemeral container (busybox, netshoot) to the pod and opens a shell in it, sharing the target's process namespace.",
      safety: "A cluster write; ephemeral containers cannot be removed until the pod is deleted. Needs patch on pods/ephemeralcontainers.",
      example: "`B` on pod/web in kns-spike, pick netshoot, then `curl localhost`.",
    },
    actions: ["pod.debug"],
    commands: [":debug", ":debug copy"],
    try: { action: "pod.debug", needs: "pod", writes: true },
  }),
  tool({
    id: "snippets", title: "Exec snippets", group: "Debug",
    summary: "Run saved commands in a pod (psql, redis-cli, kafka tools) and see the output",
    help: {
      answers: "Pick a snippet that fits the container and run it once; the output opens as text you can copy.",
      safety: "Snippets run as an exec in the container.",
    },
    actions: ["snippet.run"],
    commands: [":x"],
    try: { action: "snippet.run", needs: "pod" },
  }),
  tool({
    id: "kubectl", title: "Copy as kubectl", group: "Debug",
    summary: "The kubectl command for what you are looking at, on the clipboard",
    help: {
      answers: "Copies the kubectl command that shows the same thing (get, describe, logs) with the context and namespace spelled out.",
    },
    actions: ["res.kubectl"],
    commands: [":kubectl"],
    try: { action: "res.kubectl", needs: "row" },
  }),

  // Logs
  tool({
    id: "logs-merged", title: "Merged logs", group: "Logs",
    summary: "Logs of several marked objects in one pane, interleaved by time",
    help: {
      answers: "Mark rows with Space, then `l`: one logs pane over all of them, each line tagged with its pod. `O` on a line opens its pod.",
    },
    actions: ["res.logs", "logs.goToPod"],
    commands: [],
    try: { action: "res.logs", needs: "twoMarks" },
    builtBy: "flag",
  }),
  tool({
    id: "logs-structured", title: "Structured logs", group: "Logs",
    summary: "JSON and logfmt lines as columns: level, message, fields",
    help: {
      answers: "`J` in a logs pane parses JSON and logfmt lines into columns, so level and message line up. Plain lines stay as they are.",
    },
    actions: ["logs.structured"],
    commands: [],
    try: { action: "logs.structured", needs: "logsPane" },
  }),
  tool({
    id: "logs-patterns", title: "Log patterns", group: "Logs",
    summary: "Group similar log lines and count them, errors first",
    help: {
      answers: "`P` in a logs pane opens the patterns beside it: lines with the variable parts masked, counted. Enter filters the source logs to a pattern.",
      notFor: "Exact search; use `/` in the logs pane.",
    },
    actions: ["logs.patterns"],
    commands: [":patterns"],
    try: { action: "logs.patterns", needs: "logsPane" },
    kinds: ["patterns"],
  }),

  // Diff
  tool({
    id: "diff", title: "Diff anything", group: "Diff",
    summary: "Compare two objects, an object with its revisions, or live with last-applied",
    help: {
      answers: "Mark two rows and press `D`, or `:diff prev` for the previous revision and `:diff applied` for drift from the last kubectl apply. In the diff, `n`/`N` step through changes, `t` switches split/unified, `m` shows managed fields and metadata, Enter opens folded lines. Secret values are masked.",
      notFor: "Objects managed by Flux (server-side apply) have no last-applied; use field owners.",
    },
    actions: ["res.diff"],
    commands: [":diff", ":diff prev", ":diff applied"],
    try: { action: "res.diff", needs: "twoMarks" },
    kinds: ["diff"],
  }),
  tool({
    id: "owners", title: "Field owners", group: "Diff",
    summary: "Which manager (Flux, kubectl, a controller) owns each field of an object",
    help: {
      answers: "`O` in a YAML view marks every field with the manager that last set it: `F` Flux, `K` kns, `k` kubectl, `C` a controller, `o` other; hover a letter for the manager, operation and age. `:drift` folds a Flux-managed object down to the fields a human (kubectl, kns) set that Flux does not own.",
      notFor: "Objects without managedFields: there is nothing to show.",
      example: "`y` on deploy/web in kns-spike after `kubectl scale`, then `O`: spec.replicas shows `k`.",
    },
    actions: ["doc.fieldOwners", "doc.driftOnly"],
    commands: [":owners", ":drift"],
    try: { action: "doc.fieldOwners", needs: "yamlPane" },
  }),

  // Local dev
  tool({
    id: "devsets", title: "Dev sets", group: "Local dev",
    summary: "Named groups of forwards (and an env file) you start and stop together",
    help: {
      answers: "A dev set brings up every forward a local run needs on stable ports, with one key. Sets are per context and can start with kns.",
      safety: "Starting a set opens local ports; a set saved by an agent shows you its full content before it starts.",
      example: "`:dev up envdemo-dev`.",
    },
    actions: ["dev.picker"],
    commands: [":dev", ":dev up <name>", ":dev down <name>"],
    try: { action: "dev.picker", needs: "none" },
    kinds: ["devsets"],
  }),
  tool({
    id: "env", title: "Dev from workload", group: "Local dev",
    summary: "A workload's env with in-cluster addresses rewritten to your forwards",
    help: {
      answers: "`E` on a workload lists its env, where each value comes from and what it talks to, and builds the forwards and a .env file to run it locally.",
      safety: "Secret values stay masked until you reveal or tick them; a written .env file holds what you ticked.",
      example: "`E` on deploy/envdemo in kns-spike, then `s` to save it as a dev set.",
    },
    actions: ["dev.fromWorkload"],
    commands: [":env"],
    try: { action: "dev.fromWorkload", needs: "workload" },
    kinds: ["env"],
  }),
  tool({
    id: "names", title: "Names on one port", group: "Local dev",
    summary: "Reach HTTP forwards by name (web.kns-spike.localhost:7080), not by port",
    help: {
      answers: "`:dev names on` starts a local proxy on 127.0.0.1:7080 that routes `http://<name>.<namespace>.localhost:7080` to the forward with that label (or target name). The port-forwards view then shows each forward's name, and opening it in the browser uses the name.",
      notFor: "Non-HTTP clients (Postgres, Kafka): they keep using the forward's own port. Safari and macOS are not checked.",
      safety: "Listens on 127.0.0.1 only; a cross-site request or one from another origin gets 403, an unknown name 421. Raw forwards on fixed ports stay reachable by any local page through DNS rebinding.",
      example: "`F` on svc/web in kns-spike, `:dev names on`, then open http://web.kns-spike.localhost:7080.",
    },
    actions: [],
    commands: [":dev names on", ":dev names on <port>", ":dev names off"],
    try: { action: "pf.open", needs: "none", label: "port-forwards" },
    builtBy: "flag",
  }),
  tool({
    id: "conn-string", title: "Connection string", group: "Local dev",
    summary: "Copy a ready connection URL for a forward (postgres://, redis://, kafka)",
    help: {
      answers: "`C` on a port-forward copies a connection string for its local port. Pick no credentials for a plain URL, or a Secret key: a full URL or DSN is pointed at the forward, a password goes into the URL with the user from the same Secret.",
      notFor: "Kafka with SASL: you get the bootstrap address only.",
      safety: "kns reads the Secret and writes the clipboard itself (kept out of clipboard history on Windows, cleared after the settings' delay); the window sees a masked preview. The pick is kept in the dev set (approved sets only) or for the forward until it stops; agents cannot set it.",
      example: "`C` on the postgres forward of a dev set, Secret postgres, key DATABASE_URL.",
    },
    actions: ["pf.copyUrl"],
    commands: [],
    try: { action: "pf.copyUrl", needs: "pfPane" },
  }),
  tool({
    id: "mirrord", title: "mirrord command", group: "Local dev",
    summary: "Copy the mirrord command that runs your local process as this pod",
    help: {
      answers: "Copies `mirrord exec --target pod/<name> -- …` for the pod under the cursor. kns never runs mirrord itself.",
    },
    actions: ["pod.mirrord"],
    commands: [":mirrord"],
    try: { action: "pod.mirrord", needs: "pod" },
  }),

  // Agents
  tool({
    id: "pack", title: "Copy for an agent", group: "Agents",
    summary: "A compact, redacted bundle of objects, findings and logs for a coding agent",
    help: {
      answers: "Builds a markdown pack of up to 10 objects (why findings, YAML, events, log tails, owners) with secrets masked and cluster text fenced as untrusted, to paste into an agent.",
      notFor: "Giving an agent live access: connect it to the MCP server instead (it can make the same pack with make_pack).",
      safety: "Redaction is best effort: the size line says how many values were masked, never that it is safe; read the preview before you paste.",
      example: "Mark deploy/envdemo and its pod, `leader c`, `Space` to drop the logs, `c` to copy.",
    },
    actions: ["res.pack"],
    commands: [":pack"],
    try: { action: "res.pack", needs: "row" },
  }),
  tool({
    id: "mcp", title: "MCP server", group: "Agents",
    summary: "Let a coding agent read the cluster through kns, with your approval for changes",
    help: {
      answers: "A local MCP server on 127.0.0.1: a coding agent such as Claude Code reads what kns shows, redacted, and asks for forwards, dev sets and changes that you approve in this window. `:mcp setup` (or Connect an agent…) turns it on, creates a token for the agent, sets the current context's policy and copies the command that registers kns with the agent. `:agents` lists clients, policies and the audit of every call. Clients that only start programs (stdio) use `kns-mcp`, installed next to kns, with the token in `KNS_MCP_TOKEN`.",
      notFor: "A one-off snapshot for a chat: use Copy for an agent (`leader c`).",
      safety: "Off by default; each context is `off`, `read` or `propose` (`:mcp policy`). Loopback only, one revocable token per agent. The token does not protect against malware running as you.",
      example: "`:mcp setup`, paste the copied command in a terminal, then ask Claude Code \"why is crashy broken\" with the cursor on crashy.",
    },
    actions: ["mcp.command", "agents.connect", "agents.open"],
    commands: [":mcp setup", ":mcp on", ":mcp off", ":mcp status", ":mcp policy <off|read|propose>", ":agents"],
    try: { action: "agents.open", needs: "none" },
    kinds: ["agents"],
  }),
  tool({
    id: "proposals", title: "Agent requests", group: "Agents",
    summary: "Review what an agent asks to do, approve or reject it",
    help: {
      answers: "An agent's change, forward or env export waits here as a request; each opens the same dialog as the manual action, with the agent's note marked as unverified.",
      safety: "Nothing an agent asks for runs without your approval; there is no batch or always-allow.",
    },
    actions: ["proposals.next"],
    commands: [":proposals"],
    try: { action: "proposals.next", needs: "none" },
  }),
];

/** Every tool, in hub order. Live: registerTool edits it in place, so readers see new entries. */
export const TOOLS: readonly ToolEntry[] = entries;

const BY_ID = new Map<ToolId, ToolEntry>(entries.map((t) => [t.id, t]));

/**
 * A feature refines its own entry (better help once it is built) or adds a tool whose id it added
 * to ToolId. Same id: replaced in place, keeping its position. Call from register(). The hub
 * renders whatever TOOLS holds.
 */
export function registerTool(spec: ToolSpec): void {
  const t = tool(spec);
  const i = entries.findIndex((e) => e.id === t.id);
  if (i >= 0) entries[i] = t;
  else entries.push(t);
  BY_ID.set(t.id, t);
  notify();
}
export const toolById = (id: string): ToolEntry | undefined => BY_ID.get(id as ToolId);
export const isToolId = (id: string): id is ToolId => BY_ID.has(id as ToolId);

/** The tool a view kind belongs to (the first entry that lists it). */
export function toolForKind(kind: ViewKind): ToolEntry | undefined {
  return TOOLS.find((t) => t.kinds?.includes(kind));
}

/** A text view belongs to the tool that made its text; `doc` (docs/tools.md) belongs to the hub itself. */
const TEXT_SOURCE_TOOL: Readonly<Record<string, ToolId>> = { pack: "pack", snippet: "snippets", bundle: "trap" };

/** The tool a view belongs to: by kind, and for a text view by its source. */
export function toolForView(v: ViewState | null | undefined): ToolEntry | undefined {
  if (!v) return undefined;
  if (v.kind === "text") {
    const id = TEXT_SOURCE_TOOL[v.source.by];
    return id ? BY_ID.get(id) : undefined;
  }
  return toolForKind(v.kind);
}

// ── status hooks ───────────────────────────────────────────────────────────

export interface ToolStatus {
  text: string;
  state: "off" | "ok" | "warn" | "active";
}
export type ToolStatusHook = () => ToolStatus | null;

const statusHooks = new Map<ToolId, ToolStatusHook>();
/**
 * A tool's live status line ("on · 127.0.0.1:7099 · 1 client", "2 armed"). Register from the
 * feature's register(); `use` is a hook (it may read stores) and is called by the hub on render.
 * A later registration replaces an earlier one (the hub's own fallbacks are separate, src/hub/status.ts).
 */
export function registerToolStatus(id: ToolId, use: ToolStatusHook): void {
  statusHooks.set(id, use);
  notify();
}
export const toolStatusHook = (id: ToolId): ToolStatusHook | undefined => statusHooks.get(id);

/** Tools with nothing to report: they act once on what you point at. */
export const STATUSLESS: ReadonlySet<ToolId> = new Set<ToolId>([
  "palette", "panes", "describe-edit", "favourites", "filter", "status-colors",
  "why", "crash", "timeline", "sparklines", "reach", "relations",
  "logs-merged", "logs-structured", "logs-patterns", "snippets", "kubectl",
  "env", "conn-string", "mirrord", "pack",
]);

/**
 * Who registers the status of the other tools: the hub itself (src/hub/status.ts) or the package
 * that builds the tool, from its register(). Every ToolId is in STATUSLESS or here (test).
 */
export const STATUS_BY: Readonly<Partial<Record<ToolId, string>>> = {
  logs: "hub", shell: "hub", "port-forward": "hub", mcp: "H1 (hub fallback)",
  journal: "C2", trap: "C2", rollout: "C3", debug: "F",
  devsets: "B-dev", diff: "D", owners: "D", names: "B2", proposals: "H2",
  "ns-health": "status", "action-log": "status",
};
