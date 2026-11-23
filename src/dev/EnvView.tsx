// The env view (`E` / `:env`, docs/plan-features.md §3 B-dev): KEY · SOURCE · VALUE · → REWRITTEN,
// the summary line, the dependencies with their suggested forwards, side-effect warnings. Keys are
// registry actions (./actions.ts); rows and buttons run the same actions after moving the cursor.
import { memo, useEffect, useRef } from "react";
import { PaneSlot, PaneToolbar, type ViewProps } from "../foundation";
import type { ActionId } from "../actions";
import type { Dependency, EnvRow } from "../ipc/types";
import type { PaneId } from "../types";
import { EmptyState, Glyph, Icon, actionTip, keepFocus, openMenu, runAction, tip } from "../ui";
import { exportable, rewrittenText, summary } from "./model";
import { forgetPane, loadEnv, setEnvCursor, useEnvPane } from "./state";
import { useDevSets } from "./store";
import "./dev.css";

const SOURCE: Readonly<Record<EnvRow["source"], string>> = {
  literal: "literal",
  configMap: "configmap",
  secret: "secret",
  field: "field",
  resourceField: "resource",
};

function RowButton({ pane, index, action, icon, label }: { pane: PaneId; index: number; action: ActionId; icon: "eye" | "copy" | "open"; label: string }) {
  return (
    <button
      type="button"
      className="k-abtn"
      tabIndex={-1}
      {...actionTip(action)}
      aria-label={label}
      onMouseDown={keepFocus}
      onClick={(e) => {
        e.stopPropagation();
        runAction(action, { pane, before: () => setEnvCursor(pane, index) });
      }}
    >
      <Icon name={icon} />
    </button>
  );
}

const EnvLine = memo(function EnvLine(props: { pane: PaneId; index: number; row: EnvRow; focus: boolean; on: boolean; revealed?: string; rewritten: string | null }) {
  const { pane, index, row, focus, on, revealed, rewritten } = props;
  const can = exportable(row);
  const value = revealed ?? (row.source === "secret" ? "•••" : (row.value ?? (row.from ?? "")));
  return (
    <div
      className="dev-row t-cell"
      role="row"
      aria-selected={focus}
      data-focus={focus || undefined}
      data-off={!on || undefined}
      onMouseDown={() => setEnvCursor(pane, index)}
      onDoubleClick={() => runAction("nav.open", { pane, before: () => setEnvCursor(pane, index) })}
      onContextMenu={(e) => {
        e.preventDefault();
        setEnvCursor(pane, index);
        openMenu({ at: { x: e.clientX, y: e.clientY }, items: ["env.toggleKey", "env.reveal", "nav.open", "|", "env.saveSet", "env.export", "env.copyAs"] });
      }}
    >
      <span className="dev-cell dev-check" role="cell">
        <input
          type="checkbox"
          tabIndex={-1}
          checked={on}
          disabled={!can}
          aria-label={`include ${row.key}`}
          {...tip(can ? "Include in exports" : "A field reference exists only in the pod")}
          onMouseDown={keepFocus}
          onChange={() => runAction("env.toggleKey", { pane, before: () => setEnvCursor(pane, index) })}
        />
      </span>
      <span className="dev-cell dev-key truncate" role="cell" {...tip(row.key, { plain: true })}>{row.key}</span>
      <span className="dev-cell muted truncate" role="cell" {...tip(row.from ?? SOURCE[row.source], { plain: true })}>{SOURCE[row.source]}</span>
      <span className={`dev-cell truncate${row.masked && !revealed ? " muted" : ""}`} role="cell" dir="ltr" {...tip(value, { plain: true })}>{value}</span>
      <span className="dev-cell dev-rw truncate" role="cell" dir="ltr">{rewritten ? `→ ${rewritten}` : ""}</span>
      <span className="dev-cell dev-acts" role="cell">
        {row.masked && <RowButton pane={pane} index={index} action="env.reveal" icon="eye" label={`reveal ${row.key}`} />}
        {row.from?.match(/^(configmap|secret)\//) && <RowButton pane={pane} index={index} action="nav.open" icon="open" label={`open the source of ${row.key}`} />}
      </span>
    </div>
  );
});

const DepLine = memo(function DepLine(props: { pane: PaneId; index: number; dep: Dependency; focus: boolean }) {
  const { pane, index, dep, focus } = props;
  const f = dep.suggestedForward;
  return (
    <div
      className="dev-dep t-cell"
      role="row"
      aria-selected={focus}
      data-focus={focus || undefined}
      onMouseDown={() => setEnvCursor(pane, index)}
      onDoubleClick={() => runAction("nav.open", { pane, before: () => setEnvCursor(pane, index) })}
      onContextMenu={(e) => {
        e.preventDefault();
        setEnvCursor(pane, index);
        openMenu({ at: { x: e.clientX, y: e.clientY }, items: ["nav.open", "|", "env.saveSet", "env.export", "env.copyAs"] });
      }}
    >
      <span className="dev-dep-head">
        <Glyph state={dep.ready ? "ok" : "warn"} />
        <span className="dev-key">svc/{dep.service.name}.{dep.service.namespace}:{dep.port}</span>
        <span className="muted">{dep.kind}</span>
        <span className="muted">
          → forward {f.key}: {String(f.remotePort)} on 127.0.0.1:{f.localPort}
          {f.pin ? " (pinned)" : ""}
        </span>
      </span>
      {dep.notes.map((n, i) => (
        <span key={i} className="dev-note t-ui-multi" dir="ltr">
          {n}
        </span>
      ))}
    </div>
  );
});

export default function EnvView({ pane, view, focused, visible }: ViewProps<"env">) {
  const p = useEnvPane(pane);
  const set = useDevSets((s) => (view.devSet ? s.sets.find((x) => x.id === view.devSet) : undefined));
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (visible) void loadEnv(pane, view);
  }, [pane, view, visible]);
  useEffect(() => () => forgetPane(pane), [pane]);
  useEffect(() => {
    list.current?.querySelector("[data-focus]")?.scrollIntoView({ block: "nearest" });
  }, [p?.cursor]);

  const report = p?.report;
  const toolbar = <PaneToolbar items={["env.toggleKey", "env.reveal", "|", "env.saveSet", "env.export", "env.copyAs", "|", "view.refresh", "hub.help"]} />;
  if (!p || (!report && !p.error)) return <EmptyState compact>{toolbar}reading the env</EmptyState>;
  if (!report) return <EmptyState compact>{toolbar}Could not read the env: {p.error}</EmptyState>;

  const rows = report.rows;
  const actsAs = `${view.ref.gvr.resource}/${view.ref.name}`;
  return (
    <div className="dev-view" role="table" aria-label="Env" data-pane-focused={focused || undefined}>
      {toolbar}
      <PaneSlot name="count">{rows.length}</PaneSlot>
      {set && <PaneSlot name="labels">SET {set.name}</PaneSlot>}
      <div className="dev-summary t-ui">
        <span>{summary(report)}</span>
        <span className="muted">
          container {report.container} · a local run acts as {actsAs} in {p.context}
        </span>
      </div>
      <div className="dev-scroll" ref={list}>
        <div className="dev-head t-colhead" role="row">
          <span aria-hidden="true" />
          <span role="columnheader">Key</span>
          <span role="columnheader">Source</span>
          <span role="columnheader">Value</span>
          <span role="columnheader">Rewritten</span>
          <span aria-hidden="true" />
        </div>
        {rows.map((r, i) => (
          <EnvLine
            key={r.key}
            pane={pane}
            index={i}
            row={r}
            focus={p.cursor === i}
            on={p.included.has(r.key)}
            revealed={p.revealed?.key === r.key ? p.revealed.value : undefined}
            rewritten={rewrittenText(r, report.deps, set)}
          />
        ))}
        <div className="dev-section t-label">Dependencies {report.deps.length}</div>
        {report.deps.length === 0 && <div className="dev-note t-ui muted">No in-cluster Service address found in the env.</div>}
        {report.deps.map((d, i) => (
          <DepLine key={`${d.service.namespace}/${d.service.name}:${d.port}`} pane={pane} index={rows.length + i} dep={d} focus={p.cursor === rows.length + i} />
        ))}
        {(report.warnings.length > 0 || report.overrides.length > 0) && <div className="dev-section t-label">Side effects</div>}
        {report.warnings.map((w, i) => (
          <div key={i} className="dev-note dev-warnline t-ui-multi" dir="ltr">
            <Glyph state="warn" />
            <span>{w}</span>
          </div>
        ))}
        {report.overrides.map((o) => (
          <div key={o.key} className="dev-note t-ui muted" dir="ltr">
            override {o.key}={o.value}
          </div>
        ))}
        {report.redactions.count > 0 && <div className="dev-note t-ui muted">redacted {report.redactions.count} values</div>}
      </div>
    </div>
  );
}
