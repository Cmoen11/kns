// Module worker for the patterns view (docs/plan-features.md §0: never an inline or blob: worker,
// so the release CSP's script-src 'self' covers it). Mining 20k lines stays off the UI thread.
import { mine, templateSet, type MineLine, type MineResult } from "./patterns";

export interface MineRequest {
  id: number;
  lines: MineLine[];
  /** texts of the previous container run; null = not read (no NEW marks) */
  previous: string[] | null;
}
export type MineResponse =
  | { id: number; type: "progress"; done: number; total: number }
  | { id: number; type: "done"; result: MineResult };

const post = (m: MineResponse) => (self as unknown as { postMessage(m: MineResponse): void }).postMessage(m);

self.onmessage = (e: MessageEvent<MineRequest>) => {
  const { id, lines, previous } = e.data;
  const prev = previous ? templateSet(previous) : null;
  const result = mine(lines, prev, (done, total) => post({ id, type: "progress", done, total }));
  post({ id, type: "done", result });
};
