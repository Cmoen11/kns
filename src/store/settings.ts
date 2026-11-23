// Settings and keymap overrides (docs/ux.md §3.1), persisted, applied to <html> and to the key engine.
import { useStore } from "zustand";
import { engine, keymap, sanitizeOverrides } from "../keys";
import { registry } from "../actions";
import type { ContextFlags, KeymapOverride, Settings, Zoom } from "../types";
import { applyAppearance, onSystemModeChange } from "./appearance";
import { PERSIST_KEYS, persistedStore, type PersistedSlice } from "./persist";

export const ZOOM_STEPS: readonly Zoom[] = [85, 100, 110, 125, 150];

export const DEFAULT_SETTINGS: Settings = {
  theme: "claude",
  mode: "system",
  zoom: 100,
  rowHeight: 20,
  hints: true,
  openBeside: true,
  singleKeys: true,
  vim: false,
  k9sMode: false,
  mono: "geist",
  killEnabled: false,
  logBufferLines: 10000,
  termScrollback: 5000,
  contexts: {},
  // plan-features §2.10a; F pins the tags it ships with
  debugImages: ["busybox:1.37.0", "nicolaka/netshoot:v0.13"],
  clipboardClearSeconds: 60,
  logsStructured: true,
  agentForwardIdleMinutes: 15,
  statusColors: "full",
  rowTint: true,
  nsHealth: true,
  actionLog: "all",
  nsProblemsFirst: false,
};

const oneOf = <T,>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const int = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

/** An image reference as a user would type it (`repo/name:tag`, `name@sha256:...`); no spaces or quotes. */
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const MAX_IMAGES = 10;
function images(v: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(v)) return [...fallback];
  const out = [...new Set(v.filter((x): x is string => typeof x === "string" && IMAGE_RE.test(x)))].slice(0, MAX_IMAGES);
  return out.length > 0 ? out : [...fallback];
}

/** Field-by-field validation of stored settings; anything invalid becomes its default. */
export function sanitizeSettings(raw: unknown, d: Settings = DEFAULT_SETTINGS): Settings {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const contexts: Record<string, ContextFlags> = {};
  if (typeof r.contexts === "object" && r.contexts !== null) {
    for (const [name, v] of Object.entries(r.contexts as Record<string, unknown>)) {
      const f = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
      contexts[name] = { protected: bool(f.protected, false), readOnly: bool(f.readOnly, false) };
    }
  }
  return {
    theme: oneOf(r.theme, ["claude"] as const, d.theme),
    mode: oneOf(r.mode, ["system", "lys", "mork"] as const, d.mode),
    zoom: oneOf(r.zoom, ZOOM_STEPS, d.zoom),
    rowHeight: oneOf(r.rowHeight, [20, 28] as const, d.rowHeight),
    hints: bool(r.hints, d.hints),
    openBeside: bool(r.openBeside, d.openBeside),
    singleKeys: bool(r.singleKeys, d.singleKeys),
    vim: bool(r.vim, d.vim),
    k9sMode: bool(r.k9sMode, d.k9sMode),
    mono: oneOf(r.mono, ["geist", "jetbrains"] as const, d.mono),
    killEnabled: bool(r.killEnabled, d.killEnabled),
    logBufferLines: int(r.logBufferLines, 1000, 100000, d.logBufferLines),
    termScrollback: int(r.termScrollback, 0, 100000, d.termScrollback),
    contexts,
    debugImages: images(r.debugImages, d.debugImages),
    clipboardClearSeconds: int(r.clipboardClearSeconds, 0, 600, d.clipboardClearSeconds),
    logsStructured: bool(r.logsStructured, d.logsStructured),
    agentForwardIdleMinutes: int(r.agentForwardIdleMinutes, 0, 1440, d.agentForwardIdleMinutes),
    statusColors: oneOf(r.statusColors, ["full", "quiet"] as const, d.statusColors),
    rowTint: bool(r.rowTint, d.rowTint),
    nsHealth: bool(r.nsHealth, d.nsHealth),
    actionLog: oneOf(r.actionLog, ["all", "writes", "off"] as const, d.actionLog),
    nsProblemsFirst: bool(r.nsProblemsFirst, d.nsProblemsFirst),
  };
}

/** The settings store. State is the Settings object itself. */
export const settingsStore = persistedStore<Settings>({
  key: PERSIST_KEYS.settings,
  version: 1,
  defaults: () => ({ ...DEFAULT_SETTINGS, contexts: {}, debugImages: [...DEFAULT_SETTINGS.debugImages] }),
  sanitize: sanitizeSettings,
});

/** Narrow selector hook: useSettings((s) => s.rowHeight). */
export function useSettings<T>(select: (s: Settings) => T): T {
  return useStore(settingsStore, select);
}
export const getSettings = (): Settings => settingsStore.getState();
// Updates are functional so that one made before the first load is replayed on the loaded state.
export function setSettings(patch: Partial<Settings>): void {
  settingsStore.setState((s) => sanitizeSettings({ ...s, ...patch }), true);
}
export function setContextFlags(context: string, patch: Partial<ContextFlags>): void {
  settingsStore.setState((s) => {
    const prev = s.contexts[context] ?? { protected: false, readOnly: false };
    return sanitizeSettings({ ...s, contexts: { ...s.contexts, [context]: { ...prev, ...patch } } });
  }, true);
}
export const contextFlags = (context: string): ContextFlags =>
  settingsStore.getState().contexts[context] ?? { protected: false, readOnly: false };

/** Steps the zoom through 85/100/110/125/150 (+1, -1) or resets it (0). */
export function stepZoom(dir: 1 | -1 | 0): void {
  settingsStore.setState((s) => {
    const i = ZOOM_STEPS.indexOf(s.zoom);
    return { zoom: dir === 0 ? 100 : ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + dir))] };
  });
}

/** User keymap overrides (PersistedState.keymap). */
export const keymapStore = persistedStore<PersistedSlice<"keymap">>({
  key: PERSIST_KEYS.keymap,
  version: 1,
  defaults: () => ({ keymap: {} }),
  sanitize: (data) => ({
    keymap: sanitizeOverrides((data as { keymap?: unknown } | null)?.keymap, registry),
  }),
});
/** Replaces one action's bindings; pass undefined to return to the default. */
export function setKeymapOverride(id: string, override: KeymapOverride | undefined): void {
  keymapStore.setState((s) => {
    const next = { ...s.keymap };
    if (override) next[id] = override;
    else delete next[id];
    return { keymap: sanitizeOverrides(next, registry) };
  });
}
export const resetKeymap = (): void => keymapStore.setState({ keymap: {} });

let activeContext: string | null = null;
/** The window's kube context; read-only mode follows its flag (§14). Call on connect / context switch. */
export function setActiveContext(context: string | null): void {
  activeContext = context;
  syncEngine(getSettings());
}
export const getActiveContext = (): string | null => activeContext;

function syncEngine(s: Settings) {
  const readOnly = activeContext ? (s.contexts[activeContext]?.readOnly ?? false) : false;
  const env = engine.env();
  if (env.readOnly !== readOnly || env.singleKeys !== s.singleKeys) engine.setEnv({ readOnly, singleKeys: s.singleKeys });
  keymap.setK9sMode(s.k9sMode);
}

let started = false;
/**
 * Wires settings to the document and the key engine. Call once at startup, after boot.ts.
 * Appearance is re-applied when settings change and, in 'system' mode, when the OS scheme changes.
 */
export function initSettings(): void {
  if (started) return;
  started = true;
  let prev = getSettings();
  const apply = (s: Settings, zoom: boolean) => applyAppearance(s, { zoom });
  settingsStore.subscribe((s) => {
    const zoomChanged = s.zoom !== prev.zoom;
    const look = zoomChanged || s.theme !== prev.theme || s.mode !== prev.mode || s.mono !== prev.mono || s.rowHeight !== prev.rowHeight;
    prev = s;
    if (look) apply(s, zoomChanged);
    syncEngine(s);
  });
  onSystemModeChange(() => apply(getSettings(), false));
  keymapStore.subscribe((s) => keymap.setOverrides(s.keymap));
  void settingsStore.hydrated.then(() => {
    apply(getSettings(), true);
    syncEngine(getSettings());
  });
  void keymapStore.hydrated.then(() => keymap.setOverrides(keymapStore.getState().keymap));
}
