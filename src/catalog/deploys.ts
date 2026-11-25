// The deploys view's data (docs/catalog.md): the image files of an ops repository, read through
// Rust and the GitHub CLI (github.rs), cached per repository for this session; the `changes`
// text source (commits and pull requests between two tags of an app repository); and the compare
// target of each row, for `o`. Eager and small: the view itself loads lazily.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { backend } from "../ipc";
import type { BackendError, EnvImages, GithubCompare } from "../ipc/types";
import type { PaneId } from "../types";
import type { TextDoc } from "../views/text";
import type { CompareTarget } from "./deploys-model";

export type ImagesLoad =
  | { state: "loading" }
  | { state: "ready"; data: EnvImages }
  | { state: "error"; message: string; code: number };

const keyOf = (repo: string, imageFile: string) => `${repo}\u0001${imageFile}`;
const images = createStore<{ loads: ReadonlyMap<string, ImagesLoad> }>(() => ({ loads: new Map() }));

function put(key: string, load: ImagesLoad): void {
  const loads = new Map(images.getState().loads);
  loads.set(key, load);
  images.setState({ loads });
}

/** Reads the image files of `repo` (again, with `force`). */
export function loadImages(repo: string, imageFile: string, force = false): void {
  const key = keyOf(repo, imageFile);
  const have = images.getState().loads.get(key);
  if (have && !force && have.state !== "error") return;
  if (have?.state === "loading") return;
  put(key, { state: "loading" });
  backend.githubEnvImages(repo, imageFile).then(
    (data) => put(key, { state: "ready", data }),
    (e: unknown) => {
      const err = e as Partial<BackendError> | null;
      put(key, { state: "error", message: err?.message ?? String(e), code: err?.code ?? 0 });
    },
  );
}

/** The load of one ops repository; undefined before the first loadImages. */
export const useImages = (repo: string | undefined, imageFile: string | undefined): ImagesLoad | undefined =>
  useStore(images, (s) => (repo && imageFile ? s.loads.get(keyOf(repo, imageFile)) : undefined));

// ── compare targets of the rows on screen, for `o` ───────────────────────────

const targets = new Map<PaneId, ReadonlyMap<string, CompareTarget>>();

/** The view publishes the compare target of each row key. */
export function setCompareTargets(pane: PaneId, byKey: ReadonlyMap<string, CompareTarget>): () => void {
  targets.set(pane, byKey);
  return () => {
    if (targets.get(pane) === byKey) targets.delete(pane);
  };
}
export const compareTarget = (pane: PaneId | null, key: string | undefined): CompareTarget | undefined =>
  pane && key ? targets.get(pane)?.get(key) : undefined;

// ── compares (the `changes` text source, `o`) ────────────────────────────────

const compares = new Map<string, Promise<GithubCompare>>();

/** The commits between two refs, asked once per session (a failure is asked again). */
export function compareOf(repo: string, base: string, head: string): Promise<GithubCompare> {
  const key = `${repo}\u0001${base}\u0001${head}`;
  let p = compares.get(key);
  if (!p) {
    p = backend.githubCompare(repo, base, head);
    compares.set(key, p);
    p.catch(() => compares.delete(key));
  }
  return p;
}

/** Opens the compare page in the browser (Rust opens only pages of catalog repositories). */
export async function openCompare(t: Pick<CompareTarget, "repo" | "base" | "head">): Promise<void> {
  const c = await compareOf(t.repo, t.base, t.head);
  await backend.catalogOpen(c.url);
}

const day = (iso: string) => iso.slice(0, 10);

/** The `changes` document: a summary, the pull requests and every commit. Untrusted text, shown as text. */
export function changesDoc(c: GithubCompare): TextDoc {
  const prs = new Map<number, string>();
  for (const k of c.commits) if (k.pr !== undefined && !prs.has(k.pr)) prs.set(k.pr, `#${k.pr}  ${k.title.replace(/\s*\(#\d+\)\s*$/, "")}  (${k.author})`);
  const more = c.totalCommits > c.commits.length ? `\nGitHub lists ${c.commits.length} of ${c.totalCommits} commits; the compare page (o in the deploys view) has them all.` : "";
  const status =
    c.status === "identical" ? "the same commit" : c.status === "behind" ? `${c.head} is ${c.behindBy} commits behind ${c.base}` : c.status === "diverged" ? `diverged: ${c.aheadBy} ahead, ${c.behindBy} behind` : `${c.aheadBy} commits`;
  return {
    title: `${c.repo} ${c.base}…${c.head}`,
    sections: [
      { id: "summary", title: "Summary", format: "plain", body: `${c.repo}: ${c.base} → ${c.head} · ${status} · ${prs.size} pull requests\n${c.url}${more}` },
      {
        id: "prs",
        title: "Pull requests",
        format: "plain",
        body: prs.size ? [...prs.entries()].map(([n, line]) => `${line}\n    https://github.com/${c.repo}/pull/${n}`).join("\n") : "No pull request numbers in the commit titles.",
      },
      {
        id: "commits",
        title: "Commits (newest first)",
        format: "plain",
        body: c.commits.length ? c.commits.map((k) => `${k.sha.slice(0, 7)}  ${day(k.date)}  ${k.author}  ${k.title}`).join("\n") : "No commits.",
      },
    ],
  };
}

/** The `changes` text source: loads the compare. */
export const loadChanges = (src: { repo: string; base: string; head: string }): Promise<TextDoc> => compareOf(src.repo, src.base, src.head).then(changesDoc);
