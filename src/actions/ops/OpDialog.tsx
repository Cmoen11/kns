// The dialog behind every confirmed write (docs/ux.md §14, §11.7). Lazy: loaded on the first ask().
import { useEffect, useRef, useState } from "react";
import type { Propagation } from "../../ipc/types";
import type { OverlayProps } from "../../foundation";
import { Checkbox, Dialog, Facts, Field, Literal, RadioGroup } from "../../ui";
import type { AskRequest, AskResult } from "./ask";
import "./ops.css";

const PROPAGATION: readonly { value: Propagation; label: string }[] = [
  { value: "Background", label: "Background" },
  { value: "Foreground", label: "Foreground" },
  { value: "Orphan", label: "Orphan" },
];

const MAX_REPLICAS = 100000;

export default function OpDialog({ props, close }: OverlayProps<AskRequest>) {
  const { opts, resolve } = props;
  const [typed, setTyped] = useState("");
  const [replicas, setReplicas] = useState(opts.replicas?.current != null ? String(opts.replicas.current) : "");
  const [propagation, setPropagation] = useState<Propagation>("Background");
  const [force, setForce] = useState(false);
  const [suspendFlux, setSuspendFlux] = useState(false);

  // A dialog replaced or unmounted without an answer counts as cancelled. The timer keeps
  // StrictMode's mount/unmount/mount from cancelling a dialog that is still open.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (!mounted.current) resolve(null);
      }, 0);
    };
  }, [resolve]);

  const needsText = opts.tier >= 2 && opts.typeToConfirm !== undefined;
  const textOk = !needsText || typed === opts.typeToConfirm;
  const count = /^\d+$/.test(replicas) ? Number(replicas) : NaN;
  const replicasOk = !opts.replicas || (Number.isInteger(count) && count <= MAX_REPLICAS);
  const ready = textOk && replicasOk;
  const reason = !replicasOk ? "enter a replica count" : needsText ? `type ${opts.typeToConfirm} to confirm` : undefined;

  const settle = (r: AskResult | null) => {
    resolve(r);
    close();
  };
  const result = (): AskResult => ({
    propagation: opts.deleteOptions ? propagation : undefined,
    force: opts.deleteOptions ? force : undefined,
    replicas: opts.replicas ? count : undefined,
    suspendFlux: opts.flux?.offer ? suspendFlux : undefined,
  });

  return (
    <Dialog
      title={opts.title}
      glyph={opts.tier === 3 ? "error" : undefined}
      confirmLabel={opts.confirmLabel}
      confirmDisabled={!ready}
      confirmDisabledReason={reason}
      onConfirm={() => ready && settle(result())}
      onCancel={() => settle(null)}
    >
      {opts.body && <p>{opts.body}</p>}
      {opts.facts && <Facts facts={opts.facts} />}
      {opts.items && (
        <ul className="k-items t-mono selectable">
          {opts.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      )}
      {opts.replicas && (
        <Field
          label={opts.replicas.current != null ? `Replicas (now ${opts.replicas.current})` : "Replicas"}
          inputMode="numeric"
          // typing replaces the current count: the dialog selects a prefilled field on keyboard focus
          value={replicas}
          error={replicas !== "" && !replicasOk ? "A whole number, 0 or more" : undefined}
          onChange={(e) => setReplicas(e.target.value.trim())}
        />
      )}
      {opts.flux && (
        <div className="ops-flux">
          <p>
            Managed by {opts.flux.by ?? "Flux"} ({opts.flux.owner}). {opts.flux.effect}
          </p>
          {opts.flux.offer && (
            <Checkbox label={`Suspend ${opts.flux.owner} first`} checked={suspendFlux} onChange={(e) => setSuspendFlux(e.target.checked)} />
          )}
        </div>
      )}
      {opts.deleteOptions && (
        <>
          <RadioGroup legend="Propagation" name="ops-propagation" value={propagation} options={PROPAGATION} onChange={setPropagation} />
          <Checkbox label="Force (grace period 0)" checked={force} onChange={(e) => setForce(e.target.checked)} />
        </>
      )}
      {needsText && (
        <Field
          // the text to type as written (a label is upper case, a name is case-sensitive)
          label={
            <>
              Type <Literal>{opts.typeToConfirm}</Literal> to confirm
            </>
          }
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      )}
    </Dialog>
  );
}
