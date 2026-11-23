// Applies theme, mode, zoom, mono font and row height to <html> (docs/ux.md §9.1).
// No imports from the app: boot.ts runs this before anything else has loaded.
import type { Mode, Settings, Theme, Zoom } from "../types";

export type Appearance = Pick<Settings, "theme" | "mode" | "zoom" | "mono" | "rowHeight">;

const BOOT_KEY = "kns:boot";
const THEMES: readonly Theme[] = ["claude"];
const MODES: readonly Mode[] = ["system", "lys", "mork"];
const ZOOMS: readonly Zoom[] = [85, 100, 110, 125, 150];
/** 100% is 1.2x the base CSS sizes: 20px rows render at 24px. */
export const BASE_SCALE = 1.2;

export const DEFAULT_APPEARANCE: Appearance = { theme: "claude", mode: "system", zoom: 100, mono: "geist", rowHeight: 20 };

const darkQuery = () => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null);

/** 'system' follows prefers-color-scheme; with no answer it falls back to Mørk. */
export function resolveMode(mode: Mode, prefersDark: boolean | null = darkQuery()?.matches ?? null): "lys" | "mork" {
  if (mode !== "system") return mode;
  return prefersDark === false ? "lys" : "mork";
}

/** Calls `fn` whenever the system colour scheme changes. Returns the unsubscribe function. */
export function onSystemModeChange(fn: () => void): () => void {
  const mq = darkQuery();
  if (!mq) return () => undefined;
  mq.addEventListener("change", fn);
  return () => mq.removeEventListener("change", fn);
}

type ZoomVia = "css" | "webview";
let zoomVia: ZoomVia = "css";
let zoomSeq = 0;

function cssZoom(factor: number) {
  // `zoom` scales every CSS pixel together, like the webview zoom factor
  document.documentElement.style.setProperty("zoom", factor === 1 ? "" : String(factor));
}

/**
 * The one place zoom is applied. In Tauri it uses the webview zoom factor (needs the capability
 * `core:webview:allow-set-webview-zoom`); when that is refused, or in a plain browser, it falls
 * back to CSS `zoom` on <html>. Use zoomFactor() when converting pointer or rect coordinates.
 */
export function applyZoom(zoom: Zoom): void {
  const factor = (zoom / 100) * BASE_SCALE;
  const seq = ++zoomSeq;
  if (typeof window === "undefined") return;
  if (!("__TAURI_INTERNALS__" in window)) {
    zoomVia = "css";
    cssZoom(factor);
    return;
  }
  if (zoomVia === "css") cssZoom(factor);
  void import("@tauri-apps/api/webview")
    .then((m) => m.getCurrentWebview().setZoom(factor))
    .then(
      () => {
        if (seq !== zoomSeq) return;
        zoomVia = "webview";
        cssZoom(1);
        remember({ zoomVia });
      },
      () => {
        if (seq !== zoomSeq) return;
        zoomVia = "css";
        cssZoom(factor);
        remember({ zoomVia });
      },
    );
}

/**
 * The CSS zoom factor currently on <html> (1 when the webview zoom is used). Layout code that
 * mixes getBoundingClientRect / pointer coordinates with CSS lengths divides by this.
 */
export function zoomFactor(): number {
  if (typeof document === "undefined") return 1;
  const z = Number(document.documentElement.style.getPropertyValue("zoom"));
  return z > 0 ? z : 1;
}

interface BootMirror extends Appearance {
  zoomVia?: ZoomVia;
}

function readMirror(): Partial<BootMirror> {
  try {
    const raw = localStorage.getItem(BOOT_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return typeof v === "object" && v !== null ? (v as Partial<BootMirror>) : {};
  } catch {
    return {};
  }
}
function remember(patch: Partial<BootMirror>) {
  try {
    localStorage.setItem(BOOT_KEY, JSON.stringify({ ...readMirror(), ...patch }));
  } catch {
    /* storage unavailable: the next start shows the defaults for a frame */
  }
}

/** Sets the <html> attributes. Only attributes change on a theme or mode switch. */
export function applyAppearance(a: Appearance, opts: { zoom?: boolean } = {}): void {
  const el = document.documentElement;
  el.dataset.tema = a.theme;
  el.dataset.modus = resolveMode(a.mode);
  el.dataset.mono = a.mono;
  el.dataset.rows = String(a.rowHeight);
  el.style.colorScheme = el.dataset.modus === "lys" ? "light" : "dark";
  if (opts.zoom !== false) applyZoom(a.zoom);
  remember({ theme: a.theme, mode: a.mode, zoom: a.zoom, mono: a.mono, rowHeight: a.rowHeight });
}

/**
 * Synchronous first-paint setup from the localStorage mirror of the last applied settings.
 * The settings store loads asynchronously and applies the real values right after.
 */
export function bootAppearance(): void {
  const m = readMirror();
  const a: Appearance = {
    theme: THEMES.includes(m.theme as Theme) ? (m.theme as Theme) : DEFAULT_APPEARANCE.theme,
    mode: MODES.includes(m.mode as Mode) ? (m.mode as Mode) : DEFAULT_APPEARANCE.mode,
    zoom: ZOOMS.includes(m.zoom as Zoom) ? (m.zoom as Zoom) : DEFAULT_APPEARANCE.zoom,
    mono: m.mono === "jetbrains" ? "jetbrains" : "geist",
    rowHeight: m.rowHeight === 28 ? 28 : 20,
  };
  zoomVia = m.zoomVia === "webview" ? "webview" : "css";
  applyAppearance(a);
}
