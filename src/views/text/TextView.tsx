// The generic `text` view (docs/plan-features.md §2.8, §3 G): sections of plain text or a markdown
// subset, loaded from a registered source. DOM nodes only, through the tags in ALLOWED_TAGS;
// never innerHTML, and links are shown as text (nothing opens a URL).
//
// G adds, for docs that ask for it: a section cursor (j/k, Enter folds), dropping sections (Space
// or the section's remove button), the size line over what `c` copies ("14 KB · ~3.6k tokens ·
// redacted 7 values (4 key, …)"), the redaction legend, copy and save. Keys arrive as registry
// actions through the pane's controller (./controller); this component has no key handling.
import { createElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActionButton, EmptyState, PaneSlot, PaneToolbar, tip, toast, toasts, type ToolbarItem } from "../../foundation";
import type { ViewProps } from "../registry";
import { invalidateText } from "./actions";
import { setTextController, type TextController } from "./controller";
import { blockTag, inlineTag, parseMarkdown, type Block, type Inline } from "./markdown";
import { RULE_HELP } from "./measure";
import { textSourceLoader, type TextDoc, type TextSection } from "./sources";
import { canDrop, clampIndex, composeDoc, measureDoc, toggleDrop } from "./text-model";
import "./text.css";

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    const children = n.t === "text" || n.t === "code" ? n.text : renderInline(n.children);
    return n.t === "text" ? children : createElement(inlineTag(n), { key: i }, children);
  });
}

function renderBlock(b: Block, key: number): ReactNode {
  const tag = blockTag(b);
  switch (b.t) {
    case "heading":
    case "paragraph":
      return createElement(tag, { key, className: `txt-${b.t}` }, renderInline(b.children));
    case "list":
      return createElement(tag, { key, className: "txt-list" }, b.items.map((item, i) => createElement("li", { key: i }, renderInline(item))));
    case "code":
      return createElement(tag, { key, className: "txt-pre" }, createElement("code", null, b.text));
  }
}

interface SectionProps {
  section: TextSection;
  cursor: boolean;
  dropped: boolean;
  folded: boolean;
  droppable: boolean;
  onPoint: () => void;
}

function Section({ section, cursor, dropped, folded, droppable, onPoint }: SectionProps) {
  const hasHead = !!section.title || droppable;
  return (
    <section className="txt-section" data-section={section.id} data-cursor={cursor || undefined} data-dropped={dropped || undefined} onMouseDown={onPoint}>
      {hasHead && (
        <div className="txt-section-title t-ui">
          <span className="txt-section-name">{section.title}</span>
          {dropped && <span className="txt-section-note">dropped</span>}
          {folded && !dropped && <span className="txt-section-note">folded</span>}
          {droppable && (
            <ActionButton
              action="text.dropSection"
              before={onPoint}
              icon={dropped ? "plus" : "close"}
              label={dropped ? "Put section back" : "Remove section"}
              className="txt-section-drop"
            />
          )}
        </div>
      )}
      {!dropped && !folded && (section.format === "plain" ? <pre className="txt-pre">{section.body}</pre> : <div className="txt-md">{parseMarkdown(section.body).map(renderBlock)}</div>)}
    </section>
  );
}

function Legend({ byRule }: { byRule: Record<string, number> }) {
  const rules = Object.entries(byRule).filter(([, n]) => n > 0);
  if (rules.length === 0) return null;
  return (
    <div className="txt-legend t-ui">
      <span>
        <code>•••</code> = masked value:
      </span>
      {rules.map(([rule, n]) => (
        <span key={rule} className="txt-legend-rule" {...tip(RULE_HELP[rule] ?? "masked by the redactor")}>
          {n} {rule}
        </span>
      ))}
    </div>
  );
}

type Load = { state: "loading" } | { state: "none" } | { state: "error"; message: string } | { state: "ok"; doc: TextDoc };

const message = (e: unknown): string => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e));
/** One step of j/k inside a section taller than the pane. */
const LINE_STEP = 54;

export default function TextView({ pane, view, focused }: ViewProps<"text">) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [epoch, setEpoch] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const source = view.source;

  useEffect(() => {
    const loader = textSourceLoader(source.by);
    if (!loader) {
      setLoad({ state: "none" });
      return;
    }
    let alive = true;
    setLoad((l) => (l.state === "ok" ? l : { state: "loading" }));
    loader(source).then(
      (doc) => {
        if (!alive) return;
        setLoad({ state: "ok", doc });
        // a refreshed doc keeps drops of sections that still exist
        setDropped((d) => new Set([...d].filter((id) => doc.sections.some((s) => s.id === id))));
      },
      (e: unknown) => alive && setLoad({ state: "error", message: message(e) }),
    );
    return () => {
      alive = false;
    };
  }, [source, epoch]);

  const doc = load.state === "ok" ? load.doc : null;
  const measure = useMemo(() => (doc?.measure ? measureDoc(doc, dropped) : null), [doc, dropped]);

  // the controller reads the latest state through a ref, so it is registered once per pane
  const state = useRef({ doc, cursor, dropped });
  state.current = { doc, cursor, dropped };

  useEffect(() => {
    const sectionEl = (i: number): HTMLElement | null => scroller.current?.querySelectorAll<HTMLElement>(".txt-section")[i] ?? null;
    const show = (i: number) => requestAnimationFrame(() => sectionEl(i)?.scrollIntoView({ block: "nearest" }));
    const count = () => state.current.doc?.sections.length ?? 0;
    const cur = () => state.current.doc?.sections[clampIndex(state.current.cursor, count())];
    const go = (i: number) => {
      const next = clampIndex(i, count());
      setCursor(next);
      show(next);
    };
    const c: TextController = {
      move: (delta) => {
        const el = sectionEl(clampIndex(state.current.cursor, count()));
        const box = scroller.current;
        // inside a section taller than the pane, j/k scroll it before moving on
        if (el && box) {
          const r = el.getBoundingClientRect();
          const v = box.getBoundingClientRect();
          if (delta > 0 && r.bottom > v.bottom + 1) return void box.scrollBy({ top: LINE_STEP });
          if (delta < 0 && r.top < v.top - 1) return void box.scrollBy({ top: -LINE_STEP });
        }
        go(state.current.cursor + delta);
      },
      moveTo: (w) => go(w === "top" ? 0 : count() - 1),
      page: (delta) => {
        const box = scroller.current;
        if (!box) return;
        box.scrollBy({ top: delta * box.clientHeight * 0.9 });
        // the cursor follows to the first section visible at the top
        requestAnimationFrame(() => {
          const top = box.getBoundingClientRect().top;
          const els = [...box.querySelectorAll<HTMLElement>(".txt-section")];
          const i = els.findIndex((el) => el.getBoundingClientRect().bottom > top + 4);
          if (i >= 0) setCursor(i);
        });
      },
      fold: () => {
        const s = cur();
        if (!s) return;
        setFolded((f) => {
          const next = new Set(f);
          if (!next.delete(s.id)) next.add(s.id);
          return next;
        });
      },
      canDrop: () => {
        const { doc: d } = state.current;
        const s = cur();
        if (!d || !s) return "loading";
        if (!d.droppable) return "sections of this text cannot be dropped";
        return canDrop(d, s.id) || "this section is always kept";
      },
      drop: () => {
        const { doc: d, dropped: dr } = state.current;
        const s = cur();
        if (d && s) setDropped(toggleDrop(d, dr, s.id));
      },
      canCopy: () => (state.current.doc ? true : "loading"),
      copy: () => {
        const { doc: d, dropped: dr } = state.current;
        if (!d) return;
        const text = composeDoc(d, dr);
        const what = d.measure ? measureDoc(d, dr).line : `${text.length} characters`;
        navigator.clipboard.writeText(text).then(
          () => toast({ kind: "ok", text: `Copied ${what}` }),
          (e: unknown) => toasts.error(`Could not copy: ${message(e)}`),
        );
      },
      canSave: () => {
        const d = state.current.doc;
        if (!d) return "loading";
        return d.save ? true : "this text cannot be saved";
      },
      save: () => {
        const { doc: d, dropped: dr } = state.current;
        if (!d?.save) return;
        d.save([...dr]).then(
          (path) => path && toast({ kind: "ok", text: `Saved to ${path}` }),
          (e: unknown) => toasts.error(`Could not save: ${message(e)}`),
        );
      },
      point: (id) => {
        const i = state.current.doc?.sections.findIndex((s) => s.id === id) ?? -1;
        if (i >= 0) setCursor(i);
      },
      refresh: () => setEpoch((n) => n + 1),
    };
    setTextController(pane, c);
    return () => setTextController(pane, null);
  }, [pane]);

  // the hint row and the toolbar read `canDrop` / `canSave`
  useEffect(() => invalidateText(), [doc, cursor, dropped]);

  const toolbar = useMemo((): ToolbarItem[] => {
    const items: ToolbarItem[] = ["text.copy"];
    if (doc?.save) items.push({ action: "view.saveToFile", label: "Save", icon: null });
    items.push("|", "view.refresh", "hub.help");
    return items;
  }, [doc]);

  if (load.state === "none") return <EmptyState compact>no text source registered for {source.by}</EmptyState>;
  if (load.state === "loading") return <EmptyState compact>loading</EmptyState>;
  if (load.state === "error") return <EmptyState compact>{load.message}</EmptyState>;
  const sections = load.doc.sections;
  const cur = clampIndex(cursor, sections.length);
  return (
      <div className="txt" data-active={focused || undefined}>
        <PaneToolbar items={toolbar} label="Text" />
        <PaneSlot name="count">{measure && measure.droppable ? `${measure.kept}/${measure.droppable}` : sections.length}</PaneSlot>
        {measure && (
          <div className="txt-measure">
            <div className="txt-size t-ui" aria-live="polite">
              {measure.line}
              {measure.kept < measure.droppable && <span className="txt-size-dropped"> · {measure.droppable - measure.kept} dropped</span>}
            </div>
            <Legend byRule={measure.redactions.byRule} />
          </div>
        )}
        <div className="txt-scroll" ref={scroller}>
          {sections.length === 0 ? (
            <EmptyState compact>empty</EmptyState>
          ) : (
            sections.map((s, i) => (
              <Section
                key={s.id}
                section={s}
                cursor={i === cur}
                dropped={dropped.has(s.id)}
                folded={folded.has(s.id)}
                droppable={!!load.doc.droppable && !!s.droppable}
                onPoint={() => setCursor(i)}
              />
            ))
          )}
        </div>
      </div>
  );
}
