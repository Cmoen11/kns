// The `relations` view (docs/plan-features.md §3 C3): one tree from the object to what owns it (up
// to the Flux source), what it owns, the traffic in front of it and what it mounts. `h` / `l` fold,
// Enter describes the node (Ctrl+Enter beside). Keys arrive as registry actions through the pane's
// controller; this component has no key handling. Every name and status is cluster text, rendered
// as text only (statuses come cleaned and redacted from Rust).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RelationNode } from "../ipc/types";
import { backend, openInContext, paneContext, usePaneContext, EmptyState, Glyph, Icon, keepFocus, PaneSlot, tip, toObjRef, type ViewProps } from "../foundation";
import { cleanUntrusted } from "../ui/untrusted";
import { invalidateC3 } from "./c3-actions";
import { relationsControllers, type RelationsController } from "./c3-controller";
import type { NewPane } from "./c2-controller";
import { errorText } from "./c2-store";
import { listPointer } from "./list-pointer";
import { canFold, countNodes, flatten, fold, RELATION_WORD, statusSeverity, toObjectRef } from "./relations-model";
import "./c2.css";
import "./c3.css";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; root: RelationNode; at: number };

export default function RelationsView({ pane, view, focused }: ViewProps<"relations">) {
  const context = usePaneContext(pane);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [cursorKey, setCursorKey] = useState("");
  const [epoch, setEpoch] = useState(0);
  const seq = useRef(0);
  const ref = view.ref;
  const refKey = `${ref.gvr.group}/${ref.gvr.resource}/${ref.namespace ?? ""}/${ref.name}`;

  useEffect(() => {
    if (!context) return;
    const id = ++seq.current;
    backend.relations(toObjRef(ref, context)).then(
      (root) => id === seq.current && setLoad({ state: "ok", root, at: Date.now() }),
      (e: unknown) => id === seq.current && setLoad({ state: "error", message: errorText(e) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, refKey, epoch]);

  const root = load.state === "ok" ? load.root : null;
  const rows = useMemo(() => flatten(root, collapsed), [root, collapsed]);
  const curIndex = Math.max(0, rows.findIndex((r) => r.key === cursorKey));
  const state = useRef({ rows, curIndex, collapsed });
  state.current = { rows, curIndex, collapsed };

  const select = useCallback((i: number) => {
    const idx = Math.min(Math.max(0, i), state.current.rows.length - 1);
    const r = state.current.rows[idx];
    if (!r) return;
    // the pointer runs an action right after selecting: the controller must see the row now
    state.current.curIndex = idx;
    setCursorKey(r.key);
  }, []);

  useEffect(() => {
    const cur = () => state.current.rows[state.current.curIndex];
    const open = (newPane: NewPane) => {
      const r = cur();
      if (!r) return;
      const doc = { kind: "doc", ref: toObjectRef(r.node), format: "describe", mode: "view", managedFields: false, wrap: false } as const;
      openInContext(doc, r.node.ref.context || paneContext(pane), { pane, newPane });
    };
    const c: RelationsController = {
      move: (d) => select(state.current.curIndex + d),
      moveTo: (w) => select(w === "top" ? 0 : state.current.rows.length - 1),
      open,
      canOpen: () => (cur() ? true : "no row"),
      refresh: () => setEpoch((n) => n + 1),
      loaded: () => state.current.rows.length > 0,
      fold: (dir) => {
        const r = cur();
        if (!r) return;
        const next = fold(state.current.rows, r.key, state.current.collapsed, dir);
        setCollapsed(next.collapsed);
        setCursorKey(next.cursor);
      },
      canFold: (dir) => canFold(cur(), dir),
    };
    relationsControllers.set(pane, c);
    return () => relationsControllers.set(pane, null);
  }, [pane, select]);

  useEffect(() => invalidateC3(), [rows, curIndex]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${curIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [curIndex, rows]);

  const pointer = useMemo(() => listPointer(pane, select, invalidateC3), [pane, select]);

  const label = cleanUntrusted(`${ref.gvr.resource.replace(/s$/, "")}/${ref.name}${ref.namespace ? ` (${ref.namespace})` : ""}`);
  const head = (
    <div className="c2-head t-ui">
      <span className="c2-head-ref">{label}</span>
      {root && <span className="muted">{countNodes(root)} objects</span>}
      {load.state === "ok" && <span className="muted">read {new Date(load.at).toLocaleTimeString()}</span>}
    </div>
  );
  if (load.state === "loading") return <div className="c2">{head}<EmptyState compact>reading what {label} is connected to</EmptyState></div>;
  if (load.state === "error") return <div className="c2">{head}<EmptyState compact title="Could not read the relations">{cleanUntrusted(load.message)}</EmptyState></div>;

  return (
    <div className="c2" data-active={focused || undefined}>
      <PaneSlot name="count">{`${rows.length}/${countNodes(root)}`}</PaneSlot>
      {head}
      {rows.length <= 1 ? (
        <EmptyState compact title="Nothing related found">
          No owner, owned objects, Services, Ingresses or mounted ConfigMaps, Secrets or volumes were found for {label}.
        </EmptyState>
      ) : null}
      <div className="c2-list" ref={listRef} role="tree" aria-label="relations" {...pointer}>
        {rows.map((r, i) => {
          const n = r.node;
          const sev = statusSeverity(n.status);
          const word = RELATION_WORD[n.relation];
          return (
            <div
              key={r.key || "root"}
              className="c2-row row t-cell c3-rel"
              data-index={i}
              data-focus={i === curIndex || undefined}
              role="treeitem"
              aria-level={r.depth + 1}
              aria-expanded={r.hasChildren ? r.expanded : undefined}
              aria-selected={i === curIndex}
              style={{ paddingInlineStart: `calc(var(--k-luft-15) + ${r.depth * 2}ch)` }}
            >
              {r.hasChildren ? (
                <button
                  type="button"
                  className="k-abtn c3-fold"
                  tabIndex={-1}
                  data-act={r.expanded ? "relations.collapse" : "relations.expand"}
                  onMouseDown={keepFocus}
                  aria-label={r.expanded ? "collapse" : "expand"}
                  {...tip(r.expanded ? "collapse" : "expand", { reason: r.expanded ? "h · Left" : "l · Right" })}
                >
                  {r.expanded ? "▾" : "▸"}
                </button>
              ) : (
                <span className="c3-fold" aria-hidden />
              )}
              {word && <span className="c3-rel-word muted">{word}</span>}
              <span className="c3-rel-kind">{cleanUntrusted(n.kind)}</span>
              <span className="c2-what" dir="ltr">
                {cleanUntrusted(n.ref.name)}
                {n.ref.namespace && n.ref.namespace !== ref.namespace ? <span className="muted"> ({cleanUntrusted(n.ref.namespace)})</span> : null}
              </span>
              {sev && <span className="c2-glyph"><Glyph state={sev} /></span>}
              {n.status && <span className="c2-detail" data-sev={sev ?? undefined}>{cleanUntrusted(n.status)}</span>}
              <button type="button" className="k-abtn c2-open" tabIndex={-1} data-act="open" onMouseDown={keepFocus} aria-label="describe" {...tip("describe", { reason: "Enter · Ctrl+click opens beside" })}>
                <Icon name="open" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
