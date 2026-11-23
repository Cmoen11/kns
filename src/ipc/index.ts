// The UI imports `backend` from here and nothing else from ipc/ except types.
import { mockBackend } from "./mock";
import { tauriBackend } from "./tauri";
import type { Backend } from "./types";

/** True inside the Tauri webview; false in a plain browser (vite dev, tests). */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const backend: Backend = isTauri ? tauriBackend : mockBackend;

export * from "./types";
