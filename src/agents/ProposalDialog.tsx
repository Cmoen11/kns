// The review dialog of an agent proposal (docs/plan-features.md §5.5). One dialog per proposal,
// opened only by the human (leader y, the bottom-row "agent" item, the activity row, :proposals).
// A decision radio picks Approve or Reject, so Enter always does what the radio says and a
// keyboard user never hits Reject or Approve by accident; Esc puts the request back (pending).
//
// Every kind shows "requested by" and the agent's note as unverified, quoted text. Dev-set kinds
// reuse the approval list of B-dev (`ApproveSetBody`); env exports list secret keys unticked
// (ticking any makes it tier 2); forwards and dev sets offer who owns the forwards afterwards.
// The primary ignores input for 500 ms; a read-only context offers Reject only.
import { useEffect, useMemo, useState } from "react";
import type { OverlayProps } from "../foundation";
import type { ApprovalChoices, DevSet, Proposal } from "../ipc/types";
import type { RequestedSpec } from "../actions/ops/requested";
import { ApproveSetBody } from "../dev/ApproveSetDialog";
import { targetText } from "../dev/model";
import { Checkbox, Dialog, Facts, Field, Literal, RadioGroup } from "../ui";
import { cleanUntrusted, Untrusted } from "../ui/untrusted";
import { approvalTier, envChanges, expectedTyped } from "./proposal-model";
import "./agents.css";

export const GRACE_MS = 500;

export type Decision =
  | { kind: "approve"; choices: ApprovalChoices }
  | { kind: "reject"; reason?: string }
  /** apply only: the human opens the YAML as their own draft; the proposal ends rejected */
  | { kind: "draft" };

export interface ReviewProps {
  proposal: Proposal;
  title: string;
  /** `claude-code (token "claude-code", created 2026-11-22)` */
  requestedBy: string;
  protected: boolean;
  readOnly: boolean;
  /** devSetUp / devSetDelete: the stored set; devSetUpdate: the proposed content */
  set?: DevSet;
  /** side-effect warnings of the env workload */
  warnings?: string[];
  /** secret-sourced keys an export could include (shown unticked) */
  exportSecrets?: string[];
  /** the workload of a devSetUp's env (the typed text when secrets are ticked) */
  workload?: string;
  /** ops kinds: the confirm of the manual action at tier >= 1 */
  ops?: RequestedSpec;
  /** apply: why "open as draft" is not offered (a kept draft of the human, a Secret) */
  draftBlocked?: string | null;
  /** setting agentForwardIdleMinutes */
  idleMinutes: number;
  onDecide: (d: Decision) => void;
  onCancel: () => void;
}

type Choice = "approve" | "reject" | "draft";
type OwnerChoice = "user" | "agent";

function NoteAndFacts({ p, requestedBy, facts }: { p: Proposal; requestedBy: string; facts: { label: string; value: string }[] }) {
  return (
    <>
      <Facts facts={[...facts, { label: "requested by", value: requestedBy }]} />
      {p.reason && <Untrusted text={p.reason} label="agent's note (unverified)" />}
    </>
  );
}

/** The kind-specific body (what will happen if approved). */
function Body(props: ReviewProps & { ticked: ReadonlySet<string>; onTick: (k: string) => void }) {
  const { proposal: p, requestedBy, set, warnings, exportSecrets, ops, ticked, onTick } = props;
  const pl = p.payload;
  switch (pl.kind) {
    case "devSetUp":
    case "devSetUpdate":
      if (!set) return <p className="agents-note">The dev set is gone.</p>;
      return (
        <>
        <ApproveSetBody
          set={set}
          facts={[{ label: "requested by", value: requestedBy }, ...(pl.kind === "devSetUp" && pl.exportEnv ? [{ label: "export", value: `${pl.exportEnv.format} file (you pick where)` }] : [])]}
          reason={p.reason}
          warnings={warnings}
          exportSecrets={pl.kind === "devSetUp" && pl.exportEnv ? exportSecrets : undefined}
          ticked={ticked}
          onTick={onTick}
          onApprove={() => {}}
          onCancel={() => {}}
        />
        {pl.kind === "devSetUpdate" &&
          envChanges(set.approvedSnapshot?.env, set.env).map((l, i) => (
            <div key={i} className={l.startsWith("+") ? "dev-add t-mono" : l.startsWith("-") ? "dev-del t-mono" : "t-mono"}>
              {l}
            </div>
          ))}
        {pl.kind === "devSetUpdate" && <p className="agents-note">Approving saves this content as your set, approved; your auto-start, connection secrets and ticked secret keys stay as they are.</p>}
        </>
      );
    case "devSetDelete":
      return (
        <>
          <NoteAndFacts p={p} requestedBy={requestedBy} facts={[{ label: "set", value: set?.name ?? pl.devSet }, { label: "context", value: p.context }]} />
          <p className="agents-note">The set is deleted and its running forwards stop. Nothing in the cluster changes.</p>
        </>
      );
    case "forward":
      return (
        <>
          <NoteAndFacts
            p={p}
            requestedBy={requestedBy}
            facts={[
              { label: "target", value: `${targetText(pl.target)} in ${pl.target.namespace}` },
              { label: "port", value: `${pl.remotePort} → 127.0.0.1:${pl.localPort ?? "free port"}` },
              { label: "context", value: pl.context },
            ]}
          />
          <p className="agents-note">{targetText(pl.target)}: local processes, including the requesting agent, can use this connection.</p>
        </>
      );
    case "envExport": {
      const w = pl.spec.workload;
      return (
        <>
          <NoteAndFacts
            p={p}
            requestedBy={requestedBy}
            facts={[
              { label: "workload", value: `${w.gvr.resource}/${w.name}` },
              { label: "namespace", value: w.namespace },
              { label: "context", value: p.context },
              { label: "format", value: pl.spec.format },
              ...(pl.devSet ? [{ label: "dev set", value: set?.name ?? pl.devSet }] : []),
            ]}
          />
          <p className="agents-note">
            your local process will act as <b>{w.gvr.resource}/{w.name}</b> in <b>{p.context}</b>. The file goes where you pick in the save dialog; never to the clipboard.
          </p>
          {(pl.spec.overrides ?? []).map((o) => (
            <div key={o.key} className="t-mono">
              override <code>{cleanUntrusted(o.key, 80)}={cleanUntrusted(o.value, 200)}</code>
            </div>
          ))}
          {(warnings ?? []).map((x, i) => (
            <p key={i} className="agents-note" data-kind="warn">
              {x}
            </p>
          ))}
          {exportSecrets && exportSecrets.length > 0 && (
            <>
              <p className="agents-note" data-kind="warn">
                Secret keys are left out unless you tick them. The agent runs as you and can read the written file.
              </p>
              {exportSecrets.map((k) => (
                <Checkbox key={k} label={k} checked={ticked.has(k)} onChange={() => onTick(k)} />
              ))}
            </>
          )}
        </>
      );
    }
    case "apply":
      return (
        <>
          <NoteAndFacts
            p={p}
            requestedBy={requestedBy}
            facts={[
              { label: "kind", value: pl.parsed.gvr.resource },
              { label: "name", value: pl.parsed.name },
              { label: "namespace", value: pl.parsed.namespace },
              { label: "context", value: pl.context },
              { label: "dry run", value: pl.parsed.dryRun === "ok" ? "ok" : cleanUntrusted(pl.parsed.dryRun, 300) },
            ]}
          />
          <pre className="t-mono selectable" dir="ltr" style={{ maxHeight: "16em", overflow: "auto", margin: 0 }}>
            {cleanUntrusted(pl.yaml, 64 * 1024, { multiline: true })}
          </pre>
        </>
      );
    default:
      return ops ? (
        <>
          <Facts facts={[...ops.facts]} />
          {p.reason && <Untrusted text={p.reason} label="agent's note (unverified)" />}
          <p className="agents-note">{ops.body}</p>
        </>
      ) : null;
  }
}

export default function ProposalDialog({ props, close }: OverlayProps<ReviewProps>) {
  const { proposal: p, readOnly, onDecide, onCancel, idleMinutes } = props;
  const kind = p.payload.kind;
  const [choice, setChoice] = useState<Choice>(readOnly ? "reject" : "approve");
  const [owner, setOwner] = useState<OwnerChoice>(kind === "forward" && idleMinutes > 0 ? "agent" : "user");
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), GRACE_MS);
    return () => clearTimeout(t);
  }, []);

  const input = { protected: props.protected, includeSecrets: [...ticked], workload: props.workload };
  const expected = props.ops?.typeToConfirm ?? expectedTyped(p, input);
  const tier = props.ops ? props.ops.tier : approvalTier(p, input);
  const shownHash = useMemo(() => (p.payload.kind === "devSetUp" ? props.set?.hash : undefined), [p, props.set]);
  const hasOwner = kind === "forward" || kind === "devSetUp";

  const choices: { value: Choice; label: string }[] = [
    ...(readOnly ? [] : [{ value: "approve" as const, label: kind === "apply" ? "Apply the agent's YAML as shown" : "Approve" }]),
    ...(kind === "apply" && !readOnly && !props.draftBlocked ? [{ value: "draft" as const, label: "Open it as a draft and apply my own version" }] : []),
    { value: "reject" as const, label: "Reject (the agent gets your reason)" },
  ];
  const blocked =
    choice === "approve" && !ready ? "read the request first" : choice === "approve" && expected !== null && typed.trim() !== expected ? `type ${expected}` : null;

  const decide = () => {
    if (blocked) return;
    close();
    if (choice === "reject") return onDecide({ kind: "reject", reason: reason.trim() || undefined });
    if (choice === "draft") return onDecide({ kind: "draft" });
    const c: ApprovalChoices = {};
    if (hasOwner) c.owner = owner === "agent" && idleMinutes > 0 ? { by: "agent", idleStopMinutes: idleMinutes } : { by: "user" };
    if (ticked.size > 0) c.includeSecrets = [...ticked];
    if (expected !== null) c.typed = typed.trim();
    if (shownHash) c.shownHash = shownHash;
    onDecide({ kind: "approve", choices: c });
  };

  const confirmLabel = choice === "reject" ? "Reject" : choice === "draft" ? "Open draft" : (props.ops?.confirmLabel ?? (kind === "apply" ? "Apply" : "Approve"));

  return (
    <Dialog
      title={props.title}
      glyph={tier >= 2 ? "warn" : undefined}
      confirmLabel={confirmLabel}
      cancelLabel="Later"
      confirmDisabled={blocked !== null}
      confirmDisabledReason={blocked ?? undefined}
      onConfirm={decide}
      onCancel={() => {
        close();
        onCancel();
      }}
    >
      <Body
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
      {readOnly && <p className="agents-note" data-kind="warn">{p.context} is read-only in kns: you can only reject this request.</p>}
      <RadioGroup legend="Your decision" name="proposal-decision" value={choice} options={choices} onChange={setChoice} />
      {choice === "approve" && hasOwner && (
        <RadioGroup
          legend={kind === "forward" ? "Afterwards the forward is" : "Afterwards the forwards are"}
          name="proposal-owner"
          value={owner}
          options={[
            { value: "user", label: "kept running · owned by me" },
            ...(idleMinutes > 0 ? [{ value: "agent" as const, label: `stopped when the agent is idle for ${idleMinutes} min` }] : []),
          ]}
          onChange={setOwner}
        />
      )}
      {choice === "approve" && expected !== null && (
        <Field
          label={
            <>
              Type <Literal>{expected}</Literal> to {ticked.size > 0 ? "include secret values" : "approve in a protected context"}
            </>
          }
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      )}
      {choice === "reject" && <Field label="Reason for the agent (optional)" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
      {choice === "draft" && <p className="agents-note">The YAML opens in an editor beside, labelled AGENT DRAFT. Nothing is applied until you save it through the normal review; the agent is told you took it over.</p>}
      {kind === "apply" && props.draftBlocked && !readOnly && <p className="agents-note">{props.draftBlocked}</p>}
    </Dialog>
  );
}
