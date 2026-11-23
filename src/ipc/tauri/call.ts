// Shared invoke helpers for the Tauri mappings (src/ipc/tauri.ts and src/ipc/tauri/<pkg>.ts).
import { invoke } from "@tauri-apps/api/core";
import type { BackendError } from "../types";

export function toError(e: unknown): BackendError {
  if (e && typeof e === "object" && "message" in e) return e as BackendError;
  return { code: 0, reason: "Unknown", message: String(e) };
}

/** Invokes a command; argument names are camelCase here and snake_case in Rust (Tauri maps them). */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toError(e);
  }
}
