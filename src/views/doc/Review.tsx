// REVIEW (docs/ux.md §13.2 step 3): the diff of the server version against the edit, split when
// the pane is at least 720 wide, else unified. Read-only; keys are the review.* actions.
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { reviewExtensions, type DocFormat } from "./cm";
import { SPLIT_MIN } from "./controller";

export interface ReviewProps {
  before: string;
  after: string;
  format: DocFormat;
  wrap: boolean;
  /** user override; null = by width */
  split: boolean | null;
}

const COLLAPSE = { margin: 3, minSize: 6 };

export function Review({ before, after, format, wrap, split }: ReviewProps) {
  const host = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    // clientWidth is CSS px, so this holds under zoom
    const measure = () => setWide(el.clientWidth >= SPLIT_MIN);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sideBySide = split ?? wide;
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const ext = reviewExtensions(format, wrap);
    if (sideBySide) {
      const mv = new MergeView({
        parent,
        a: { doc: before, extensions: ext },
        b: { doc: after, extensions: ext },
        gutter: true,
        highlightChanges: true,
        collapseUnchanged: COLLAPSE,
      });
      return () => mv.destroy();
    }
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: after,
        extensions: [ext, unifiedMergeView({ original: before, mergeControls: false, gutter: true, highlightChanges: true, collapseUnchanged: COLLAPSE })],
      }),
    });
    return () => view.destroy();
  }, [before, after, format, wrap, sideBySide]);

  return <div className="doc-review" ref={host} data-layout={sideBySide ? "split" : "unified"} />;
}
