// The MCP port (Enter on the port row, `:mcp port <n>`). The server listens on 127.0.0.1 only; a
// running server restarts on the new port, and a taken port is reported, never silently changed.
import { useState } from "react";
import type { OverlayProps } from "../foundation";
import { Dialog, Field } from "../foundation";
import { setPort } from "./actions";
import { getMcpStatus } from "./store";
import "./agents.css";

export default function PortDialog({ close }: OverlayProps<Record<string, never>>) {
  const status = getMcpStatus();
  const [text, setText] = useState(String(status?.port ?? 7099));
  const port = Number(text);
  const ok = Number.isInteger(port) && port >= 1024 && port <= 65535;
  const save = () => {
    if (!ok) return;
    close();
    void setPort(port);
  };
  return (
    <Dialog title="MCP server port" confirmLabel="Save" confirmDisabled={!ok} confirmDisabledReason="1024-65535" onConfirm={save} onCancel={close}>
      <Field label="Port on 127.0.0.1" value={text} inputMode="numeric" onChange={(e) => setText(e.target.value.trim())} error={ok ? undefined : "1024-65535"} />
      <p className="agents-note t-ui-multi">Clients configured with the old port need the new setup command (connect again).</p>
    </Dialog>
  );
}
