// Handlers for the actions that only change settings. Imported eagerly by main.tsx.
import { registerActions, type ActionContext } from "../actions";
import type { Mode, Theme, Zoom } from "../types";
import { confirm } from "../ui/confirm";
import { toast } from "../ui/toast";
import { contextFlags, getActiveContext, getSettings, setContextFlags, setSettings, stepZoom, ZOOM_STEPS } from "./settings";

const THEMES: readonly Theme[] = ["claude"];
const MODES: readonly Mode[] = ["system", "lys", "mork"];

/** The argument when it is one of `allowed`; with no argument, the value after `current`. */
function pick<T extends string | number>(ctx: ActionContext, allowed: readonly T[], current: T, usage: string): T | null {
  const arg = ctx.args[0];
  if (arg === undefined) return allowed[(allowed.indexOf(current) + 1) % allowed.length];
  const hit = allowed.find((a) => String(a) === arg);
  if (hit === undefined) {
    toast({ kind: "warn", text: `Usage: ${usage}` });
    return null;
  }
  return hit;
}

function onOff(ctx: ActionContext, current: boolean, usage: string): boolean | null {
  const arg = ctx.args[0];
  if (arg === undefined) return !current;
  if (arg === "on" || arg === "off") return arg === "on";
  toast({ kind: "warn", text: `Usage: ${usage}` });
  return null;
}

export const unregisterSettingsActions = registerActions({
  "ui.zoomIn": () => stepZoom(1),
  "ui.zoomOut": () => stepZoom(-1),
  "ui.zoomReset": () => stepZoom(0),
  "ui.zoom": (ctx) => {
    const zoom = pick<Zoom>(ctx, ZOOM_STEPS, getSettings().zoom, ":ui 85|100|110|125|150");
    if (zoom !== null) setSettings({ zoom });
  },
  "app.theme": (ctx) => {
    const theme = pick(ctx, THEMES, getSettings().theme, ":theme claude");
    if (theme !== null) setSettings({ theme });
  },
  "app.mode": (ctx) => {
    const mode = pick(ctx, MODES, getSettings().mode, ":mode system|lys|mork");
    if (mode !== null) setSettings({ mode });
  },
  "app.density": (ctx) => {
    const rowHeight = pick(ctx, [20, 28] as const, getSettings().rowHeight, ":rows 20|28");
    if (rowHeight !== null) setSettings({ rowHeight });
  },
  "hints.toggle": () => setSettings({ hints: !getSettings().hints }),
  "app.readOnly": {
    enabled: () => getActiveContext() !== null || "no context is connected",
    run: (ctx) => {
      const context = getActiveContext();
      if (!context) return;
      const readOnly = onOff(ctx, contextFlags(context).readOnly, ":ro on|off");
      if (readOnly === null) return;
      setContextFlags(context, { readOnly });
      toast(readOnly ? `Read-only on for ${context}` : `Read-only off for ${context}`);
    },
  },
  "app.killSwitch": async (ctx) => {
    const on = onOff(ctx, getSettings().killEnabled, ":kill on|off");
    if (on === null || on === getSettings().killEnabled) return;
    if (on) {
      // turning kill on is tier 2 (§14)
      const ok = await confirm({
        tier: 2,
        title: "Enable kill",
        body: "Kill deletes pods with grace period 0. It stays confirmed every time.",
        typeToConfirm: "kill",
        confirmLabel: "Enable",
      });
      if (!ok) return;
    }
    setSettings({ killEnabled: on });
    toast(on ? "Kill enabled" : "Kill disabled");
  },
});
