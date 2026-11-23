// Text sources for the generic `text` view (docs/plan-features.md §2.8). Owners register theirs:
// `doc` (I, bundled docs/tools.md), `bundle` (C2), `snippet` (F), `pack` (G).
import type { RedactionReport } from "../../ipc/types";
import type { TextSource } from "../../types";

export interface TextSection {
  id: string;
  title: string;
  /** untrusted when it comes from a cluster or an agent; rendered as text */
  body: string;
  format: "plain" | "markdown";
  /** Space drops it from what `c` copies and `Mod+S` saves (only with `TextDoc.droppable`) */
  droppable?: boolean;
  /** what the Redactor masked in this section; summed over the kept sections for the size line */
  redactions?: RedactionReport;
}

export interface TextDoc {
  title: string;
  sections: TextSection[];
  /** sections marked `droppable` can be dropped with Space / their remove button */
  droppable?: boolean;
  /** shows the size line (bytes, ~tokens, "redacted N values") and the redaction legend */
  measure?: boolean;
  /** the text `c` copies, from the kept section ids; default: the kept bodies joined by a blank line */
  compose?: (kept: readonly string[]) => string;
  /** `Mod+S`; the saved path, or null when cancelled. Absent: the doc cannot be saved. */
  save?: (dropped: readonly string[]) => Promise<string | null>;
}

export type TextSourceBy = TextSource["by"];
export type TextLoader<B extends TextSourceBy = TextSourceBy> = (src: Extract<TextSource, { by: B }>) => Promise<TextDoc>;

const loaders = new Map<TextSourceBy, TextLoader>();

/** Registers the loader for one source kind. Re-registering replaces (HMR safe). */
export function registerTextSource<B extends TextSourceBy>(by: B, load: TextLoader<B>): () => void {
  const entry = load as unknown as TextLoader;
  loaders.set(by, entry);
  return () => {
    if (loaders.get(by) === entry) loaders.delete(by);
  };
}

/** The loader registered for `by`, or undefined. */
export function textSourceLoader(by: TextSourceBy): TextLoader | undefined {
  return loaders.get(by);
}
