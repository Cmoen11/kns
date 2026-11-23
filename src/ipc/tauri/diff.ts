// Tauri mapping of DiffBackend (contract/diff.ts). Owner D; ownership.rs.
import type { DiffBackend } from "../types";
import { call } from "./call";

export const diffTauri: DiffBackend = {
  fieldOwners: (objRef) => call("field_owners", { objRef }),
  revisions: (objRef) => call("revisions", { objRef }),
};
