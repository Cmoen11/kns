// Drag to rearrange (docs/ux.md §3.5): drag a pane header onto another pane. The outer 25% of a
// target's edge (capped at 160px) inserts on that side, the centre swaps. Nothing moves until the
// drop; the preview is an outline over where the pane will land. Esc cancels.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { Rect } from "../store/geometry";
import { focusPane, getGeometry, insertPane, swapPanes } from "../store/layout";
import type { Edge } from "../store/layout-tree";
import type { PaneId } from "../types";
import { animateLayout } from "./animate";
import { cancelMove } from "./modes";

/** §3.5: the pointer must travel this far before a press on the header becomes a drag. */
export const DRAG_THRESHOLD = 6;
const EDGE_SHARE = 0.25;
const EDGE_CAP = 160;

export interface DropZone {
  target: PaneId;
  /** null: swap with the target */
  edge: Edge | null;
  /** where the pane lands, in pane-area coordinates (the preview outline) */
  rect: Rect;
}

export interface PaneDrag {
  source: PaneId;
  zone: DropZone | null;
}

export const paneDrag = createStore<PaneDrag | null>(() => null);
export const usePaneDrag = <T,>(select: (s: PaneDrag | null) => T): T => useStore(paneDrag, select);

/** The drop zone under a point of one target rect: an edge band, or the centre (swap). */
export function zoneIn(r: Rect, x: number, y: number): { edge: Edge | null; rect: Rect } {
  const bw = Math.min(r.w * EDGE_SHARE, EDGE_CAP);
  const bh = Math.min(r.h * EDGE_SHARE, EDGE_CAP);
  const near: [Edge, number][] = [
    ["left", (x - r.x) / bw],
    ["right", (r.x + r.w - x) / bw],
    ["up", (y - r.y) / bh],
    ["down", (r.y + r.h - y) / bh],
  ];
  let edge: Edge | null = null;
  let best = 1;
  for (const [e, d] of near) {
    if (d < best) {
      best = d;
      edge = e;
    }
  }
  const halfW = r.w / 2;
  const halfH = r.h / 2;
  switch (edge) {
    case "left": return { edge, rect: { x: r.x, y: r.y, w: halfW, h: r.h } };
    case "right": return { edge, rect: { x: r.x + halfW, y: r.y, w: halfW, h: r.h } };
    case "up": return { edge, rect: { x: r.x, y: r.y, w: r.w, h: halfH } };
    case "down": return { edge, rect: { x: r.x, y: r.y + halfH, w: r.w, h: halfH } };
    default: return { edge: null, rect: r };
  }
}

/** The drop zone at a point of the pane area; null over the source itself or outside every pane. */
export function dropZoneAt(rects: ReadonlyMap<PaneId, Rect>, source: PaneId, x: number, y: number): DropZone | null {
  for (const [id, r] of rects) {
    if (x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h) continue;
    if (id === source) return null;
    return { target: id, ...zoneIn(r, x, y) };
  }
  return null;
}

function sameZone(a: DropZone | null, b: DropZone | null): boolean {
  return a === b || (!!a && !!b && a.target === b.target && a.edge === b.edge);
}

/** Commits a drop: insert on an edge of the target, or swap with it. */
export function dropPane(source: PaneId, zone: DropZone): boolean {
  const done = animateLayout(() => (zone.edge ? insertPane(source, zone.target, zone.edge) : swapPanes(source, zone.target)));
  focusPane(source);
  return done;
}

const NOT_A_HANDLE = "button, a, input, textarea, select, [role='button'], [contenteditable]";

/**
 * pointerdown on a pane header: tracks the press and turns it into a drag after the threshold.
 * The pointer is captured by the header, so a terminal or editor under the pointer never sees it.
 */
export function startHeaderDrag(e: PointerEvent, source: PaneId, header: HTMLElement): void {
  if (e.button !== 0 || paneDrag.getState()) return;
  if (e.target instanceof Element && e.target.closest(NOT_A_HANDLE)) return;
  const area = header.closest<HTMLElement>(".panes");
  if (!area) return;
  const pointer = e.pointerId;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let dragging = false;

  // pointer coordinates are viewport px; the geometry is in CSS px of the pane area (page zoom)
  const local = (cx: number, cy: number) => {
    const b = area.getBoundingClientRect();
    const sx = b.width > 0 ? area.clientWidth / b.width : 1;
    const sy = b.height > 0 ? area.clientHeight / b.height : 1;
    return { x: (cx - b.left) * sx, y: (cy - b.top) * sy };
  };

  const stop = () => {
    window.removeEventListener("keydown", onKey, true);
    header.removeEventListener("pointermove", onMove);
    header.removeEventListener("pointerup", onUp);
    header.removeEventListener("pointercancel", onCancel);
    header.removeEventListener("lostpointercapture", onCancel);
    if (header.hasPointerCapture(pointer)) header.releasePointerCapture(pointer);
    delete document.documentElement.dataset.paneDrag;
  };
  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointer) return;
    if (!dragging) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD) return;
      dragging = true;
      cancelMove();
      document.documentElement.dataset.paneDrag = "";
      paneDrag.setState({ source, zone: null }, true);
    }
    const p = local(ev.clientX, ev.clientY);
    const zone = dropZoneAt(getGeometry().rects, source, p.x, p.y);
    const cur = paneDrag.getState();
    if (cur && !sameZone(cur.zone, zone)) paneDrag.setState({ source, zone }, true);
  };
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pointer) return;
    const zone = paneDrag.getState()?.zone ?? null;
    stop();
    paneDrag.setState(null, true);
    if (dragging && zone) dropPane(source, zone);
  };
  const onCancel = () => {
    stop();
    paneDrag.setState(null, true);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (!dragging) return;
    // while dragging every key belongs to the drag; Esc cancels it
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.key === "Escape") onCancel();
  };

  try {
    header.setPointerCapture(pointer);
  } catch {
    return; // the pointer is already gone
  }
  window.addEventListener("keydown", onKey, true);
  header.addEventListener("pointermove", onMove);
  header.addEventListener("pointerup", onUp);
  header.addEventListener("pointercancel", onCancel);
  header.addEventListener("lostpointercapture", onCancel);
}
