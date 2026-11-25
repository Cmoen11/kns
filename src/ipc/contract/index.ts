// Feature contracts (docs/plan-features.md §2.1): one file per package, one owner each.
// Re-exported from ../types.ts, so `import type { DevSet } from "../ipc"` works everywhere.
export * from "./agents";
export * from "./catalog";
export * from "./debug";
export * from "./dev";
export * from "./diag";
export * from "./diff";
export * from "./events";
export * from "./fwd";
export * from "./health";
export * from "./logs";
export * from "./pack";
export * from "./update";
