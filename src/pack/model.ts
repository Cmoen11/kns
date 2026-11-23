// Pure pack logic (docs/plan-features.md §3 G): composing a pack with sections dropped (the same
// rule as Rust `pack::compose`) and how a pack becomes text-view sections. The size line and the
// redaction legend are the text view's (src/views/text/measure.ts). Tested in model.test.ts.
import type { Pack, PackSectionInfo, RedactionReport } from "../ipc/types";
import type { ObjectRef } from "../types";

/** Objects per pack (Rust `pack::MAX_REFS`). */
export const MAX_PACK_REFS = 10;
/** Log lines per container in the human's pack. */
export const PACK_LOG_TAIL = 100;

/** `header` + ("\n" + body) per section not dropped, in order. */
export function composePack(header: string, sections: readonly Pick<PackSectionInfo, "id" | "body">[], dropped: ReadonlySet<string>): string {
  let out = header;
  for (const s of sections) if (!dropped.has(s.id)) out += `\n${s.body}`;
  return out;
}

export function packTitle(refs: readonly ObjectRef[]): string {
  const first = refs[0];
  if (!first) return "pack";
  const one = `${first.gvr.resource.replace(/s$/, "")}/${first.name}`;
  return refs.length === 1 ? `pack · ${one}` : `pack · ${one} +${refs.length - 1}`;
}

/** Sections of a pack as the text view shows them: the header first, never droppable. */
export function packSections(p: Pack): { id: string; title: string; body: string; droppable: boolean; redactions?: RedactionReport }[] {
  return [{ id: "header", title: "", body: p.header, droppable: false }, ...p.sections.map((s) => ({ id: s.id, title: s.title, body: s.body, droppable: true, redactions: s.redactions }))];
}
