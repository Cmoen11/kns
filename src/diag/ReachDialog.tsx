// `res.reach` without a target (hub Try, row menu, palette): pick the Service (and port) the pod
// should reach. Typing `web:80` or `svc/web 80` works as on the `:` line; the list below fills the
// field with a Service of the pod's namespace. Opening the view changes nothing in the cluster.
import { useMemo, useState } from "react";
import { Dialog, Field, Literal, openView, RadioGroup, useTable, type OverlayProps } from "../foundation";
import { cleanUntrusted } from "../ui/untrusted";
import type { ReachDialogProps } from "./c3-actions";
import { parseReachArgs, SVC_GVR } from "./reach-model";
import "./c3.css";

const MAX_LISTED = 8;

export default function ReachDialog({ props, close }: OverlayProps<ReachDialogProps>) {
  const { from, context } = props;
  const ns = from.namespace ?? "default";
  const query = useMemo(() => ({ context, gvr: SVC_GVR, namespace: ns }), [context, ns]);
  const snap = useTable(query);
  const [text, setText] = useState("");
  const services = useMemo(
    () =>
      snap.rows
        // filter while typing; once the text names a Service, list them all again
        .filter((r, _i, all) => {
          const word = text.split(/[:\s.]/)[0] ?? "";
          return !word || all.some((x) => x.name === word) || r.name.includes(word);
        })
        .slice(0, MAX_LISTED)
        .map((r) => ({ value: r.name, label: cleanUntrusted(`${r.name}${typeof r.cells[4] === "string" && r.cells[4] ? ` · ${r.cells[4]}` : ""}`) })),
    [snap.rows, text],
  );
  const parsed = text.trim() ? parseReachArgs(text.trim().split(/\s+/), ns) : "type a Service, e.g. web:80";
  const error = typeof parsed === "string" ? parsed : undefined;
  const chosen = services.find((s) => s.value === text.split(/[:\s.]/)[0])?.value ?? "";

  return (
    <Dialog
      title="Can it reach?"
      confirmLabel="Check"
      confirmDisabled={error !== undefined}
      confirmDisabledReason={error}
      onConfirm={() => {
        if (typeof parsed === "string") return;
        close();
        openView({ kind: "reach", from, to: parsed.to, port: parsed.port });
      }}
      onCancel={close}
    >
      <div className="t-body c3-dialog-from" dir="ltr">
        from pod/{cleanUntrusted(from.name)} ({cleanUntrusted(ns)}) · context {cleanUntrusted(context)}
      </div>
      <Field
        label={
          <>
            Service and port, like <Literal>web:80</Literal> or <Literal>svc/db.other-ns 5432</Literal>
          </>
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        error={text.trim() ? error : undefined}
      />
      {services.length > 0 ? (
        <RadioGroup legend={`Services in ${cleanUntrusted(ns)}`} name="reach-target" value={chosen} options={services} onChange={(v) => setText(v)} />
      ) : (
        <p className="t-ui-multi c3-dialog-note">{snap.synced ? `No Services in ${cleanUntrusted(ns)} match.` : "reading Services…"}</p>
      )}
      <p className="t-ui-multi c3-dialog-note">Static checks only read the cluster. The probe from inside the pod is offered in the view and asks first.</p>
    </Dialog>
  );
}
