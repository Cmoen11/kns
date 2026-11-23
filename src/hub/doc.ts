// The `doc` text source (docs/plan-features.md §2.8): docs/tools.md, bundled with `?raw` in its own
// lazy chunk, shown one tool's section at a time ("Learn more") or whole (anchor "").
import { registerTextSource, type TextDoc } from "../views/text";
import { docSection, docSections } from "./model";

const load = async (): Promise<string> => (await import("../../docs/tools.md?raw")).default;

export async function loadDoc(anchor: string): Promise<TextDoc> {
  const md = await load();
  if (!anchor) return { title: "Tools", sections: docSections(md).map((s) => ({ ...s, format: "markdown" as const })) };
  const s = docSection(md, anchor);
  if (!s) throw new Error(`docs/tools.md has no section "${anchor}"`);
  return { title: s.title, sections: [{ id: s.id, title: s.title, body: s.body, format: "markdown" }] };
}

export function registerDocSource(): void {
  registerTextSource("doc", (src) => loadDoc(src.anchor));
}
