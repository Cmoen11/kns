// Tauri mapping of PackBackend (contract/pack.ts). Owner G (pack.rs); redactPreview is A1's (redact.rs).
import type { PackBackend } from "../types";
import { call } from "./call";

export const packTauri: PackBackend = {
  contextPack: (req) => call("context_pack", { req }),
  packSave: (packId, dropped) => call("pack_save", { packId, dropped: dropped ?? [] }),
  redactPreview: (text) => call("redact_preview", { text }),
};
