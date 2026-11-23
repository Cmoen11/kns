// Tauri mapping of LogsBackend (contract/logs.ts). Owner E; logs.rs.
import { Channel, invoke } from "@tauri-apps/api/core";
import type { LogEvent, LogsBackend } from "../types";
import { toError } from "./call";

export const logsTauri: LogsBackend = {
  streamLogs: (query, onEvent) => {
    const channel = new Channel<LogEvent>();
    let stopped = false;
    channel.onmessage = (e) => {
      if (!stopped) onEvent(e);
    };
    const id = invoke<string>("stream_logs", { query, channel });
    id.catch((e) => {
      if (!stopped) onEvent({ type: "error", pod: "", container: "", message: toError(e).message });
    });
    return () => {
      if (stopped) return;
      stopped = true;
      id.then((streamId) => invoke("stop_stream", { id: streamId })).catch(() => {});
    };
  },
};
