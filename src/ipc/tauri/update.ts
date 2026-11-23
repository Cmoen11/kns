// Tauri mapping of UpdateBackend (contract/update.ts): src-tauri/src/update.rs.
import type { UpdateBackend } from "../types";
import { call } from "./call";

export const updateTauri: UpdateBackend = {
  updateStatus: () => call("update_status"),
  updateCheck: () => call("update_check"),
  updateInstall: () => call("update_install"),
};
