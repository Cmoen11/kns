// The rows of the settings view (docs/ux.md §11.10): Appearance, Keys, Contexts, Safety, Logs,
// then the keymap. Each row knows how to change itself; the view only moves a cursor.
import { registry, type ActionDef } from "../../actions";
import { engine, isRebindable, keymap, platform } from "../../keys";
import { ZOOM_STEPS, contextFlags, setContextFlags, setSettings } from "../../store/settings";
import type { NameProxyStatus } from "../../ipc/types";
import type { Mode, Settings } from "../../types";
import { confirm } from "../../ui";
import type { ItemRow, ListRow } from "./list-model";

const MODES: readonly { value: Mode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "lys", label: "Light" },
  { value: "mork", label: "Dark" },
];
const STATUS_COLORS: readonly { value: "full" | "quiet"; label: string }[] = [
  { value: "full", label: "Full" },
  { value: "quiet", label: "Quiet" },
];
const ACTION_LOG: readonly { value: "all" | "writes" | "off"; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "writes", label: "Cluster writes" },
  { value: "off", label: "Off" },
];
const ROWS: readonly { value: 20 | 28; label: string }[] = [
  { value: 20, label: "Compact 20" },
  { value: 28, label: "Roomy 28" },
];
const MONO: readonly { value: Settings["mono"]; label: string }[] = [
  { value: "geist", label: "Geist Mono" },
  { value: "jetbrains", label: "JetBrains Mono" },
];
export const LOG_BUFFER_STEPS = [1000, 2000, 5000, 10000, 20000, 50000, 100000] as const;
export const SCROLLBACK_STEPS = [1000, 2000, 5000, 10000, 50000, 100000] as const;
export const CLIPBOARD_CLEAR_STEPS = [0, 15, 30, 60, 120, 300] as const;
export const AGENT_IDLE_STEPS = [0, 5, 15, 30, 60] as const;
export const NAME_PROXY_PORTS = [7080, 7081, 7082, 7090] as const;
const seconds = (n: number) => (n === 0 ? "never" : n < 60 ? `${n} s` : `${n / 60} min`);
const minutes = (n: number) => (n === 0 ? "never" : `${n} min`);

/** The option `dir` steps from `current`, wrapping; a value between two steps snaps to the nearer one first. */
export function stepOption<T>(options: readonly T[], current: T, dir: 1 | -1): T {
  let i = options.indexOf(current);
  if (i < 0 && typeof current === "number") {
    i = 0;
    for (let j = 1; j < options.length; j++) {
      if (Math.abs((options[j] as number) - current) < Math.abs((options[i] as number) - current)) i = j;
    }
    return options[i];
  }
  return options[(Math.max(i, 0) + dir + options.length) % options.length];
}

function choice<T>(key: string, label: string, hint: string, options: readonly { value: T; label: string }[], current: T, set: (v: T) => void): ItemRow {
  const values = options.map((o) => o.value);
  const cycle = (dir: 1 | -1) => set(stepOption(values, current, dir));
  return {
    type: "item", key, cells: [label, hint],
    value: options.find((o) => o.value === current)?.label ?? String(current),
    change: () => cycle(1), cycle, control: "choice",
  };
}

function toggle(key: string, label: string, hint: string, on: boolean, set: (on: boolean) => void): ItemRow {
  return {
    type: "item", key, cells: [label, hint], value: on ? "on" : "off", control: "toggle",
    change: () => set(!on),
    // left = off, right = on
    cycle: (dir) => {
      if ((dir === 1) !== on) set(dir === 1);
    },
  };
}

const numbers = (steps: readonly number[]) => steps.map((n) => ({ value: n, label: n.toLocaleString("en-US") }));

/** Turning protection off is itself tier 2: type the context name (§8.2). */
async function setProtected(context: string, on: boolean): Promise<void> {
  if (!on) {
    const ok = await confirm({
      tier: 2,
      title: "Remove protection",
      body: "Writes on this context will no longer ask for the resource name.",
      facts: [{ label: "context", value: context }],
      typeToConfirm: context,
      confirmLabel: "Unprotect",
    });
    if (!ok) return;
  }
  setContextFlags(context, { protected: on });
}

export function keymapActions(): ActionDef[] {
  return registry.list().filter((d) => d.built && !d.alias);
}

/** The name proxy lives in Rust (proxy.rs); the rows ask it through `:dev names` code (lazy). */
function setNameProxy(on: boolean, port?: number): void {
  void import("../../dev/names").then((m) => m.setNames(on, port));
}

/** Rows for the current settings. `contexts` are the kube context names; `names` the name proxy state (null: unknown). */
export function buildSettingsRows(s: Settings, contexts: readonly string[], names: NameProxyStatus | null = null): ListRow[] {
  const rows: ListRow[] = [
    { type: "group", key: "g:appearance", label: "Appearance" },
    choice("mode", "Mode", "System follows the OS, live", MODES, s.mode, (mode) => setSettings({ mode })),
    choice("zoom", "Zoom", "size of everything", ZOOM_STEPS.map((z) => ({ value: z, label: `${z}%` })), s.zoom, (zoom) => setSettings({ zoom })),
    choice("rows", "Row height", "table rows", ROWS, s.rowHeight, (rowHeight) => setSettings({ rowHeight })),
    choice("mono", "Mono font", "logs, YAML, terminal", MONO, s.mono, (mono) => setSettings({ mono })),
    toggle("hints", "Key hints", "the hint row at the bottom", s.hints, (hints) => setSettings({ hints })),
    toggle("openBeside", "Open beside", "logs, describe, YAML and shells open in a pane next to the table", s.openBeside, (openBeside) => setSettings({ openBeside })),
    choice("statusColors", "Status colours", "Full: ok and in-progress glyphs coloured too; Quiet: only warnings and errors", STATUS_COLORS, s.statusColors, (statusColors) => setSettings({ statusColors })),
    toggle("rowTint", "Row tint", "a faint warn / error tint behind failing table rows", s.rowTint, (rowTint) => setSettings({ rowTint })),
    toggle("nsHealth", "Namespace health", "badges with failing pods and degraded workloads per namespace (one cluster-wide watch)", s.nsHealth, (nsHealth) => setSettings({ nsHealth })),
    toggle("nsProblemsFirst", "Namespaces with problems first", "context sidebar order; s in the sidebar", s.nsProblemsFirst, (nsProblemsFirst) => setSettings({ nsProblemsFirst })),
    choice("actionLog", "Action log", "what Recent in the activity panel records (never secret values)", ACTION_LOG, s.actionLog, (actionLog) => setSettings({ actionLog })),

    { type: "group", key: "g:keys", label: "Keys" },
    toggle("singleKeys", "Single-character keys", "off: only chords and named keys act", s.singleKeys, (singleKeys) => setSettings({ singleKeys })),
    toggle("k9s", "k9s keys", "restores the k9s bindings that kns replaced", s.k9sMode, (k9sMode) => setSettings({ k9sMode })),
    toggle("vim", "Vim keys in editors", "describe, YAML and edit use vim keys; :w reviews, :q leaves", s.vim, (vim) => setSettings({ vim })),
  ];

  if (contexts.length > 0) rows.push({ type: "group", key: "g:contexts", label: "Contexts" });
  for (const c of contexts) {
    const f = s.contexts[c] ?? contextFlags(c);
    rows.push(
      toggle(`ctx:${c}:protected`, `${c}: protected`, "every write asks for the name", f.protected, (on) => void setProtected(c, on)),
      toggle(`ctx:${c}:readOnly`, `${c}: read-only`, "writes are disabled", f.readOnly, (readOnly) => setContextFlags(c, { readOnly })),
    );
  }

  rows.push(
    { type: "group", key: "g:safety", label: "Safety" },
    // the kill switch has its own confirmed action; the row only asks for it
    toggle("kill", "Kill", "delete pods with grace period 0", s.killEnabled, (on) => void engine.run("app.killSwitch", { source: "api", args: [on ? "on" : "off"] })),
    choice("clipboardClear", "Clear copied secrets", "a secret value copied by kns is wiped from the clipboard after", CLIPBOARD_CLEAR_STEPS.map((n) => ({ value: n, label: seconds(n) })), s.clipboardClearSeconds, (clipboardClearSeconds) => setSettings({ clipboardClearSeconds })),
    choice("agentIdle", "Agent forwards idle stop", "forwards an agent owns stop after this long without traffic", AGENT_IDLE_STEPS.map((n) => ({ value: n, label: minutes(n) })), s.agentForwardIdleMinutes, (agentForwardIdleMinutes) => setSettings({ agentForwardIdleMinutes })),
    // the first image is the debug dialog's default; cycling moves another one to the front
    choice("debugImage", "Debug image", "default image of the debug container", s.debugImages.map((i) => ({ value: i, label: i })), s.debugImages[0], (img) => setSettings({ debugImages: [img, ...s.debugImages.filter((i) => i !== img)] })),

    { type: "group", key: "g:logs", label: "Logs" },
    choice("logBuffer", "Log buffer", "lines kept per log pane", numbers(LOG_BUFFER_STEPS), s.logBufferLines, (logBufferLines) => setSettings({ logBufferLines })),
    choice("scrollback", "Terminal scrollback", "lines kept per shell", numbers(SCROLLBACK_STEPS), s.termScrollback, (termScrollback) => setSettings({ termScrollback })),
    toggle("logsStructured", "Structured logs", "JSON and logfmt lines as columns", s.logsStructured, (logsStructured) => setSettings({ logsStructured })),
  );

  if (names) {
    const ports = NAME_PROXY_PORTS.includes(names.port as (typeof NAME_PROXY_PORTS)[number]) ? [...NAME_PROXY_PORTS] : [names.port, ...NAME_PROXY_PORTS];
    rows.push(
      { type: "group", key: "g:localdev", label: "Local dev" },
      toggle("nameProxy", "Names (*.localhost)", "forwards answer as http://<name>.<namespace>.localhost:<port>", names.on, (on) => setNameProxy(on, names.port)),
      // changing the port while off only remembers it once names are turned on (`:dev names on <port>`)
      choice("nameProxyPort", "Name proxy port", "127.0.0.1 only; also :dev names on <port>", ports.map((n) => ({ value: n, label: String(n) })), names.port, (port) => setNameProxy(names.on, port)),
    );
  }

  const overrides = keymap.overrides();
  let group = "";
  for (const d of keymapActions()) {
    if (d.group !== group) {
      group = d.group;
      rows.push({ type: "group", key: `g:keymap:${group}`, label: `Keymap · ${group}` });
    }
    const bindings = keymap.display(d.id, platform);
    rows.push({
      type: "item",
      key: `key:${d.id}`,
      cells: [d.label, d.command ? `:${d.command}` : ""],
      keys: bindings,
      value: overrides[d.id] ? "edited" : bindings.length === 0 ? "no key" : undefined,
      search: `${d.label} ${d.id} ${d.group} ${d.command ?? ""} ${bindings.map((b) => b.join(" ")).join(" ")}`,
      actionId: isRebindable(d) ? d.id : undefined,
      edited: !!overrides[d.id],
      title: d.id,
    });
  }
  return rows;
}
