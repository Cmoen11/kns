// The SQL editor of the database view: CodeMirror with the engine's SQL dialect and completion of
// the open database's tables. Mod+Enter is the app's `db.run` (the key engine takes it first).
import { history, historyKeymap, indentWithTab, standardKeymap, toggleComment } from "@codemirror/commands";
import { MySQL, PostgreSQL, sql, type SQLNamespace } from "@codemirror/lang-sql";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { DbEngine, DbSchemaEntry } from "../ipc/types";
import { lookAndFeel } from "../views/doc/cm";

export interface SqlEditorHandle {
  text(): string;
  /** the selected text, or the statement under the cursor (between blank lines / semicolons) */
  statement(): string;
  set(text: string): void;
  focus(): void;
}

/** The statement around `pos`: text between the previous and next `;`, trimmed. */
export function statementAt(doc: string, pos: number): string {
  const before = doc.lastIndexOf(";", pos - 1);
  const after = doc.indexOf(";", pos);
  const s = doc.slice(before + 1, after < 0 ? doc.length : after).trim();
  if (s) return s;
  // the cursor right after a `;`: the statement it ends
  const prev = doc.lastIndexOf(";", before - 1);
  return doc.slice(prev + 1, before < 0 ? 0 : before).trim();
}

function completion(engine: DbEngine, schemas: readonly DbSchemaEntry[]) {
  const ns: { [k: string]: SQLNamespace } = {};
  for (const s of schemas) {
    const tables: { [k: string]: SQLNamespace } = {};
    for (const t of s.tables) tables[t.name] = [];
    ns[s.name] = tables;
  }
  const defaultSchema = engine === "postgres" ? (schemas.some((s) => s.name === "public") ? "public" : undefined) : undefined;
  return sql({ dialect: engine === "postgres" ? PostgreSQL : MySQL, schema: ns, defaultSchema, upperCaseKeywords: true });
}

export function SqlEditor({ engine, schemas, initial, onChange, handle }: {
  engine: DbEngine;
  schemas: readonly DbSchemaEntry[];
  initial: string;
  onChange(text: string): void;
  handle: { current: SqlEditorHandle | null };
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const change = useRef(onChange);
  change.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          lineNumbers(),
          drawSelection(),
          highlightActiveLine(),
          history(),
          keymap.of([...standardKeymap, ...historyKeymap, indentWithTab, { key: "Mod-/", run: toggleComment }]),
          lookAndFeel,
          lang.current.of(completion(engine, schemas)),
          placeholder("SELECT … — Mod+Enter runs the statement under the cursor"),
          EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off", "aria-label": "SQL" }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) change.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    handle.current = {
      text: () => view.state.doc.toString(),
      statement: () => {
        const sel = view.state.selection.main;
        if (!sel.empty) return view.state.sliceDoc(sel.from, sel.to).trim();
        return statementAt(view.state.doc.toString(), sel.head);
      },
      set: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } }),
      focus: () => view.focus(),
    };
    return () => {
      view.destroy();
      viewRef.current = null;
      handle.current = null;
    };
    // created once; the language follows below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: lang.current.reconfigure(completion(engine, schemas)) });
  }, [engine, schemas]);

  return <div className="db-sql-editor" ref={host} />;
}
