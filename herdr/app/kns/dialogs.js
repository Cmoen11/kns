// The dialogs the panel opens (openOverlay with props.view): a read-only document (YAML, why,
// events, a decoded Secret), the edit → review → apply flow, and one confirmed action
// (restart, scale, image, delete, run now, port-forward). Each dialog has its own connection.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Editor, EditorState, TextView, Scrollbar, v_virtual_list } from "gpui-base";
import { props, closeOverlay, theme, settings, notify } from "herdr";
import { Kns, errText } from "./client.js";
import * as M from "./model.js";
import { unified, merge3, conflictLines } from "./diff.js";

const syntax = (t) => ({ keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, boolean: t.ansi1 });

function button(t, id, text, onClick, { primary = false, danger = false, disabled = false } = {}) {
  const bg = disabled ? t.raised : danger ? t.ansi1 : primary ? t.solid : t.raised;
  const fg = disabled ? t.dim : danger || primary ? t.solid_foreground : t.foreground;
  return h_flex().id(id).h(30).px(14).items_center().rounded(8).border_1().border_color(primary || danger ? bg : t.input).bg(bg).text_color(fg).text_size(12.5)
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick))
    .child(text);
}

function frame(t, title, subtitle, body, buttons, onKey, handle) {
  return v_flex().id("kns-dialog").size_full().min_h(0).p(16).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
    .track_focus(handle).on_key_down(onKey)
    .child(h_flex().gap(8).items_center()
      .child(div().text_size(15).font_semibold().truncate().child(title))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(subtitle ?? ""))
      .child(div().id("esc").text_size(11).text_color(t.dim).cursor_pointer().on_click(() => closeOverlay(props().overlay)).child("Esc")))
    .child(body)
    .when(buttons.length > 0, (el) => el.child(h_flex().gap(8).justify_end().children(buttons)));
}

// ── documents ─────────────────────────────────────────────────────────────

export class DocDialog {
  init(_p, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.text = null;
    this.error = null;
    this.code = null;
    this.kns = new Kns((cx) => {
      if (this.kns.ready && !this.asked) {
        this.asked = true;
        this.load(cx);
      }
      cx.notify();
    });
    this.kns.run(cx);
  }

  close() {
    this.kns.close();
    this.code?.release();
  }

  load(cx) {
    const { doc, obj } = props();
    cx.spawn(async (cx) => {
      try {
        if (doc === "yaml") {
          const yaml = await this.kns.call("get_yaml", { objRef: obj, managedFields: false });
          this.code = EditorState.new({ language: "yaml", value: yaml, readonly: true, font_family: settings().font_family, syntax: syntax(theme()) });
        } else if (doc === "why") this.text = whyMarkdown(await this.kns.call("diagnose", { objRef: obj }));
        else if (doc === "events") this.text = eventsMarkdown(await this.kns.call("list_events", { context: obj.context, namespace: obj.namespace, objRef: obj }));
        else if (doc === "secret") this.text = secretMarkdown(await this.kns.call("decode_secret", { objRef: obj }));
      } catch (e) {
        this.error = errText(e);
      }
      cx.notify();
    });
  }

  render() {
    const t = theme(), p = props();
    const title = { yaml: "YAML", why: "Why", events: "Events", secret: "Secret" }[p.doc] ?? p.doc;
    const body = this.error ? div().flex_1().text_color(t.ansi1).child(this.error)
      : this.code ? Editor.new(this.code).font_family(settings().font_family).text_size(settings().font_size).flex_1().min_h(0)
        : this.text !== null ? div().id("doc-scroll").flex_1().min_h(0).overflow_y_scrollbar().child(TextView.markdown("doc", this.text).selectable(true))
          : div().flex_1().text_color(t.dim).child(this.kns.ready ? "Loading…" : "Connecting to kns…");
    return frame(t, title, `${p.label} · ${p.obj?.context ?? ""}`, body, [], (e, cx) => {
      if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); }
    }, this.handle);
  }
}

const md = (s) => String(s ?? "").replace(/([\\`*_[\]<>#|])/g, "\\$1");

function whyMarkdown(d) {
  const findings = d?.findings ?? [];
  const out = [];
  if (!findings.length) out.push("**✓ Nothing looks wrong.**");
  for (const f of findings) {
    const glyph = ["error", "critical"].includes(f.severity) ? "✗" : ["warning", "warn"].includes(f.severity) ? "!" : "i";
    out.push(`### ${glyph} ${md(f.title)}`);
    if (f.detail) out.push(md(f.detail));
    const ev = (f.evidence ?? []).map(evidenceText).filter(Boolean);
    if (ev.length) out.push("```\n" + ev.join("\n").slice(0, 6000) + "\n```");
  }
  if (d?.checked?.length) out.push(`*checked: ${md(d.checked.join(", "))}*`);
  return out.join("\n\n");
}

function evidenceText(e) {
  switch (e?.type) {
    case "field": return `${String(e.path ?? "").replace(/^\//, "").replaceAll("/", ".")} = ${e.value ?? ""}`;
    case "logLine": return `${e.previous ? "(previous) " : ""}${e.text ?? ""}`;
    case "event": return `${e.event?.reason ?? ""}: ${e.event?.message ?? ""}`;
    case "object": return `${e.ref?.gvr?.resource ?? ""}/${e.ref?.name ?? ""}`;
    case "diff": return `${e.left ?? ""}\n→\n${e.right ?? ""}`;
    default: return e ? JSON.stringify(e) : "";
  }
}

function eventsMarkdown(rows) {
  if (!rows?.length) return "*No events (they expire after an hour).*";
  const now = Date.now();
  return rows.map((e) => {
    const warn = e.type === "Warning";
    const count = (e.count ?? 1) > 1 ? ` ×${e.count}` : "";
    return `${warn ? "**!**" : "·"} \`${M.age(e.lastSeen, now) || "?"}\` **${md(e.reason)}** ${md(e.message)}${count}`;
  }).join("\n\n");
}

function secretMarkdown(map) {
  const out = ["*Decoded values. Nothing here is written to disk.*"];
  for (const [k, v] of Object.entries(map ?? {})) {
    out.push(`**${md(k)}**`);
    out.push(v === null ? "*(binary)*" : "```\n" + String(v).replaceAll("```", "ˋˋˋ") + "\n```");
  }
  return out.join("\n\n");
}

// ── edit → review → apply ─────────────────────────────────────────────────

/**
 * props: {obj (null for a new manifest), label, context, flags, namespace}.
 * Phases: loading → edit → review (diff + server dry run) → apply. A version or field-manager
 * conflict offers a rebase (three-way, like the window); a field-manager conflict also force.
 * A protected context asks for its name before the apply; read-only refuses in kns.
 */
export class EditDialog {
  init(_p, cx) {
    this.handle = cx.focus_handle();
    this.phase = "loading";
    this.original = "";
    this.owner = null;
    this.diff = [];
    this.dry = null; // null | "running" | "ok" | {error}
    this.warnings = [];
    this.conflict = null;
    this.message = null;
    this.confirmInput = InputState.new({ placeholder: "context name" });
    this.confirmInput.on("change", (_e, cx) => { this.confirmText = this.confirmInput.value(); cx.notify(); });
    this.confirmInput.on("submit", (_e, cx) => this.apply(cx));
    this.confirmText = "";
    this.editor = null;
    this.kns = new Kns((cx) => {
      if (this.kns.ready && this.phase === "loading" && !this.asked) {
        this.asked = true;
        this.load(cx);
      }
      cx.notify();
    });
    this.kns.run(cx);
  }

  close() {
    this.kns.close();
    this.editor?.release();
  }

  makeEditor(text) {
    this.editor?.release();
    this.editor = EditorState.new({ language: "yaml", value: text, font_family: settings().font_family, syntax: syntax(theme()) });
    this.editor.focus();
  }

  load(cx) {
    const p = props();
    cx.spawn(async (cx) => {
      try {
        if (p.obj) {
          const [yaml, json] = await Promise.all([this.kns.call("get_yaml", { objRef: p.obj, managedFields: false }), this.kns.call("get_json", { objRef: p.obj })]);
          this.original = yaml;
          this.owner = M.gitopsOwner(json);
          this.makeEditor(yaml);
        } else {
          this.makeEditor(`# Manifests to apply in ${p.context} (several documents with ---).\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\n  namespace: ${p.namespace ?? "default"}\ndata:\n  key: value\n`);
        }
        this.phase = "edit";
      } catch (e) {
        this.message = errText(e);
        this.phase = "error";
      }
      cx.notify();
    });
  }

  text() {
    return this.editor?.value() ?? "";
  }

  review(cx) {
    const text = this.text();
    const marks = conflictLines(text);
    if (marks.length) { this.message = `Resolve the conflict markers first (lines ${marks.join(", ")}).`; return cx.notify(); }
    if (props().obj && text === this.original) { this.message = "No changes."; return cx.notify(); }
    this.message = null;
    this.phase = "review";
    this.diff = unified(props().obj ? this.original : "", text, 3);
    this.confirmText = "";
    this.confirmInput.set_value("");
    this.dryRun(cx, text);
    this.handle.focus();
    cx.notify();
  }

  dryRun(cx, text) {
    this.dry = "running";
    this.warnings = [];
    this.conflict = null;
    cx.spawn(async (cx) => {
      try {
        const r = await this.kns.call("apply_yaml", { context: props().context, yaml: text, opts: { dryRun: true } });
        this.dry = "ok";
        this.warnings = r?.warnings ?? [];
      } catch (e) {
        this.dry = { error: errText(e) };
        this.conflict = M.conflictOf(e);
      }
      cx.notify();
    });
  }

  apply(cx, force = false) {
    const p = props();
    if (this.applying) return;
    if (this.dry !== "ok" && !force) return;
    if (p.flags?.protected && this.confirmText !== p.context) {
      this.message = `Type ${p.context} to apply on this protected context.`;
      this.confirmInput.focus();
      return cx.notify();
    }
    this.applying = true;
    const params = { context: p.context, yaml: this.text(), opts: force ? { force: true } : {} };
    if (p.flags?.protected) params.confirm = p.context;
    cx.spawn(async (cx) => {
      try {
        const r = await this.kns.call("apply_yaml", params);
        const warnings = r?.warnings ?? [];
        notify({ title: `Applied ${p.label}`, body: warnings.length ? `warning: ${warnings.join("; ")}` : p.context, level: warnings.length ? "warning" : "success", timeout: 5000 });
        closeOverlay(p.overlay);
      } catch (e) {
        if (e?.reason === "ConfirmRequired") {
          // the context became protected meanwhile
          p.flags = { ...(p.flags ?? {}), protected: true };
          this.message = `Type ${p.context} to apply on this protected context.`;
        } else {
          this.dry = { error: errText(e) };
          this.conflict = M.conflictOf(e);
        }
      } finally {
        this.applying = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  /** The object changed on the server: replay the edit onto its current version. */
  rebase(cx) {
    const p = props();
    cx.spawn(async (cx) => {
      try {
        const fresh = await this.kns.call("get_yaml", { objRef: p.obj, managedFields: false });
        const { text, conflicts } = merge3(this.original, this.text(), fresh);
        this.original = fresh;
        this.editor.set_value(text);
        if (conflicts > 0) {
          this.phase = "edit";
          this.message = `${conflicts} of your changes overlap with changes on the server: keep one side of each marked block, then review again.`;
          this.editor.focus();
        } else if (text === fresh) {
          notify({ title: "Nothing left to apply", body: "the server already has these changes", level: "info", timeout: 4000 });
          closeOverlay(p.overlay);
          return;
        } else {
          this.message = "Rebased on the server's version.";
          this.review(cx);
        }
      } catch (e) {
        this.message = errText(e);
      }
      cx.notify();
    });
  }

  key(e, cx) {
    const k = e.key, m = e.modifiers ?? {};
    const save = (m.platform || m.control) && (k === "s" || k === "enter");
    if (this.phase === "edit") {
      if (save) this.review(cx);
      else if (k === "escape") closeOverlay(props().overlay);
      else return;
    } else if (this.phase === "review") {
      if (k === "escape") { this.phase = "edit"; this.editor?.focus(); }
      else if (k === "enter" && !this.confirming()) this.apply(cx);
      else if (save) this.apply(cx);
      else return;
    } else if (k === "escape") closeOverlay(props().overlay);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  confirming() {
    return Boolean(props().flags?.protected);
  }

  render() {
    const t = theme(), p = props();
    const title = p.obj ? `Edit ${p.label}` : "Apply a manifest";
    let body, buttons = [];
    if (this.phase === "loading" || this.phase === "error") {
      body = div().flex_1().text_color(this.phase === "error" ? t.ansi1 : t.dim).child(this.message ?? (this.kns.ready ? "Loading…" : "Connecting to kns…"));
    } else if (this.phase === "edit") {
      body = v_flex().flex_1().min_h(0).gap(8)
        .when(Boolean(this.owner), (el) => el.child(div().text_size(12).text_color(t.blocked).child(`Managed by ${this.owner}: it will put its own version back unless you change the source.`)))
        .when(Boolean(this.message), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.message)))
        .child(div().flex_1().min_h(0).rounded(8).border_1().border_color(t.border).overflow_hidden()
          .child(Editor.new(this.editor).font_family(settings().font_family).text_size(settings().font_size).size_full()));
      buttons = [
        button(t, "cancel", "Cancel", () => closeOverlay(p.overlay)),
        button(t, "review", "Review  ⌘S", (_e, cx) => this.review(cx), { primary: true }),
      ];
    } else {
      body = this.reviewBody(t, p);
      const ok = this.dry === "ok";
      buttons = [button(t, "back", "Back to edit", (_e, cx) => { this.phase = "edit"; this.editor?.focus(); cx.notify(); })];
      if (this.conflict && p.obj) buttons.push(button(t, "rebase", "Rebase on server", (_e, cx) => this.rebase(cx)));
      if (this.conflict === "fieldManager") buttons.push(button(t, "force", "Force apply", (_e, cx) => this.apply(cx, true), { danger: true }));
      buttons.push(button(t, "apply", this.applying ? "Applying…" : "Apply", (_e, cx) => this.apply(cx), { primary: true, disabled: !ok || this.applying }));
    }
    return frame(t, title, p.context, body, buttons, (e, cx) => this.key(e, cx), this.handle);
  }

  reviewBody(t, p) {
    const size = settings().font_size ?? 13, rowH = Math.ceil(size * 1.7);
    const adds = this.diff.filter((d) => d.kind === "+").length, dels = this.diff.filter((d) => d.kind === "-").length;
    const status = this.dry === "running" ? div().text_color(t.dim).child("Dry run on the server…")
      : this.dry === "ok" ? div().text_color(t.ansi2).font_semibold().child("✓ The server accepts this change (dry run)")
        : v_flex().gap(2)
          .child(div().text_color(t.ansi1).font_semibold().child(this.conflict === "version" ? "✗ The object changed since you opened it: rebase your change on it"
            : this.conflict === "fieldManager" ? "✗ Another field manager owns some of these fields: rebase keeps theirs where you did not edit, force takes them over"
              : "✗ The server refuses this change"))
          .child(div().text_size(11.5).text_color(t.ansi1).child(this.dry?.error ?? ""));
    const row = (d) => d.kind === "@"
      ? div().h(rowH).flex_none().px(10).flex().items_center().bg(t.raised).text_color(t.dim).child(d.text)
      : h_flex().h(rowH).flex_none().gap(8).px(6).when(d.kind === "+", (el) => el.bg(t.ansi2 + "1c")).when(d.kind === "-", (el) => el.bg(t.ansi1 + "1c"))
        .child(div().w(18).flex_none().text_color(d.kind === "+" ? t.ansi2 : d.kind === "-" ? t.ansi1 : t.dim).child(d.kind === " " ? "" : d.kind))
        .child(div().flex_1().min_w(0).truncate().child(d.text || " "));
    return v_flex().flex_1().min_h(0).gap(8)
      .child(h_flex().gap(10).items_center().child(status).child(div().flex_1())
        .child(div().text_size(11.5).text_color(t.ansi2).child(`+${adds}`)).child(div().text_size(11.5).text_color(t.ansi1).child(`−${dels}`)))
      .children(this.warnings.map((w) => div().text_size(12).text_color(t.blocked).child(`! ${w}`)))
      .when(Boolean(this.owner), (el) => el.child(div().text_size(12).text_color(t.blocked).child(`! Managed by ${this.owner}: it will put its own version back.`)))
      .when(Boolean(this.message), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.message)))
      .child(div().flex_1().min_h(0).relative().rounded(8).border_1().border_color(t.border).overflow_hidden().font_family(settings().font_family).text_size(size)
        .child(div().absolute().inset_0().child(v_virtual_list("kns-diff", this.diff.length, rowH, (i) => String(i), (range) => this.diff.slice(range.start, range.end).map(row)).size_full()))
        .child(Scrollbar.vertical("kns-diff").absolute().inset_0()))
      .when(Boolean(p.flags?.protected), (el) => el.child(v_flex().gap(4)
        .child(div().text_size(12).text_color(t.blocked).child(`${p.context} is protected: type its name to apply.`))
        .child(div().h(30).px(8).flex().items_center().rounded(7).border_1().border_color(t.input).bg(t.background)
          .on_mouse_down("left", (_e, cx) => { this.confirmInput.focus(); cx.stop_propagation(); })
          .child(Input.new(this.confirmInput).h_full().text_size(12.5)))));
  }
}

// ── one confirmed action ───────────────────────────────────────────────────

const ACTIONS = {
  restart: { title: "Restart", verb: "Restart", detail: "A rolling restart: new pods start before the old ones stop." },
  scale: { title: "Scale", verb: "Scale", input: "Replicas" },
  image: { title: "Set image", verb: "Set image", input: "Image" },
  delete: { title: "Delete", verb: "Delete", danger: true, detail: "The object is deleted; a controller may make a new one." },
  trigger: { title: "Run now", verb: "Run", detail: "Starts a Job from the CronJob's template." },
  forward: { title: "Port-forward", verb: "Forward", input: "[local:]remote port", local: true },
};

/** props: {action, obj, label, context, flags, replicas?, kind?, gvr?}. */
export class ActionDialog {
  init(_p, cx) {
    this.handle = cx.focus_handle();
    this.spec = ACTIONS[props().action];
    this.busy = false;
    this.error = null;
    this.containers = null;
    this.input = InputState.new({ placeholder: this.spec?.input ?? "", value: props().action === "scale" && props().replicas !== null && props().replicas !== undefined ? String(props().replicas) : "" });
    this.input.on("change", (_e, cx) => cx.notify());
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.confirm = InputState.new({ placeholder: props().context });
    this.confirm.on("change", (_e, cx) => cx.notify());
    this.confirm.on("submit", (_e, cx) => this.go(cx));
    this.kns = new Kns((cx) => {
      if (this.kns.ready && props().action === "image" && !this.containers) this.loadImages(cx);
      cx.notify();
    });
    this.kns.run(cx);
    if (this.spec?.input) this.input.focus();
    else if (props().flags?.protected) this.confirm.focus();
    else this.handle.focus();
  }

  close() {
    this.kns.close();
  }

  /** The containers of the pod template and their images: "app=nginx:1.27 sidecar=…". */
  loadImages(cx) {
    this.containers = [];
    cx.spawn(async (cx) => {
      try {
        const o = await this.kns.call("get_json", { objRef: props().obj });
        this.base = props().res === "pods" ? "/spec" : props().res === "cronjobs" ? "/spec/jobTemplate/spec/template/spec" : "/spec/template/spec";
        const at = this.base.split("/").filter(Boolean).reduce((v, k) => v?.[k], o);
        this.containers = (at?.containers ?? []).map((c) => [c.name, c.image]);
        this.input.set_value(this.containers.length === 1 ? this.containers[0][1] : this.containers.map(([n, i]) => `${n}=${i}`).join(" "));
      } catch (e) {
        this.error = errText(e);
      }
      cx.notify();
    });
  }

  params() {
    const p = props(), v = this.input.value().trim();
    switch (p.action) {
      case "restart": return ["restart", { objRef: p.obj }];
      case "delete": return ["delete_object", { objRef: p.obj, opts: {} }];
      case "trigger": return ["trigger_cron_job", { objRef: p.obj }];
      case "scale": {
        if (!/^\d+$/.test(v)) throw new Error("give a number of replicas");
        return ["scale", { objRef: p.obj, replicas: Number(v) }];
      }
      case "image": {
        const wanted = this.containers.length === 1 ? [[this.containers[0][0], v]] : v.split(/\s+/).filter(Boolean).map((x) => x.split("="));
        const ops = [];
        for (const [name, image] of wanted) {
          const i = this.containers.findIndex(([n]) => n === name);
          if (i < 0) throw new Error(`no container "${name}"`);
          if (!image) throw new Error(`no image for ${name}`);
          if (this.containers[i][1] !== image) {
            // the test op fails the patch if the containers moved since they were read
            ops.push({ op: "test", path: `${this.base}/containers/${i}/name`, value: name });
            ops.push({ op: "replace", path: `${this.base}/containers/${i}/image`, value: image });
          }
        }
        if (!ops.length) throw new Error("no image changed");
        return ["patch_object", { objRef: p.obj, patch: ops, patchType: "json" }];
      }
      case "forward": {
        const [l, r] = v.includes(":") ? v.split(":") : [null, v];
        if (!r) throw new Error("give a remote port (number or name)");
        const remote = /^\d+$/.test(r) ? Number(r) : r;
        const local = l ? Number(l) : null;
        const target = p.kind === "workload" ? { kind: "workload", gvr: p.gvr, namespace: p.obj.namespace, name: p.obj.name } : { kind: p.kind, namespace: p.obj.namespace, name: p.obj.name };
        return ["start_forward", { query: { context: p.context, target, remotePort: remote, localPort: local, pin: local !== null } }];
      }
    }
    throw new Error(`unknown action ${p.action}`);
  }

  go(cx) {
    const p = props();
    if (this.busy) return;
    let method, params;
    try { [method, params] = this.params(); } catch (e) { this.error = e.message; return cx.notify(); }
    const mutating = p.action !== "forward";
    if (mutating && p.flags?.protected) {
      if (this.confirm.value() !== p.context) { this.error = `Type ${p.context} to go ahead.`; this.confirm.focus(); return cx.notify(); }
      params.confirm = p.context;
    }
    this.busy = true;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        const r = await this.kns.call(method, params);
        const body = p.action === "forward" && r?.localPort ? `http://${r.address ?? "127.0.0.1"}:${r.localPort} → ${r.pod ?? p.obj.name}` : typeof r === "string" && r ? r : p.context;
        notify({ title: `${this.spec.verb} ${p.label}`, body, level: "success", timeout: 6000 });
        closeOverlay(p.overlay);
      } catch (e) {
        if (e?.reason === "ConfirmRequired") { p.flags = { ...(p.flags ?? {}), protected: true }; this.error = `Type ${p.context} to go ahead.`; this.confirm.focus(); }
        else this.error = errText(e);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  render() {
    const t = theme(), p = props(), s = this.spec;
    if (!s) return frame(t, "kns", "", div().child(`unknown action ${p.action}`), [], () => {}, this.handle);
    const protectedCtx = p.flags?.protected && p.action !== "forward";
    const field = (label, state, hint) => v_flex().gap(5)
      .child(div().text_size(11.5).text_color(t.dim).child(label))
      .child(div().h(32).px(9).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.background)
        .on_mouse_down("left", (_e, cx) => { state.focus(); cx.stop_propagation(); })
        .child(Input.new(state).h_full().text_size(12.8)))
      .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint)));
    const body = v_flex().gap(12)
      .when(Boolean(s.detail), (el) => el.child(div().text_color(t.muted).child(s.detail)))
      .when(Boolean(s.input), (el) => el.child(field(s.input, this.input, p.action === "image" && this.containers?.length > 1 ? "container=image, separated by spaces" : p.action === "forward" ? "a port number or name; local port optional (else a free one)" : null)))
      .when(protectedCtx, (el) => el.child(field(`${p.context} is protected: type its name`, this.confirm, null)))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)));
    return frame(t, `${s.title} ${p.label}`, p.context, body, [
      button(t, "cancel", "Cancel", () => closeOverlay(p.overlay)),
      button(t, "go", this.busy ? "Working…" : s.verb, (_e, cx) => this.go(cx), { primary: !s.danger, danger: s.danger, disabled: this.busy || !this.kns.ready }),
    ], (e, cx) => {
      if (e.key === "escape") closeOverlay(p.overlay);
      else if (e.key === "enter" && !s.input && !protectedCtx) this.go(cx);
      else return;
      cx.stop_propagation();
    }, this.handle);
  }
}
