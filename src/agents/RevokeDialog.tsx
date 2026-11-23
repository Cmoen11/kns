// Revoking a client (`x` in the agents view, `:mcp revoke <name>`; plan §3 H1 step 3, §5.2): the
// token stops working at once, its open requests are cancelled and the forwards it still owns stop
// (Rust). Forwards it requested that the human took over are listed with "stop these too",
// checked by default.
import { useEffect, useState } from "react";
import type { OverlayProps } from "../foundation";
import { backend, Checkbox, Dialog, Facts, toast, toasts } from "../foundation";
import type { BackendError, Forward } from "../ipc/types";
import { refreshStatus } from "./store";
import "./agents.css";

const label = (f: Forward) => `${f.context} · ${f.target.kind}/${f.target.namespace}/${f.target.name} → 127.0.0.1:${f.localPort}`;

export default function RevokeDialog({ props, close }: OverlayProps<{ name: string }>) {
  const name = props.name;
  const [forwards, setForwards] = useState<Forward[] | null>(null);
  const [stopTaken, setStopTaken] = useState(true);
  useEffect(() => {
    backend.listForwards().then(setForwards, () => setForwards([]));
  }, []);
  const owned = (forwards ?? []).filter((f) => f.owner.by === "agent" && f.owner.client === name);
  const taken = (forwards ?? []).filter((f) => f.owner.by === "user" && f.requestedBy === name);

  const run = async () => {
    try {
      await backend.mcpClientRevoke(name);
      if (stopTaken) for (const f of taken) await backend.stopForward(f.id).catch(() => {});
      refreshStatus();
      const stopped = owned.length + (stopTaken ? taken.length : 0);
      toast({ kind: "ok", text: `Revoked ${name}${stopped ? ` · stopped ${stopped} forward${stopped === 1 ? "" : "s"}` : ""}` });
      close();
    } catch (e) {
      toasts.error(`Revoke ${name}: ${(e as Partial<BackendError>)?.message ?? String(e)}`);
    }
  };

  return (
    <Dialog title={`Revoke ${name}`} confirmLabel="Revoke" confirmDisabled={forwards === null} confirmDisabledReason="reading forwards…" onConfirm={() => void run()} onCancel={close}>
      <p className="agents-note t-ui-multi">Its token stops working now and its open requests are cancelled. Connect it again later to get a new token.</p>
      {owned.length > 0 && (
        <>
          <p className="agents-note t-ui-multi">Forwards it still owns stop with it:</p>
          <Facts facts={owned.map((f, i) => ({ label: String(i + 1), value: label(f) }))} />
        </>
      )}
      {taken.length > 0 && (
        <>
          <Facts facts={taken.map((f, i) => ({ label: `you ${i + 1}`, value: label(f) }))} />
          <Checkbox label={`Stop ${taken.length === 1 ? "this forward" : "these forwards"} too (requested by ${name}, now yours)`} checked={stopTaken} onChange={(e) => setStopTaken(e.target.checked)} />
        </>
      )}
    </Dialog>
  );
}
