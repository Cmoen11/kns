// The pane area (docs/ux.md §3). Panes are flat, absolutely positioned siblings keyed by pane id,
// placed from the computed geometry: a split, move, fold or zoom never remounts a pane (a terminal
// or editor keeps its state), and hidden panes stay mounted so their sessions keep running.
import { memo, useLayoutEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { bindingText, engine, platform } from "../keys";
import { moveDivider, type DividerGeom, type Geometry, type SplitGeom, type StripGeom } from "../store/geometry";
import {
  equalizeAllPanes,
  equalizeSplitById,
  focusPane,
  geometryOf,
  getGeometry,
  getViewport,
  getWorkspace,
  setSplitSizes,
  setViewport,
  useGeometry,
  useWorkspace,
} from "../store/layout";
import { leafIds, setSplitSizes as treeSetSizes } from "../store/layout-tree";
import { zoomFactor } from "../store/appearance";
import { flash } from "../store/status";
import { currentView } from "../store/workspace";
import type { PaneId, PaneState, Workspace } from "../types";
import { faultsText, usePaneFaultsAll } from "../store/pane-status";
import { runAction, Tabs, tip, type TabItem } from "../ui";
import { titleOf } from "../views/registry";
import { usePaneDrag } from "./drag";
import { usePaneModes } from "./modes";
import { Pane } from "./Pane";

const px = (n: number) => `${n}px`;
/** §3.3: 8px hit area around the 1px line. */
const HIT_BEFORE = 3;

function place(el: HTMLElement, x: number, y: number, w: number, h: number) {
  el.style.left = px(x);
  el.style.top = px(y);
  el.style.width = px(w);
  el.style.height = px(h);
}

function dividerBox(d: DividerGeom) {
  return d.dir === "row"
    ? { x: d.rect.x - HIT_BEFORE, y: d.rect.y, w: 8, h: d.rect.h }
    : { x: d.rect.x, y: d.rect.y - HIT_BEFORE, w: d.rect.w, h: 8 };
}

/** Writes a geometry straight to the DOM (divider drag): no React render, no pane content work. */
function applyGeometry(container: HTMLElement, g: Geometry) {
  for (const el of container.querySelectorAll<HTMLElement>(":scope > [data-pane]")) {
    const r = g.rects.get(el.dataset.pane ?? "");
    if (r) place(el, r.x, r.y, r.w, r.h);
  }
  const dividers = new Map(g.dividers.map((d) => [`${d.split}:${d.index}`, d]));
  for (const el of container.querySelectorAll<HTMLElement>(":scope > [data-divider]")) {
    const d = dividers.get(el.dataset.divider ?? "");
    if (!d) continue;
    const b = dividerBox(d);
    place(el, b.x, b.y, b.w, b.h);
  }
}

interface Drag {
  pointer: number;
  start: number;
  split: SplitGeom;
  ws: Workspace;
  sizes: number[] | null;
  /** a click without movement must not commit (it would snap or round the fractions) */
  moved: boolean;
  frame: number;
  last: { pos: number; alt: boolean };
}

const Divider = memo(function Divider({ d }: { d: DividerGeom }) {
  const drag = useRef<Drag | null>(null);
  const horizontal = d.dir === "row";
  const key = `${d.split}:${d.index}`;

  const step = (el: HTMLElement) => {
    const s = drag.current;
    if (!s) return;
    s.frame = 0;
    // pointer coordinates are viewport px; CSS lengths are divided by the zoom
    const delta = (s.last.pos - s.start) / zoomFactor();
    const sizes = moveDivider(s.split, d.index, delta, { snap: !s.last.alt });
    if (!sizes || !el.parentElement) return;
    s.sizes = sizes;
    applyGeometry(el.parentElement, geometryOf({ ...s.ws, root: treeSetSizes(s.ws.root, d.split, sizes) }, getViewport()));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ws = getWorkspace();
    const split = getGeometry().splits.get(d.split);
    if (e.button !== 0 || !ws || !split) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      return; // the pointer is already gone
    }
    e.currentTarget.dataset.drag = "";
    const pos = horizontal ? e.clientX : e.clientY;
    drag.current = { pointer: e.pointerId, start: pos, split, ws, sizes: null, moved: false, frame: 0, last: { pos, alt: e.altKey } };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = drag.current;
    if (!s || e.pointerId !== s.pointer) return;
    s.last = { pos: horizontal ? e.clientX : e.clientY, alt: e.altKey };
    if (s.last.pos !== s.start) s.moved = true;
    if (!s.moved) return;
    const el = e.currentTarget;
    if (!s.frame) s.frame = requestAnimationFrame(() => step(el));
  };
  const finish = (e: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const s = drag.current;
    if (!s || e.pointerId !== s.pointer) return;
    const el = e.currentTarget;
    if (s.frame) cancelAnimationFrame(s.frame);
    if (commit && s.moved) step(el);
    drag.current = null;
    delete el.dataset.drag;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    // commit the fractions; when nothing changed, put the DOM back as React rendered it
    if (!(commit && s.moved && s.sizes && setSplitSizes(d.split, s.sizes)) && el.parentElement) applyGeometry(el.parentElement, getGeometry());
  };

  const b = dividerBox(d);
  return (
    <div
      className="pane-divider"
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      data-divider={key}
      data-dir={d.dir}
      {...tip("Drag to resize", { reason: "double-click equalizes", delay: 1200 })}
      style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, true)}
      onPointerCancel={(e) => finish(e, false)}
      onDoubleClick={(e) => (e.shiftKey ? equalizeAllPanes() : equalizeSplitById(d.split))}
    />
  );
});

interface FrameProps {
  id: PaneId;
  index: number;
  focused: boolean;
  zoomed: boolean;
  visible: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  move: "source" | "target" | undefined;
}

const PaneFrame = memo(function PaneFrame({ id, index, focused, zoomed, visible, x, y, w, h, move }: FrameProps) {
  return (
    <div className="pane-frame" data-pane={id} data-hidden={visible ? undefined : ""} data-move={move} style={{ left: x, top: y, width: w, height: h }}>
      <Pane id={id} index={index} focused={focused} visible={visible} zoomed={zoomed} />
    </div>
  );
});

function Strip({ strip, order, panes }: { strip: StripGeom; order: readonly PaneId[]; panes: Record<PaneId, PaneState> }) {
  const faults = usePaneFaultsAll();
  const items: TabItem[] = strip.panes.map((id) => {
    const f = faults[id];
    return {
      id,
      index: order.indexOf(id) + 1,
      label: panes[id] ? titleOf(currentView(panes[id])) : "",
      state: f ? (f.error > 0 ? "error" : "warn") : undefined,
      stateText: f ? faultsText(f) : undefined,
    };
  });
  const r = strip.rect;
  return (
    <div className="pane-strip" style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
      <Tabs
        items={items}
        active={strip.active}
        onSelect={focusPane}
        // the tab's pane takes focus first, then the registered action closes it (guards, reopen stack)
        onClose={(id) => void runAction("pane.close", { pane: id })}
        closeTitle="Close pane"
        closeAction="pane.close"
        label={strip.reason === "zoom" ? "Zoomed panes" : "Folded panes"}
      />
    </div>
  );
}

export function PaneTree() {
  const ref = useRef<HTMLDivElement>(null);
  const panes = useWorkspace((ws) => ws?.panes);
  const root = useWorkspace((ws) => ws?.root);
  const focused = useWorkspace((ws) => ws?.focused ?? null);
  const zoomed = useWorkspace((ws) => ws?.zoomed ?? null);
  const geometry = useGeometry();
  const move = usePaneModes((s) => s.move);
  const drag = usePaneDrag((s) => s);
  const order = useMemo(() => (root ? leafIds(root) : []), [root]);
  // last known rect of each pane, so a hidden pane keeps its size (a terminal must not collapse)
  const lastRects = useRef(new Map<PaneId, { x: number; y: number; w: number; h: number }>());

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setViewport(el.clientWidth, el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // §3.4: say so when layout pressure folds panes away
  let folded = 0;
  for (const s of geometry.strips) if (s.reason === "fold") folded += s.panes.length;
  const prevFolded = useRef(0);
  useLayoutEffect(() => {
    if (folded > prevFolded.current) {
      const key = engine.bindingsFor("pane.next")[0];
      flash(`folded: ${folded} panes${key ? ` (${bindingText(key, platform)} cycles)` : ""}`);
    }
    prevFolded.current = folded;
  }, [folded]);

  if (!panes || !root) return <div className="panes" ref={ref} />;
  // DOM order is the stable creation order: reordering DOM nodes would reset scroll positions
  const ids = Object.keys(panes);
  for (const id of lastRects.current.keys()) if (!panes[id]) lastRects.current.delete(id);
  return (
    <div className="panes" ref={ref} data-mode={move ? "move" : drag ? "drag" : undefined}>
      {ids.map((id) => {
        const rect = geometry.rects.get(id);
        if (rect) lastRects.current.set(id, rect);
        const r = rect ?? lastRects.current.get(id) ?? { x: 0, y: 0, w: geometry.size.w, h: geometry.size.h };
        return (
          <PaneFrame
            key={id}
            id={id}
            index={order.indexOf(id) + 1}
            focused={focused === id}
            zoomed={zoomed === id}
            visible={!!rect}
            x={r.x}
            y={r.y}
            w={r.w}
            h={r.h}
            move={move ? (move.target === id ? "target" : move.pane === id ? "source" : undefined) : drag?.source === id ? "source" : undefined}
          />
        );
      })}
      {geometry.dividers.map((d) => (
        <Divider key={`${d.split}:${d.index}`} d={d} />
      ))}
      {geometry.strips.map((s, i) => (
        <Strip key={i} strip={s} order={order} panes={panes} />
      ))}
      {drag?.zone && (
        // §3.5: an outline over where the pane will land, no fill; nothing moves until the drop
        <div
          className="pane-drop"
          data-swap={drag.zone.edge ? undefined : ""}
          aria-hidden="true"
          style={{ left: drag.zone.rect.x, top: drag.zone.rect.y, width: drag.zone.rect.w, height: drag.zone.rect.h }}
        />
      )}
    </div>
  );
}
