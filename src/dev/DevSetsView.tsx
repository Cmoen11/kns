// The devsets view (docs/plan-features.md §3 B-dev): every saved set with its state and origin
// (`agent: claude-code · not approved`); the cursor set's forwards, rewrites and env below.
// u / x / e / Delete and the row buttons run the same actions (./actions.ts).
import { memo, useEffect } from "react";
import { PaneSlot, PaneToolbar, type ViewProps } from "../foundation";
import type { ActionId } from "../actions";
import type { DevSet } from "../ipc/types";
import type { PaneId } from "../types";
import { ActionHint, EmptyState, Glyph, Icon, actionTip, keepFocus, openMenu, runAction, type IconName } from "../ui";
import { useForwards } from "../views/shell/forwards";
import { approved, diffLines, forwardLine, originText, rewriteLine } from "./model";
import { forgetPane, setSetsCursor, useSetsPane } from "./state";
import { useDevSets, useRunningSetIds } from "./store";
import "./dev.css";

const ROW_ACTS: readonly { action: ActionId; icon: IconName; label: string }[] = [
  { action: "dev.up", icon: "play", label: "Start the set" },
  { action: "dev.down", icon: "stop", label: "Stop the set" },
  { action: "dev.edit", icon: "edit", label: "Edit the set" },
  { action: "dev.delete", icon: "delete", label: "Delete the set" },
];

const SetRow = memo(function SetRow(props: { pane: PaneId; index: number; count: number; set: DevSet; up: number; focus: boolean }) {
  const { pane, index, count, set, up, focus } = props;
  const point = () => setSetsCursor(pane, index, count);
  return (
    <div
      className="dev-set t-cell"
      role="row"
      aria-selected={focus}
      data-focus={focus || undefined}
      onMouseDown={point}
      onDoubleClick={() => runAction("nav.open", { pane, before: point })}
      onContextMenu={(e) => {
        e.preventDefault();
        point();
        openMenu({ at: { x: e.clientX, y: e.clientY }, items: ["nav.open", "dev.up", "dev.down", "dev.edit", "|", "dev.delete"] });
      }}
    >
      <Glyph state={up > 0 ? "ok" : approved(set) ? "suspended" : "warn"} />
      <span className="dev-key truncate">{set.name}</span>
      <span className="muted truncate">{set.context}</span>
      <span className="truncate">{up > 0 ? `up · ${up} forward${up === 1 ? "" : "s"}` : `down · ${set.forwards.length} forward${set.forwards.length === 1 ? "" : "s"}`}</span>
      <span className={approved(set) ? "muted truncate" : "dev-warn truncate"} dir="ltr">
        {originText(set)}
      </span>
      <span className="dev-acts">
        {ROW_ACTS.map(({ action, icon, label }) => (
          <button
            key={action}
            type="button"
            className="k-abtn"
            tabIndex={-1}
            {...actionTip(action)}
            aria-label={label}
            onMouseDown={keepFocus}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              runAction(action, { pane, before: point });
            }}
          >
            <Icon name={icon} />
          </button>
        ))}
      </span>
    </div>
  );
});

function Details({ set }: { set: DevSet }) {
  const diff = diffLines(set);
  const w = set.env?.workload;
  return (
    <div className="dev-details t-ui-multi" dir="ltr">
      <div className="dev-section t-label">Forwards {set.forwards.length}</div>
      {set.forwards.map((f) => (
        <div key={f.key}>{forwardLine(f)}</div>
      ))}
      {set.rewrites.length > 0 && <div className="dev-section t-label">Rewrites {set.rewrites.length}</div>}
      {set.rewrites.map((r, i) => (
        <div key={i}>{rewriteLine(r, set.forwards)}</div>
      ))}
      {set.env && w && (
        <>
          <div className="dev-section t-label">Env</div>
          <div>
            {w.gvr.resource}/{w.name} in {w.namespace}
            {set.env.container ? ` · container ${set.env.container}` : ""} · {set.env.format}
            {set.env.includeSecrets ? ` · ${set.env.includeSecrets.length} secret keys ticked` : ""}
          </div>
          {(set.env.overrides ?? []).map((o) => (
            <div key={o.key}>
              override {o.key}={o.value}
            </div>
          ))}
        </>
      )}
      {diff.length > 0 && <div className="dev-section t-label">Changed since approval</div>}
      {diff.map((l, i) => (
        <div key={i} className={l.startsWith("+") ? "dev-add" : l.startsWith("-") ? "dev-del" : ""}>
          {l}
        </div>
      ))}
      <div className="muted">start with kns: {set.autoStart ? "on" : "off"}</div>
    </div>
  );
}

export default function DevSetsView({ pane, view, focused }: ViewProps<"devsets">) {
  const sets = useDevSets((s) => s.sets);
  const loaded = useDevSets((s) => s.loaded);
  const running = useRunningSetIds();
  const forwards = useForwards((s) => s.list);
  const state = useSetsPane(pane);

  // `selected` puts the cursor on that set once
  useEffect(() => {
    if (!view.selected) return;
    const i = sets.findIndex((s) => s.id === view.selected);
    if (i >= 0) setSetsCursor(pane, i, sets.length);
  }, [pane, view.selected, sets]);
  useEffect(() => () => forgetPane(pane), [pane]);

  const toolbar = <PaneToolbar items={["dev.up", "dev.down", "dev.edit", "dev.delete", "|", { action: "dev.picker", args: ["save"], label: "new from running forwards", icon: "plus", showLabel: true }, "view.refresh", "hub.help"]} />;
  if (!loaded) return <EmptyState compact>{toolbar}reading dev sets</EmptyState>;
  if (sets.length === 0) {
    return (
      <EmptyState title="No dev sets">
        {toolbar}
        <ActionHint action="dev.fromWorkload" label="dev from workload" /> on a workload builds one from its dependencies; :dev save &lt;name&gt; saves the running forwards.
      </EmptyState>
    );
  }
  const cursor = Math.min(state?.cursor ?? 0, sets.length - 1);
  const current = sets[cursor];
  return (
    <div className="dev-view" role="table" aria-label="Dev sets" data-pane-focused={focused || undefined}>
      {toolbar}
      <PaneSlot name="count">{sets.length}</PaneSlot>
      <div className="dev-scroll">
        {sets.map((s, i) => (
          <SetRow key={s.id} pane={pane} index={i} count={sets.length} set={s} up={running.includes(s.id) ? forwards.filter((f) => f.devSet === s.id).length : 0} focus={i === cursor} />
        ))}
        {current && <Details set={current} />}
      </div>
    </div>
  );
}
