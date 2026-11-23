// The xterm theme, built from the --k-* tokens (docs/ux.md §13.4). Tokens are var() chains and
// color-mix() values, so each one is resolved through a probe element's computed colour.
import type { ITheme } from "@xterm/xterm";
import { zoomFactor } from "../../foundation";
import { cssColorToHex, withAlpha } from "./colors";

// ANSI colours map onto the text levels, the accent and the two status hues, like logs (§13.3) [ours].
const TOKENS = {
  background: "--k-bg-pane",
  foreground: "--k-text-2",
  cursor: "--k-accent",
  cursorAccent: "--k-bg-pane",
  selectionBackground: "--k-row-focus",
  selectionInactiveBackground: "--k-row-marked",
  selectionForeground: "--k-text",
  black: "--k-line",
  brightBlack: "--k-text-muted",
  red: "--k-st-error",
  brightRed: "--k-st-error",
  yellow: "--k-st-warn",
  brightYellow: "--k-st-warn",
  green: "--k-accent",
  brightGreen: "--k-accent",
  blue: "--k-text-3",
  brightBlue: "--k-text-2",
  magenta: "--k-text-3",
  brightMagenta: "--k-text-2",
  cyan: "--k-text-2",
  brightCyan: "--k-text",
  white: "--k-text-2",
  brightWhite: "--k-text",
} as const satisfies Partial<Record<keyof ITheme, string>>;

let probe: HTMLSpanElement | null = null;

function resolve(names: readonly string[]): Map<string, string> {
  if (!probe) {
    probe = document.createElement("span");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none";
  }
  document.body.appendChild(probe);
  const out = new Map<string, string>();
  const style = getComputedStyle(probe);
  for (const name of names) {
    probe.style.color = `var(${name})`;
    const hex = cssColorToHex(style.color);
    if (hex) out.set(name, hex);
  }
  probe.remove();
  return out;
}

export function readTheme(): ITheme {
  const resolved = resolve([...new Set<string>([...Object.values(TOKENS), "--k-frame"])]);
  const theme: ITheme = {};
  for (const [key, token] of Object.entries(TOKENS) as [keyof typeof TOKENS, string][]) {
    const hex = resolved.get(token);
    if (hex) theme[key] = hex;
  }
  const frame = resolved.get("--k-frame");
  if (frame) {
    theme.scrollbarSliderBackground = withAlpha(frame, 0.5);
    theme.scrollbarSliderHoverBackground = frame;
    theme.scrollbarSliderActiveBackground = frame;
  }
  return theme;
}

/** The mono stack chosen in settings (`data-mono` on <html>). */
export function monoFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--k-font-mono").trim() || "monospace";
}

export const MONO_SIZE = 12;
const LINE_BOX = 16;

/** xterm's lineHeight is a multiplier of the font's own line height; this aims at the 16px line box. */
export function lineHeightFor(family: string): number {
  const span = document.createElement("span");
  span.textContent = "Mg";
  span.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:400 ${MONO_SIZE}px/normal ${family}`;
  document.body.appendChild(span);
  const h = span.getBoundingClientRect().height / zoomFactor();
  span.remove();
  if (!(h > 0)) return 1;
  return Math.min(2, Math.max(1, (LINE_BOX + 0.05) / h));
}

