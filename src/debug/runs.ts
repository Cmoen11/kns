// Snippet runs kept for the `text` view's `snippet` source (plan-features §2.8): in memory only,
// the last 20. The output arrives already cleaned and redacted by Rust (debug.rs snippet_run).
import type { SnippetOutput } from "../ipc/types";
import type { TextDoc } from "../views/text";
import { runSummary } from "./model";

export interface SnippetRun {
  id: string;
  snippet: string;
  title: string;
  command: string;
  pod: string;
  namespace: string;
  container?: string;
  context: string;
  at: number;
  result: SnippetOutput;
}

const MAX_RUNS = 20;
const runs = new Map<string, SnippetRun>();
let n = 0;

export function addRun(r: Omit<SnippetRun, "id">): string {
  const id = `run-${Date.now().toString(36)}-${(++n).toString(36)}`;
  runs.set(id, { ...r, id });
  while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value as string);
  return id;
}

export const getRun = (id: string): SnippetRun | undefined => runs.get(id);

/** The text document of a run; a run lost to a reload says so instead of failing. */
export function runDoc(id: string): TextDoc {
  const r = runs.get(id);
  if (!r) {
    return {
      title: "snippet",
      sections: [{ id: "gone", title: "Run not kept", body: "Snippet output is kept in memory only. Run it again with `:x`.", format: "markdown" }],
    };
  }
  const where = `${r.namespace}/${r.pod}${r.container ? ` · ${r.container}` : ""} · ${r.context}`;
  return {
    title: `${r.snippet} · ${r.pod}`,
    sections: [
      { id: "run", title: "Run", body: `$ sh -c ${r.command}\n${where}\n${runSummary(r.result)}`, format: "plain" },
      { id: "output", title: "Output", body: r.result.output || "(no output)", format: "plain" },
    ],
  };
}
