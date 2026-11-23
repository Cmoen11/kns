// Tauri mapping of FwdBackend (contract/fwd.ts). Owner B-fwd; forward.rs, service.rs.
import type { FwdBackend } from "../types";
import { call } from "./call";

export const fwdTauri: FwdBackend = {
  startForward: (query) => call("start_forward", { query }),
  listForwards: () => call("list_forwards"),
  stopForward: (id) => call("stop_forward", { id }),
  resolveForwardTarget: (context, target) => call("resolve_forward_target", { context, target }),
  openForward: (id) => call("open_forward", { id }),
  serviceInfo: (objRef) => call("service_info", { objRef }),
  nameProxyStatus: () => call("name_proxy_status"),
  nameProxySet: (on, port) => call("name_proxy_set", { on, port }),
};
