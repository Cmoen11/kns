// Tauri mapping of DevBackend (contract/dev.ts). Owner B-dev; devset.rs, env.rs.
import type { DevBackend } from "../types";
import { call } from "./call";

export const devTauri: DevBackend = {
  devSetsList: (context) => call("dev_sets_list", { context }),
  devSetSave: (set, proposalId) => call("dev_set_save", { set, proposalId }),
  devSetDelete: (id, proposalId) => call("dev_set_delete", { id, proposalId }),
  devSetUp: (id, hash, proposalId) => call("dev_set_up", { id, hash, proposalId }),
  devSetDown: (id) => call("dev_set_down", { id }),
  devSetFailures: (clear) => call("dev_set_failures", { clear }),
  envResolve: (objRef, container) => call("env_resolve", { objRef, container }),
  envReveal: (objRef, container, key) => call("env_reveal", { objRef, container, key }),
  envExport: (req) => call("env_export", { req }),
  connSecretsList: (context, namespace) => call("conn_secrets_list", { context, namespace }),
  forwardConnInfo: (forward) => call("forward_conn_info", { forward }),
  forwardConnCopy: (req) => call("forward_conn_copy", { req }),
  volumesList: (objRef, container) => call("volumes_list", { objRef, container }),
  volumesExport: (req) => call("volumes_export", { req }),
};
