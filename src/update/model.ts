// Auto-update (docs/auto-update.md): pure helpers for `:update` and the bottom-row item.
import type { UpdateStatus } from "../ipc/types";

export type UpdateCommand = { kind: "default" } | { kind: "check" } | { kind: "install" } | { kind: "status" } | { kind: "error"; message: string };

export const UPDATE_USAGE = ":update [check|install|status]";

export function parseUpdateArgs(args: readonly string[]): UpdateCommand {
  if (args.length === 0) return { kind: "default" };
  if (args.length === 1 && (args[0] === "check" || args[0] === "install" || args[0] === "status")) return { kind: args[0] };
  return { kind: "error", message: `usage: ${UPDATE_USAGE}` };
}

/** The bottom-row item: only while a newer version is downloaded or being installed. */
export function indicatorText(s: UpdateStatus | null): string | null {
  if (!s || !s.version) return null;
  if (s.state === "ready") return `update ${s.version}`;
  if (s.state === "installing") return `updating to ${s.version}…`;
  return null;
}

/** One line for `:update status` and for a finished check. */
export function statusText(s: UpdateStatus | null): string {
  if (!s) return "update status unknown";
  const v = `kns ${s.current}`;
  switch (s.state) {
    case "disabled":
      return `${v} · does not update itself${s.message ? ` (${s.message})` : ""}`;
    case "idle":
      return s.checkedAt ? `${v} is up to date` : `${v} · not checked yet`;
    case "checking":
      return `${v} · checking for updates…`;
    case "downloading":
      return `${v} · downloading ${s.version ?? "update"}${s.progress != null ? ` ${s.progress}%` : ""}`;
    case "ready":
      return `kns ${s.version} is ready · :update install to restart`;
    case "installing":
      return `installing kns ${s.version}…`;
    case "error":
      return `${v} · update check failed${s.message ? `: ${s.message}` : ""}`;
  }
}
