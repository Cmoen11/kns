// The diff view (docs/plan-features.md §3 D): two objects, two revisions, or live against
// last-applied, as YAML. Read-only. It is built from the REVIEW diff's pieces (the CodeMirror
// merge view with `reviewExtensions` from the doc view), not the `Review` component itself: that
// component keeps its editors private, and `n` / `N` and keyboard scrolling need them.
// Lazy chunk; keys are the diff.* actions and the shared nav.* / view.refresh (actions.ts).
import { MergeView, getChunks, goToNextChunk, goToPreviousChunk, unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { PaneSlot, paneContext, type ViewProps } from "../foundation";
import { ActionHint, EmptyState } from "../ui";
import { reviewExtensions } from "../views/doc/cm";
import { loadSides } from "./load";
import { buildDiff, type DiffText } from "./model";
import { clearDiffUi, diffControllers, patchDiffUi, useDiffUi } from "./session";
import "./diff.css";

const COLLAPSE = { margin: 3, minSize: 6 };

function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (typeof e === "object" && e !== null && "message" in e && typeof (e as { message: unknown }).message === "string") return (e as { message: string }).message;
  return String(e);
}

interface Editors {
  /** the editor whose selection marks the current hunk (the right side in split) */
  main: EditorView;
  /** the element that scrolls */
  scroller: HTMLElement;
  destroy(): void;
}

export default function DiffView({ pane, view, focused }: ViewProps<"diff">) {
  const host = useRef<HTMLDivElement>(null);
  const eds = useRef<Editors | null>(null);
  const [text, setText] = useState<DiffText | null>(null);
  const [tick, setTick] = useState(0);
  const expanded = useDiffUi(pane, (s) => s.expanded);
  const loading = useDiffUi(pane, (s) => s.loading);
  const error = useDiffUi(pane, (s) => s.error);
  const chunks = useDiffUi(pane, (s) => s.chunks);
  const current = useDiffUi(pane, (s) => s.current);
  const note = useDiffUi(pane, (s) => s.note);
  const leftLabel = useDiffUi(pane, (s) => s.leftLabel);
  const rightLabel = useDiffUi(pane, (s) => s.rightLabel);
  const { left, right, managedFields, split } = view;

  // load both sides; a refresh (view.refresh) bumps `tick`
  useEffect(() => {
    let alive = true;
    patchDiffUi(pane, { loading: true });
    loadSides(left, right, paneContext(pane))
      .then(([a, b]) => {
        if (!alive) return;
        const t = buildDiff(a, b, managedFields);
        setText(t);
        patchDiffUi(pane, { loading: false, error: null, note: t.note, leftLabel: t.leftLabel, rightLabel: t.rightLabel });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setText(null);
        patchDiffUi(pane, { loading: false, error: errorText(e), chunks: 0, current: -1 });
      });
    return () => {
      alive = false;
    };
  }, [pane, left, right, managedFields, tick]);

  // the editors: rebuilt when the text, the layout or the collapse state changes
  useEffect(() => {
    const parent = host.current;
    if (!parent || !text || text.before === text.after) {
      patchDiffUi(pane, { chunks: 0, current: -1 });
      return;
    }
    const ext = reviewExtensions("yaml", false);
    const collapse = expanded ? undefined : COLLAPSE;
    let e: Editors;
    if (split) {
      const mv = new MergeView({
        parent,
        a: { doc: text.before, extensions: ext },
        b: { doc: text.after, extensions: ext },
        gutter: true,
        highlightChanges: true,
        collapseUnchanged: collapse,
      });
      e = { main: mv.b, scroller: mv.dom, destroy: () => mv.destroy() };
      patchDiffUi(pane, { chunks: mv.chunks.length, current: -1 });
    } else {
      const v = new EditorView({
        parent,
        state: EditorState.create({
          doc: text.after,
          extensions: [ext, unifiedMergeView({ original: text.before, mergeControls: false, gutter: true, highlightChanges: true, collapseUnchanged: collapse })],
        }),
      });
      e = { main: v, scroller: v.scrollDOM, destroy: () => v.destroy() };
      patchDiffUi(pane, { chunks: getChunks(v.state)?.chunks.length ?? 0, current: -1 });
    }
    eds.current = e;
    return () => {
      eds.current = null;
      e.destroy();
    };
  }, [pane, text, split, expanded]);

  // the controller the eager actions call
  useEffect(() => {
    const lineH = () => eds.current?.main.defaultLineHeight ?? 18;
    const scrollBy = (px: number) => eds.current?.scroller.scrollBy({ top: px });
    const hunk = (dir: 1 | -1) => {
      const e = eds.current;
      if (!e) return;
      (dir > 0 ? goToNextChunk : goToPreviousChunk)(e.main);
      const info = getChunks(e.main.state);
      if (!info) return;
      const head = e.main.state.selection.main.head;
      const i = info.chunks.findIndex((c) => (info.side === "a" ? c.fromA <= head && head <= Math.max(c.fromA, c.toA) : c.fromB <= head && head <= Math.max(c.fromB, c.toB)));
      patchDiffUi(pane, { current: i });
    };
    diffControllers.set(pane, {
      scroll: (n) => scrollBy(n * lineH()),
      page: (dir) => {
        const s = eds.current?.scroller;
        if (s) scrollBy(dir * Math.max(lineH(), s.clientHeight - lineH()));
      },
      edge: (end) => {
        const s = eds.current?.scroller;
        if (s) s.scrollTop = end === "top" ? 0 : s.scrollHeight;
      },
      hunk,
      refresh: () => setTick((t) => t + 1),
      toggleExpanded: () => patchDiffUi(pane, { expanded: !expanded }),
    });
    return () => {
      diffControllers.delete(pane);
    };
  }, [pane, expanded]);

  useEffect(() => () => clearDiffUi(pane), [pane]);

  const same = text !== null && text.before === text.after;
  return (
    <div className="diff" data-focused={focused || undefined} data-layout={split ? "split" : "unified"}>
      <PaneSlot name="labels">
        {managedFields && <span>Managed</span>}
        {!split && <span>Unified</span>}
        {expanded && <span>All lines</span>}
      </PaneSlot>
      <PaneSlot name="count">{chunks > 0 ? (current >= 0 ? `${current + 1}/${chunks}` : `${chunks} ${chunks === 1 ? "change" : "changes"}`) : null}</PaneSlot>
      {text && !error && (
        <div className="diff-sides t-ui" data-layout={split ? "split" : "unified"}>
          {/* cluster names: text nodes only */}
          <span className="diff-side truncate" data-side="a">{split ? leftLabel : `− ${leftLabel}`}</span>
          <span className="diff-side truncate" data-side="b">{split ? rightLabel : `+ ${rightLabel}`}</span>
        </div>
      )}
      {note && !error && <div className="diff-note t-ui muted">{note}</div>}
      <div className="diff-body" ref={host} hidden={!text || same || error !== null} />
      {error !== null && <EmptyState compact>{error}</EmptyState>}
      {same && !error && (
        <EmptyState compact>
          No differences{managedFields ? "" : " (managed fields, status and object ids are not compared: "}
          {managedFields ? null : <ActionHint action="diff.managedFields" label="compare everything" />}
          {managedFields ? null : ")"}
        </EmptyState>
      )}
      {loading && !text && !error && <div className="diff-loading t-ui">loading</div>}
    </div>
  );
}
