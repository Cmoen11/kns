// Tauri mapping of CatalogBackend (contract/catalog.ts, catalog.rs).
import type { CatalogBackend } from "../types";
import { call } from "./call";

export const catalogTauri: CatalogBackend = {
  catalogLoad: () => call("catalog_load"),
  catalogChoose: () => call("catalog_choose"),
  catalogForget: () => call("catalog_forget"),
  catalogOpen: (url) => call("catalog_open", { url }),
};
