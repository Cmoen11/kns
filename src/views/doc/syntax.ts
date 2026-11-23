// The syntax colours of the doc editor (docs/ux.md §13.1): the tag → --k-syn-* mapping and the
// scalar marks the YAML grammar cannot give. Colours are CSS variables only, so a theme or mode
// switch needs no reconfigure. Part of the lazy editor chunk (imported by cm.ts only).
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

// @lezer/yaml: keys are definition(propertyName), quoted scalars string, plain scalars and block
// scalar text content, `: , -` separator, `---` / `...` meta, the block scalar header (`|`, `>-`)
// special(string), anchors and aliases labelName, tags typeName, directives keyword. No italics.
const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--k-syn-key)" },
  { tag: [t.string, t.content, t.attributeValue], color: "var(--k-syn-string)" },
  { tag: t.number, color: "var(--k-syn-number)" },
  { tag: [t.bool, t.null, t.atom], color: "var(--k-syn-atom)" },
  { tag: [t.meta, t.keyword, t.special(t.string), t.labelName, t.typeName], color: "var(--k-syn-meta)" },
  { tag: [t.punctuation, t.separator, t.bracket, t.squareBracket, t.brace, t.operator], color: "var(--k-syn-punct)" },
  { tag: [t.comment, t.lineComment], color: "var(--k-syn-comment)", fontStyle: "normal" },
]);

const colours = EditorView.theme({
  // `*`: the mark may sit outside the highlighter's own span
  ".cm-k-num, .cm-k-num *": { color: "var(--k-syn-number)" },
  ".cm-k-atom, .cm-k-atom *": { color: "var(--k-syn-atom)" },
  // a search match is primary text on its background step, whatever token it covers
  ".cm-k-match *, .cm-k-match-current *": { color: "var(--k-text)" },
});

/** Shared by every editor: the highlight style and the colours of the marks. */
export const syntaxColours: Extension = [syntaxHighlighting(highlight), colours];

// The YAML grammar has one node (Literal) for every plain scalar. The ones the core schema reads
// as a number, boolean or null are marked from the syntax tree, so a key, a comment, a quoted
// "true" or a line of a block scalar is never coloured as one. Viewport only.
const NUMBER = /^(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|0x[\da-fA-F]+|0o[0-7]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
const ATOM = /^(?:true|True|TRUE|false|False|FALSE|null|Null|NULL|~)$/;
const numMark = Decoration.mark({ class: "cm-k-num" });
const atomMark = Decoration.mark({ class: "cm-k-atom" });
/** longest plain scalar worth testing: `-1.7976931348623157e+308` is 24 */
const MAX_SCALAR = 32;

function scalarMarks(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.name === "Key") return false;
        if (node.name !== "Literal" || node.to - node.from > MAX_SCALAR) return;
        const text = view.state.sliceDoc(node.from, node.to);
        if (NUMBER.test(text)) b.add(node.from, node.to, numMark);
        else if (ATOM.test(text)) b.add(node.from, node.to, atomMark);
      },
    });
  }
  return b.finish();
}

export const yamlScalars: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = scalarMarks(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) {
        this.decorations = scalarMarks(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
