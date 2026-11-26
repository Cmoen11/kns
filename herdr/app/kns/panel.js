// The kns panel: live tables of the space's cluster, its health, and actions on a row.
// Logs and shells open as Herdr terminal panes (kns-tui logs / exec); YAML, why, events and
// edits open as dialogs (dialogs.js); changes go through kns, which enforces read-only and
// protected contexts.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, run, theme, settings, readTextFile, exec, openOverlay, notify, nextCommand } from "herdr";
import { Kns, errText } from "./client.js";
import * as M from "./model.js";
import { knsTui } from "./config.js";

const ROW = 26;
/** The columns shown for a resource, besides the name (and Age, CPU, memory at the end). */
const COLUMNS = {
  pods: ["Ready", "Status", "Restarts"],
  deployments: ["Ready", "Available"],
  statefulsets: ["Ready"],
  daemonsets: ["Desired", "Ready"],
  replicasets: ["Desired", "Ready"],
  services: ["Type", "Cluster-IP", "Port(s)"],
  ingresses: ["Hosts", "Address"],
  jobs: ["Status", "Completions", "Duration"],
  cronjobs: ["Schedule", "Suspend", "Active", "Last Schedule"],
  configmaps: ["Data"],
  secrets: ["Type", "Data"],
  nodes: ["Status", "Roles", "Version"],
  events: ["Type", "Reason", "Object"],
};
const SORTS = ["name", "problems", "newest", "cpu", "memory"];

function load(key) {
  try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; }
}

/** A connection error a new sign-in may fix (the same rule as the kns window's looksLikeAuthError). */
function authError(e) {
  if (!e) return false;
  if (e.code === 401) return true;
  return /\b(sso|token|expired|credential|exec plugin|getting credentials|unauthori[sz]ed)\b/i.test(e.message ?? String(e));
}

/** Namespaces used per context, newest first: what a picker offers when listing them is forbidden. */
function recentNamespaces(context) {
  return load(`kns.ns.${context}`) ?? [];
}

function rememberNamespace(context, ns) {
  if (!context || !ns) return;
  const list = [ns, ...recentNamespaces(context).filter((n) => n !== ns)].slice(0, 12);
  localStorage.setItem(`kns.ns.${context}`, JSON.stringify(list));
}

/** `.kns.toml` in `folder` or a parent, up to the git root or the home folder. */
async function findProject(folder) {
  let dir = folder;
  for (let i = 0; dir && i < 12; i++) {
    const text = await readTextFile(`${dir}/.kns.toml`).catch(() => null);
    if (text !== null) return M.parseProject(text);
    if ((await readTextFile(`${dir}/.git/HEAD`).catch(() => null)) !== null) return {};
    if ((await readTextFile(`${dir}/.git`).catch(() => null)) !== null) return {}; // a worktree
    const up = dir.replace(/\/[^/]+\/?$/, "");
    if (!up || up === dir) break;
    dir = up;
  }
  return {};
}

export class Panel {
  init(props, cx) {
    // a pane opened with props {context, namespace, resource} stays on them; others follow the space
    this.pinned = props?.context ? { context: props.context, namespace: props.namespace ?? null, resource: props.resource ?? null } : null;
    this.kns = new Kns((cx) => this.onKns(cx));
    this.handle = cx.focus_handle();
    this.filter = "";
    this.filterInput = InputState.new({ placeholder: "Filter" });
    this.filterInput.on("change", (_e, cx) => { this.filter = this.filterInput.value(); this.cursor = 0; cx.notify(); });
    this.filterInput.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.filterInput.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.filterInput.on("submit", (_e, cx) => { this.handle.focus(); cx.notify(); });
    this.pickInput = InputState.new({ placeholder: "Type to filter" });
    this.pickInput.on("change", (_e, cx) => { this.pickFilter = this.pickInput.value(); this.pickAt = 0; cx.notify(); });
    this.pickInput.on("submit", (_e, cx) => this.choose(this.pickShown()[this.pickAt], cx));

    this.contexts = [];
    this.currentContext = null;
    this.context = null;
    this.namespace = null;
    this.res = M.TABS[0];
    this.resources = [];
    this.flags = {};
    this.server = "";
    this.hasMetrics = false;
    this.metrics = new Map();
    this.table = new M.Table();
    this.sub = null;
    this.gen = 0;
    this.scope = null;
    this.back = [];
    this.cursor = 0;
    this.selected = null;
    this.sort = "name";
    this.picking = null;
    this.pickItems = [];
    this.pickFilter = "";
    this.pickAt = 0;
    this.note = null;
    this.spaceId = undefined;
    this.width = 420;
    this.readyFor = null;
    this.alerts = localStorage.getItem("kns.alerts") === "1";
    this.sso = {};
    this.ssoRead = false;
    this.signingIn = null;
    this.connectError = null;
    this.fallback = null;
    this.seen = new Map();
    this.memo = null;

    this.kns.run(cx);
    cx.timer.every(15000, (cx) => this.pollMetrics(cx));
    cx.timer.every(20000, (cx) => cx.notify()); // ages
    // the AWS sign-in state: a few file reads in kns, no network (someone may sign in in a terminal)
    cx.timer.every(60000, (cx) => cx.spawn(async (cx) => { await this.checkSso(); cx.notify(); }));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.command(c, cx);
        cx.notify();
      }
    });
  }

  close() {
    this.sub?.stop();
    this.kns.close();
  }

  // ── connection and view setup ─────────────────────────────────────────────

  onKns(cx) {
    if (this.kns.ready && this.readyFor !== this.kns.hello) {
      this.readyFor = this.kns.hello;
      cx.spawn(async (cx) => {
        await this.loadContexts();
        await this.applySpace(cx, true);
        cx.notify();
      });
    }
    cx.notify();
  }

  async loadContexts() {
    try {
      const v = await this.kns.call("list_contexts");
      this.contexts = v.contexts ?? [];
      this.currentContext = v.current ?? null;
      await this.checkSso();
    } catch (e) {
      this.say(`kubeconfig: ${errText(e)}`, "error");
    }
  }

  async checkSso() {
    if (!this.kns.ready) return;
    const names = this.contexts.filter((c) => c.awsProfile).map((c) => c.name);
    if (!names.length) { this.sso = {}; this.ssoRead = true; return; }
    try {
      this.sso = (await this.kns.call("aws_sso_status", { contexts: names })) ?? {};
    } catch {
      this.sso = {};
    }
    this.ssoRead = true;
  }

  /** Offers `aws sso login` for a context: an expired or missing token, or a refused connection. */
  needsLogin(context) {
    const info = this.contexts.find((c) => c.name === context);
    if (!info?.awsProfile) return false;
    if (context === this.context && (authError(this.connectError) || (this.table.state === "error" && authError({ message: this.table.message })))) return true;
    if (!this.ssoRead) return false;
    const st = this.sso[context]?.state;
    return st !== "valid" && st !== "refreshable";
  }

  signIn(context, cx) {
    if (this.signingIn) return;
    this.signingIn = context;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // the AWS CLI opens the browser; this returns when the sign-in is done
        await this.kns.call("aws_sso_login", { context });
        this.say(`Signed in for ${context}`, "info");
        await this.checkSso();
        if (this.context === context) await this.switchContext(context, cx, { namespace: this.namespace, res: this.res });
      } catch (e) {
        this.say(`aws sso login: ${errText(e)}`, "error");
      } finally {
        this.signingIn = null;
        cx.notify();
      }
    });
  }

  /** The namespace to show when listing all of them is forbidden: kubeconfig's, else the last used. */
  ownNamespace(context) {
    return this.contexts.find((c) => c.name === context)?.namespace ?? recentNamespaces(context)[0] ?? null;
  }

  /** The active space decides the view: what you picked there before, else its .kns.toml. */
  async applySpace(cx, force = false) {
    const space = spaces().find((s) => s.active);
    if (!force && space?.id === this.spaceId) return;
    this.spaceId = space?.id ?? null;
    if (!this.kns.ready) return;
    const saved = this.pinned ?? (space && load(`kns.view.${space.id}`)) ?? {};
    const project = space?.folder && !space.machine ? await findProject(space.folder) : {};
    const names = this.contexts.map((c) => c.name);
    const pick = [saved.context, project.context, this.currentContext, names[0]].find((c) => c && names.includes(c));
    if (!pick) {
      this.say(this.contexts.length ? "none of the contexts is available" : "no contexts in the kubeconfig", "error");
      return;
    }
    const info = this.contexts.find((c) => c.name === pick);
    let namespace = "namespace" in saved ? saved.namespace : project.namespace ?? info?.namespace ?? null;
    if (namespace === null && localStorage.getItem(`kns.allForbidden.${pick}`) === "1") namespace = this.ownNamespace(pick);
    const res = this.resolve(saved.resource ?? project.resource ?? "pods") ?? M.TABS[0];
    this.back = [];
    this.scope = !saved.resource && project.selector ? { selector: project.selector, label: project.selector } : null;
    await this.switchContext(pick, cx, { namespace, res });
  }

  saveView() {
    if (this.pinned) this.pinned = { context: this.context, namespace: this.namespace, resource: M.resKey(this.res) };
    else if (this.spaceId) localStorage.setItem(`kns.view.${this.spaceId}`, JSON.stringify({ context: this.context, namespace: this.namespace, resource: M.resKey(this.res) }));
  }

  async switchContext(context, cx, { namespace = null, res = this.res } = {}) {
    const gen = ++this.gen;
    this.sub?.stop();
    this.sub = null;
    this.context = context;
    this.namespace = namespace;
    this.res = res;
    this.table = new M.Table();
    this.metrics = new Map();
    this.server = "";
    this.flags = {};
    cx.notify();
    try {
      const info = await this.kns.call("connect", { context });
      if (gen !== this.gen) return;
      this.server = info.serverVersion ?? "";
      this.hasMetrics = Boolean(info.hasMetrics);
      this.connectError = null;
    } catch (e) {
      if (gen !== this.gen) return;
      this.connectError = e;
      if (authError(e)) await this.checkSso();
      this.table.state = "error";
      this.table.message = errText(e);
      return cx.notify();
    }
    this.flags = await this.kns.call("context_flags", { context }).catch(() => ({}));
    const found = await this.kns.call("discover", { context }).catch(() => []);
    if (gen !== this.gen) return;
    this.resources = (found ?? []).map(M.fromDiscovery).filter(Boolean);
    // the tab may have been a guess before discovery: take the cluster's version of it
    this.res = this.resolve(M.resKey(this.res)) ?? this.res;
    await this.subscribe(cx);
  }

  /** A tab or discovered resource by plural, `plural.group`, kind or short name. */
  resolve(name) {
    const n = String(name ?? "").toLowerCase();
    if (!n) return null;
    const hit = (r) => r.resource === n || M.resKey(r) === n || r.kind?.toLowerCase() === n || (r.short ?? []).includes(n) || r.label?.toLowerCase() === n;
    const rank = (r) => (r.group === "" ? 0 : r.group === "apps" ? 1 : r.group === "batch" ? 2 : r.group.endsWith(".k8s.io") ? 4 : 3);
    const found = this.resources.filter(hit).sort((a, b) => rank(a) - rank(b))[0];
    const tab = M.TABS.find(hit) ?? M.TABS.find((t) => (n === "po" && t.resource === "pods") || (n === "deploy" && t.resource === "deployments") || (n === "svc" && t.resource === "services"));
    return found ? { ...found, label: tab?.label ?? found.label } : tab ?? null;
  }

  async subscribe(cx) {
    const gen = ++this.gen;
    this.sub?.stop();
    this.sub = null;
    this.table = new M.Table();
    this.cursor = 0;
    this.selected = null;
    this.seen = new Map();
    this.memo = null;
    cx.notify();
    if (!this.kns.ready || !this.context) return;
    const query = {
      context: this.context,
      gvr: M.gvr(this.res),
      namespace: this.res.namespaced ? this.namespace : null,
      labelSelector: this.scope?.selector ?? null,
      fieldSelector: this.scope?.field ?? null,
    };
    try {
      const sub = await this.kns.stream("subscribe_table", { query }, (ev) => {
        if (gen !== this.gen) return;
        this.table.apply(ev);
        if (ev?.type === "disconnected") this.sub = null;
        if (ev?.type === "snapshot" && query.namespace) rememberNamespace(query.context, query.namespace);
        // RBAC grants one namespace, not all of them: remember it and show that one (as kns does)
        if (ev?.type === "state" && ev.state === "forbidden" && this.res.namespaced && query.namespace === null) {
          localStorage.setItem(`kns.allForbidden.${query.context}`, "1");
          const own = this.ownNamespace(query.context);
          if (own) this.fallback = { context: query.context, namespace: own, label: this.res.label.toLowerCase() };
        }
        this.watchHealth();
      });
      if (gen !== this.gen) return sub.stop();
      this.sub = sub;
    } catch (e) {
      if (gen !== this.gen) return;
      this.table.state = "error";
      this.table.message = errText(e);
    }
    this.pollMetrics(cx);
    cx.notify();
  }

  pollMetrics(cx) {
    if (!this.kns.ready || !this.hasMetrics || !this.context) return;
    const pods = M.is(this.res, "", "pods"), nodes = M.is(this.res, "", "nodes");
    if (!pods && !nodes) return;
    const gen = this.gen;
    cx.spawn(async (cx) => {
      try {
        const list = pods
          ? await this.kns.call("pod_metrics", { context: this.context, namespace: this.res.namespaced ? this.namespace : null })
          : await this.kns.call("node_metrics", { context: this.context });
        if (gen !== this.gen) return;
        this.metrics = new Map((list ?? []).map((m) => [`${m.namespace ?? ""}/${m.name}`, m]));
        this.memo = null;
        cx.notify();
      } catch {
        this.hasMetrics = false;
      }
    });
  }

  /** With alerts on: a pod that turns red after the first snapshot posts a notification. */
  watchHealth() {
    if (!M.is(this.res, "", "pods") || this.table.state !== "live") return;
    const first = this.seen.size === 0;
    for (const r of this.table.rows) {
      const h = M.health(this.table, r), before = this.seen.get(r.uid);
      if (this.alerts && !first && h === M.BAD && before !== undefined && before !== M.BAD) {
        notify({ title: `${r.name} is failing`, body: `${this.table.cell(r, "Status")} · ${this.context}${r.namespace ? ` / ${r.namespace}` : ""}`, level: "error", timeout: 8000 });
      }
      this.seen.set(r.uid, h);
    }
  }

  // ── rows ─────────────────────────────────────────────────────────────────

  rows() {
    const key = `${this.table.version}|${this.filter}|${this.sort}|${this.metrics.size}|${this.table.rows.length}`;
    if (this.memo?.key === key) return this.memo.rows;
    const t = this.table;
    const list = t.rows.filter((r) => M.matches(r, this.filter)).map((r) => ({ r, h: M.health(t, r), m: this.metrics.get(`${r.namespace ?? ""}/${r.name}`) }));
    const byName = (a, b) => (a.r.namespace ?? "").localeCompare(b.r.namespace ?? "") || a.r.name.localeCompare(b.r.name);
    const sorts = {
      name: byName,
      problems: (a, b) => b.h - a.h || byName(a, b),
      newest: (a, b) => (b.r.created ?? "").localeCompare(a.r.created ?? "") || byName(a, b),
      cpu: (a, b) => (b.m?.cpuMilli ?? -1) - (a.m?.cpuMilli ?? -1) || byName(a, b),
      memory: (a, b) => (b.m?.memBytes ?? -1) - (a.m?.memBytes ?? -1) || byName(a, b),
    };
    list.sort(sorts[this.sort] ?? byName);
    this.memo = { key, rows: list };
    return list;
  }

  current() {
    const rows = this.rows();
    if (this.selected) {
      const i = rows.findIndex((x) => x.r.uid === this.selected);
      if (i >= 0) this.cursor = i;
    }
    this.cursor = Math.max(0, Math.min(this.cursor, rows.length - 1));
    return rows[this.cursor] ?? null;
  }

  /** A click selects; a second click on the same row within 400 ms opens it (pods: logs). */
  rowClick(uid, cx) {
    const rows = this.rows(), i = rows.findIndex((x) => x.r.uid === uid);
    if (i < 0) return;
    const now = Date.now(), again = this.lastClick?.uid === uid && now - this.lastClick.at < 400;
    this.lastClick = { uid, at: now };
    this.select(i, cx);
    this.handle.focus();
    if (again) {
      const y = rows[i];
      const open = this.actions(y).find((a) => a.key === "⏎");
      if (open) open.fn(cx);
      else if (M.is(this.res, "", "pods")) this.logs(y, false);
    }
  }

  select(i, cx) {
    const rows = this.rows();
    this.cursor = Math.max(0, Math.min(i, rows.length - 1));
    this.selected = rows[this.cursor]?.r.uid ?? null;
    cx.notify();
  }

  // ── actions ──────────────────────────────────────────────────────────────

  actions(x) {
    if (!x) return [];
    const r = this.res, row = x.r, kind = r.resource;
    const obj = M.objRef(this.context, r, row), lbl = M.label(r, row.name);
    const pods = M.is(r, "", "pods"), workload = M.WORKLOADS.includes(kind) && r.group !== "" ;
    const ro = this.flags.readOnly;
    const a = [];
    const add = (id, text, key, fn, opts = {}) => a.push({ id, text, key, fn, ...opts });
    if (workload || M.is(r, "", "services") || M.is(r, "", "nodes")) add("pods", "Pods", "⏎", (cx) => this.drill(x, cx));
    if (M.is(r, "batch", "cronjobs")) add("jobs", "Jobs", "⏎", (cx) => this.drill(x, cx));
    if (pods || workload) add("logs", "Logs", "l", () => this.logs(x, false));
    if (pods) add("prev", "Previous logs", "p", () => this.logs(x, true));
    if (pods || workload) add("shell", "Shell", "s", () => this.shell(x));
    add("yaml", "YAML", "y", () => this.doc("yaml", obj, lbl));
    if (!ro) add("edit", "Edit", "e", () => this.edit(obj, lbl), { write: true });
    if (pods || workload || ["services", "ingresses", "cronjobs", "nodes"].includes(kind) || r.group.includes("fluxcd") || r.group.includes("argoproj")) add("why", "Why", "d", () => this.doc("why", obj, lbl));
    add("events", "Events", "E", () => this.doc("events", obj, lbl));
    if (M.is(r, "", "secrets")) add("decode", "Decode", "x", () => this.doc("secret", obj, lbl));
    if (pods || workload || M.is(r, "", "services")) add("forward", "Forward", "F", () => this.action("forward", obj, lbl, { kind: pods ? "pod" : M.is(r, "", "services") ? "service" : "workload", gvr: M.gvr(r) }));
    if (!ro) {
      if (["deployments", "statefulsets", "daemonsets"].includes(kind) && r.group === "apps") add("restart", "Restart", "r", () => this.action("restart", obj, lbl), { write: true });
      if (["deployments", "statefulsets", "replicasets"].includes(kind) && r.group === "apps") add("scale", "Scale", "S", () => this.action("scale", obj, lbl, { replicas: Number(row.cells[r.resource === "replicasets" ? 1 : 0]?.split("/")[1]) || null }), { write: true });
      if ((["deployments", "statefulsets", "daemonsets", "replicasets"].includes(kind) && r.group === "apps") || M.is(r, "batch", "cronjobs") || pods) add("image", "Set image", "i", () => this.action("image", obj, lbl, { res: kind }), { write: true });
      if (M.is(r, "batch", "cronjobs")) add("trigger", "Run now", "t", () => this.action("trigger", obj, lbl), { write: true });
      add("delete", "Delete", "D", () => this.action("delete", obj, lbl), { write: true, danger: true });
    }
    return a;
  }

  /** Workload/service → its pods, node → pods on it, CronJob → jobs; Esc goes back. */
  drill(x, cx) {
    const r = this.res, row = x.r, lbl = M.label(r, row.name);
    const go = (res, scope) => {
      this.back.push({ res: this.res, scope: this.scope, namespace: this.namespace, filter: this.filter });
      this.res = res;
      this.scope = scope;
      if (row.namespace) this.namespace = row.namespace;
      this.filterInput.set_value("");
      this.filter = "";
      this.subscribe(cx);
    };
    if (M.is(r, "", "nodes")) return go(this.resolve("pods"), { field: `spec.nodeName=${row.name}`, label: `on ${lbl}` });
    if (M.is(r, "batch", "cronjobs")) return go(this.resolve("jobs"), { label: `jobs in ${row.namespace} (of ${lbl} and others)` });
    cx.spawn(async (cx) => {
      try {
        const obj = await this.kns.call("get_json", { objRef: M.objRef(this.context, r, row) });
        const selector = M.selectorOf(obj);
        if (!selector) return this.say(`${lbl} has no pod selector`, "warning", cx);
        go(this.resolve("pods"), { selector, label: `of ${lbl}` });
      } catch (e) {
        this.say(errText(e), "error", cx);
      }
    });
  }

  goBack(cx) {
    const prev = this.back.pop();
    if (!prev) return false;
    Object.assign(this, { res: prev.res, scope: prev.scope, namespace: prev.namespace, filter: prev.filter });
    this.filterInput.set_value(prev.filter ?? "");
    this.subscribe(cx);
    return true;
  }

  /** A real terminal for logs and shells: split the focused pane, else a new tab. */
  terminal(args, name) {
    const before = new Set(panes().map((p) => p.pane));
    const argv = [knsTui(), ...args];
    const f = focused();
    if (f?.pane) run("pane.split", { direction: "down", pane: f.pane, argv });
    else run("tab.new", { name, argv });
    this.pendingRename = { before, name, tries: 0 };
  }

  /** Names the pane a split made once it shows up (`run` returns nothing to go by). */
  renamePending(cx) {
    const p = this.pendingRename;
    if (!p) return;
    const fresh = panes().find((x) => !p.before.has(x.pane) && x.terminal);
    if (fresh) {
      run("pane.rename", { pane: fresh.pane, name: p.name });
      this.pendingRename = null;
    } else if (++p.tries > 40) this.pendingRename = null;
    else cx.spawn(async (cx) => { await cx.sleep(100); this.renamePending(cx); });
  }

  logs(x, previous) {
    const r = this.res, row = x.r, args = ["logs", "--context", this.context];
    if (M.is(r, "", "pods")) args.push(`${row.namespace}/${row.name}`);
    else args.push("--workload", `${row.namespace}/${M.resKey(r)}/${row.name}`);
    if (previous) args.push("--previous");
    this.terminal(args, `${previous ? "prev " : ""}logs ${row.name}`);
  }

  shell(x) {
    const r = this.res, row = x.r;
    if (M.is(r, "", "pods")) return this.terminal(["exec", "--context", this.context, `${row.namespace}/${row.name}`], `shell ${row.name}`);
    // a workload: its first running pod
    this.kns.call("pods_for", { objRef: M.objRef(this.context, r, row) }).then((pods) => {
      const p = (pods ?? []).find((p) => p.phase === "Running") ?? (pods ?? [])[0];
      if (!p) return this.say(`${row.name} has no pod to open a shell in`, "warning");
      this.terminal(["exec", "--context", this.context, `${p.namespace}/${p.name}`], `shell ${p.name}`);
    }, (e) => this.say(errText(e), "error"));
  }

  doc(doc, obj, lbl) {
    openOverlay({ mod: "kns", kind: "dialog", width: 0.72, height: 0.82, props: { view: "doc", doc, obj, label: lbl } });
  }

  edit(obj, lbl) {
    openOverlay({ mod: "kns", kind: "dialog", modal: true, width: 0.82, height: 0.88, props: { view: "edit", obj, label: lbl, context: this.context, flags: this.flags } });
  }

  newManifest() {
    if (!this.context) return;
    openOverlay({ mod: "kns", kind: "dialog", modal: true, width: 0.82, height: 0.88, props: { view: "edit", obj: null, label: "new manifest", context: this.context, flags: this.flags, namespace: this.namespace } });
  }

  action(action, obj, lbl, extra = {}) {
    openOverlay({ mod: "kns", kind: "dialog", width: 540, props: { view: "action", action, obj, label: lbl, context: this.context, flags: this.flags, ...extra } });
  }

  say(text, level = "info", cx = null) {
    this.note = { text, level, at: Date.now() };
    cx?.notify();
  }

  command(c, cx) {
    if (c === "focus") this.handle.focus();
    else if (c === "new") this.newManifest();
    else if (c === "refresh") this.subscribe(cx);
    else if (c === "window") exec(knsTui(), ["open"]).catch(() => {});
  }

  // ── pickers ──────────────────────────────────────────────────────────────

  pick(kind, cx) {
    this.picking = kind;
    this.pickFilter = "";
    this.pickInput.set_value("");
    this.pickAt = 0;
    this.pickNote = null;
    if (kind === "context") {
      this.pickItems = this.contexts.map((c) => ({
        value: c.name,
        text: c.name,
        hint: this.needsLogin(c.name) ? "sign-in needed" : c.name === this.currentContext ? "kubeconfig current" : c.namespace ?? "",
      }));
      this.pickAt = Math.max(0, this.pickItems.findIndex((i) => i.value === this.context));
    } else if (kind === "resource") {
      const seen = new Set();
      this.pickItems = this.resources
        .filter((r) => !seen.has(M.resKey(r)) && seen.add(M.resKey(r)))
        .map((r) => ({ value: M.resKey(r), text: r.kind || r.resource, hint: M.resKey(r) }))
        .sort((a, b) => a.text.localeCompare(b.text));
    } else {
      this.pickItems = [{ value: null, text: "All namespaces", hint: "" }];
      const gen = this.gen;
      const query = { context: this.context, gvr: { group: "", version: "v1", resource: "namespaces" } };
      cx.spawn(async (cx) => {
        let sub = null;
        try {
          sub = await this.kns.stream("subscribe_table", { query }, (ev) => {
            if (this.picking !== "namespace" || gen !== this.gen) return;
            if (ev?.type === "state" && (ev.state === "forbidden" || ev.state === "error")) {
              const known = [this.ownNamespace(this.context), ...recentNamespaces(this.context)].filter(Boolean);
              this.pickItems = [...new Set(known)].map((n) => ({ value: n, text: n, hint: n === this.contexts.find((c) => c.name === this.context)?.namespace ? "kubeconfig" : "used before" }));
              if (localStorage.getItem(`kns.allForbidden.${this.context}`) !== "1") this.pickItems.unshift({ value: null, text: "All namespaces", hint: "" });
              this.pickNote = "You may not list namespaces here: these are kubeconfig's and the ones you used. Type any other name.";
              sub?.stop();
              return;
            }
            if (ev?.type !== "snapshot") return;
            const names = (ev.rows ?? []).map((r) => r.name).sort();
            this.pickItems = [{ value: null, text: "All namespaces", hint: "" }, ...names.map((n) => ({ value: n, text: n, hint: "" }))];
            this.pickAt = Math.max(0, this.pickItems.findIndex((i) => i.value === this.namespace));
            sub?.stop();
          });
        } catch (e) {
          this.say(`cannot list namespaces (${errText(e)}): pick a resource tab or type the name`, "warning", cx);
        }
        await cx.sleep(4000);
        sub?.stop();
      });
    }
    this.pickInput.focus();
    cx.notify();
  }

  pickShown() {
    const f = this.pickFilter.toLowerCase();
    if (!f) return this.pickItems;
    const shown = this.pickItems.filter((i) => `${i.text} ${i.hint}`.toLowerCase().includes(f));
    // a namespace nobody may list can still be typed
    if (this.picking === "namespace" && !shown.some((i) => i.value === this.pickFilter)) shown.push({ value: this.pickFilter, text: this.pickFilter, hint: "use this name" });
    return shown;
  }

  choose(item, cx) {
    const kind = this.picking;
    this.picking = null;
    this.handle.focus();
    if (!item) return cx.notify();
    this.back = [];
    this.scope = null;
    if (kind === "context") {
      const info = this.contexts.find((c) => c.name === item.value);
      this.switchContext(item.value, cx, { namespace: info?.namespace ?? null, res: this.res }).then(() => this.saveView());
    } else if (kind === "namespace") {
      this.namespace = item.value;
      if (!this.res.namespaced) this.res = M.TABS[0];
      this.saveView();
      this.subscribe(cx);
    } else {
      this.res = this.resolve(item.value) ?? this.res;
      this.saveView();
      this.subscribe(cx);
    }
    cx.notify();
  }

  // ── keys ─────────────────────────────────────────────────────────────────

  key(e, cx) {
    const k = e.key, mods = e.modifiers ?? {};
    if (this.picking) {
      const shown = this.pickShown();
      if (k === "escape") { this.picking = null; this.handle.focus(); }
      else if (k === "down") this.pickAt = Math.min(this.pickAt + 1, shown.length - 1);
      else if (k === "up") this.pickAt = Math.max(this.pickAt - 1, 0);
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
    if (this.typing) {
      if (k === "escape" || k === "down") { this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      return;
    }
    if (mods.control || mods.platform || mods.alt) return;
    const rows = this.rows(), x = this.current();
    const page = Math.max(1, Math.floor((this.listHeight ?? 300) / ROW) - 1);
    const act = (id) => this.actions(x).find((a) => a.id === id)?.fn(cx);
    switch (k === "shift" ? "" : e.key_char ?? k) {
      case "j": case "down": this.select(this.cursor + 1, cx); break;
      case "k": case "up": this.select(this.cursor - 1, cx); break;
      case "pagedown": this.select(this.cursor + page, cx); break;
      case "pageup": this.select(this.cursor - page, cx); break;
      case "g": case "home": this.select(0, cx); break;
      case "G": case "end": this.select(rows.length - 1, cx); break;
      case "/": this.filterInput.focus(); break;
      case "c": this.pick("context", cx); break;
      case "n": this.pick("namespace", cx); break;
      case ":": this.pick("resource", cx); break;
      case "o": this.sort = SORTS[(SORTS.indexOf(this.sort) + 1) % SORTS.length]; this.memo = null; break;
      case "R": this.subscribe(cx); break;
      case "N": this.newManifest(); break;
      case "enter": case "\r": act("pods") ?? act("jobs") ?? (x && M.is(this.res, "", "pods") ? this.logs(x, false) : null); break;
      case "escape":
        if (this.filter) { this.filterInput.set_value(""); this.filter = ""; this.memo = null; }
        else this.goBack(cx);
        break;
      default: {
        const a = this.actions(x).find((a) => a.key === (e.key_char ?? k) && a.key !== "⏎");
        if (!a) return;
        a.fn(cx);
      }
    }
    cx.stop_propagation();
    cx.notify();
  }

  // ── drawing ──────────────────────────────────────────────────────────────

  render(cx) {
    const t = theme();
    const space = spaces().find((s) => s.active);
    if (!this.pinned && space?.id !== this.spaceId && this.kns.ready && this.contexts.length) cx.spawn(async (cx) => { await this.applySpace(cx); cx.notify(); });
    if (this.pendingRename) this.renamePending(cx);
    if (this.fallback) {
      const f = this.fallback;
      this.fallback = null;
      if (f.context === this.context && this.namespace === null) {
        this.namespace = f.namespace;
        this.say(`Listing ${f.label} in all namespaces is forbidden: showing ${f.namespace}`, "warning");
        this.subscribe(cx);
      }
    }
    return v_flex().id("kns-root").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12.5)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => { if (!this.typing && !this.picking) this.handle.focus(); })
      .on_size_change((size, cx) => { this.width = size.width / (settings().zoom ?? 1); cx.notify(); })
      .child(this.header(t))
      .child(this.kns.ready ? this.body(t, cx) : this.offline(t));
  }

  header(t) {
    const st = this.kns.ready ? this.table.state : this.kns.state;
    const dot = { live: t.ansi2, syncing: t.dim, reconnecting: t.blocked, connecting: t.dim, starting: t.dim, forbidden: t.ansi1, error: t.ansi1, off: t.dim, down: t.ansi1 }[st] ?? t.dim;
    const rows = this.kns.ready ? this.table.rows : [];
    const bad = rows.filter((r) => M.health(this.table, r) === M.BAD).length;
    const warn = rows.filter((r) => M.health(this.table, r) === M.WARN).length;
    const chip = (id, text, onClick, accent) => h_flex().id(id).h(24).px(8).gap(5).items_center().rounded(6).border_1().border_color(accent ?? t.border).bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover)).min_w(0)
      .on_click((_e, cx) => onClick(cx)).child(div().truncate().child(text)).child(div().text_size(9).text_color(t.dim).child("▾"));
    return v_flex().flex_none().px(10).pt(9).pb(6).gap(6).border_b(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().gap(6).items_center()
        .child(div().font_bold().text_color(t.accent).child("kns"))
        .when(this.kns.ready && Boolean(this.context), (el) => el
          .child(chip("ctx", this.context, (cx) => this.pick("context", cx), this.flags.protected ? t.blocked : this.flags.readOnly ? t.dim : null))
          .when(this.res.namespaced, (el) => el.child(chip("ns", this.namespace ?? "all namespaces", (cx) => this.pick("namespace", cx)))))
        .child(div().flex_1())
        .when(bad > 0, (el) => el.child(div().text_size(11).text_color(t.ansi1).child(`✗ ${bad}`)))
        .when(warn > 0, (el) => el.child(div().text_size(11).text_color(t.blocked).child(`~ ${warn}`)))
        .child(div().size(7).rounded(4).bg(dot).tooltip(this.table.message ?? st)))
      .when(this.kns.ready && Boolean(this.context) && this.needsLogin(this.context), (el) => el.child(h_flex().gap(8).items_center().px(8).py(5).rounded(6).bg(t.raised).border_1().border_color(t.blocked)
        .child(div().flex_1().min_w(0).text_size(11.5).child(this.signingIn === this.context ? "Signing in: finish it in the browser…" : `Not signed in to AWS for ${this.context}`))
        .when(this.signingIn !== this.context, (el) => el.child(div().id("sso-login").h(24).px(10).flex().items_center().rounded(6).bg(t.solid).text_color(t.solid_foreground).text_size(11.5).cursor_pointer()
          .hover((s) => s.opacity(0.88)).on_click((_e, cx) => this.signIn(this.context, cx)).child("Sign in")))))
      .when(this.kns.ready && (this.flags.protected || this.flags.readOnly), (el) => el.child(div().text_size(11).text_color(this.flags.readOnly ? t.dim : t.blocked)
        .child(this.flags.readOnly ? "read-only context: changes are refused" : "protected context: changes ask for its name")))
      .when(this.kns.ready, (el) => el.child(this.tabs(t)));
  }

  tabs(t) {
    const tab = (r, i) => {
      const on = M.resKey(r) === M.resKey(this.res) && !this.scope;
      return div().id(`tab-${i}`).px(7).py(3).rounded(5).flex_none().cursor_pointer().text_size(11.5)
        .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected).font_semibold()).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.back = []; this.scope = null; this.res = this.resolve(M.resKey(r)) ?? r; this.saveView(); this.subscribe(cx); })
        .child(r.label);
    };
    const known = M.TABS.some((x) => M.resKey(x) === M.resKey(this.res));
    return h_flex().id("tabs").gap(2).items_center().overflow_x_scroll()
      .children(M.TABS.filter((r) => !r.namespaced || true).map(tab))
      .when(!known, (el) => el.child(tab(this.res, "extra")))
      .child(div().id("tab-more").px(7).py(3).rounded(5).flex_none().cursor_pointer().text_size(11.5).text_color(t.dim).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.pick("resource", cx)).child("More…"));
  }

  offline(t) {
    const s = this.kns.state;
    const text = {
      connecting: "Connecting to kns…",
      starting: "Starting kns in the background…",
      off: "kns runs, but its connection for Herdr is off.",
      down: "kns is not running.",
      closed: "Closed.",
    }[s] ?? s;
    const button = (id, label, fn) => div().id(id).h(30).px(14).flex().items_center().rounded(8).bg(t.solid).text_color(t.solid_foreground).cursor_pointer().hover((x) => x.opacity(0.88))
      .on_click((_e, cx) => fn(cx)).child(label);
    return v_flex().flex_1().p(16).gap(10).items_start()
      .child(div().text_color(t.muted).child(text))
      .when(Boolean(this.kns.error), (el) => el.child(div().text_size(11.5).text_color(t.ansi1).child(this.kns.error)))
      .when(s === "off", (el) => el.child(button("tcp-on", "Turn on", (cx) => cx.spawn(async () => { await exec(knsTui(), ["tcp", "on"]).catch(() => null); this.kns.retry(); }))))
      .when(s === "down", (el) => el.child(button("start", "Start kns", (cx) => { this.kns.retry(); cx.notify(); })))
      .child(div().text_size(11).text_color(t.dim).child(`kns-tui: ${knsTui()}`));
  }

  body(t, cx) {
    const rows = this.rows(), x = this.current(), size = settings().ui_font_size ?? 13;
    const narrow = this.width < 380;
    const cols = (COLUMNS[this.res.resource] ?? this.table.columns.filter((c) => !/^(name|age|namespace)$/i.test(c.name)).slice(0, 3).map((c) => c.name))
      .filter((c) => this.table.column(c) !== null)
      .slice(0, narrow ? 2 : 4);
    const metrics = this.metrics.size > 0 && (M.is(this.res, "", "pods") || M.is(this.res, "", "nodes"));
    const allNs = this.res.namespaced && this.namespace === null;
    const widthOf = (name, cells) => Math.min(150, Math.max(name.length, ...cells.slice(0, 200).map((c) => c.length)) * 6.6 + 10);
    const colW = cols.map((c) => widthOf(c, rows.map((y) => this.table.cell(y.r, c))));
    const now = Date.now();
    const color = (h) => (h === M.BAD ? t.ansi1 : h === M.WARN ? t.blocked : h === M.DONE ? t.dim : t.foreground);

    const line = (y, i) => {
      const on = i === this.cursor, r = y.r;
      // no handlers in a virtual list's rows (Herdr refuses them): clicks arrive at on_item_click
      return h_flex().h(ROW).flex_none().px(10).gap(8).items_center().cursor_pointer()
        .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .child(div().size(6).rounded(3).flex_none().bg(y.h === M.BAD ? t.ansi1 : y.h === M.WARN ? t.blocked : y.h === M.DONE ? t.dim : t.ansi2))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_color(r.deleting ? t.dim : color(y.h)).child(r.name))
          .when(allNs, (el) => el.child(div().truncate().text_size(10.5).text_color(t.dim).child(r.namespace ?? ""))))
        .children(cols.map((c, ci) => div().w(colW[ci]).flex_none().truncate().text_size(11.5)
          .text_color(c === "Status" && y.h !== M.OK ? color(y.h) : t.muted).child(this.table.cell(r, c))))
        .when(metrics, (el) => el
          .child(div().w(44).flex_none().text_right().text_size(11).text_color(t.dim).child(y.m ? M.fmtCpu(y.m.cpuMilli) : ""))
          .child(div().w(48).flex_none().text_right().text_size(11).text_color(t.dim).child(y.m ? M.fmtMem(y.m.memBytes) : "")))
        .child(div().w(30).flex_none().text_right().text_size(11).text_color(t.dim).child(M.age(r.created, now)));
    };

    const head = h_flex().h(22).flex_none().px(10).gap(8).items_center().text_size(10.5).text_color(t.dim).border_b(1).border_color(t.border)
      .child(div().w(6).flex_none())
      .child(div().flex_1().child(`${rows.length}${this.filter ? ` of ${this.table.rows.length}` : ""} ${this.res.label.toLowerCase()}`))
      .children(cols.map((c, ci) => div().w(colW[ci]).flex_none().truncate().child(c.toUpperCase())))
      .when(metrics, (el) => el.child(div().w(44).flex_none().text_right().child("CPU")).child(div().w(48).flex_none().text_right().child("MEM")))
      .child(div().w(30).flex_none().text_right().child("AGE"));

    const empty = (text) => div().p(12).text_color(t.dim).child(text);
    const listArea = this.picking ? this.picker(t) : div().flex_1().min_h(0).relative()
      .on_size_change((s, cx) => { this.listHeight = s.height / (settings().zoom ?? 1); })
      // a virtual list needs a definite height: pinned to the area, not sized by a flex chain
      .when(rows.length > 0, (el) => el
        .child(div().absolute().inset_0()
          .child(v_virtual_list("kns-rows", rows.length, ROW, (i) => rows[i].r.uid, (range) => rows.slice(range.start, range.end).map((y, k) => line(y, range.start + k)))
            .on_item_click((uid, cx) => this.rowClick(uid, cx))
            .size_full()))
        .child(Scrollbar.vertical("kns-rows").absolute().inset_0()))
      .when(rows.length === 0, (el) => el.child(empty(
        this.table.state === "syncing" ? "Loading…"
          : this.table.state === "live" ? (this.filter ? "Nothing matches the filter" : "Nothing here")
            : this.table.state === "forbidden" && this.res.namespaced && this.namespace === null
              ? `You may not list ${this.res.label.toLowerCase()} in all namespaces of ${this.context}: pick a namespace (n).`
              : this.table.state === "forbidden" ? `You may not list ${this.res.label.toLowerCase()} here (${this.table.message ?? "forbidden"}).`
                : this.table.message ?? this.table.state)));

    return v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().px(10).py(6).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().id("filter").flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(6).border_1().border_color(this.typing ? t.accent : t.border).bg(t.background)
          .on_mouse_down("left", (_e, cx) => { this.filterInput.focus(); cx.stop_propagation(); })
          .child(Input.new(this.filterInput).h_full().text_size(12)))
        .child(div().id("sort").px(6).h(26).flex().items_center().rounded(6).cursor_pointer().text_size(11).text_color(this.sort === "name" ? t.dim : t.foreground).hover((s) => s.bg(t.hover))
          .tooltip("Sort (o)").on_click((_e, cx) => { this.sort = SORTS[(SORTS.indexOf(this.sort) + 1) % SORTS.length]; this.memo = null; cx.notify(); }).child(`↕ ${this.sort}`))
        .child(div().id("alerts").px(6).h(26).flex().items_center().rounded(6).cursor_pointer().text_size(11).text_color(this.alerts ? t.foreground : t.dim).hover((s) => s.bg(t.hover))
          .tooltip(this.alerts ? "Notify when a pod starts failing: on" : "Notify when a pod starts failing: off")
          .on_click((_e, cx) => { this.alerts = !this.alerts; localStorage.setItem("kns.alerts", this.alerts ? "1" : "0"); cx.notify(); }).child(this.alerts ? "🔔" : "🔕")))
      .when(Boolean(this.scope), (el) => el.child(h_flex().flex_none().px(10).py(4).gap(6).items_center().bg(t.raised).border_b(1).border_color(t.border)
        .child(div().id("back").cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { if (!this.goBack(cx)) { this.scope = null; this.subscribe(cx); } }).child("←"))
        .child(div().flex_1().truncate().text_size(11.5).child(`${this.res.label} ${this.scope.label}`))))
      .when(!this.picking && rows.length > 0, (el) => el.child(head))
      .child(listArea)
      .child(this.footer(t, x));
  }

  picker(t) {
    const shown = this.pickShown();
    this.pickAt = Math.max(0, Math.min(this.pickAt, shown.length - 1));
    return v_flex().flex_1().min_h(0).p(8).gap(6)
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(11).text_color(t.dim).child({ context: "Context", namespace: "Namespace", resource: "Resource" }[this.picking]))
        .child(div().flex_1())
        .child(div().id("pick-close").text_size(11).text_color(t.dim).cursor_pointer().on_click((_e, cx) => { this.picking = null; this.handle.focus(); cx.notify(); }).child("Esc")))
      .child(div().h(30).px(8).flex().items_center().rounded(7).border_1().border_color(t.accent).bg(t.background).child(Input.new(this.pickInput).h_full().text_size(12.5)))
      .when(Boolean(this.pickNote), (el) => el.child(div().text_size(11).text_color(t.dim).child(this.pickNote)))
      .child(v_flex().id("pick-list").flex_1().min_h(0).overflow_y_scrollbar()
        .children(shown.slice(0, 500).map((item, i) => h_flex().id(`pick-${i}`).h(26).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .when(i === this.pickAt, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.choose(item, cx))
          .child(div().flex_1().truncate().when(item.value === (this.picking === "context" ? this.context : this.picking === "namespace" ? this.namespace : M.resKey(this.res)), (el) => el.font_semibold()).child(item.text))
          .child(div().text_size(10.5).text_color(t.dim).truncate().child(item.hint ?? "")))));
  }

  footer(t, x) {
    const note = this.note && Date.now() - this.note.at < 8000 ? this.note : null;
    const acts = this.actions(x);
    const button = (a) => h_flex().id(`act-${a.id}`).h(24).px(8).gap(5).items_center().rounded(6).flex_none().cursor_pointer()
      .border_1().border_color(a.danger ? t.ansi1 + "66" : t.border).bg(t.raised).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { a.fn(cx); cx.notify(); })
      .child(div().text_size(11.5).text_color(a.danger ? t.ansi1 : t.foreground).child(a.text))
      .child(div().text_size(10).text_color(t.dim).child(a.key));
    return v_flex().flex_none().border_t(1).border_color(t.border).bg(t.chrome)
      .when(Boolean(x) && !this.picking, (el) => el.child(v_flex().px(10).pt(7).pb(8).gap(6)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().truncate().font_semibold().child(M.label(this.res, x.r.name)))
          .when(Boolean(x.r.namespace), (el) => el.child(div().text_size(11).text_color(t.dim).truncate().child(x.r.namespace))))
        .child(h_flex().gap(5).flex_wrap().children(acts.map(button)))))
      .when(Boolean(note), (el) => el.child(div().px(10).pb(6).text_size(11.5).text_color(note.level === "error" ? t.ansi1 : note.level === "warning" ? t.blocked : t.muted).child(note.text)))
      .when(!x && !note, (el) => el.child(h_flex().px(10).py(6).gap(10).text_size(11).text_color(t.dim)
        .child("c context").child("n namespace").child(": resource").child("/ filter").child("N new")));
  }
}
