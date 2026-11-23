// "Start port-forward" dialog (docs/ux.md §13.5, docs/plan-features.md §2.4). On a Service or a
// workload the target is the object itself by default: Rust picks a ready pod per connection and
// moves on when it goes away (failover; `waiting` while none is ready). "One pod" pins a pod.
// Ports by number or name, local port (default = remote), pin, label, loopback address. Enter starts.
// B2: ports a `k9scli.io/*` annotation asks for are preselected; on Windows "own address" gives the
// service a stable 127.0.1.x so it keeps its own port.
import { useEffect, useRef, useState } from "react";
import { backend, CORE_PODS, focusedContext, kindName, toast, toObjRef, type OverlayProps } from "../../foundation";
import type { BackendError, ForwardTarget, ForwardTargetInfo, PodRef, PortHint } from "../../ipc/types";
import { platform } from "../../keys";
import { Checkbox, Dialog, Facts, Field, objectFacts, RadioGroup } from "../../ui";
import { forwardName, getForwards, startForward } from "./forwards";
import type { PfStartProps } from "./open";
import {
  containerPorts, forwardHost, hintPort, k9sHints, parseLocalPort, parseRemotePort, portLabel, serviceAddress, targetText, validAddress, type ContainerPort,
} from "./ports";

import "./pf.css";

// The fields are prefilled (the container port, its mirror, 127.0.0.1): the dialog selects a
// field's value on keyboard focus (focusField in src/ui/Dialog.tsx), so typing replaces it.

const MAX_PODS = 12;
const CUSTOM = "custom";
const LABEL_RE = /^[A-Za-z0-9 ._-]{1,40}$/;
const WORKLOADS = new Set(["deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "cronjobs"]);

const errorText = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e ? String((e as BackendError).message) : String(e);

/** One option of the port list: what the remote field gets, and its label. */
interface PortOption {
  value: string;
  label: string;
}

export default function PfStartDialog({ props, close }: OverlayProps<PfStartProps>) {
  const { ref, container } = props;
  const context = useRef(focusedContext()).current;
  const isPod = ref.gvr.resource === "pods" && ref.gvr.group === "";
  const isService = ref.gvr.resource === "services" && ref.gvr.group === "";
  const canFollow = isService || WORKLOADS.has(ref.gvr.resource);
  const objectTarget: ForwardTarget | null = !ref.namespace
    ? null
    : isService
      ? { kind: "service", namespace: ref.namespace, name: ref.name }
      : canFollow
        ? { kind: "workload", gvr: ref.gvr, namespace: ref.namespace, name: ref.name }
        : null;
  const [mode, setMode] = useState<"object" | "pod">(objectTarget ? "object" : "pod");
  const [info, setInfo] = useState<ForwardTargetInfo | null>(null);
  const [pods, setPods] = useState<PodRef[] | null>(null);
  const [pod, setPod] = useState("");
  const [ports, setPorts] = useState<ContainerPort[] | null>(null);
  const [remote, setRemote] = useState("");
  const [local, setLocal] = useState("");
  const [pin, setPin] = useState(false);
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("127.0.0.1");
  const [ownAddress, setOwnAddress] = useState(false);
  /** the annotation port that was preselected, for the line under the ports */
  const [hint, setHint] = useState<{ remote: number; local?: number; auto: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // the local port follows the remote one until the user edits it
  const localTouched = useRef(false);
  const remoteTouched = useRef(false);
  const remoteInput = useRef<HTMLInputElement>(null);

  const prefill = (value: string) => {
    if (remoteTouched.current) return;
    setRemote(value);
    if (!localTouched.current) setLocal(value);
  };
  /** a k9scli.io hint wins over the first port; its local port fills the local field */
  const prefillHint = (hints: readonly PortHint[] | undefined, ports: readonly ContainerPort[]): boolean => {
    for (const h of hints ?? []) {
      const remotePort = hintPort(h, ports);
      if (remotePort === null) continue;
      if (remoteTouched.current) return true;
      setRemote(String(remotePort));
      if (!localTouched.current) setLocal(String(h.localPort ?? remotePort));
      setHint({ remote: remotePort, local: h.localPort, auto: h.auto });
      return true;
    }
    return false;
  };

  // the port arrives after the dialog took focus: select the prefill then too
  useEffect(() => {
    const el = remoteInput.current;
    if (el && !remoteTouched.current && el === document.activeElement) el.select();
  }, [ports, info]);

  // the Service / workload as the target: its ports and the pod it resolves to now
  useEffect(() => {
    if (mode !== "object" || !objectTarget) return;
    let alive = true;
    setInfo(null);
    backend.resolveForwardTarget(context, objectTarget).then(
      (i) => {
        if (!alive) return;
        setInfo(i);
        const first = i.ports[0];
        // a workload's hints name container ports, by number or name: resolve names through its ports
        const named = i.ports.map((p) => ({ container: "", port: p.port, name: p.name, protocol: p.protocol }));
        if (!prefillHint(i.hints, named) && first) prefill(String(first.port));
      },
      (e: unknown) => alive && setError(errorText(e)),
    );
    return () => {
      alive = false;
    };
    // objectTarget is derived from ref
  }, [mode, ref, context]);

  useEffect(() => {
    if (mode !== "pod" || pods !== null) return;
    let alive = true;
    backend.podsFor(toObjRef(ref, context)).then(
      (list) => {
        if (!alive) return;
        const sorted = [...list].sort((a, b) => Number(b.phase === "Running") - Number(a.phase === "Running"));
        setPods(sorted);
        setPod(sorted[0]?.name ?? "");
        if (sorted.length === 0) setError("No pod is behind this object.");
      },
      (e: unknown) => alive && setError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [mode, pods, ref, context]);

  const chosen = pods?.find((p) => p.name === pod);
  const namespace = chosen?.namespace;

  useEffect(() => {
    if (mode !== "pod" || !pod || namespace === undefined) return;
    let alive = true;
    setPorts(null);
    backend.getJson({ context, gvr: CORE_PODS, namespace, name: pod }).then(
      (json) => {
        if (!alive) return;
        const own = container ? containerPorts(json, container) : [];
        const found = own.length > 0 ? own : containerPorts(json);
        setPorts(found);
        if (!prefillHint(k9sHints(json), found) && found.length > 0) prefill(String(found[0].port));
      },
      // ports are a convenience: the remote port can still be typed
      () => alive && setPorts([]),
    );
    return () => {
      alive = false;
    };
  }, [mode, pod, namespace, container, context]);

  const changeRemote = (text: string) => {
    setRemote(text);
    if (!localTouched.current && /^\d+$/.test(text.trim())) setLocal(text);
  };

  // Windows "address per service": a stable 127.0.1.x, so the forward keeps the remote port
  const canOwnAddress = platform !== "mac" && ref.namespace !== undefined;
  const toggleOwnAddress = (on: boolean) => {
    setOwnAddress(on);
    if (!on) return setAddress("127.0.0.1");
    const used = getForwards().map((f) => f.address);
    setAddress(serviceAddress(`${ref.namespace}/${ref.name}`, used) ?? "127.0.0.1");
    if (/^\d+$/.test(remote.trim())) {
      localTouched.current = true;
      setLocal(remote.trim());
    }
  };

  const remotePort = parseRemotePort(remote);
  const localPort = parseLocalPort(local);
  const addressOk = validAddress(address);
  const labelOk = label.trim() === "" || LABEL_RE.test(label.trim());
  const target: ForwardTarget | null = mode === "object" ? objectTarget : chosen ? { kind: "pod", namespace: chosen.namespace, name: chosen.name } : null;
  const reason =
    busy ? "starting"
    : !target ? (mode === "pod" ? "no pod" : "no target")
    : remotePort === null ? "enter the remote port (number or name)"
    : localPort === null ? "the local port is not valid"
    : pin && localPort === 0 ? "a pinned forward needs a local port"
    : !addressOk ? "the address must be a loopback IP"
    : !labelOk ? "the label is 1-40 of A-Z a-z 0-9 space . _ -"
    : null;

  const start = () => {
    if (reason !== null || !target || remotePort === null || localPort === null) return;
    setBusy(true);
    setError(null);
    const origin = isPod ? undefined : `${ref.gvr.resource}/${ref.name}`;
    startForward(
      {
        context,
        target,
        remotePort,
        localPort: localPort || undefined,
        pin: pin || undefined,
        address: address.trim(),
        label: label.trim() || undefined,
      },
      { origin, pod: target.kind === "pod" ? (origin ? { gvr: CORE_PODS, namespace: target.namespace, name: target.name } : ref) : undefined },
    ).then(
      (f) => {
        toast({ kind: f.status === "waiting" ? "warn" : "ok", text: `Forwarding ${forwardHost(f)} -> ${forwardName(f)}${f.status === "waiting" ? " (waiting for a ready pod)" : ""}` });
        close();
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorText(e));
      },
    );
  };

  // the port list: Service ports or the workload's container ports (object), else the pod's
  const portOptions: PortOption[] =
    mode === "object"
      ? (info?.ports ?? []).map((p) => ({ value: String(p.port), label: p.name ? `${p.port} ${p.name}` : String(p.port) }))
      : (ports ?? []).map((p) => ({ value: String(p.port), label: portLabel(p) }));
  const portChoice = portOptions.some((p) => p.value === remote.trim()) ? remote.trim() : CUSTOM;
  const shownPods = pods?.slice(0, MAX_PODS) ?? [];
  const resolvedLine =
    mode === "object" && objectTarget && info
      ? targetText({ target: objectTarget, resolvedPod: info.resolvedPod, status: info.ready ? "active" : "waiting" })
      : null;

  return (
    <Dialog title="Port-forward" confirmLabel="Start" confirmDisabled={reason !== null} confirmDisabledReason={reason ?? undefined} onConfirm={start} onCancel={close}>
      <Facts facts={objectFacts({ kind: kindName(ref), name: ref.name, namespace: ref.namespace, context })} />
      {objectTarget && (
        <RadioGroup
          legend="Target"
          name="pf-target"
          value={mode}
          options={[
            { value: "object", label: isService ? "The Service: any ready endpoint, follows restarts" : "The workload: any ready pod, follows restarts" },
            { value: "pod", label: "One pod" },
          ]}
          onChange={setMode}
        />
      )}
      {resolvedLine && (
        <p className="t-ui-multi pf-resolved" role="status">
          {resolvedLine}
          {!info?.ready && " · the forward waits until a pod is ready"}
        </p>
      )}
      {mode === "pod" && shownPods.length > 1 && (
        <RadioGroup legend="Pod" name="pf-pod" value={pod} options={shownPods.map((p) => ({ value: p.name, label: p.phase === "Running" ? p.name : `${p.name} (${p.phase})` }))} onChange={setPod} />
      )}
      {mode === "pod" && pods && pods.length > MAX_PODS && <p className="t-ui-multi">Showing {MAX_PODS} of {pods.length} pods.</p>}
      {portOptions.length > 1 && (
        <RadioGroup
          legend={mode === "object" && isService ? "Service port" : "Container port"}
          name="pf-port"
          value={portChoice}
          options={[...portOptions, { value: CUSTOM, label: "other" }]}
          onChange={(v) => {
            if (v === CUSTOM) return;
            remoteTouched.current = true;
            changeRemote(v);
          }}
        />
      )}
      {/* remote and local side by side: they are a pair, and the dialog stays short enough for a small window */}
      <div className="pf-ports">
        <Field
          ref={remoteInput}
          label="Remote port"
          placeholder={portOptions.length === 0 && (ports !== null || info !== null) ? "number or port name" : undefined}
          value={remote}
          onChange={(e) => {
            remoteTouched.current = true;
            changeRemote(e.target.value);
          }}
          error={remote.trim() !== "" && remotePort === null ? "1-65535 or a port name" : undefined}
        />
        <Field
          label="Local port"
          inputMode="numeric"
          placeholder="any free port"
          value={local}
          onChange={(e) => {
            localTouched.current = true;
            setLocal(e.target.value);
          }}
          error={localPort === null ? "1-65535, or empty for any free port" : undefined}
        />
      </div>
      {hint && (
        <p className="t-ui-multi pf-resolved" role="status">
          k9scli.io annotation: remote {hint.remote}
          {hint.local !== undefined ? ` → local ${hint.local}` : ""}
          {hint.auto ? " (auto-port-forward)" : ""}
        </p>
      )}
      <Checkbox label="Pin the local port (fail when it is busy)" checked={pin} onChange={(e) => setPin(e.target.checked)} />
      {canOwnAddress && (
        <Checkbox label="Own address 127.0.1.x (keeps the remote port as local port)" checked={ownAddress} onChange={(e) => toggleOwnAddress(e.target.checked)} />
      )}
      <div className="pf-ports">
        <Field label="Label" placeholder="optional" value={label} onChange={(e) => setLabel(e.target.value)} error={labelOk ? undefined : "A-Z a-z 0-9 space . _ -"} />
        <Field label="Address" value={address} onChange={(e) => setAddress(e.target.value)} error={addressOk ? undefined : "127.0.0.1 or ::1"} />
      </div>
      {error && (
        <p className="t-ui-multi" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
