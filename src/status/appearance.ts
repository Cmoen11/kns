// Status-colour settings on <html>: data-status="quiet" (only warn and error keep a hue) and
// data-tint="on" (failing table rows get a faint tint). tokens.css reads both.
import { getSettings, settingsStore } from "../store/settings";

function apply(): void {
  const s = getSettings();
  const el = document.documentElement;
  if (el.dataset.status !== s.statusColors) el.dataset.status = s.statusColors;
  const tint = s.rowTint ? "on" : "off";
  if (el.dataset.tint !== tint) el.dataset.tint = tint;
}

let started = false;
export function initStatusAppearance(): void {
  if (started || typeof document === "undefined") return;
  started = true;
  apply();
  settingsStore.subscribe(apply);
  void settingsStore.hydrated.then(apply);
}
