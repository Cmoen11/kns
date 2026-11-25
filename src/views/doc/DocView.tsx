// The doc view (docs/ux.md §13.1, §13.2): one CodeMirror editor for describe, YAML, JSON and
// secrets in view, edit and review. This module is the lazy chunk; everything CodeMirror lives
// behind it. React renders only the chrome around the editor; the document never enters React.
import { useEffect, useMemo, useRef } from "react";
import { LAYERS } from "../../actions";
import { PaneSlot, useScopeLayer, useWorkspace, type ViewProps } from "../../foundation";
import type { DocView as DocViewState, PaneId } from "../../types";
import { ActionButton, ActionHint, BarInput, Button, EmptyState, FilterChip, Glyph, Toolbar, runAction, type ToolbarItem } from "../../ui";
import { useOwners } from "../../diff/owners-state";
import { Controller } from "./controller";
import { Review } from "./Review";
import { controllers, useDocUi } from "./session";
import "./doc.css";

function SearchBar({ pane }: { pane: PaneId }) {
  useScopeLayer(LAYERS.searchInput);
  const query = useDocUi(pane, (s) => s.query);
  const mode = useDocUi(pane, (s) => s.searchMode);
  const error = useDocUi(pane, (s) => s.searchError);
  return (
    <BarInput
      label="Search"
      autoFocus
      value={query}
      chip={<FilterChip mode={mode === "re" ? "RE" : "TEXT"} />}
      error={error ?? undefined}
      onChange={(e) => controllers.get(pane)?.setQuery(e.currentTarget.value)}
      onBlur={() => controllers.get(pane)?.applySearch()}
    />
  );
}

/** §13.2 step 7. Its keys are editor.discardConfirm / editor.stay in the dialog.discard scope. */
function DiscardDialog({ pane, secret }: { pane: PaneId; secret: boolean }) {
  useScopeLayer(LAYERS.dialogDiscard);
  const stay = useRef<HTMLButtonElement>(null);
  // focus leaves the editor, or typed keys would still reach the buffer behind the dialog
  useEffect(() => stay.current?.focus(), []);
  return (
    <div className="k-scrim doc-scrim">
      <div className="k-dialog k-overlay" role="alertdialog" aria-modal="true" aria-label="Discard changes">
        <h2 className="k-dialog-title t-dialog-title">Discard changes?</h2>
        <div className="k-dialog-body t-body">
          {secret ? "The edited secret values are not saved anywhere." : "The edit and its draft are dropped."}
        </div>
        <div className="k-dialog-footer">
          <Button variant="tertiary" action="editor.discardConfirm" onClick={() => runAction("editor.discardConfirm", { pane })}>
            Discard
          </Button>
          <Button ref={stay} variant="primary" action="editor.stay" onClick={() => runAction("editor.stay", { pane })}>
            Keep editing
          </Button>
        </div>
      </div>
    </div>
  );
}

function ReviewLines({ pane }: { pane: PaneId }) {
  const dryRun = useDocUi(pane, (s) => s.review?.dryRun);
  const message = useDocUi(pane, (s) => s.review?.message ?? null);
  const warnings = useDocUi(pane, (s) => s.review?.warnings);
  const conflict = useDocUi(pane, (s) => s.review?.conflict ?? null);
  const flux = useDocUi(pane, (s) => s.review?.flux ?? null);
  const argo = useDocUi(pane, (s) => s.review?.argo ?? null);
  const applying = useDocUi(pane, (s) => s.review?.applying ?? false);
  return (
    <div className="doc-lines t-ui" role="status">
      {applying ? (
        <div className="doc-line">applying</div>
      ) : dryRun === "running" ? (
        <div className="doc-line">dry run running</div>
      ) : dryRun === "ok" ? (
        <div className="doc-line">
          <Glyph state="ok" />
          <span>dry run ok</span>
        </div>
      ) : (
        <div className="doc-line" data-state="error">
          <Glyph state="error" />
          <span className="doc-line-text">{message ?? "dry run failed"}</span>
        </div>
      )}
      {/* the conflict banner: what happened, then the one way on (its key and a button) */}
      {conflict === "version" && (
        <div className="doc-line doc-conflict" data-state="warn">
          <Glyph state="warn" />
          <span className="t-label">Conflict</span>
          <span className="doc-line-text">The object changed on the server while you edited. Nothing was applied.</span>
          <span className="doc-line-hint"><ActionHint action="review.rebase" label="rebase onto the new version" /></span>
        </div>
      )}
      {conflict === "fieldManager" && (
        <div className="doc-line doc-conflict" data-state="warn">
          <Glyph state="warn" />
          <span className="t-label">Conflict</span>
          <span className="doc-line-text">Another field manager owns fields this edit changes.</span>
          <span className="doc-line-hint"><ActionHint action="review.apply" label="take them over (asks first)" /></span>
        </div>
      )}
      {warnings?.map((w, i) => (
        <div className="doc-line" data-state="warn" key={i}>
          <Glyph state="warn" />
          <span className="doc-line-text">{w}</span>
        </div>
      ))}
      {flux && (
        <div className="doc-line" data-state="warn">
          <Glyph state="warn" />
          <span className="doc-line-text">
            Managed by Flux ({flux.resource === "kustomizations" ? "Kustomization" : "HelmRelease"} {flux.namespace}/{flux.name}): this change will be reverted
          </span>
          <span className="doc-line-hint"><ActionHint action="review.suspendFlux" label="suspend it first" /></span>
        </div>
      )}
      {argo && (
        <div className="doc-line" data-state="warn">
          <Glyph state="warn" />
          <span className="doc-line-text">
            Managed by Argo CD ({argo}): the app shows OutOfSync, and its next sync (at once with self-heal) reverts this change. Change it in Git to keep it.
          </span>
        </div>
      )}
      {/* the two ways out of REVIEW, always on screen (the header toolbar is revealed on hover) */}
      <div className="doc-line doc-review-acts">
        <ActionButton action="review.apply" className="doc-act" icon="check" label="Apply" showLabel showKeys keep />
        <ActionButton action="review.back" className="doc-act" icon="back" label="Back to edit" showLabel showKeys keep />
      </div>
    </div>
  );
}

const FORMAT_SEGMENTS = [["describe", "Describe"], ["yaml", "YAML"], ["json", "JSON"]] as const;

/**
 * The pane-header toolbar (docs/frontend.md §17): every button is an action of the mode the pane
 * is in, so a click does what the key (and vim's :w / :q / :e) does. Pressed states are the
 * pane's own state.
 */
function DocToolbar({ pane, view }: { pane: PaneId; view: DocViewState }) {
  const hasQuery = useDocUi(pane, (s) => s.query !== "");
  const folded = useDocUi(pane, (s) => s.folded);
  const revealed = useDocUi(pane, (s) => s.revealed > 0);
  const diffGutter = useDocUi(pane, (s) => s.diffGutter);
  const reviewRevealed = useDocUi(pane, (s) => s.review?.revealed ?? false);
  const discardAsk = useDocUi(pane, (s) => s.discardAsk);
  const owners = useOwners(pane, (s) => s.on);
  const drift = useOwners(pane, (s) => s.drift);
  // 0 = no source pane, 1 = linked, 2 = following
  const link = useWorkspace((ws) => {
    const l = ws?.panes[pane]?.link;
    return ws && l && l.source !== null && ws.panes[l.source] ? (l.follow ? 2 : 1) : 0;
  });
  const { mode, format, wrap, managedFields } = view;

  const items = useMemo<ToolbarItem[]>(() => {
    if (discardAsk) return []; // the dialog is modal
    // Order = what a narrow pane keeps (the rest is in "more"): the way forward and the way out
    // first, then what is used most, the toggles after that. A toolbar's left end never moves:
    // optional buttons sit at the end of their group, labels do not change with the state.
    if (mode === "review") {
      return [
        { action: "review.apply", icon: "check", label: "Apply", showLabel: true },
        { action: "review.back", icon: "back", label: "Back", showLabel: true },
        "|",
        { action: "review.toggleSplit", icon: "columns" },
        { action: "editor.wrap", icon: "wrap", active: wrap },
        { action: "review.revealSecret", icon: "eye", active: reviewRevealed },
        "|",
        // only while there is a conflict / a Flux owner (their scopes): last, so nothing shifts
        "review.rebase",
        "review.suspendFlux",
      ];
    }
    if (mode === "edit") {
      return [
        { action: "editor.review", icon: "check", label: "Review", showLabel: true },
        // one label clean or dirty (the button must not change width while typing): dirty, it asks
        { action: "editor.leave", icon: "close", label: "Cancel", showLabel: true },
        "|",
        { action: "editor.find", icon: "search" },
        { action: "editor.copy", icon: "copy" },
        { action: "editor.diffGutter", icon: "diff", active: diffGutter },
        { action: "editor.wrap", icon: "wrap", active: wrap },
        { action: "editor.foldAll", icon: "fold", active: folded },
        ...(hasQuery ? (["|", { action: "editor.findNext", icon: "caret" }] as const) : []),
      ];
    }
    return [
      "res.edit",
      "|",
      { action: "filter.open", icon: "search", label: "search", active: hasQuery },
      "doc.copy",
      { action: "doc.wrap", active: wrap },
      { action: "doc.foldAll", icon: "fold", active: folded },
      // kept (disabled) outside YAML, so what follows never moves
      { action: "doc.managedFields", icon: "logs", active: managedFields, keep: true },
      // field owners (D): kept (disabled) outside YAML like managed fields
      { action: "doc.fieldOwners", icon: null, label: "Owners", active: owners, keep: true },
      { action: "doc.driftOnly", icon: null, label: "Drift", active: drift, keep: true },
      "|",
      // a secret has one view (its segments would be three dead buttons): reveal instead
      ...(format === "secret"
        ? [{ action: "secret.revealToggle", active: revealed } as const]
        : FORMAT_SEGMENTS.map(([f, label], i) => ({ action: "doc.format", icon: null, label, args: [f], active: format === f, join: i > 0 }) as const)),
      "|",
      "view.refresh",
      "hub.help",
      ...(link ? [{ action: "pane.followToggle", icon: "link", active: link === 2 } as const] : []),
      // stepping through the matches: only with a search, at the end
      ...(hasQuery ? (["|", { action: "search.previous", icon: "up" }, { action: "search.next", icon: "caret" }] as const) : []),
    ];
  }, [mode, format, wrap, managedFields, hasQuery, folded, revealed, diffGutter, reviewRevealed, discardAsk, link, owners, drift]);

  return (
    <PaneSlot name="toolbar">
      <Toolbar className={mode === "view" ? "doc-tb" : "doc-tb doc-tb-work"} label="Document" items={items} />
    </PaneSlot>
  );
}

export default function DocView({ pane, view, focused, visible }: ViewProps<"doc">) {
  const host = useRef<HTMLDivElement>(null);
  const ctl = useRef<Controller | null>(null);
  const latest = useRef({ view, focused, visible });
  latest.current = { view, focused, visible };

  useEffect(() => {
    const now = latest.current;
    const c = new Controller(pane, host.current!, now.view, now.focused, now.visible);
    ctl.current = c;
    return () => {
      ctl.current = null;
      c.destroy();
    };
  }, [pane]);
  useEffect(() => ctl.current?.sync(view, focused, visible), [view, focused, visible]);

  const loading = useDocUi(pane, (s) => s.loading);
  const loadError = useDocUi(pane, (s) => s.loadError);
  const dirty = useDocUi(pane, (s) => s.dirty);
  const searchInput = useDocUi(pane, (s) => s.searchInput);
  const query = useDocUi(pane, (s) => s.query);
  const searchMode = useDocUi(pane, (s) => s.searchMode);
  const matches = useDocUi(pane, (s) => s.matches);
  const current = useDocUi(pane, (s) => s.current);
  const apiError = useDocUi(pane, (s) => s.apiError);
  const revealed = useDocUi(pane, (s) => s.revealed);
  const diffGutter = useDocUi(pane, (s) => s.diffGutter);
  const discardAsk = useDocUi(pane, (s) => s.discardAsk);
  const review = useDocUi(pane, (s) => s.review);
  const vim = useDocUi(pane, (s) => s.vim);
  const vimKeys = useDocUi(pane, (s) => s.vimKeys);
  const owners = useOwners(pane, (s) => (s.on ? (s.drift ? `Drift ${s.driftCount}` : "Owners") : null));
  const inReview = view.mode === "review" && review !== null;

  return (
    <div className="doc" data-focused={focused || undefined} data-mode={view.mode}>
      <PaneSlot name="chips">
        {searchInput ? (
          <SearchBar pane={pane} />
        ) : query ? (
          <FilterChip mode={searchMode === "re" ? "RE" : "TEXT"} value={query} onRemove={() => ctl.current?.closeSearch()} />
        ) : null}
      </PaneSlot>
      <DocToolbar pane={pane} view={view} />
      <PaneSlot name="labels">
        {dirty && <span>Edited</span>}
        {inReview && review.conflict && <span>Conflict</span>}
        {diffGutter && <span>Diff</span>}
        {view.wrap && <span>Wrap</span>}
        {view.mode === "view" && view.format === "yaml" && view.managedFields && <span>Managed</span>}
        {view.mode === "view" && view.format === "yaml" && owners && <span>{owners}</span>}
        {revealed > 0 && <span>Revealed {revealed}</span>}
        {vim && !inReview && <span>{vimKeys ? `Vim ${vimKeys}` : "Vim"}</span>}
      </PaneSlot>
      <PaneSlot name="count">{query && !inReview ? `${matches === 0 ? 0 : current + 1}/${matches}` : null}</PaneSlot>

      {inReview && <ReviewLines pane={pane} />}
      {apiError && !inReview && (
        <div className="doc-lines t-ui" role="alert">
          <div className="doc-line" data-state="error">
            <Glyph state="error" />
            <span className="doc-line-text">{apiError}</span>
          </div>
        </div>
      )}
      <div className="doc-editor" ref={host} hidden={inReview || loadError !== null} />
      {inReview && <Review before={review.before} after={review.after} format={view.format} wrap={view.wrap} split={review.split} />}
      {loadError !== null && <EmptyState compact>{loadError}</EmptyState>}
      {loading && loadError === null && <div className="doc-loading t-ui">loading</div>}
      {discardAsk && <DiscardDialog pane={pane} secret={view.format === "secret"} />}
    </div>
  );
}
