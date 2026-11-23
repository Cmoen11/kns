// Untrusted text (docs/plan-features.md §0, §2.12): cluster text and agent-written text (`reason`,
// `label`, set names) is cleaned before it is shown, and shown as text only, never as HTML.
// Rust has the same rules in `redact::clean_untrusted()`.
import { createElement, type ReactElement } from "react";

// ANSI: CSI (ESC [ ... final), OSC (ESC ] ... BEL | ESC \), and two-char ESC sequences.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
// Unicode tag characters (U+E0000–E007F, surrogate pairs 󠀀–󠁿).
const TAGS = /\uDB40[\uDC00-\uDC7F]/g;
// bidi controls, zero-width characters, BOM
const INVISIBLE = /[‪-‮⁦-⁩‎‏​-‍⁠﻿]/g;
// C0 and C1 controls except \t \n \r (handled separately)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export interface CleanOptions {
  /** keep newlines and tabs; default false: every line break and tab becomes one space */
  multiline?: boolean;
}

/**
 * Strips control characters, ANSI sequences, Unicode tag characters, bidi controls and zero-width
 * characters, then truncates to `max` code points (with an ellipsis).
 */
export function cleanUntrusted(s: string, max = 500, opts: CleanOptions = {}): string {
  let out = String(s).replace(ANSI, "").replace(TAGS, "").replace(INVISIBLE, "");
  out = opts.multiline ? out.replace(/\r\n?/g, "\n") : out.replace(/[\r\n\t]+/g, " ");
  out = out.replace(CONTROL, "");
  const points = Array.from(out);
  if (points.length > max) out = points.slice(0, Math.max(0, max - 1)).join("") + "…";
  return out;
}

export interface UntrustedProps {
  text: string;
  /** shown before the text, e.g. "agent's note (unverified)" */
  label?: string;
  max?: number;
}

/** Cleaned, quoted, muted text in an isolated bidi run. Text nodes only. */
export function Untrusted({ text, label, max = 500 }: UntrustedProps): ReactElement {
  const body = createElement(
    "q",
    { dir: "ltr", className: "k-untrusted", style: { unicodeBidi: "isolate", color: "var(--k-text-muted)" } },
    cleanUntrusted(text, max),
  );
  if (!label) return body;
  return createElement(
    "span",
    { className: "k-untrusted-wrap" },
    createElement("span", { className: "k-untrusted-label", style: { color: "var(--k-text-3)" } }, `${label}: `),
    body,
  );
}
