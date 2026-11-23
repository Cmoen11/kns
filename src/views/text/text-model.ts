// Pure state of the `text` view (docs/plan-features.md §2.8, §3 G): dropped sections, what `c`
// copies, the size line. Tested in text-model.test.ts.
import type { RedactionReport } from "../../ipc/types";
import { sizeLine, sumReports } from "./measure";
import type { TextDoc } from "./sources";

export const canDrop = (doc: TextDoc, id: string): boolean => !!doc.droppable && !!doc.sections.find((s) => s.id === id)?.droppable;

/** Drops a droppable section, or puts it back; anything else returns `dropped` unchanged. */
export function toggleDrop(doc: TextDoc, dropped: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!canDrop(doc, id)) return dropped;
  const next = new Set(dropped);
  if (!next.delete(id)) next.add(id);
  return next;
}

export const keptIds = (doc: TextDoc, dropped: ReadonlySet<string>): string[] => doc.sections.filter((s) => !dropped.has(s.id)).map((s) => s.id);

/** The text `c` copies: the doc's own composition, else the kept bodies joined by a blank line. */
export function composeDoc(doc: TextDoc, dropped: ReadonlySet<string>): string {
  const kept = keptIds(doc, dropped);
  if (doc.compose) return doc.compose(kept);
  return doc.sections
    .filter((s) => !dropped.has(s.id))
    .map((s) => s.body)
    .join("\n\n");
}

export interface Measure {
  /** "14 KB · ~3.6k tokens · redacted 7 values (4 key, 2 url, 1 jwt)" */
  line: string;
  redactions: RedactionReport;
  kept: number;
  droppable: number;
}

/** The size line over what would be copied now. */
export function measureDoc(doc: TextDoc, dropped: ReadonlySet<string>): Measure {
  const text = composeDoc(doc, dropped);
  const redactions = sumReports(doc.sections.filter((s) => !dropped.has(s.id)).map((s) => s.redactions));
  const droppable = doc.sections.filter((s) => s.droppable).length;
  const kept = doc.sections.filter((s) => s.droppable && !dropped.has(s.id)).length;
  return { line: sizeLine(text, redactions), redactions, kept, droppable };
}

export const clampIndex = (i: number, n: number): number => (n <= 0 ? 0 : Math.max(0, Math.min(n - 1, i)));
