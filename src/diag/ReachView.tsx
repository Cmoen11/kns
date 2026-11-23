// The `reach` view (docs/plan-features.md §3 C3): can this pod talk to that Service? One row per
// step of the static chain (Service, port, endpoints, target port, NetworkPolicies of both ends by
// standard rules, DNS), then "probe from inside the pod" (Enter asks, then runs a fixed command as
// an exec) and its result, and "debug container" when the probe cannot run there. Keys arrive as
// registry actions through the pane's controller; this component has no key handling. Every
// detail is cluster text, cleaned and redacted in Rust and rendered as text only.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReachCheck } from "../ipc/types";
import {
  backend, confirm, contextFlags, paneContext, usePaneContext, EmptyState, flash, Glyph, Icon, keepFocus, objectFacts, openView, PaneSlot, runAction, setSelection, tableView, tip, toObjRef,
  type ViewProps,
} from "../foundation";
import { cleanUntrusted } from "../ui/untrusted";
import { invalidateC3 } from "./c3-actions";
import { reachControllers } from "./c3-controller";
import type { ListController, NewPane } from "./c2-controller";
import { errorText } from "./c2-store";
import { listPointer } from "./list-pointer";
import { POD_GVR, reachRows, reachTitle, verdict, type ProbeState, type ReachRow } from "./reach-model";
import "./c2.css";
import "./c3.css";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; check: ReachCheck; at: number };

const NETPOL = { group: "networking.k8s.io", version: "v1", resource: "networkpolicies" };
const GLYPH = { true: "ok", false: "error", null: "warn" } as const;

export default function ReachView({ pane, view, focused }: ViewProps<"reach">) {
  const context = usePaneContext(pane);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [probe, setProbe] = useState<ProbeState>({ state: "idle" });
  const [canProbe, setCanProbe] = useState<true | string>(true);
  const [cursor, setCursorState] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const seq = useRef(0);
  const { from, to } = view;
  const key = `${from.namespace}/${from.name}>${to.gvr.resource}/${to.namespace}/${to.name}:${view.port ?? ""}`;

  useEffect(() => {
    if (!context) return;
    const id = ++seq.current;
    backend.reach(toObjRef(from, context), toObjRef(to, context), view.port).then(
      (check) => id === seq.current && setLoad({ state: "ok", check, at: Date.now() }),
      (e: unknown) => id === seq.current && setLoad({ state: "error", message: errorText(e) }),
    );
    backend.canI({ context, verb: "create", gvr: POD_GVR, subresource: "exec", namespace: from.namespace }).then(
      (ok) => id === seq.current && setCanProbe(ok ? true : `forbidden: cannot create pods/exec in ${from.namespace ?? ""}`),
      () => undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, key, epoch]);

  // the view is about the source pod: `pod.debug` (and :kubectl) read it from the selection
  useEffect(() => {
    setSelection(pane, { focused: from });
    return () => setSelection(pane, null);
  }, [pane, from]);

  const check = load.state === "ok" ? load.check : null;
  const rows = useMemo(() => reachRows(check, probe, canProbe), [check, probe, canProbe]);
  const cur = Math.min(Math.max(0, cursor), Math.max(0, rows.length - 1));
  const state = useRef({ rows, cur, check, probe });
  state.current = { rows, cur, check, probe };
  const setCursor = useCallback((i: number) => {
    state.current.cur = Math.min(Math.max(0, i), Math.max(0, state.current.rows.length - 1));
    setCursorState(state.current.cur);
  }, []);

  const runProbe = useCallback(async () => {
    const c = state.current.check;
    const ctx = paneContext(pane);
    if (!c || !ctx || c.port === undefined || c.port === null) return;
    const port = c.port;
    const ok = await confirm({
      tier: 1,
      title: "Probe from inside the pod",
      body: `Runs one fixed command in ${from.name} (nc, wget or bash, whichever the image has) that opens a connection to ${to.name}:${port} and closes it. Nothing is changed.`,
      facts: objectFacts({ kind: "Pod", name: from.name, namespace: from.namespace, context: ctx, protected: contextFlags(ctx).protected }),
      confirmLabel: "Probe",
    });
    if (!ok) return;
    setProbe({ state: "running" });
    try {
      const result = await backend.reachProbe(toObjRef(from, ctx), toObjRef(to, ctx), port);
      setProbe({ state: "done", result });
    } catch (e) {
      setProbe({ state: "error", message: errorText(e) });
    }
  }, [from, to]);

  useEffect(() => {
    const target = (r: ReachRow | undefined): (() => void) | string => {
      if (!r) return "no row";
      if (r.type === "probe") return r.disabled ?? (() => void runProbe());
      if (r.type === "debug") return () => runAction("pod.debug", { pane });
      if (r.type === "step") {
        const name = r.step.name;
        if (name === "egress from source" || name === "DNS") return () => openView(tableView(NETPOL, from.namespace ?? "*"), { pane });
        if (name === "ingress to destination") return () => openView(tableView(NETPOL, to.namespace ?? "*"), { pane });
        if (name === "source pod") return () => openView({ kind: "why", ref: from }, { pane });
        return () => openView({ kind: "why", ref: to }, { pane });
      }
      return "nothing to open on this row";
    };
    const c: ListController = {
      move: (d) => setCursor(state.current.cur + d),
      moveTo: (w) => setCursor(w === "top" ? 0 : state.current.rows.length - 1),
      open: (newPane: NewPane) => {
        const t = target(state.current.rows[state.current.cur]);
        if (typeof t === "string") return flash(t, "warn");
        const r = state.current.rows[state.current.cur];
        // steps open a view: beside when asked
        if (newPane && r?.type === "step") {
          const name = r.step.name;
          const ns = name === "ingress to destination" ? to.namespace : from.namespace;
          if (name.includes("egress") || name.includes("ingress") || name === "DNS") return void openView(tableView(NETPOL, ns ?? "*"), { pane, newPane });
          return void openView({ kind: "why", ref: name === "source pod" ? from : to }, { pane, newPane });
        }
        t();
      },
      canOpen: () => {
        const t = target(state.current.rows[state.current.cur]);
        return typeof t === "string" ? t : true;
      },
      refresh: () => {
        setProbe({ state: "idle" });
        setEpoch((n) => n + 1);
      },
      loaded: () => state.current.check !== null,
    };
    reachControllers.set(pane, c);
    return () => reachControllers.set(pane, null);
  }, [pane, from, to, runProbe, setCursor]);

  useEffect(() => invalidateC3(), [rows, cur]);
  // land on the probe result when it arrives
  useEffect(() => {
    if (probe.state === "done" || probe.state === "error") {
      const i = state.current.rows.findIndex((r) => r.type === "result" || r.type === "probeError");
      if (i >= 0) setCursor(i);
    }
  }, [probe, setCursor]);

  const pointer = useMemo(() => listPointer(pane, setCursor, invalidateC3), [pane, setCursor]);
  const title = cleanUntrusted(reachTitle({ from, to, port: view.port ?? check?.port ?? undefined }));
  const v = check ? verdict(check) : null;
  const head = (
    <div className="c2-head t-ui">
      <span className="c2-head-ref">{title}</span>
      {v && (
        <span className="c3-verdict" data-state={v.glyph}>
          <Glyph state={v.glyph} /> {v.text}
        </span>
      )}
      {load.state === "ok" && <span className="muted">read {new Date(load.at).toLocaleTimeString()}</span>}
    </div>
  );
  if (load.state === "loading") return <div className="c2">{head}<EmptyState compact>checking the path from {cleanUntrusted(from.name)} to {cleanUntrusted(to.name)}</EmptyState></div>;
  if (load.state === "error") return <div className="c2">{head}<EmptyState compact title="Could not check">{cleanUntrusted(load.message)}</EmptyState></div>;

  return (
    <div className="c2" data-active={focused || undefined}>
      <PaneSlot name="count">{v ? (check?.ok === true ? "ok" : check?.ok === false ? "fail" : "?") : ""}</PaneSlot>
      {head}
      <div className="c2-list" role="listbox" aria-label="reach checks" {...pointer}>
        {rows.map((r, i) => (
          <div key={r.key} className="c2-row row t-cell c3-reach-row" data-index={i} data-focus={i === cur || undefined} data-type={r.type} role="option" aria-selected={i === cur} aria-disabled={(r.type === "probe" && !!r.disabled) || undefined}>
            <Row row={r} />
            {(r.type === "step" || r.type === "debug" || (r.type === "probe" && !r.disabled)) && (
              <button type="button" className="k-abtn c2-open" tabIndex={-1} data-act="open" onMouseDown={keepFocus} aria-label="open" {...tip(r.type === "probe" ? "probe (asks first)" : r.type === "debug" ? "debug container" : "open", { reason: "Enter" })}>
                <Icon name={r.type === "probe" ? "reach" : r.type === "debug" ? "bug" : "open"} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="c3-foot t-hint muted">NetworkPolicies are evaluated by the standard rules; a CNI may add its own. The probe answers for this pod, now.</div>
    </div>
  );
}

function Row({ row }: { row: ReachRow }) {
  switch (row.type) {
    case "step": {
      const s = row.step;
      return (
        <>
          <span className="c2-glyph"><Glyph state={GLYPH[String(s.ok) as "true" | "false" | "null"]} /></span>
          <span className="c3-step-name">{cleanUntrusted(s.name)}</span>
          <span className="c2-what" dir="ltr">{cleanUntrusted(s.detail)}</span>
        </>
      );
    }
    case "probe":
      return (
        <>
          <span className="c2-glyph"><Glyph state={row.label.startsWith("probing") ? "progress" : "unknown"} /></span>
          <span className="c3-step-name">probe</span>
          <span className="c2-what">{row.label}{row.disabled && !row.label.startsWith("probing") ? <span className="muted"> · {cleanUntrusted(row.disabled)}</span> : null}</span>
        </>
      );
    case "result": {
      const r = row.result;
      return (
        <>
          <span className="c2-glyph"><Glyph state={r.ok ? "ok" : "error"} /></span>
          <span className="c3-step-name">{r.ok ? "connected" : "failed"}</span>
          <span className="c2-what" dir="ltr">
            {cleanUntrusted(r.command)}
            {r.output ? <span className="muted"> · {cleanUntrusted(r.output.split("\n").slice(0, 2).join(" · "))}</span> : null}
          </span>
        </>
      );
    }
    case "probeError":
      return (
        <>
          <span className="c2-glyph"><Glyph state="error" /></span>
          <span className="c3-step-name">probe</span>
          <span className="c2-what">{cleanUntrusted(row.message)}</span>
        </>
      );
    case "debug":
      return (
        <>
          <span className="c2-glyph"><Glyph state="unknown" /></span>
          <span className="c3-step-name">debug</span>
          <span className="c2-what">the probe cannot run in this pod: open a debug container with network tools</span>
        </>
      );
  }
}
