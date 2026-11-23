// Helpers and state shared by the mock backends (src/ipc/mock.ts and src/ipc/mock/<pkg>.ts).
import type { BackendError, Forward, Json } from "../types";

export const delay = <T>(v: T, ms = 60): Promise<T> => new Promise<T>((r) => setTimeout(() => r(v), ms));

/** Rejects like a real command: with a BackendError. */
export const fail = (reason: string, message: string, code = 0): Promise<never> =>
  new Promise((_, reject) => setTimeout(() => reject({ code, reason, message } satisfies BackendError), 60));

let n = 0;
/** Unique-enough id for mock objects. */
export const mockId = (prefix: string): string => `${prefix}${(++n).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

export const nowIso = (): string => new Date().toISOString();

/** Running forwards (the base mock's startForward and the dev-set mock share them). */
export const mockForwards = new Map<string, Forward>();

/** Context flags of the mock's seeded settings (see loadState("settings") in src/ipc/mock.ts). */
export const MOCK_CONTEXT_FLAGS: Record<string, { protected: boolean; readOnly: boolean }> = {
  staging: { protected: true, readOnly: false },
};

/** The mock's persisted UI state when localStorage is unavailable (src/ipc/mock.ts load/saveState). */
export const mockState = new Map<string, Json>();

/**
 * The flags the UI last saved (`:ro`, `:protect`), like Rust's ctxflags.rs reads them from the
 * settings file: localStorage, then the in-memory copy, then the seed.
 */
export function mockContextFlags(context: string): { protected: boolean; readOnly: boolean } {
  let saved: unknown = mockState.get("settings");
  try {
    const raw = localStorage.getItem("kns:settings");
    if (raw) saved = JSON.parse(raw);
  } catch {
    /* no localStorage (tests, private mode) */
  }
  const contexts = (saved as { data?: { contexts?: Record<string, { protected?: unknown; readOnly?: unknown }> } } | undefined)?.data?.contexts;
  const f = contexts ? contexts[context] : MOCK_CONTEXT_FLAGS[context];
  return { protected: f?.protected === true, readOnly: f?.readOnly === true };
}

/** A deterministic content hash for mock dev sets (Rust uses sha256 of canonical JSON). */
export function mockHash(value: unknown): string {
  const text = JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ text.charCodeAt(i), 2246822507) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
