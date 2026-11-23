// Auto-update (docs/auto-update.md): Rust checks the release feed, downloads and verifies a newer
// version in the background, and installs it only when the human asks. Mirror:
// src-tauri/src/contract/update.rs. Changes arrive as the `update` BackendEvent.

/**
 * disabled: this build does not update itself (dev build, no update key, KNS_NO_UPDATE);
 * ready: a newer version is downloaded and verified, waiting for updateInstall().
 */
export type UpdateState = "disabled" | "idle" | "checking" | "downloading" | "ready" | "installing" | "error";

export interface UpdateStatus {
  state: UpdateState;
  /** the running version */
  current: string;
  /** the newer version on offer (downloading, ready, installing) */
  version?: string;
  /** release notes of that version, as published */
  notes?: string;
  /** percent downloaded, when the size is known */
  progress?: number;
  /** why the state is disabled or error */
  message?: string;
  /** RFC 3339 time of the last finished check */
  checkedAt?: string;
}

export interface UpdateBackend {
  updateStatus(): Promise<UpdateStatus>;
  /** Checks now (and downloads a newer version). Resolves with the status after the check. */
  updateCheck(): Promise<UpdateStatus>;
  /** Installs the downloaded version and restarts kns. Rejects unless the state is ready. */
  updateInstall(): Promise<void>;
}
