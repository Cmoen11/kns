// The approval list (docs/plan-features.md §3 B-dev, §5.5): every forward, rewrite and env detail of
// a set, its origin, the diff against the last approved content, the data-plane line per service,
// "your local process will act as …", side-effect warnings and, with an export, the secret keys
// by name (unticked; ticking any makes it tier 2). Prop-driven: H2 reuses it for agent proposals.
// The primary button ignores input for 500 ms.
import { useEffect, useMemo, useState } from "react";
import type { OverlayProps } from "../foundation";
import { Checkbox, Dialog, Facts, Field, Literal } from "../ui";
import { cleanUntrusted, Untrusted } from "../ui/untrusted";
import type { ApproveSetProps } from "./flows";
import { approved, diffLines, forwardLine, originText, rewriteLine, targetText } from "./model";
import "./dev.css";

const GRACE_MS = 500;

export function ApproveSetBody(props: ApproveSetProps & { ticked: ReadonlySet<string>; onTick: (key: string) => void }) {
  const { set, facts, reason, warnings, exportSecrets, ticked, onTick } = props;
  const diff = diffLines(set);
  const services = [...new Set(set.forwards.map((f) => targetText(f.target)))];
  const w = set.env?.workload;
  return (
    <div className="dev-approve t-ui-multi" dir="ltr">
      <Facts
        facts={[
          { label: "set", value: set.name },
          { label: "context", value: set.context },
          { label: "origin", value: originText(set) },
          ...(facts ?? []),
        ]}
      />
      {reason && <Untrusted text={reason} label="agent's note (unverified)" />}
      <div className="dev-section t-label">Forwards {set.forwards.length}</div>
      {set.forwards.map((f) => (
        <div key={f.key}>{forwardLine(f)}</div>
      ))}
      {services.map((s) => (
        <div key={s} className="muted">
          {s}: local processes, including the requesting agent, can use this connection
        </div>
      ))}
      {set.rewrites.length > 0 && <div className="dev-section t-label">Rewrites {set.rewrites.length}</div>}
      {set.rewrites.map((r, i) => (
        <div key={i}>{rewriteLine(r, set.forwards)}</div>
      ))}
      {set.env && w && (
        <>
          <div className="dev-section t-label">Env</div>
          <div>
            your local process will act as <b>{w.gvr.resource}/{w.name}</b> in <b>{set.context}</b>
          </div>
          {(set.env.overrides ?? []).map((o) => (
            <div key={o.key}>
              override <code>{cleanUntrusted(o.key, 80)}={cleanUntrusted(o.value, 200)}</code>
            </div>
          ))}
          {(warnings ?? []).map((x, i) => (
            <div key={i} className="dev-warn">
              {x}
            </div>
          ))}
        </>
      )}
      {!approved(set) && set.approvedSnapshot && <div className="dev-section t-label">Changed since approval</div>}
      {diff.map((l, i) => (
        <div key={i} className={l.startsWith("+") ? "dev-add" : l.startsWith("-") ? "dev-del" : ""}>
          {l}
        </div>
      ))}
      {exportSecrets && exportSecrets.length > 0 && (
        <>
          <div className="dev-section t-label">Export: secret keys</div>
          <div className="muted">Ticked keys are written to the file; the agent runs as you and can read it.</div>
          {exportSecrets.map((k) => (
            <Checkbox key={k} label={k} checked={ticked.has(k)} onChange={() => onTick(k)} />
          ))}
        </>
      )}
    </div>
  );
}

export default function ApproveSetDialog({ props, close }: OverlayProps<ApproveSetProps>) {
  const { set, protectedContext, confirmLabel, onApprove, onCancel } = props;
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [typed, setTyped] = useState("");
  const [ready, setReady] = useState(false);
  // the set as shown: its hash is what the start passes
  const shownHash = useMemo(() => set.hash, [set]);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), GRACE_MS);
    return () => clearTimeout(t);
  }, []);

  const w = set.env?.workload;
  const expected = ticked.size > 0 ? (w?.name ?? set.name) : protectedContext ? set.context : null;
  const reason = !ready ? "read the list first" : expected !== null && typed.trim() !== expected ? `type ${expected}` : null;

  return (
    <Dialog
      title={`Start dev set ${set.name}`}
      confirmLabel={confirmLabel ?? "Approve"}
      confirmDisabled={reason !== null}
      confirmDisabledReason={reason ?? undefined}
      onConfirm={() => {
        if (reason !== null) return;
        close();
        onApprove({ includeSecrets: [...ticked], typed: expected === null ? undefined : typed.trim(), shownHash });
      }}
      onCancel={() => {
        close();
        onCancel();
      }}
    >
      <ApproveSetBody
        {...props}
        ticked={ticked}
        onTick={(k) =>
          setTicked((s) => {
            const n = new Set(s);
            if (n.has(k)) n.delete(k);
            else n.add(k);
            return n;
          })
        }
      />
      {expected !== null && (
        <Field
          label={
            <>
              Type <Literal>{expected}</Literal> to {ticked.size > 0 ? "include secret values" : "start in a protected context"}
            </>
          }
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      )}
    </Dialog>
  );
}
