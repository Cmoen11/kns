// Status glyphs and the nodelinje (docs/ux.md §9.5, §9.6). Filled shapes, whole pixels,
// currentColor. Shape carries the state; colour only adds warn and error.
import { memo } from "react";

export type GlyphState = "ok" | "progress" | "warn" | "error" | "suspended" | "done" | "terminating" | "unknown";

/**
 * Line icons for buttons (mouse parity): 12px grid, 1px stroke, currentColor. One entry = one
 * symbol in the sprite; `dots` are filled circles. Add an icon here and it is usable everywhere.
 */
const ICONS = {
  back: { d: "M7.5 2.5 4 6l3.5 3.5" },
  forward: { d: "M4.5 2.5 8 6 4.5 9.5" },
  up: { d: "M2.5 7.5 6 4l3.5 3.5" },
  caret: { d: "M3 4.5 6 7.5 9 4.5" },
  "split-right": { d: "M1.5 2.5h9v7h-9zM6 2.5v7" },
  "split-down": { d: "M1.5 2.5h9v7h-9zM1.5 6h9" },
  zoom: { d: "M1.5 4.5v-3h3M7.5 1.5h3v3M10.5 7.5v3h-3M4.5 10.5h-3v-3" },
  close: { d: "M2.5 2.5l7 7M9.5 2.5l-7 7" },
  more: { d: "", dots: [[2, 6], [6, 6], [10, 6]] },
  star: { d: "M6 1.5 7.4 4.4l3.1.4-2.3 2.2.6 3.1L6 8.6l-2.8 1.5.6-3.1L1.5 4.8l3.1-.4z" },
  help: { d: "M10.5 6a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zM4.7 4.9a1.35 1.35 0 1 1 1.9 1.2c-.4.2-.6.5-.6.9", dots: [[6, 8.7]] },
  settings: { d: "M1.5 3.5h1.2M5.3 3.5h5.2M1.5 8.5h5.2M9.3 8.5h1.2M5.3 3.5a1.3 1.3 0 1 1-2.6 0 1.3 1.3 0 0 1 2.6 0zM9.3 8.5a1.3 1.3 0 1 1-2.6 0 1.3 1.3 0 0 1 2.6 0z" },
  home: { d: "M1.5 6 6 1.8 10.5 6M3 5v5.5h6V5" },
  search: { d: "M8.2 5a3.2 3.2 0 1 1-6.4 0 3.2 3.2 0 0 1 6.4 0zM7.4 7.4l3 3" },
  refresh: { d: "M10 6a4 4 0 1 1-1.2-2.8M10 1.8v2.6H7.4" },
  history: { d: "M2 6a4 4 0 1 0 1.2-2.8M2 1.8v2.6h2.6M6 4v2.2l1.5 1" },
  logs: { d: "M2 3h8M2 6h8M2 9h5" },
  describe: { d: "M2.5 1.5h7v9h-7zM4.5 4.5h3M4.5 7h3" },
  yaml: { d: "M4.5 1.5C3.2 1.5 3 2.1 3 3.1v1.3c0 .8-.4 1.3-1.2 1.6.8.3 1.2.8 1.2 1.6v1.3c0 1 .2 1.6 1.5 1.6M7.5 1.5c1.3 0 1.5.6 1.5 1.6v1.3c0 .8.4 1.3 1.2 1.6-.8.3-1.2.8-1.2 1.6v1.3c0 1-.2 1.6-1.5 1.6" },
  edit: { d: "M2 10l.6-2.6 5.8-5.8 2 2-5.8 5.8zM7.2 2.8l2 2" },
  shell: { d: "M2 3.5 5 6 2 8.5M6.5 9.5h4" },
  forwardPort: { d: "M1.5 4h8M7.5 1.8 9.7 4 7.5 6.2M10.5 8h-8M4.5 5.8 2.3 8l2.2 2.2" },
  scale: { d: "M6 1.5v9M3.5 4 6 1.5 8.5 4M3.5 8 6 10.5 8.5 8" },
  delete: { d: "M2 3.5h8M4.5 3.5v-2h3v2M3 3.5l.5 7h5l.5-7" },
  copy: { d: "M4.5 4.5h6v6h-6zM7.5 2.5v-1h-6v6h1" },
  wrap: { d: "M1.5 3h9M1.5 6h7a1.75 1.75 0 0 1 0 3.5H6M7.2 8.2 5.8 9.5l1.4 1.3M1.5 9.5h2" },
  follow: { d: "M6 1.5v6M3.5 5 6 7.5 8.5 5M2 10.5h8" },
  clock: { d: "M10.5 6a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zM6 3.5V6l1.8 1.2" },
  filter: { d: "M1.5 2.5h9L7 6.8v3.7L5 9.3V6.8z" },
  check: { d: "M2 6.5 4.8 9 10 3" },
  columns: { d: "M1.5 2.5h9v7h-9zM4.5 2.5v7M7.5 2.5v7" },
  container: { d: "M1.5 3.5 6 1.5l4.5 2v5L6 10.5l-4.5-2zM1.5 3.5 6 5.5l4.5-2M6 5.5v5" },
  plus: { d: "M6 2v8M2 6h8" },
  play: { d: "M3.5 2.5v7l6-3.5z" },
  pause: { d: "M4 2.5v7M8 2.5v7" },
  eye: { d: "M1.5 6S3.2 3 6 3s4.5 3 4.5 3S8.8 9 6 9 1.5 6 1.5 6z", dots: [[6, 6]] },
  fold: { d: "M3.5 1.5 6 4l2.5-2.5M3.5 10.5 6 8l2.5 2.5M1.5 6h9" },
  diff: { d: "M6 1.5v5M3.5 4h5M3.5 9.5h5" },
  link: { d: "M4.8 7.2l2.4-2.4M5.6 3.6l.9-.9a2 2 0 0 1 2.8 2.8l-.9.9M6.4 8.4l-.9.9a2 2 0 0 1-2.8-2.8l.9-.9" },
  // tables: faults only, wide columns, sort direction, the namespace of a row
  fault: { d: "M6 1.8 10.6 10H1.4zM6 5v2.4", dots: [[6, 8.6]] },
  wide: { d: "M1.5 6h9M3.5 4 1.5 6l2 2M8.5 4l2 2-2 2" },
  "sort-asc": { d: "M6 10V2M3 5l3-3 3 3" },
  "sort-desc": { d: "M6 2v8M3 7l3 3 3-3" },
  open: { d: "M2.5 6h7M6.5 3 9.5 6l-3 3" },
  // row actions: restart a workload (not the view's refresh), reconcile
  restart: { d: "M6 1.5v4M3.6 3.3a4 4 0 1 0 4.8 0" },
  sync: { d: "M2 5a4.1 4.1 0 0 1 7.2-1.6M10 7a4.1 4.1 0 0 1-7.2 1.6M9.4 1.4v2.2H7.2M2.6 10.6V8.4h2.2" },
  // logs, shell, forwards: end a session or forward, empty the buffer, open in the browser, select mode
  stop: { d: "M3 3h6v6H3z" },
  clear: { d: "M10.5 6a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zM2.9 9.1l6.2-6.2" },
  external: { d: "M5 2.5H2.5v7h7V7M7 1.5h3.5V5M10.5 1.5 6 6" },
  select: { d: "M2 2.5h1.5M5.2 2.5h1.6M8.5 2.5H10M2 9.5h1.5M5.2 9.5h1.6M8.5 9.5H10M2 5.2v1.6M10 5.2v1.6" },
  // feature tools (docs/plan-features.md §2.10a); `help` and `diff` are above
  why: { d: "M7.8 4.8a3.3 3.3 0 1 1-6.6 0 3.3 3.3 0 0 1 6.6 0zM7 7l3.5 3.5M4.5 3v1.9", dots: [[4.5, 6.5]] },
  timeline: { d: "M1.5 6h9M3 4v4M6 2.5v7M9 4.5v3" },
  bug: { d: "M4 5h4v3.5a2 2 0 0 1-4 0zM4.6 5a1.4 1.4 0 0 1 2.8 0M1.5 7h2.5M8 7h2.5M2 3.5 4 5M10 3.5 8 5M2 10.5l2-1.3M10 10.5l-2-1.3" },
  trap: { d: "M10.5 6a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zM6 1.5v2M6 8.5v2M1.5 6h2M8.5 6h2", dots: [[6, 6]] },
  pack: { d: "M2.5 2.5h7v8h-7zM4.5 1.5h3v2h-3zM4.5 6h3M4.5 8h3" },
  plug: { d: "M4 1.5v2.5M8 1.5v2.5M3 4h6v2a3 3 0 0 1-6 0zM6 9v1.5" },
  env: { d: "M1.5 2.5h9v7h-9zM3.5 5h2M3.5 7h3.5M7.5 5h1" },
  agent: { d: "M2.5 4h7v6h-7zM6 4V2.5M1.5 6.5V8M10.5 6.5V8", dots: [[4.5, 6.6], [7.5, 6.6], [6, 2]] },
  tools: { d: "M1.5 1.5H5V5H1.5zM7 1.5h3.5V5H7zM1.5 7H5v3.5H1.5zM7 7h3.5v3.5H7z" },
  relations: { d: "M1.5 1.5h3v2h-3zM7.5 4.5h3v2h-3zM7.5 8.5h3v2h-3zM3 3.5v6h4.5M3 5.5h4.5" },
  reach: { d: "M1.5 6h6.5M6 4l2 2-2 2M10.5 2.5v7" },
  pattern: { d: "M1.5 3h2M5.5 3h5M1.5 6h2M5.5 6h5M1.5 9h2M5.5 9h3" },
} satisfies Record<string, { d: string; dots?: number[][] }>;

export type IconName = keyof typeof ICONS;

/** One line icon, aria-hidden: the button around it carries the name. Requires <GlyphSprite/>. */
export const Icon = memo(function Icon({ name }: { name: IconName }) {
  return (
    <svg className="k-icon" width="12" height="12" aria-hidden="true" focusable="false">
      <use href={`#k-i-${name}`} />
    </svg>
  );
});

/**
 * Mount once near the root. <Glyph> references these symbols, so a table row costs one <use>.
 * Geometry at 8px: square 7x7, lines 8x2, circle Ø8, small square 4x4.
 */
export function GlyphSprite() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        <symbol id="k-g-ok" viewBox="0 0 8 8">
          <rect x="0" y="0" width="7" height="7" shapeRendering="crispEdges" />
        </symbol>
        <symbol id="k-g-progress" viewBox="0 0 8 8">
          <rect x="0" y="3" width="8" height="2" shapeRendering="crispEdges" />
        </symbol>
        <symbol id="k-g-warn" viewBox="0 0 8 8">
          <path d="M0 6.6 6.6 0 8 1.4 1.4 8Z" />
        </symbol>
        <symbol id="k-g-error" viewBox="0 0 8 8">
          <circle cx="4" cy="4" r="4" />
        </symbol>
        <symbol id="k-g-suspended" viewBox="0 0 8 8">
          <rect x="3" y="0" width="2" height="8" shapeRendering="crispEdges" />
        </symbol>
        <symbol id="k-g-done" viewBox="0 0 8 8">
          <rect x="2" y="2" width="4" height="4" shapeRendering="crispEdges" />
        </symbol>
        {(Object.entries(ICONS) as [string, { d: string; dots?: number[][] }][]).map(([name, icon]) => (
          <symbol key={name} id={`k-i-${name}`} viewBox="0 0 12 12">
            {icon.d && <path d={icon.d} fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="square" />}
            {icon.dots?.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="1" fill="currentColor" />)}
          </symbol>
        ))}
      </defs>
    </svg>
  );
}

const SYMBOL: Record<GlyphState, string | null> = {
  ok: "k-g-ok",
  progress: "k-g-progress",
  warn: "k-g-warn",
  error: "k-g-error",
  suspended: "k-g-suspended",
  done: "k-g-done",
  terminating: "k-g-progress", // "in transit"; the row is muted and the word says Terminating
  unknown: null, // the absence of a node plus the word
};

/**
 * One status glyph, aria-hidden: always put the status word next to it.
 * Renders nothing for 'unknown'. Requires <GlyphSprite/> in the document.
 */
export const Glyph = memo(function Glyph({ state }: { state: GlyphState }) {
  const id = SYMBOL[state];
  if (!id) return null;
  return (
    <svg className="glyph" data-state={state} width="8" height="8" aria-hidden="true" focusable="false">
      <use href={`#${id}`} />
    </svg>
  );
});

export type NodelinjeState = "live" | "reconnecting" | "stale";

/**
 * The nodelinje: square, line, circle. size 4 is the watch / connection glyph (28px wide, 8px
 * gaps); size 8 is the empty-state block (16px gaps). Live shows all three, reconnecting drops
 * the line, stale / paused / offline keeps only the circle. Always pair it with a word.
 */
export const Nodelinje = memo(function Nodelinje({ size = 4, state = "live" }: { size?: 4 | 8; state?: NodelinjeState }) {
  const gap = size * 2;
  const sq = size === 8 ? 7 : 4;
  const th = size === 8 ? 2 : 1;
  const width = size * 3 + gap * 2;
  const x2 = size + gap;
  const x3 = x2 + size + gap;
  return (
    <svg className="k-nodelinje" data-state={state} width={width} height={size} aria-hidden="true" focusable="false">
      {state !== "stale" && <rect x="0" y="0" width={sq} height={sq} shapeRendering="crispEdges" />}
      {state === "live" && (
        <rect x={x2} y={Math.floor((size - th) / 2)} width={size} height={th} shapeRendering="crispEdges" />
      )}
      <circle cx={x3 + size / 2} cy={size / 2} r={size / 2} />
    </svg>
  );
});
