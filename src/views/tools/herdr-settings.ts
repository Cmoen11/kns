// Settings → Background and Herdr (docs/herdr.md): keep kns running in the tray, start it at
// login, and "Add to Herdr", which installs the Herdr app's kns panel (and the herdr TUI plugin)
// from kns itself (herdr.rs). Rows like the rest of settings-model.ts; the statuses are asked by
// SettingsView and refreshed after every change.
import { backend } from "../../ipc";
import type { BackendError, BackgroundStatus, HerdrInstallReport, HerdrStatus } from "../../ipc/types";
import { confirm, toast, toasts } from "../../ui";
import type { ItemRow, ListRow } from "./list-model";

const message = (e: unknown) => (e as BackendError)?.message ?? String(e);

function report(title: string, r: HerdrInstallReport): void {
  const lines = [...r.done.map((l) => `✓ ${l}`), ...r.notes.map((l) => `! ${l}`), ...r.tips.map((l) => `· ${l}`)];
  toast({ kind: r.notes.length ? "warn" : "ok", text: `${title}\n${lines.join("\n")}` });
}

export async function addToHerdr(refresh: () => void): Promise<void> {
  try {
    report("Added kns to Herdr", await backend.herdrInstall());
  } catch (e) {
    toasts.error(`Add to Herdr: ${message(e)}`);
  }
  refresh();
}

export async function removeFromHerdr(refresh: () => void): Promise<void> {
  const ok = await confirm({
    tier: 1,
    title: "Remove kns from Herdr",
    body: "The kns panel is removed from the Herdr app, the herdr TUI plugin is unlinked, and kns stops listening for Herdr.",
    confirmLabel: "Remove",
  });
  if (!ok) return;
  try {
    report("Removed kns from Herdr", await backend.herdrUninstall());
  } catch (e) {
    toasts.error(`Remove from Herdr: ${message(e)}`);
  }
  refresh();
}

function herdrState(h: HerdrStatus): string {
  if (h.modInstalled) return h.modCurrent ? "added" : "update";
  if (h.tuiPluginWritten) return "added (TUI)";
  return h.appFound || h.tuiFound ? "not added" : "Herdr not found";
}

export function backgroundRows(b: BackgroundStatus | null, refresh: () => void): ListRow[] {
  if (!b) return [];
  const set = (keepRunning: boolean, launchAtLogin?: boolean) =>
    void backend.backgroundSet(keepRunning, launchAtLogin).then(refresh, (e) => toasts.error(`Background: ${message(e)}`));
  const row = (key: string, label: string, hint: string, on: boolean, change: (on: boolean) => void): ItemRow => ({
    type: "item", key, cells: [label, hint], value: on ? "on" : "off", control: "toggle",
    change: () => change(!on),
    cycle: (dir) => {
      if ((dir === 1) !== on) change(dir === 1);
    },
  });
  return [
    { type: "group", key: "g:background", label: "Background" },
    row("bgKeep", "Keep running in the tray", "closing the window leaves kns running, so Herdr and kns-tui keep working", b.keepRunning || b.startedInBackground, (on) => set(on)),
    row("bgLogin", "Launch at login", "starts kns in the background when you log in (macOS)", b.launchAtLogin, (on) => set(on || b.keepRunning, on)),
  ];
}

export function herdrRows(h: HerdrStatus | null, refresh: () => void): ListRow[] {
  if (!h) return [];
  const rows: ListRow[] = [
    { type: "group", key: "g:herdr", label: "Herdr" },
    {
      type: "item", key: "herdr:add",
      cells: ["Add to Herdr", h.modInstalled && !h.modCurrent ? "this kns carries a newer panel: Enter updates it" : "a live kns panel in the Herdr app (and the herdr TUI plugin); logs and shells open as Herdr panes"],
      value: herdrState(h),
      change: () => void addToHerdr(refresh),
    },
  ];
  if (h.modInstalled || h.tuiPluginWritten) {
    rows.push(
      {
        type: "item", key: "herdr:tcp", cells: ["Connection for Herdr", "127.0.0.1 behind a token only you can read; the Herdr panel connects here"],
        value: h.tcp.listening ? `127.0.0.1:${h.tcp.port ?? "?"}` : h.tcp.error ? "error" : "off",
        change: () => void addToHerdr(refresh),
      },
      { type: "item", key: "herdr:remove", cells: ["Remove from Herdr", "the panel, the TUI plugin link and the connection"], value: "", change: () => void removeFromHerdr(refresh) },
    );
  }
  return rows;
}
