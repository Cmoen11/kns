// The traffic view (`:traffic`, docs/tools.md#traffic): who a pod talks to. Reads the pod's socket
// table every 3 s while the pane is visible (traffic.rs) and adds the readings up: outbound flows
// by peer and port, inbound by the pod's port and the peer (pods of one workload together), and
// what it listens on. Enter opens the peer (describe); `p` pauses, `x` starts over.
import { useEffect, useMemo, useRef, useState } from "react";
import { fallbackNamespaces } from "../catalog/namespaces";
import { backend, openView, toObjRef, usePaneContext, type ViewProps } from "../foundation";
import type { BackendError, TrafficPeer } from "../ipc/types";
import { docView } from "../table/drill";
import type { ObjectRef } from "../types";
import { EmptyState } from "../ui";
import { ListPane } from "../views/tools/ListPane";
import type { ListRow } from "../views/tools/list-model";
import { setTrafficControls } from "./actions";
import { addSample, connecting, EMPTY, flowStatus, peerLabel, sortFlows, type Flow, type Traffic } from "./model";

const EVERY_MS = 3000;
const core = (resource: string) => ({ group: "", version: "v1", resource });

/** The object Enter opens for a peer; none for an address outside the cluster. */
function peerRef(p: TrafficPeer): ObjectRef | undefined {
  switch (p.kind) {
    case "pod":
    case "self":
      return { gvr: core("pods"), namespace: p.namespace, name: p.name };
    case "service":
      return { gvr: core("services"), namespace: p.namespace, name: p.name };
    case "node":
      return { gvr: core("nodes"), name: p.name };
    default:
      return undefined;
  }
}

type Failure = { message: string; reason: string };

export default function TrafficView({ pane, view, focused, visible }: ViewProps<"traffic">) {
  const context = usePaneContext(pane);
  const [traffic, setTraffic] = useState<Traffic>(EMPTY);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = useRef({ paused });
  live.current = { paused };
  const podKey = `${context}/${view.pod.namespace}/${view.pod.name}/${view.container ?? ""}`;

  // another pod (back / forward through the history): start over
  useEffect(() => {
    setTraffic(EMPTY);
    setFailure(null);
  }, [podKey]);

  useEffect(() => {
    if (!visible || paused || !context) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      setBusy(true);
      try {
        const s = await backend.trafficSample({ ref: toObjRef(view.pod, context), container: view.container, namespaces: fallbackNamespaces(context) });
        if (stopped) return;
        setTraffic((t) => addSample(t, s, Date.now()));
        setFailure(null);
      } catch (e) {
        if (stopped) return;
        const err = e as Partial<BackendError> | null;
        setFailure({ message: err?.message ?? String(e), reason: err?.reason ?? "" });
        // no `cat` anywhere: reading again will not help until a debug container is added
        if (err?.reason === "NeedsDebug") return setBusy(false);
      }
      setBusy(false);
      if (!stopped) timer = setTimeout(() => void read(), EVERY_MS);
    };
    void read();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [visible, paused, context, podKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () =>
      setTrafficControls(pane, {
        togglePause: () => setPaused((p) => !p),
        clear: () => {
          setTraffic(EMPTY);
          setFailure(null);
          setPaused(false);
        },
        paused: () => live.current.paused,
      }),
    [pane],
  );

  const ownNs = view.pod.namespace;
  const rows = useMemo<ListRow[]>(() => {
    const now = traffic.at ?? Date.now();
    const out: ListRow[] = [];
    const head = [
      traffic.container ? `through ${traffic.container}` : "",
      paused ? "paused (p)" : `every ${EVERY_MS / 1000} s`,
      `${traffic.readings} readings`,
      failure ? `last reading failed: ${failure.message}` : "",
    ].filter(Boolean);
    out.push({ type: "group", key: "g:about", label: head.join(" · ") });
    for (const [i, n] of traffic.notes.entries()) out.push({ type: "group", key: `g:note:${i}`, label: n });
    const flowRow = (f: Flow): ListRow => {
      const ref = peerRef(f.peer);
      const label = peerLabel(f.peer, ownNs);
      return {
        type: "item",
        key: f.key,
        glyph: f.open > 0 ? (connecting(f) ? "warn" : "ok") : undefined,
        cells: [label, `${f.port}/${f.proto}`, flowStatus(f, now)],
        value: f.peer.kind === "self" ? "this pod" : f.peer.kind,
        search: `${label} ${f.peer.name} ${f.peer.workload ?? ""} ${f.port} ${f.proto} ${f.members.join(" ")} ${f.peer.kind}`,
        title: [`${f.direction === "out" ? "to" : "from"} ${label} · port ${f.port}/${f.proto}`, `seen in ${f.seen} of ${traffic.readings} readings`, f.members.length ? `${f.members.join(", ")}` : "", connecting(f) ? "still connecting: the peer may refuse or drop it (a NetworkPolicy, a firewall)" : ""].filter(Boolean).join("\n"),
        open: ref ? (newPane) => openView(docView(ref, "describe"), { newPane, context }) : undefined,
      };
    };
    const outbound = sortFlows([...traffic.flows.values()].filter((f) => f.direction === "out"), ownNs);
    const inbound = sortFlows([...traffic.flows.values()].filter((f) => f.direction === "in"), ownNs);
    out.push({ type: "group", key: "g:out", label: `Outbound · ${outbound.length} (the pod connected)` });
    out.push(...outbound.map(flowRow));
    out.push({ type: "group", key: "g:in", label: `Inbound · ${inbound.length} (connected to the pod)` });
    out.push(...inbound.map(flowRow));
    out.push({ type: "group", key: "g:listen", label: `Listening · ${traffic.listening.length}` });
    for (const l of traffic.listening) {
      out.push({ type: "item", key: `l:${l.proto}:${l.ip}:${l.port}`, cells: [`:${l.port}`, l.proto, l.ip === "0.0.0.0" || l.ip === "::" ? "every address" : l.ip], search: `listen ${l.port} ${l.proto} ${l.ip}` });
    }
    return out;
  }, [traffic, failure, paused, ownNs, context]);

  if (traffic.readings === 0 && failure) {
    return (
      <EmptyState compact title="Could not read the socket table">
        {failure.message}
      </EmptyState>
    );
  }
  if (traffic.readings === 0) return <EmptyState compact>{busy || !visible ? `reading the connections of ${view.pod.name}` : "paused (p)"}</EmptyState>;
  return <ListPane pane={pane} focused={focused} name="traffic" rows={rows} empty={<EmptyState compact>No connections</EmptyState>} />;
}
