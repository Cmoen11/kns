// CodeMirror 6 pieces of the doc view: theme and highlight style built only from --k-* tokens
// (they are CSS variables, so a theme or mode switch needs no reconfigure), the search and error
// state, and the extension set per format and mode. Loaded lazily with DocView.
import {
  history, historyKeymap, indentWithTab, insertBlankLine, standardKeymap, toggleComment,
} from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import {
  bracketMatching, codeFolding, foldGutter, foldService, indentOnInput, indentUnit,
} from "@codemirror/language";
import { unifiedMergeView } from "@codemirror/merge";
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration, EditorView, GutterMarker, MatchDecorator, ViewPlugin, drawSelection, gutter, highlightActiveLine,
  highlightActiveLineGutter, keymap, lineNumbers, type DecorationSet, type ViewUpdate,
} from "@codemirror/view";
import { ownershipExtension } from "./ownership";
import type { Match } from "./search-match";
import { syntaxColours, yamlScalars } from "./syntax";

export type DocFormat = "yaml" | "describe" | "json" | "secret";

// ── theme (docs/ux.md §9.2, §13.1) ─────────────────────────────────────────

const theme = EditorView.theme({
  "&": { color: "var(--k-text-2)", backgroundColor: "var(--k-bg-pane)", height: "100%" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--k-font-mono)", fontSize: "var(--k-type-mono)", lineHeight: "var(--k-h-line)", fontWeight: "400",
    fontVariantLigatures: "none", overflow: "auto",
  },
  ".cm-content": { padding: "0", caretColor: "var(--k-text)" },
  ".cm-line": { padding: "0 var(--k-luft-15)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--k-text)", borderLeftWidth: "var(--k-ring)" },
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--k-match-current)",
  },
  ".cm-content ::selection": { backgroundColor: "var(--k-match-current)", color: "var(--k-text)" },
  ".cm-gutters": { backgroundColor: "var(--k-bg-pane)", color: "var(--k-text-muted)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 var(--k-luft-15)", minWidth: "var(--k-luft-6)" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0", width: "var(--k-luft-2)", textAlign: "center", cursor: "default" },
  ".cm-activeLine": { backgroundColor: "var(--k-row-focus-idle)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--k-text)" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--k-bg-chip)", border: "none", color: "var(--k-text-2)", borderRadius: "var(--k-radius)",
    padding: "0 var(--k-luft-1)", margin: "0 var(--k-luft-05)",
  },
  "&.cm-focused .cm-matchingBracket, .cm-matchingBracket": { backgroundColor: "var(--k-match)", color: "var(--k-text)" },
  "&.cm-focused .cm-nonmatchingBracket, .cm-nonmatchingBracket": { backgroundColor: "transparent", textDecoration: "underline" },
  ".cm-selectionMatch": { backgroundColor: "var(--k-match)" },
  ".cm-k-match": { backgroundColor: "var(--k-match)", textDecoration: "underline", color: "var(--k-text)" },
  ".cm-k-match-current": { backgroundColor: "var(--k-match-current)", textDecoration: "underline", color: "var(--k-text)" },
  ".cm-k-match-line": { boxShadow: "inset var(--k-ring) 0 0 var(--k-accent)" },
  ".cm-k-errline": { textDecoration: "underline", textDecorationColor: "var(--k-text)", textDecorationThickness: "var(--k-hair)" },
  ".cm-k-errgutter": { width: "var(--k-luft-2)" },
  ".cm-k-errgutter .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center" },
  ".cm-k-key": { color: "var(--k-syn-key)" },
  ".cm-k-punct": { color: "var(--k-syn-punct)" },
});

function matcher(re: RegExp, cls: string): Extension {
  const deco = new MatchDecorator({ regexp: re, decoration: Decoration.mark({ class: cls }) });
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = deco.createDeco(view);
      }
      update(u: ViewUpdate) {
        this.decorations = deco.updateDeco(u, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// Describe has no grammar: `Key:` at the start of a line is a key, a table header is punctuation.
const describeKeys = matcher(/^\s*[A-Za-z][\w ./()-]*?:(?=\s|$)/gm, "cm-k-key");
const describeHeads = matcher(/^\s*[A-Z]{2,}(?:\s{2,}[A-Z]{2,})+\s*$/gm, "cm-k-punct");

/** Indentation folding for formats without a grammar, and a fallback inside YAML and JSON. */
const indentFold = foldService.of((state, from) => {
  const line = state.doc.lineAt(from);
  const indent = /^\s*/.exec(line.text)![0].length;
  if (line.text.trim() === "") return null;
  let end = -1;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const l = state.doc.line(n);
    if (l.text.trim() === "") continue;
    if (/^\s*/.exec(l.text)![0].length <= indent) break;
    end = l.to;
  }
  return end > line.to ? { from: line.to, to: end } : null;
});

// ── search (the header bar drives it) ──────────────────────────────────────

export interface SearchValue {
  matches: readonly Match[];
  current: number;
}
export const setSearch = StateEffect.define<SearchValue>();

const matchMark = Decoration.mark({ class: "cm-k-match" });
const currentMark = Decoration.mark({ class: "cm-k-match-current" });
const currentLine = Decoration.line({ class: "cm-k-match-line" });

function searchDeco(state: EditorState, v: SearchValue): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const cur = v.matches[v.current];
  const curLine = cur ? state.doc.lineAt(Math.min(cur.from, state.doc.length)).from : -1;
  let lineDone = false;
  for (let i = 0; i < v.matches.length; i++) {
    const m = v.matches[i];
    if (m.to > state.doc.length) break;
    if (!lineDone && curLine >= 0 && m.from >= curLine) {
      b.add(curLine, curLine, currentLine);
      lineDone = true;
    }
    b.add(m.from, m.to, i === v.current ? currentMark : matchMark);
  }
  return b.finish();
}

const searchField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setSearch)) return searchDeco(tr.state, e.value);
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ── inline API errors (§13.2 step 5) ───────────────────────────────────────

/** 1-based line numbers; [] clears */
export const setErrorLines = StateEffect.define<readonly number[]>();

const errLine = Decoration.line({ class: "cm-k-errline" });

class ErrorMarker extends GutterMarker {
  toDOM(): Node {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "glyph");
    svg.setAttribute("data-state", "error");
    svg.setAttribute("width", "8");
    svg.setAttribute("height", "8");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(ns, "use");
    use.setAttribute("href", "#k-g-error");
    svg.appendChild(use);
    return svg;
  }
}
const errorMarker = new ErrorMarker();

const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (!e.is(setErrorLines)) continue;
      const b = new RangeSetBuilder<Decoration>();
      for (const n of [...new Set(e.value)].sort((x, y) => x - y)) {
        if (n >= 1 && n <= tr.state.doc.lines) {
          const from = tr.state.doc.line(n).from;
          b.add(from, from, errLine);
        }
      }
      return b.finish();
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const errorGutter = gutter({
  class: "cm-k-errgutter",
  lineMarker(view, line) {
    let hit = false;
    view.state.field(errorField).between(line.from, line.from, () => {
      hit = true;
      return false;
    });
    return hit ? errorMarker : null;
  },
  lineMarkerChange: (u) => u.startState.field(errorField) !== u.state.field(errorField),
});

// ── extension set ──────────────────────────────────────────────────────────

/** Toggles that change without rebuilding the state. */
export const wrapConf = new Compartment();
export const diffConf = new Compartment();
/** Vim keys (vim.ts, loaded only while the setting is on); [] = off. */
export const vimConf = new Compartment();

export const wrapExt = (on: boolean): Extension => (on ? EditorView.lineWrapping : []);

/** The diff gutter against the server version (§13.2 step 2). */
export const diffExt = (original: string | null): Extension =>
  original === null ? [] : unifiedMergeView({ original, mergeControls: false, highlightChanges: false, gutter: true });

// §5.3: a curated keymap. Only text-editing keys; every app chord is a registry action.
const editKeys = keymap.of([
  ...standardKeymap,
  ...historyKeymap,
  indentWithTab,
  { key: "Mod-/", run: toggleComment },
  { key: "Mod-Enter", run: insertBlankLine },
]);

function language(format: DocFormat): Extension {
  if (format === "describe") return [describeKeys, describeHeads];
  return [yaml(), yamlScalars];
}

export interface EditorConfig {
  format: DocFormat;
  editable: boolean;
  wrap: boolean;
  /** vimExtension() of vim.ts, or [] */
  vim: Extension;
  onUpdate(u: ViewUpdate): void;
}

/** Shared by the main editor and the review panes. */
export const lookAndFeel: Extension = [theme, syntaxColours, EditorState.tabSize.of(2), indentUnit.of("  ")];

export function editorExtensions(cfg: EditorConfig): Extension {
  return [
    // first: vim's key handler must run before every other keymap
    vimConf.of(cfg.vim),
    errorGutter,
    lineNumbers(),
    // field-owner letters in the YAML view (D, src/views/doc/ownership.ts); inert unless toggled
    ownershipExtension(),
    foldGutter({ openText: "⌄", closedText: "›" }),
    codeFolding({ placeholderText: "…" }),
    indentFold,
    drawSelection(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    bracketMatching(),
    EditorState.allowMultipleSelections.of(true),
    lookAndFeel,
    language(cfg.format),
    searchField,
    errorField,
    wrapConf.of(wrapExt(cfg.wrap)),
    diffConf.of([]),
    // view and review are not EDIT: without a contenteditable the app's single keys stay active
    EditorView.editable.of(cfg.editable),
    EditorState.readOnly.of(!cfg.editable),
    cfg.editable ? [history(), indentOnInput(), editKeys] : [],
    EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off", "aria-label": "Document" }),
    EditorView.updateListener.of(cfg.onUpdate),
  ];
}

/** Read-only extensions for the two sides of the review diff. */
export function reviewExtensions(format: DocFormat, wrap: boolean): Extension {
  return [
    lineNumbers(),
    lookAndFeel,
    language(format),
    wrapExt(wrap),
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
  ];
}
