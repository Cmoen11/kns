// Action ids of docs/plan-features.md §2.7 that are not built yet, one array per package.
// A2 adds their keymap rows as `built: false`; a package flips its actions to built by emptying
// ONLY its own array (each array is its own block, so packages never touch the same lines).
// src/features.test.ts reads NOT_BUILT and checks the arrays are disjoint and each id belongs to
// its package (PENDING_PREFIXES).

export const PENDING_B_FWD: readonly string[] = [];

export const PENDING_B_DEV: readonly string[] = [];

export const PENDING_B2: readonly string[] = [];

export const PENDING_C1: readonly string[] = [];

export const PENDING_C2: readonly string[] = [];

export const PENDING_C3: readonly string[] = [];

export const PENDING_D: readonly string[] = [];

export const PENDING_E: readonly string[] = [];

export const PENDING_F: readonly string[] = [];

export const PENDING_G: readonly string[] = [];

export const PENDING_H1: readonly string[] = [];

export const PENDING_H2: readonly string[] = [];

export const PENDING_H3: readonly string[] = [];

export const PENDING_I: readonly string[] = [];

/** Every package's array, by package name. */
export const PENDING: Readonly<Record<string, readonly string[]>> = {
  "B-fwd": PENDING_B_FWD,
  "B-dev": PENDING_B_DEV,
  B2: PENDING_B2,
  C1: PENDING_C1,
  C2: PENDING_C2,
  C3: PENDING_C3,
  D: PENDING_D,
  E: PENDING_E,
  F: PENDING_F,
  G: PENDING_G,
  H1: PENDING_H1,
  H2: PENDING_H2,
  H3: PENDING_H3,
  I: PENDING_I,
};

/** Id prefixes (or exact ids) each package may list. */
export const PENDING_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  "B-fwd": ["pf."],
  "B-dev": ["dev.", "picker.dev", "env."],
  B2: ["pf."],
  C1: ["res.why", "why."],
  C2: ["res.timeline", "res.trap", "trap.", "journal."],
  C3: ["res.reach", "res.relations", "relations.", "rollout."],
  D: ["res.diff", "diff.", "doc.fieldOwners", "doc.driftOnly"],
  E: ["logs.", "patterns."],
  F: ["pod.debug", "pod.mirrord", "snippet.", "res.kubectl", "debug."],
  G: ["res.pack", "text."],
  H1: ["mcp.", "agents."],
  H2: ["proposals.", "agent."],
  H3: ["mcp."],
  I: ["hub."],
};

/** Every pending id of every package. */
export const NOT_BUILT_FEATURES: readonly string[] = Object.values(PENDING).flat();
