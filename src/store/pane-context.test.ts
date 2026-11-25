// §8.3: a pane can show another kube context than the window. What an action or a view is about is
// its pane's context (paneContext / focusedContext / usePaneContext); the window's context only
// decides which workspace is on screen. This guard keeps reads of the window's context to the
// files that are about the window, so a new feature cannot quietly act on the wrong cluster.
import { describe, expect, it } from "vitest";

/** Every source file under src (no tests, no mock backend), by path relative to src. */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>(["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../ipc/mock/**", "!../ipc/mock.ts"], { query: "?raw", import: "default", eager: true }))
    // files of this folder come back as "./x.ts"
    .map(([p, text]) => [p.startsWith("./") ? `store/${p.slice(2)}` : p.replace(/^\.\.\//, ""), text]),
);

/** Files that may read the window's context, with why. */
const WINDOW_READERS: Record<string, string> = {
  "store/cluster.ts": "owns it",
  "shell/Titlebar.tsx": "shows the window's context next to the focused pane's",
  "sidepanels/ContextSidebar.tsx": "switches the window",
  "sidepanels/ActivityPanel.tsx": "window-wide rows: forwards, connection health",
  "status/index.ts": "records window context switches",
  "status/health.ts": "namespace health of the window's context (sidebar badges)",
  "catalog/store.ts": "follows the kubeconfig's context list (not the window's context) to protect production contexts",
  "palette/Picker.tsx": "the window mode of the context picker",
  "palette/sources.ts": "palette context rows switch the window",
  "palette/favourites/store.ts": "a saved layout fills the window's workspace",
  "agents/show.ts": "agent panes open in the window's context only",
  "agents/store.ts": "contexts the human connected",
  "diag/TrapsView.tsx": "a hint text only",
  "diag/index.ts": "starts the C2 background reads for the window's context",
  "debug/index.ts": "activity rows of the window's context",
  "panes/scope-sync.ts": "re-syncs scopes when any discovery changes",
  "shell/BottomRow.tsx": "the window's connection health",
  "agents/publish.ts": "re-publishes when a connection changes",
  "table/warm.ts": "re-derives the warm tabs' table queries when discovery changes",
  "shell/ContextTabs.tsx": "the tab strip: the window's context is the active tab",
};

const PATTERNS: RegExp[] = [
  /\bwindowContext\(/,
  /useCluster\(\(\w+\)\s*=>[^;]*?\b\w+\.context\b(?!s)/,
  /getCluster\(\)\.context\b(?!s)/,
  /clusterStore\.getState\(\)\.context\b(?!s)/,
  /\{[^}]*\bcontext\b[^}]*\}\s*=\s*getCluster\(\)/,
  /\bcurrentContext\b/,
  /\bclusterStore\.(subscribe|getState)\(/,
];

describe("window context reads (§8.3)", () => {
  it("happen only in files about the window", () => {
    const offenders: string[] = [];
    for (const [rel, text] of Object.entries(SOURCES)) {
      if (WINDOW_READERS[rel]) continue;
      for (const p of PATTERNS) if (p.test(text)) offenders.push(`${rel}: ${p.source}`);
    }
    expect(offenders).toEqual([]);
  });

  it("lists no file that does not read it", () => {
    const stale = Object.keys(WINDOW_READERS).filter((rel) => !PATTERNS.some((p) => p.test(SOURCES[rel] ?? "")));
    expect(stale).toEqual([]);
  });

  it("nobody uses the removed currentContext()", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    expect(Object.keys(SOURCES).filter((rel) => /\bcurrentContext\b/.test(SOURCES[rel]))).toEqual([]);
  });
});
