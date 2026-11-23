// The themed tooltip (mouse parity, docs/frontend.md §17): label, key chips, and the reason when a
// control is disabled. One host for the whole window with delegated listeners, so a control costs
// nothing but its attributes:
//
//   <button {...tip("Pane menu")} aria-label="Pane menu" />                          // text only
//   <button {...actionTip("pane.close")} />                                          // label + live key
//   <button {...actionTip("res.delete", undefined, state.reason)} />                 // + why it is disabled
//
// The key is read from the live keymap when the tooltip opens (no subscription per control). The
// tooltip never takes focus or pointer events, opens after TIP_DELAY (at once when the pointer
// comes from another control), and closes on a key, a click, a scroll and when its control goes
// away. Never put a native `title` on the same element or on an ancestor: both would show.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { registry, type ActionId } from "../actions/registry";
import { zoomFactor } from "../store/appearance";
import type { Binding } from "../types";
import { shownBinding } from "./action-state";
import { KeyChip } from "./KeyChip";

/** ms the pointer rests on a control before its tooltip opens */
export const TIP_DELAY = 300;
/** ms after a tooltip closed during which the next control's opens at once */
const WARM = 400;
/** px between the control and the tooltip, and between the tooltip and the window edge */
const GAP = 6;
const EDGE = 4;

export interface TipProps {
  "data-tip"?: string;
  "data-tip-action"?: string;
  "data-tip-keys"?: string;
  "data-tip-reason"?: string;
  "data-tip-delay"?: number;
  "data-tip-clipped"?: "";
  "data-tip-plain"?: "";
}

export interface TipOptions {
  /** show this action's key, from the live keymap */
  action?: ActionId;
  /** an explicit key (a pending sequence's Esc); `action` wins */
  keys?: Binding;
  /** why the control is disabled; also a second line of help */
  reason?: string;
  /** ms before it opens, for things the pointer crosses all the time (a divider); never opens at once */
  delay?: number;
  /** only when the element's text is cut off (an ellipsized name): the tooltip is the full text */
  clipped?: boolean;
  /** the label is someone's text (a resource name): shown as written and wrapped, never capitalized or cut */
  plain?: boolean;
}

/** Tooltip attributes for any element. An empty label gives no tooltip. Text is rendered as text. */
export function tip(label: string | undefined | null, opts: TipOptions = {}): TipProps {
  if (!label) return {};
  return {
    "data-tip": label,
    "data-tip-action": opts.action,
    "data-tip-keys": opts.keys && !opts.action ? JSON.stringify(opts.keys) : undefined,
    "data-tip-reason": opts.reason || undefined,
    "data-tip-delay": opts.delay,
    "data-tip-clipped": opts.clipped ? "" : undefined,
    "data-tip-plain": opts.plain ? "" : undefined,
  };
}

/** Tooltip attributes of a control that runs an action: the registry label (or `label`) and the live key. */
export function actionTip(action: ActionId, label?: string, reason?: string): TipProps {
  return tip(label ?? registry.target(action)?.label ?? action, { action, reason });
}

interface Shown {
  el: Element;
  label: string;
  plain: boolean;
  binding?: Binding;
  reason?: string;
}

function read(el: Element): Shown | null {
  const label = el.getAttribute("data-tip");
  if (!label) return null;
  let binding: Binding | undefined;
  const action = el.getAttribute("data-tip-action");
  const keys = el.getAttribute("data-tip-keys");
  try {
    if (action) binding = shownBinding(action as ActionId);
    else if (keys) {
      const parsed: unknown = JSON.parse(keys);
      if (Array.isArray(parsed) && parsed.every((c) => typeof c === "string")) binding = parsed as Binding;
    }
  } catch {
    binding = undefined;
  }
  return { el, label, plain: el.hasAttribute("data-tip-plain"), binding, reason: el.getAttribute("data-tip-reason") ?? undefined };
}

/** The element, or something inside it (a tab's label), is ellipsized. */
function isClipped(el: Element): boolean {
  if (el.scrollWidth > el.clientWidth) return true;
  for (const c of el.querySelectorAll("*")) if (c.scrollWidth > c.clientWidth) return true;
  return false;
}

const anchorOf = (t: EventTarget | null): Element | null => (t instanceof Element ? t.closest("[data-tip]") : null);

/** ms before the full text of a cut-off cell shows: the pointer crosses table rows all the time */
export const CLIP_DELAY = 600;

/** Attributes for an element whose text may be ellipsized: its full text, only while it is cut. */
export const clipTip = (text: string | undefined | null): TipProps => tip(text, { clipped: true, plain: true, delay: CLIP_DELAY });

/** Mount once at the root. */
export function TooltipHost() {
  const [shown, setShown] = useState<Shown | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // the control under the pointer, whether or not its tooltip shows: a tooltip that was closed
    // (key, click, scroll) stays closed until the pointer leaves this control
    let hover: Element | null = null;
    let visible = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closedAt = -Infinity;
    let gone: MutationObserver | null = null;
    // after a click or a key nothing opens until the pointer really moves: a button that appears
    // under a resting pointer (the click changed the toolbar) must not pop its tooltip over the result
    let rest: { x: number; y: number } | null = null;

    const close = (warm: boolean) => {
      clearTimeout(timer);
      timer = undefined;
      if (!visible) return;
      visible = false;
      closedAt = warm ? performance.now() : -Infinity;
      gone?.disconnect();
      gone = null;
      setShown(null);
    };
    const open = (el: Element) => {
      timer = undefined;
      if (!el.isConnected || hover !== el) return;
      // text that fits needs no tooltip (measured now, not per row at render)
      if (el.hasAttribute("data-tip-clipped") && !isClipped(el)) return;
      const next = read(el);
      if (!next) return;
      visible = true;
      setShown(next);
      // the control was removed or lost its tooltip while the pointer rested on it (live data)
      gone?.disconnect();
      gone = new MutationObserver(() => {
        if (!el.isConnected || !el.hasAttribute("data-tip")) {
          hover = null;
          close(false);
        }
      });
      gone.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-tip"] });
    };

    const onOver = (e: PointerEvent) => {
      // touch has no hover; a held button is a drag (divider, resize handle, text selection)
      if (e.pointerType === "touch" || e.buttons !== 0) return;
      const el = anchorOf(e.target);
      if (el === hover) return;
      hover = el;
      if (!el) return close(true);
      const warm = visible || performance.now() - closedAt < WARM;
      close(false);
      if (!rest) arm(el, warm);
    };
    const arm = (el: Element, warm: boolean) => {
      const slow = Number(el.getAttribute("data-tip-delay")) || 0;
      if (warm && !slow) open(el);
      else timer = setTimeout(() => open(el), slow || TIP_DELAY);
    };
    let at = { x: -1, y: -1 };
    const onMove = (e: PointerEvent) => {
      at = { x: e.clientX, y: e.clientY };
      if (!rest || (Math.abs(e.clientX - rest.x) < 2 && Math.abs(e.clientY - rest.y) < 2)) return;
      rest = null;
      if (hover && !visible && timer === undefined && e.buttons === 0) arm(hover, false);
    };
    const onDown = (e: PointerEvent) => {
      rest = { x: e.clientX, y: e.clientY };
      close(false);
    };
    const onLeave = () => {
      hover = null;
      close(false);
    };
    const dismiss = () => close(false);
    // a key: what it changes under a resting pointer (a new toolbar) stays quiet as well
    const onKey = () => {
      rest = at;
      close(false);
    };
    // only a scroll that moves the control: a following log pane scrolls by itself all the time
    const onScroll = (e: Event) => {
      if (hover && e.target instanceof Node && e.target.contains(hover)) close(false);
    };

    const opts = { capture: true, passive: true } as const;
    window.addEventListener("pointerover", onOver, opts);
    window.addEventListener("pointerdown", onDown, opts);
    window.addEventListener("pointermove", onMove, opts);
    // on the window, like the key engine: it stops the propagation of every key it consumes
    window.addEventListener("keydown", onKey, opts);
    window.addEventListener("wheel", dismiss, opts);
    window.addEventListener("scroll", onScroll, opts);
    document.documentElement.addEventListener("pointerleave", onLeave, { passive: true });
    window.addEventListener("blur", onLeave);
    return () => {
      close(false);
      window.removeEventListener("pointerover", onOver, opts);
      window.removeEventListener("pointerdown", onDown, opts);
      window.removeEventListener("pointermove", onMove, opts);
      window.removeEventListener("keydown", onKey, opts);
      window.removeEventListener("wheel", dismiss, opts);
      window.removeEventListener("scroll", onScroll, opts);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  }, []);

  // placed after it is measured, before paint: under the control, centred on it, above when there
  // is no room below (the bottom row), always inside the window. Rects are viewport px, CSS lengths
  // are divided by the zoom.
  useLayoutEffect(() => {
    const el = box.current;
    if (!shown || !el) return;
    const z = zoomFactor();
    const r = shown.el.getBoundingClientRect();
    const vw = window.innerWidth / z;
    const vh = window.innerHeight / z;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const x = Math.max(EDGE, Math.min((r.left + r.width / 2) / z - w / 2, vw - w - EDGE));
    let y = r.bottom / z + GAP;
    if (y + h > vh - EDGE) y = Math.max(EDGE, r.top / z - h - GAP);
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    el.style.visibility = "visible";
  }, [shown]);

  if (!shown) return null;
  return (
    // aria-hidden: the control carries its own name (aria-label); this is the pointer's copy
    <div ref={box} className="k-tip k-overlay" data-plain={shown.plain || undefined} aria-hidden="true">
      <span className="k-tip-head">
        <span className="k-tip-label t-ui">{shown.label}</span>
        {shown.binding && <KeyChip binding={shown.binding} />}
      </span>
      {shown.reason && <span className="k-tip-reason t-ui-multi">{shown.reason}</span>}
    </div>
  );
}
