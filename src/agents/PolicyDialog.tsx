// The agent policy of one context (Enter on a policy row, `:mcp policy`; plan §5.4): off / read /
// propose plus an optional namespace allowlist. `propose` on a protected context asks for the
// tier-2 confirm after this dialog closes (setPolicy).
import { useState } from "react";
import type { OverlayProps } from "../foundation";
import { contextFlags, Dialog, Field, RadioGroup } from "../foundation";
import type { McpPolicy } from "../ipc/types";
import { setPolicy } from "./actions";
import { policyOf } from "./model";
import { getMcpStatus } from "./store";
import "./agents.css";

const NS = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export default function PolicyDialog({ props, close }: OverlayProps<{ context: string }>) {
  const context = props.context;
  const current = policyOf(getMcpStatus(), context);
  const flags = contextFlags(context);
  const [policy, setChoice] = useState<McpPolicy>(current.policy);
  const [ns, setNs] = useState((current.namespaces ?? []).join(", "));
  const list = ns.split(/[\s,]+/).filter(Boolean);
  const bad = list.find((n) => !NS.test(n));

  const save = () => {
    if (bad) return;
    close();
    void setPolicy(context, policy, list.length ? list : undefined);
  };

  return (
    <Dialog title={`Agents in ${context}`} confirmLabel="Save" confirmDisabled={!!bad} confirmDisabledReason={`"${bad}" is not a namespace name`} onConfirm={save} onCancel={close}>
      <RadioGroup
        legend="What agents may do"
        name="agents-policy-ctx"
        value={policy}
        options={[
          { value: "off", label: "off: agents see nothing in this context" },
          { value: "read", label: "read: objects, logs, events, diagnoses (secrets masked)" },
          { value: "propose", label: "propose: also ask for forwards, env exports and changes; you approve each" },
        ]}
        onChange={setChoice}
      />
      <Field label="Only these namespaces (optional, comma separated)" value={ns} onChange={(e) => setNs(e.target.value)} placeholder="every namespace" error={bad ? `"${bad}" is not a namespace name` : undefined} />
      {flags.protected && <p className="agents-note t-ui-multi" data-kind="warn">{context} is protected: allowing proposals asks you to type its name, and every request here is tier 2.</p>}
      {flags.readOnly && <p className="agents-note t-ui-multi">{context} is read-only in kns: agents can only read here, whatever you pick.</p>}
      <p className="agents-note t-ui-multi">With a namespace list, cluster-scoped objects (nodes, CRDs, cluster roles) are hidden from agents. Lowering the policy cancels open requests here.</p>
    </Dialog>
  );
}
