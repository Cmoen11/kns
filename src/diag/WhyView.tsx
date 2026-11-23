// The `why` view (docs/plan-features.md §3 C1): findings worst first, each followed by the
// evidence that proves it. Keys arrive as registry actions through the pane's controller
// (./controller); this component has no key handling. Every text comes from the cluster through
// Rust (redacted, cleaned) and is rendered as text only.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Diagnosis } from "../ipc/types";
import {
  backend, openInContext, usePaneContext, EmptyState, flash, Glyph, Icon, keepFocus, openView, PaneSlot, resolveResource, runAction, tip, toast, toasts, toObjRef,
  type ViewProps,
} from "../foundation";
import { cleanUntrusted } from "../ui/untrusted";
import { invalidateWhy } from "./actions";
import { setWhyController, type NewPane, type WhyController } from "./controller";
import {
  clampCursor, countLabel, evidenceContext, evidenceTarget, evidenceText, findingTarget, findingsText, kindTag, refLabel, whyRows, type EvidenceEnv, type WhyRow,
} from "./why-model";
import "./why.css";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; diag: Diagnosis };

const message = (e: unknown): string => (typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e));

const env: EvidenceEnv = {
  resolve: (kind) => {
    const r = resolveResource(kind);
    return r ? { gvr: r.gvr, namespaced: r.namespaced } : undefined;
  },
};

/** The view a row opens (null: nothing to open), plus why not. */
function rowTarget(row: WhyRow | undefined, diag: Diagnosis | null): { view: Parameters<typeof openView>[0]; context: string } | string {
  if (!row || !diag) return "no row";
  if (row.type === "next") return { view: row.view, context: diag.ref.context };
  if (row.type === "evidence") {
    const view = evidenceTarget(row.data, diag.ref, env);
    return view ? { view, context: evidenceContext(row.data, diag.ref) } : "nothing to open for this evidence";
  }
  const t = findingTarget(row.data, diag.ref, env);
  return t ? { view: t.view, context: evidenceContext(row.data.evidence[t.evidence], diag.ref) } : "this finding has no evidence to open";
}

const SEV_GLYPH = { error: "error", warn: "warn", info: "unknown" } as const;

export default function WhyView({ pane, view, focused }: ViewProps<"why">) {
  const context = usePaneContext(pane);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [cursor, setCursor] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const seq = useRef(0);
  const ref = view.ref;
  const refKey = `${ref.gvr.group}/${ref.gvr.resource}/${ref.namespace ?? ""}/${ref.name}`;
  const lastKey = useRef(refKey);

  // one request per target (a follow retarget changes view.ref) and per refresh; a late answer
  // for an older target is dropped. A refresh keeps the old findings on screen until it answers.
  useEffect(() => {
    if (!context) return;
    const id = ++seq.current;
    if (lastKey.current !== refKey) {
      lastKey.current = refKey;
      setLoad({ state: "loading" });
    }
    backend.diagnose(toObjRef(ref, context)).then(
      (diag) => {
        if (id === seq.current) setLoad({ state: "ok", diag });
      },
      (e: unknown) => {
        if (id === seq.current) setLoad({ state: "error", message: message(e) });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, refKey, epoch]);
  useEffect(() => setCursor(0), [refKey]);

  const diag = load.state === "ok" ? load.diag : null;
  const rows = useMemo(() => whyRows(diag), [diag]);
  const cur = clampCursor(cursor, rows.length);

  const openRow = useCallback(
    (i: number, newPane: NewPane) => {
      const t = rowTarget(rows[i], diag);
      if (typeof t === "string") {
        flash(t, "warn");
        return;
      }
      // an object of another context opens beside, in that context (§8.3)
      openInContext(t.view, t.context, { pane, newPane });
    },
    [rows, diag, pane],
  );

  const state = useRef({ rows, cur, diag, openRow });
  state.current = { rows, cur, diag, openRow };

  useEffect(() => {
    const c: WhyController = {
      move: (d) => setCursor((i) => clampCursor(clampCursor(i, state.current.rows.length) + d, state.current.rows.length)),
      moveTo: (w) => setCursor(w === "top" ? 0 : Math.max(0, state.current.rows.length - 1)),
      open: (newPane) => state.current.openRow(state.current.cur, newPane),
      canOpen: () => {
        const t = rowTarget(state.current.rows[state.current.cur], state.current.diag);
        return typeof t === "string" ? t : true;
      },
      refresh: () => setEpoch((n) => n + 1),
      copy: () => {
        const d = state.current.diag;
        if (!d) return false;
        navigator.clipboard.writeText(findingsText(d)).then(
          () => toast({ kind: "ok", text: `Copied ${d.findings.length} finding${d.findings.length === 1 ? "" : "s"}` }),
          (e: unknown) => toasts.error(`Could not copy: ${message(e)}`),
        );
        return true;
      },
      loaded: () => state.current.diag !== null,
    };
    setWhyController(pane, c);
    return () => setWhyController(pane, null);
  }, [pane]);

  // the hint row and toolbar read `loaded` / `canOpen`
  useEffect(() => invalidateWhy(), [diag, cur]);

  // keep the cursor row in view
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${cur}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cur, rows]);

  const indexOf = (e: MouseEvent): number => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
    return el ? Number(el.dataset.index) : -1;
  };
  const onClick = (e: MouseEvent) => {
    const i = indexOf(e);
    if (i < 0) return;
    setCursor(i);
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    // the row's open button, Ctrl/⌘+click (beside) and a middle click run nav.open, as in tables
    if (act || e.ctrlKey || e.metaKey) {
      const newPane: NewPane = e.ctrlKey || e.metaKey ? (e.shiftKey ? "down" : "right") : null;
      runAction("nav.open", { pane, newPane, before: () => (state.current.cur = i) });
    }
  };
  const onDoubleClick = (e: MouseEvent) => {
    const i = indexOf(e);
    if (i >= 0 && !(e.target as HTMLElement).closest("[data-act]")) runAction("nav.open", { pane, before: () => (state.current.cur = i) });
  };
  const onAuxClick = (e: MouseEvent) => {
    const i = indexOf(e);
    if (e.button === 1 && i >= 0) {
      setCursor(i);
      runAction("nav.open", { pane, newPane: "right", before: () => (state.current.cur = i) });
    }
  };
  // right-click: the cursor moves to the row; the default menu (hint-row actions) opens for it
  const onContextMenu = (e: MouseEvent) => {
    const i = indexOf(e);
    if (i >= 0) {
      setCursor(i);
      state.current.cur = i;
      invalidateWhy();
    }
  };

  const title = (
    <div className="why-head t-ui">
      <span className="why-head-ref">{cleanUntrusted(refLabel(toObjRef(ref, context ?? "")))}</span>
      {diag && <span className="muted">checked {diag.checked.length} things · {new Date(diag.at).toLocaleTimeString()}</span>}
      {diag?.redactions && diag.redactions.count > 0 && <span className="muted">redacted {diag.redactions.count} value{diag.redactions.count === 1 ? "" : "s"}</span>}
    </div>
  );

  if (load.state === "loading") return <div className="why">{title}<EmptyState compact>checking {cleanUntrusted(ref.name)}</EmptyState></div>;
  if (load.state === "error") return <div className="why">{title}<EmptyState compact title="Could not diagnose">{cleanUntrusted(load.message)}</EmptyState></div>;

  return (
    <div className="why" data-active={focused || undefined}>
      <PaneSlot name="count">{countLabel(diag)}</PaneSlot>
      {title}
      {diag && diag.findings.length === 0 && (
        <div className="why-none t-body">
          <div className="why-none-title">No known cause found.</div>
          <div className="muted">Checked: {diag.checked.join(", ")}</div>
        </div>
      )}
      <div className="why-list" ref={listRef} role="listbox" aria-label="findings" onClick={onClick} onDoubleClick={onDoubleClick} onAuxClick={onAuxClick} onContextMenu={onContextMenu}>
        {rows.map((row, i) => (
          <Row key={row.key} row={row} index={i} focus={i === cur} canOpen={typeof rowTarget(row, diag) !== "string"} />
        ))}
      </div>
    </div>
  );
}

function OpenButton() {
  return (
    <button type="button" className="k-abtn why-open" tabIndex={-1} data-act="open" onMouseDown={keepFocus} aria-label="open" {...tip("open", { reason: "Enter · Ctrl+click opens beside" })}>
      <Icon name="open" />
    </button>
  );
}

function Row({ row, index, focus, canOpen }: { row: WhyRow; index: number; focus: boolean; canOpen: boolean }) {
  const common = { "data-index": index, "data-focus": focus || undefined, role: "option", "aria-selected": focus };
  if (row.type === "next") {
    return (
      <div className="why-row why-next row t-cell" {...common}>
        <Icon name="open" />
        <span className="why-text">{row.label}</span>
        <OpenButton />
      </div>
    );
  }
  if (row.type === "finding") {
    const f = row.data;
    return (
      <div className="why-row why-finding row" data-sev={f.severity} {...common}>
        <div className="why-line t-cell">
          <Glyph state={SEV_GLYPH[f.severity]} />
          <span className="why-title">{f.title}</span>
          {canOpen && <OpenButton />}
        </div>
        {f.detail && <div className="why-detail t-cell muted">{f.detail}</div>}
      </div>
    );
  }
  const e = row.data;
  return (
    <div className="why-row why-evidence row t-cell" data-type={e.type} {...common}>
      <span className="why-tag muted">{kindTag(e)}</span>
      <span className="why-text" dir="ltr">{evidenceText(e)}</span>
      {canOpen && <OpenButton />}
      {e.type === "diff" && (
        <div className="why-diff">
          {e.left.split("\n").filter(Boolean).map((l, k) => <div key={`l${k}`} className="why-del">- {l}</div>)}
          {e.right.split("\n").filter(Boolean).map((l, k) => <div key={`r${k}`} className="why-add">+ {l}</div>)}
        </div>
      )}
    </div>
  );
}
