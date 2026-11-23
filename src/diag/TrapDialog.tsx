// `:trap` (docs/plan-features.md §3 C2): what to wait for and for how long. Arming changes nothing
// in the cluster: kns watches the pods while it runs and saves a redacted bundle when it fires.
import { useState } from "react";
import { backend, Checkbox, Dialog, RadioGroup, toast, type OverlayProps } from "../foundation";
import type { TrapTrigger } from "../ipc/types";
import { cleanUntrusted } from "../ui/untrusted";
import type { TrapDialogProps } from "./c2-actions";
import { errorText, refreshTraps } from "./c2-store";
import { DEFAULT_TRIGGERS, DURATIONS, TRIGGERS, untilFor, type Duration } from "./traps-model";

export default function TrapDialog({ props, close }: OverlayProps<TrapDialogProps>) {
  const [triggers, setTriggers] = useState<TrapTrigger[]>([...DEFAULT_TRIGGERS]);
  const [duration, setDuration] = useState<Duration>("1h");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ref, context } = props;
  const label = cleanUntrusted(`${ref.gvr.resource.replace(/s$/, "")}/${ref.name}${ref.namespace ? ` (${ref.namespace})` : ""}`);
  const reason = busy ? "arming" : triggers.length === 0 ? "pick at least one trigger" : null;
  const toggle = (t: TrapTrigger, on: boolean) => setTriggers((list) => (on ? [...list.filter((x) => x !== t), t] : list.filter((x) => x !== t)));

  return (
    <Dialog
      title="Arm a trap"
      confirmLabel="Arm"
      confirmDisabled={reason !== null}
      confirmDisabledReason={reason ?? undefined}
      onConfirm={() => {
        if (reason !== null) return;
        setBusy(true);
        setError(null);
        backend.trapArm({ context, gvr: ref.gvr, namespace: ref.namespace, name: ref.name }, { triggers: TRIGGERS.map((t) => t.value).filter((t) => triggers.includes(t)), until: untilFor(duration) }).then(
          () => {
            close();
            toast({ kind: "ok", text: `Trap armed on ${label}: kns saves an incident bundle when it fires (:traps)` });
            void refreshTraps();
          },
          (e: unknown) => {
            setBusy(false);
            setError(errorText(e));
          },
        );
      }}
      onCancel={close}
    >
      <div className="t-body c2-trap-target" dir="ltr">
        {label} · context {cleanUntrusted(context)}
      </div>
      <fieldset className="k-radio-group">
        <legend className="t-label">Fire when</legend>
        {TRIGGERS.map((t) => (
          <Checkbox key={t.value} label={t.label} checked={triggers.includes(t.value)} onChange={(e) => toggle(t.value, e.target.checked)} />
        ))}
      </fieldset>
      <RadioGroup legend="Keep it armed for" name="trap-duration" value={duration} options={DURATIONS} onChange={setDuration} />
      <div className="t-ui-multi c2-trap-lines">
        <div>Watches the pods while kns runs; nothing is changed in the cluster.</div>
        <div>A bundle holds the diagnosis, events, previous and current logs, metric samples and the pod YAML, redacted.</div>
        <div>At most one bundle a minute per trap.</div>
      </div>
      {error && (
        <p className="t-ui-multi" role="alert">
          {cleanUntrusted(error)}
        </p>
      )}
    </Dialog>
  );
}
