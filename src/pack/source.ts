// The `pack` text source (docs/plan-features.md §3 G): asks Rust for a redacted pack of the view's
// refs in the current context and hands the text view droppable sections, the size line and save.
import { backend, focusedContext, toObjRef } from "../foundation";
import type { TextDoc } from "../views/text";
import type { TextSource } from "../types";
import { composePack, PACK_LOG_TAIL, packSections } from "./model";

export async function loadPack(src: Extract<TextSource, { by: "pack" }>): Promise<TextDoc> {
  const context = focusedContext();
  if (!context) throw new Error("not connected to a cluster");
  const pack = await backend.contextPack({ refs: src.refs.map((r) => toObjRef(r, context)), logs: { tail: PACK_LOG_TAIL, previous: true }, sections: [] });
  return {
    title: "pack",
    droppable: true,
    measure: true,
    // the preview shows exactly the text that is copied: plain, not rendered
    sections: packSections(pack).map((s) => ({ ...s, format: "plain" as const })),
    compose: (kept) => {
      const keep = new Set(kept);
      return composePack(pack.header, pack.sections, new Set(pack.sections.map((s) => s.id).filter((id) => !keep.has(id))));
    },
    save: (dropped) => backend.packSave(pack.id, [...dropped]),
  };
}
