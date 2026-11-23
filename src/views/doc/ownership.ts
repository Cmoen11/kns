// Field-owner gutter for the YAML view (docs/plan-features.md §3 D; owner D): a letter per field
// (F Flux, K kns, k kubectl, C controller, o other), hover = manager, operation and age. `:drift`
// folds away everything except the fields a human changed under Flux.
//
// One entry in `editorExtensions` (cm.ts). It is self-contained because the controller rebuilds
// the editor state on every load (`setState`), which would drop anything dispatched into it: the
// plugin finds its pane from the DOM, reads the toggles from src/diff/owners-state.ts (outside
// CodeMirror) whenever it is created and when they change, and turns its own gutter on and off
// through a compartment. Lazy, with the doc chunk.
import { Compartment, RangeSet, StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { backend, flash, paneContext, paneView, toObjRef } from "../../foundation";
import type { FieldOwner } from "../../ipc/types";
import { tip } from "../../ui";
import { getOwners, ownersStore, patchOwners } from "../../diff/owners-state";
import { driftHidden, driftPaths, isFluxManaged, ownersByLine, ownersTip, pointerLines } from "../../diff/owners-model";

class OwnerMarker extends GutterMarker {
  constructor(readonly letter: string, readonly cls: string, readonly text: string) {
    super();
  }
  eq(other: OwnerMarker): boolean {
    return other.letter === this.letter && other.cls === this.cls && other.text === this.text;
  }
  toDOM(): Node {
    const el = document.createElement("span");
    el.className = "cm-k-owner";
    el.dataset.class = this.cls;
    // manager names are cluster text: a text node, and a plain tooltip (never capitalized or cut)
    el.textContent = this.letter;
    for (const [k, v] of Object.entries(tip(this.text, { plain: true }))) if (v !== undefined) el.setAttribute(k, String(v));
    el.setAttribute("aria-label", this.text);
    return el;
  }
}

class Folded extends WidgetType {
  constructor(readonly lines: number) {
    super();
  }
  eq(other: Folded): boolean {
    return other.lines === this.lines;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-k-driftfold";
    el.textContent = `${this.lines} ${this.lines === 1 ? "line" : "lines"} Flux owns or nobody changed`;
    return el;
  }
}

interface Data {
  markers: RangeSet<GutterMarker>;
  hidden: DecorationSet;
}
const EMPTY: Data = { markers: RangeSet.empty, hidden: Decoration.none };

const setData = StateEffect.define<Data>();
const field = StateField.define<Data>({
  create: () => EMPTY,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setData)) return e.value;
    // stale until the plugin recomputes after the change; keep it in place meanwhile
    return tr.docChanged ? { markers: v.markers.map(tr.changes), hidden: v.hidden.map(tr.changes) } : v;
  },
  provide: (f) => EditorView.decorations.from(f, (d) => d.hidden),
});

const spacer = new OwnerMarker("K", "spacer", "");
const theme = EditorView.baseTheme({
  ".cm-k-owners .cm-gutterElement": { padding: "0 var(--k-luft-05)", minWidth: "var(--k-luft-2)", textAlign: "center", color: "var(--k-text-muted)", cursor: "default" },
  ".cm-k-owner[data-class=kubectl], .cm-k-owner[data-class=kns], .cm-k-owner[data-class=other]": { color: "var(--k-text)", fontWeight: "600" },
  ".cm-k-owner[data-class=spacer]": { visibility: "hidden" },
  ".cm-k-driftfold": { color: "var(--k-text-3)", backgroundColor: "var(--k-bg-header)", padding: "0 var(--k-luft-15)" },
});
const on = [gutter({ class: "cm-k-owners", markers: (v) => v.state.field(field).markers, initialSpacer: () => spacer }), theme];

const comp = new Compartment();

function build(state: EditorState, owners: readonly FieldOwner[], drift: boolean): { data: Data; driftCount: number } {
  const lines = pointerLines(state.doc.toString());
  const now = Date.now();
  const marks: Range<GutterMarker>[] = [];
  for (const e of ownersByLine(owners, lines)) {
    if (e.line > state.doc.lines) continue;
    marks.push(new OwnerMarker(e.letter, e.managerClass, ownersTip(e, now)).range(state.doc.line(e.line).from));
  }
  const paths = driftPaths(owners);
  const folds: Range<Decoration>[] = [];
  if (drift) {
    for (const r of driftHidden(paths, lines, state.doc.lines)) {
      const from = state.doc.line(r.start).from;
      const to = state.doc.line(r.end).to;
      folds.push(Decoration.replace({ block: true, widget: new Folded(r.end - r.start + 1) }).range(from, to));
    }
  }
  return {
    data: { markers: RangeSet.of(marks, true), hidden: Decoration.set(folds, true) },
    driftCount: paths.filter((p) => lines.has(p)).length,
  };
}

const plugin = ViewPlugin.fromClass(
  class {
    private pane: string | null = null;
    private owners: FieldOwner[] | null = null;
    private ownersKey = "";
    private shown = false;
    /** what was last drawn (skip work when another pane's toggle changed) and last told */
    private sig = "";
    private told = "";
    private timer: ReturnType<typeof setTimeout> | null = null;
    private token = 0;
    private readonly unsub: () => void;

    constructor(private readonly view: EditorView) {
      this.unsub = ownersStore.subscribe(() => this.schedule(false));
      this.schedule(false);
    }

    update(u: ViewUpdate): void {
      // the object changed (refresh): fetch the owners again, then re-map the lines
      if (u.docChanged) this.schedule(true);
    }

    destroy(): void {
      this.unsub();
      if (this.timer) clearTimeout(this.timer);
      this.token++;
    }

    /** Never dispatch inside an update: run after it. A doc change waits a little (typing, polls). */
    private schedule(refetch: boolean): void {
      if (refetch) {
        this.ownersKey = "";
        this.sig = "";
      }
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.sync();
      }, refetch ? 250 : 0);
    }

    private async sync(): Promise<void> {
      const view = this.view;
      this.pane ??= view.dom.closest<HTMLElement>("[data-pane]")?.dataset.pane ?? null;
      const pane = this.pane;
      if (!pane) return;
      const ui = getOwners(pane);
      const v = paneView(pane);
      const active = ui.on && v?.kind === "doc" && v.mode === "view" && v.format === "yaml";
      if (!active) {
        if (this.shown) {
          this.shown = false;
          this.sig = "";
          view.dispatch({ effects: [comp.reconfigure([]), setData.of(EMPTY)] });
        }
        return;
      }
      const key = `${v.ref.gvr.group}/${v.ref.gvr.resource}/${v.ref.namespace ?? ""}/${v.ref.name}`;
      if (this.ownersKey !== key || !this.owners) {
        const token = ++this.token;
        try {
          const owners = await backend.fieldOwners(toObjRef(v.ref, paneContext(pane)));
          if (token !== this.token) return;
          this.owners = owners;
          this.ownersKey = key;
        } catch (e) {
          if (token !== this.token) return;
          const msg = typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
          patchOwners(pane, { error: msg });
          flash(`field owners: ${msg}`, "warn");
          return;
        }
      }
      const owners = this.owners;
      const sig = `${key}|${ui.drift}|${view.state.doc.length}`;
      if (this.shown && sig === this.sig) return;
      this.sig = sig;
      const flux = isFluxManaged(owners);
      const drift = ui.drift && flux;
      const { data, driftCount } = build(view.state, owners, drift);
      const effects: StateEffect<unknown>[] = [setData.of(data)];
      if (!this.shown) effects.unshift(comp.reconfigure(on));
      this.shown = true;
      view.dispatch({ effects });
      // say it once per object and toggle, not on every redraw
      const tell = `${key}|${ui.drift}`;
      if (tell !== this.told) {
        this.told = tell;
        if (ui.drift && !flux) flash("not managed by Flux: no Flux-owned fields to compare against", "warn");
        else if (owners.length === 0) flash("no managedFields on this object", "warn");
        else if (drift && driftCount === 0) flash("no drift: Flux owns every field a human could have changed");
      }
      patchOwners(pane, { fluxManaged: flux, driftCount, error: null, ...(ui.drift && !flux ? { drift: false } : {}) });
    }
  },
);

/** The extension for every doc editor; inert unless the pane's owner letters are on in a YAML view. */
export function ownershipExtension(): Extension {
  return [field, comp.of([]), plugin];
}
