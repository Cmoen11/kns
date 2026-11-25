// Tauri mapping of HealthBackend (contract/health.ts): a Channel stream like subscribe_table;
// stop_stream ends it (nshealth.rs).
import { Channel, invoke } from "@tauri-apps/api/core";
import type { HealthBackend, NsHealthSnapshot } from "../types";
import { toError } from "./call";

export const healthTauri: HealthBackend = {
  subscribeNsHealth: (context, onSnapshot, namespaces) => {
    const channel = new Channel<NsHealthSnapshot>();
    let stopped = false;
    channel.onmessage = (s) => {
      if (!stopped) onSnapshot(s);
    };
    const id = invoke<string>("subscribe_ns_health", { context, namespaces: namespaces?.length ? namespaces : null, channel });
    id.catch((e) => {
      if (!stopped) onSnapshot({ context, state: "error", message: toError(e).message, namespaces: [], pods: 0, workloads: 0 });
    });
    return () => {
      if (stopped) return;
      stopped = true;
      id.then((streamId) => invoke("stop_stream", { id: streamId })).catch(() => {});
    };
  },
};
