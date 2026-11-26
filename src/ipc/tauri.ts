// Real backend: Tauri commands + Channels. Command names and argument names
// must match src-tauri/src/commands/*.rs exactly (Tauri maps camelCase args to snake_case).
// Feature contracts map in ./tauri/<pkg>.ts (one owner each) and are spread in below.
import { Channel, invoke } from "@tauri-apps/api/core";
import { agentsTauri } from "./tauri/agents";
import { catalogTauri } from "./tauri/catalog";
import { call, toError } from "./tauri/call";
import { debugTauri } from "./tauri/debug";
import { devTauri } from "./tauri/dev";
import { diagTauri } from "./tauri/diag";
import { diffTauri } from "./tauri/diff";
import { eventsTauri } from "./tauri/events";
import { fwdTauri } from "./tauri/fwd";
import { githubTauri } from "./tauri/github";
import { healthTauri } from "./tauri/health";
import { logsTauri } from "./tauri/logs";
import { packTauri } from "./tauri/pack";
import { trafficTauri } from "./tauri/traffic";
import { updateTauri } from "./tauri/update";
import type { Backend, ExecEvent, ExecSession, TableEvent, Unsubscribe } from "./types";

/** Starts a backend stream that reports through a Channel and returns its stop function. */
function stream<E>(cmd: string, args: Record<string, unknown>, onEvent: (e: E) => void): Unsubscribe {
  const channel = new Channel<E>();
  let stopped = false;
  channel.onmessage = (e) => {
    if (!stopped) onEvent(e);
  };
  const id = invoke<string>(cmd, { ...args, channel });
  id.catch((e) => {
    if (!stopped) onEvent({ type: "state", state: "error", message: toError(e).message } as E);
  });
  return () => {
    if (stopped) return;
    stopped = true;
    id.then((streamId) => invoke("stop_stream", { id: streamId })).catch(() => {});
  };
}

export const tauriBackend: Backend = {
  listContexts: () => call("list_contexts"),
  connect: (context) => call("connect", { context }),
  awsSsoLogin: (context) => call("aws_sso_login", { context }),
  awsSsoStatus: (contexts) => call("aws_sso_status", { contexts }),
  discover: (context) => call("discover", { context }),

  subscribeTable: (query, onEvent) => stream<TableEvent>("subscribe_table", { query }, onEvent),

  getYaml: (objRef, opts) => call("get_yaml", { objRef, managedFields: opts?.managedFields ?? false }),
  getJson: (objRef) => call("get_json", { objRef }),
  getJsonMasked: (objRef, salt) => call("get_json_masked", { objRef, salt }),
  listEvents: (q) => call("list_events", { context: q.context, namespace: q.namespace, objRef: q.ref }),
  podsFor: (objRef) => call("pods_for", { objRef }),

  applyYaml: (context, yaml, opts, proposalId) => call("apply_yaml", { context, yaml, opts: opts ?? {}, proposalId }),
  deleteObject: (objRef, opts, proposalId) => call("delete_object", { objRef, opts: opts ?? {}, proposalId }),
  patchObject: (objRef, patch, patchType, subresource, proposalId) =>
    call("patch_object", { objRef, patch, patchType: patchType ?? "merge", subresource, proposalId }),
  scale: (objRef, replicas, proposalId) => call("scale", { objRef, replicas, proposalId }),
  restart: (objRef, proposalId) => call("restart", { objRef, proposalId }),
  triggerCronJob: (objRef) => call("trigger_cron_job", { objRef }),
  decodeSecret: (objRef) => call("decode_secret", { objRef }),

  podMetrics: (context, namespace) => call("pod_metrics", { context, namespace }),
  nodeMetrics: (context) => call("node_metrics", { context }),

  exec: async (query, onEvent): Promise<ExecSession> => {
    const channel = new Channel<ExecEvent>();
    let closed = false;
    channel.onmessage = (e) => {
      if (!closed) onEvent(e);
    };
    const id = await call<string>("exec_start", { query, channel });
    return {
      write: (data) => void invoke("exec_write", { id, data }).catch(() => {}),
      resize: (cols, rows) => void invoke("exec_resize", { id, cols, rows }).catch(() => {}),
      close: () => {
        if (closed) return;
        closed = true;
        void invoke("stop_stream", { id }).catch(() => {});
      },
    };
  },

  canI: (query) => call("can_i", { query }),

  loadState: (key) => call("load_state", { key }),
  backgroundStatus: () => call("background_status"),
  backgroundSet: (keepRunning, launchAtLogin) => call("background_set", { keepRunning, launchAtLogin: launchAtLogin ?? null }),
  herdrStatus: () => call("herdr_status"),
  herdrInstall: () => call("herdr_install"),
  herdrUninstall: () => call("herdr_uninstall"),
  saveState: (key, value) => call("save_state", { key, value }),

  ...fwdTauri,
  ...devTauri,
  ...diagTauri,
  ...diffTauri,
  ...logsTauri,
  ...debugTauri,
  ...packTauri,
  ...agentsTauri,
  ...eventsTauri,
  ...healthTauri,
  ...catalogTauri,
  ...githubTauri,
  ...trafficTauri,
  ...updateTauri,
};
