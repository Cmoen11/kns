// Port-forward manager (docs/ux.md §13.5): NAME, NAMESPACE, TARGET, OWNER, LOCAL, REMOTE, STATE, AGE.
// Keys are registry actions (./actions.ts): pf.stop, pf.copyAddress, pf.openBrowser, nav.*, nav.open,
// view.refresh; pf.copyUrl (src/dev/conn.ts, B2). The row buttons run the same actions after moving
// the cursor to their row. With names on (`:dev names on`, B2) LOCAL shows the forward's
// `<name>.<ns>.localhost:<port>` and the raw address in its tooltip.
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useRef, useState } from "react";
import { PaneSlot, PaneToolbar, type ViewProps } from "../../foundation";
import type { ActionId } from "../../actions";
import type { Forward } from "../../ipc/types";
import { useSettings } from "../../store/settings";
import { ActionHint, actionTip, EmptyState, Glyph, Icon, keepFocus, runAction, tip, type IconName } from "../../ui";
import { nameUrl, useNames } from "../../dev/names";
import { cursorIndex, forgetCursor, forwardMeta, setCursor, useForwards, watchForwards } from "./forwards";
import { ageText, forwardHost, ownerText, remoteText, targetName, targetText } from "./ports";
import "./pf.css";

const AGE_TICK_MS = 10_000;

interface RowProps {
  pane: string;
  index: number;
  f: Forward;
  focus: boolean;
  top: number;
  now: number;
  /** `http://<name>.<ns>.localhost:<port>` while the name proxy routes this forward */
  named: string | null;
}

/** The row buttons: one per action of the cursor row, in the order of the keys' hints. */
const ROW_ACTIONS: readonly { action: ActionId; icon: IconName }[] = [
  { action: "pf.openBrowser", icon: "external" },
  { action: "pf.copyAddress", icon: "copy" },
  { action: "pf.copyUrl", icon: "link" },
  { action: "pf.stop", icon: "stop" },
];
const LABEL: Readonly<Record<string, string>> = {
  "pf.openBrowser": "Open in the browser",
  "pf.copyAddress": "Copy the address",
  "pf.copyUrl": "Copy the connection string",
  "pf.stop": "Stop the forward",
};

const Row = memo(function Row({ pane, index, f, focus, top, now, named }: RowProps) {
  const m = forwardMeta(f.id);
  const broken = f.status === "error";
  const waiting = f.status === "waiting";
  return (
    <div
      className="pf-row t-cell"
      role="row"
      aria-selected={focus}
      data-focus={focus || undefined}
      style={{ transform: `translateY(${top}px)` }}
      onMouseDown={() => setCursor(pane, index)}
      onDoubleClick={() => runAction("nav.open", { pane, before: () => setCursor(pane, index) })}
    >
      <span className="pf-cell pf-name truncate" role="cell">{f.label ?? targetName(f.target)}</span>
      <span className="pf-cell truncate" role="cell">{f.namespace}</span>
      <span className="pf-cell truncate" role="cell" {...tip(targetText(f), { plain: true, reason: m?.origin ? `started on ${m.origin}` : undefined })}>{targetText(f)}</span>
      <span className="pf-cell pf-owner truncate" role="cell" {...tip(ownerText(f), { plain: true })}>{f.owner.by === "agent" ? `agent: ${f.owner.client}` : f.requestedBy ? `me · ${f.requestedBy}` : "me"}</span>
      {named ? (
        <span className="pf-cell pf-named truncate" role="cell" {...tip(named, { plain: true, reason: `also ${forwardHost(f)}` })}>
          {named}
        </span>
      ) : (
        <span className="pf-cell truncate" role="cell">{forwardHost(f)}</span>
      )}
      <span className="pf-cell num truncate" role="cell">{remoteText(f)}</span>
      <span className="pf-cell pf-state truncate" role="cell" {...(broken || waiting ? tip(broken ? "Error" : "Waiting", { reason: f.message }) : undefined)}>
        <Glyph state={broken ? "error" : waiting ? "progress" : "ok"} />
        <span className={broken ? "status-word pf-broken" : waiting ? "status-word pf-waiting" : "status-word"}>{broken ? "Error" : waiting ? "Waiting" : "Active"}</span>
      </span>
      <span className="pf-cell pf-age muted num" role="cell">{ageText(now - (m?.at ?? f.startedAt))}</span>
      <span className="pf-cell pf-acts" role="cell">
        {/* plain buttons, not ActionButtons: a row must not subscribe to the engine (frontend.md §17) */}
        {ROW_ACTIONS.map(({ action, icon }) => (
          <button
            key={action}
            type="button"
            className="k-abtn"
            tabIndex={-1}
            // the registry's label and, when the tooltip opens, the live key: nothing per row
            {...actionTip(action)}
            aria-label={LABEL[action]}
            data-action={action}
            onMouseDown={keepFocus}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              runAction(action, { pane, before: () => setCursor(pane, index) });
            }}
          >
            <Icon name={icon} />
          </button>
        ))}
      </span>
    </div>
  );
});

export default function PortForwardsView({ pane, focused, visible }: ViewProps<"portforwards">) {
  const list = useForwards((s) => s.list);
  const loaded = useForwards((s) => s.loaded);
  const error = useForwards((s) => s.error);
  const cursor = useForwards((s) => cursorIndex(s, pane));
  const rowHeight = useSettings((s) => s.rowHeight);
  const names = useNames((s) => s.status);
  const namesOn = names?.on === true;
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());

  // polled only while this pane is on screen
  useEffect(() => (visible ? watchForwards() : undefined), [visible]);
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(t);
  }, [visible]);
  useEffect(() => () => forgetCursor(pane), [pane]);


  const virtual = useVirtualizer({
    count: list.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  });
  useEffect(() => {
    virtual.measure();
  }, [rowHeight, virtual]);
  useEffect(() => {
    if (cursor >= 0) virtual.scrollToIndex(cursor, { align: "auto" });
  }, [cursor, virtual]);

  // B2: copy a connection string; names on one port (mouse parity for `:dev names on|off`)
  const connToolbar = (
    <PaneToolbar
      label="Connection"
      items={[
        { action: "pf.copyUrl", icon: "link" },
        { action: "dev.picker", args: ["names", namesOn ? "off" : "on"], label: namesOn ? "names off" : "names on one port", icon: "link", showLabel: true, active: namesOn },
      ]}
    />
  );

  if (!loaded) return <EmptyState compact>syncing</EmptyState>;
  if (list.length === 0) {
    if (error) return <EmptyState compact>Could not list port-forwards: {error}</EmptyState>;
    return (
      <>
        {connToolbar}
        <EmptyState title="No port-forwards">
          <ActionHint action="pf.start" label="port-forward" /> on a pod, service or workload starts one
        </EmptyState>
      </>
    );
  }

  return (
    <div className="pf-view" role="table" aria-label="Port-forwards" aria-rowcount={list.length} data-pane-focused={focused || undefined}>
      <PaneSlot name="count">{list.length}</PaneSlot>
      {namesOn && <PaneSlot name="labels">NAMES :{names.port}</PaneSlot>}
      {connToolbar}
      <div className="pf-head t-colhead" role="row">
        <span role="columnheader">Name</span>
        <span role="columnheader">Namespace</span>
        <span role="columnheader">Target</span>
        <span role="columnheader">Owner</span>
        <span role="columnheader">Local</span>
        <span role="columnheader" className="num">Remote</span>
        <span role="columnheader">State</span>
        <span role="columnheader" className="num">Age</span>
        <span role="columnheader" aria-hidden="true" />
      </div>
      {error && <div className="pf-error t-ui" role="status">listing failed: {error}</div>}
      <div className="pf-scroll" ref={scroller}>
        <div className="pf-rows" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((item) => {
            const f = list[item.index];
            return f ? <Row key={f.id} pane={pane} index={item.index} f={f} focus={item.index === cursor} top={item.start} now={now} named={nameUrl(names, f.id)} /> : null;
          })}
        </div>
      </div>
    </div>
  );
}
