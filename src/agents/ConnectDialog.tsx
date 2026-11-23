// The connect wizard (`:mcp setup`, `a` in the agents view, the hub's MCP entry; plan §3 H1 step
// 4): one dialog that turns the server on, names the client, sets the current context's policy
// and has Rust copy the setup command. The token never reaches the webview.
import { useState } from "react";
import type { OverlayProps } from "../foundation";
import { Checkbox, contextFlags, focusedContext, Dialog, Facts, Field, Literal, RadioGroup } from "../foundation";
import type { McpPolicy } from "../ipc/types";
import { addClient, setPolicy, setPort, setServer } from "./actions";
import { CLIENT_NAME, policyOf } from "./model";
import { getMcpStatus } from "./store";
import "./agents.css";

export default function ConnectDialog({ close }: OverlayProps<Record<string, never>>) {
  const status = getMcpStatus();
  const context = focusedContext();
  const flags = context ? contextFlags(context) : { protected: false, readOnly: false };
  const stored = context ? policyOf(status, context).policy : "off";
  const [name, setName] = useState("claude-code");
  const [port, setPortText] = useState(String(status?.port ?? 7099));
  const [turnOn, setTurnOn] = useState(!status?.on);
  const [policy, setPolicyChoice] = useState<McpPolicy>(stored === "off" ? (flags.readOnly ? "read" : "propose") : stored);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const portNo = Number(port);
  const portOk = Number.isInteger(portNo) && portNo >= 1024 && portNo <= 65535;
  const nameOk = CLIENT_NAME.test(name);
  const rekey = status?.clients.some((c) => c.name === name) ?? false;
  const needTyped = !!context && policy === "propose" && flags.protected && stored !== "propose";
  const typedOk = !needTyped || typed === context;
  const ready = nameOk && portOk && typedOk && !busy;
  const reason = !nameOk ? "the client name is 1-40 of A-Z a-z 0-9 . _ -" : !portOk ? "the port is 1024-65535" : !typedOk ? `type ${context} to allow proposals` : "working…";

  const run = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      if (portNo !== (status?.port ?? 7099) && !(await setPort(portNo))) return;
      if (turnOn && !status?.on && !(await setServer(true))) return;
      if (context && policy !== stored && !(await setPolicy(context, policy, policyOf(status, context).namespaces, { confirmed: true }))) return;
      if (await addClient(name)) close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Connect an agent" confirmLabel="Connect and copy" confirmDisabled={!ready} confirmDisabledReason={reason} onConfirm={() => void run()} onCancel={close}>
      <p className="agents-note t-ui-multi">
        Agents such as Claude Code can then read the contexts you allow, through a server on this machine only (127.0.0.1). They cannot change
        anything themselves: forwards, env exports and writes are requests you approve here. Secret values are always masked.
      </p>
      {!status?.on && <Checkbox label={`Turn the MCP server on (127.0.0.1:${portOk ? portNo : "…"})`} checked={turnOn} onChange={(e) => setTurnOn(e.target.checked)} />}
      <Field label="Port" value={port} inputMode="numeric" onChange={(e) => setPortText(e.target.value.trim())} error={portOk ? undefined : "1024-65535"} />
      <Field label="Client name" value={name} onChange={(e) => setName(e.target.value.trim())} error={nameOk ? undefined : "1-40 of A-Z a-z 0-9 . _ -"} />
      {rekey && <p className="agents-note t-ui-multi" data-kind="warn">{name} exists: connecting again gives it a new token and the old one stops working.</p>}
      {context ? (
        <>
          <RadioGroup
            legend={`Agents in ${context}`}
            name="agents-policy"
            value={policy}
            options={[
              { value: "read", label: "read: look at objects, logs and events" },
              { value: "propose", label: flags.readOnly ? "propose: ask for changes (read-only here: stays read)" : "propose: also ask for forwards, env exports and changes" },
            ]}
            onChange={setPolicyChoice}
          />
          {needTyped && (
            <Field
              label={
                <>
                  {context} is protected: type <Literal>{context}</Literal> to allow proposals
                </>
              }
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          )}
        </>
      ) : (
        <p className="agents-note t-ui-multi">No context is open: set a policy later in the agents view.</p>
      )}
      <Facts facts={[{ label: "copies", value: "claude mcp add --scope user --transport http kns http://127.0.0.1:" + (portOk ? portNo : "…") + "/mcp --header 'Authorization: Bearer …'" }]} />
      <p className="agents-note t-ui-multi" data-kind="warn">
        The token is in the copied command: it lands in your shell history and in ~/.claude.json. It protects against other programs, not
        against malware running as you. Revoke it here at any time.
      </p>
    </Dialog>
  );
}
