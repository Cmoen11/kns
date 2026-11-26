// The agent skill (`:mcp skill`, `s` in the agents view, its toolbar button): writes a Claude Code
// skill (`~/.claude/skills/kns/SKILL.md`, every project) that teaches an agent to use kns through
// the `kns-mcp` CLI, for agents that have no MCP server registered. Optionally Rust also creates a
// token for the client `kns-cli` that only `kns-mcp` reads; the token never reaches the webview.
import { useState } from "react";
import type { OverlayProps } from "../foundation";
import { Checkbox, Dialog, Facts } from "../foundation";
import { installSkill, setServer } from "./actions";
import { getMcpStatus } from "./store";
import "./agents.css";

export default function SkillDialog({ close }: OverlayProps<Record<string, never>>) {
  const status = getMcpStatus();
  const hasCli = status?.clients.some((c) => c.name === "kns-cli") ?? false;
  const [token, setToken] = useState(true);
  const [turnOn, setTurnOn] = useState(!status?.on);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      if (turnOn && !status?.on && !(await setServer(true))) return;
      if (await installSkill(token)) close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Install agent skill" confirmLabel="Install" confirmDisabled={busy} confirmDisabledReason="working…" onConfirm={() => void run()} onCancel={close}>
      <p className="agents-note t-ui-multi">
        Writes a Claude Code skill to your home folder (all projects). It teaches an agent to use kns from the shell with the bundled
        <code> kns-mcp </code> command (<code>kns-mcp tools</code>, <code>kns-mcp call explain_why …</code>) instead of a registered MCP server.
        It gets the same access: the policy per context, approvals in this window and the audit.
      </p>
      {!status?.on && <Checkbox label={`Turn the MCP server on (127.0.0.1:${status?.port ?? 7099})`} checked={turnOn} onChange={(e) => setTurnOn(e.target.checked)} />}
      <Checkbox label={hasCli ? "Create a new CLI token (replaces the one kns-cli has)" : "Create a CLI token (client kns-cli)"} checked={token} onChange={(e) => setToken(e.target.checked)} />
      <Facts
        facts={[
          { label: "writes", value: "~/.claude/skills/kns/SKILL.md" },
          ...(token ? [{ label: "token", value: "kns settings folder, rust/cli-token (only you can read it)" }] : [{ label: "token", value: "the agent needs KNS_MCP_TOKEN" }]),
        ]}
      />
      {token && (
        <p className="agents-note t-ui-multi" data-kind="warn">
          Any program running as you can read the token file and use kns-mcp, as with the token in ~/.claude.json. Revoking kns-cli here deletes
          it.
        </p>
      )}
    </Dialog>
  );
}
