// `window.__knsMock`: a dev-only console API that plays an agent against the mock backend
// (docs/plan-features.md §2.11). The mock backend ships in the production bundle (it is picked at
// runtime in src/ipc/index.ts), so this is installed only when `import.meta.env.DEV && !isTauri`.
import type { DevSetDraft, Proposal, ProposalPayload, BackendError } from "../types";
import { mockMcpCallAsync, mockPropose } from "./agents";
import { mockAutostart, mockSaveDevSet } from "./dev";
import { setNextSaveDialog } from "./dialog";
import { emitMock } from "./events";

export interface KnsMock {
  agent: {
    /** creates a pending proposal as `client` (default "claude-code") */
    propose(payload: ProposalPayload, reason?: string, client?: string): Proposal;
    /** saves a dev set as an agent (agent rules: own sets only, autoStart/connSecrets/includeSecrets stripped) */
    saveDevSet(draft: DevSetDraft, client?: string): unknown;
    /** an MCP tool call as `client` (default "claude-code"; needs `:mcp on` and a client from `:mcp setup`) */
    call(tool: string, args?: unknown, client?: string): Promise<unknown>;
  };
  /** the next mock save dialog answers this, once */
  saveDialog(answer: "save" | "cancel" | "repo"): void;
  /** plays Rust's autoStart of one dev set after connect (a failure shows as a toast and in Activity) */
  autostart(devSetId: string): Promise<void>;
  emit: typeof emitMock;
}

export function shouldInstallKnsMock(dev: boolean, isTauri: boolean): boolean {
  return dev && !isTauri;
}

export function createKnsMock(): KnsMock {
  return {
    agent: {
      propose: (payload, reason, client = "claude-code") => mockPropose(client, payload, reason),
      saveDevSet: (draft, client = "claude-code") => mockSaveDevSet(draft, { by: "agent", client, at: new Date().toISOString() }),
      // every tool of the table, incl. H2's dev-set and proposal tools (some wait: async)
      call: (tool, args, client = "claude-code") =>
        mockMcpCallAsync(client, tool, (args ?? {}) as Record<string, unknown>).then((r) =>
          r.ok ? r.data : Promise.reject({ code: 0, reason: r.error.code, message: r.error.message } satisfies BackendError),
        ),
    },
    saveDialog: setNextSaveDialog,
    autostart: mockAutostart,
    emit: emitMock,
  };
}

/** Installs `window.__knsMock` when allowed; returns whether it did. */
export function installKnsMock(): boolean {
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (typeof window === "undefined" || !shouldInstallKnsMock(import.meta.env.DEV, isTauri)) return false;
  (window as unknown as { __knsMock?: KnsMock }).__knsMock = createKnsMock();
  return true;
}
