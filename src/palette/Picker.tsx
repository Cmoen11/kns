// The namespace picker (docs/ux.md §8.1) and the context picker (§8.2, §8.3): the palette's list
// component, 400 wide, with their own keys (pin a namespace slot, toggle a protected context).
import { contextDetail } from "../store/context-label";
import { useEffect, useMemo, useState } from "react";
import { LAYERS } from "../actions";
import {
  openPaneInContext, paneView, refreshContexts, setNamespace, setNamespaceAllPanes, setPaneContext, switchContext, toasts, useCluster, useNamespaces,
  showOverlay, usePaneContext, type OverlayProps,
} from "../foundation";
import { CONTEXT_ALIAS_OVERLAY } from "./overlays";
import { useSettings } from "../store/settings";
import { toggleProtected } from "./context";
import { nsSlotOf } from "./favourites/slots";
import { noteNamespaceUsed, toggleNamespacePin, useFav } from "./favourites/store";
import { rank } from "./fuzzy";
import { currentSnapshot, dismiss, typedAhead, useOverlaySession, type ListController, type NewPane } from "./session";
import { first, step, type ListRow } from "./ui/ListBox";
import { ListOverlay } from "./ui/ListOverlay";

export type PickerProps = { kind: "ns"; allPanes: boolean } | { kind: "ctx"; pane?: boolean };

export default function Picker({ props }: OverlayProps<PickerProps>) {
  return props.kind === "ns" ? <NamespacePicker allPanes={props.allPanes} /> : <ContextPicker paneOnly={props.pane === true} />;
}

interface Entry {
  row: ListRow;
  /** what Enter uses */
  value: string;
}

function usePickerList(entries: readonly Entry[], text: string) {
  const [sel, setSel] = useState<number | null>(null);
  const rows = useMemo(() => entries.map((e) => e.row), [entries]);
  const selected = sel !== null && sel < rows.length ? sel : first(rows);
  const label = selected >= 0 ? rows[selected].label : "";
  const ghost = text !== "" && label.length > text.length && label.toLowerCase().startsWith(text.toLowerCase()) ? label.slice(text.length) : "";
  return { rows, selected, setSel, ghost, label, down: () => setSel(step(rows, selected, 1)), up: () => setSel(step(rows, selected, -1)) };
}

function NamespacePicker({ allPanes }: { allPanes: boolean }) {
  const [text, setText] = useState(typedAhead);
  const pane = currentSnapshot().pane;
  // the namespaces of the focused pane's context (§8.3)
  const context = usePaneContext(pane);
  const { names, synced, forbidden } = useNamespaces(context || undefined);
  const slots = useFav((s) => s.nsSlots[context]);
  const view = pane ? paneView(pane) : undefined;
  const current = view?.kind === "table" ? view.namespace : undefined;

  const entries = useMemo(() => {
    const safe = slots ?? [];
    const entry = (ns: string, positions: readonly number[] = []): Entry => {
      const slot = ns === "*" ? 0 : nsSlotOf(safe, ns);
      return {
        value: ns,
        row: {
          key: ns, label: ns === "*" ? "all namespaces" : ns, positions, current: ns === current,
          slot: ns === "*" ? "0" : slot > 0 ? String(slot) : "",
          labels: slot > 0 && safe[slot - 1]?.pinned ? ["PIN"] : undefined,
        },
      };
    };
    const q = text.trim();
    if (q === "") {
      // slots first, in slot order; the rest alphabetically
      const slotted = safe.filter((s): s is NonNullable<typeof s> => !!s && names.includes(s.name)).map((s) => s.name);
      return [entry("*"), ...slotted.map((n) => entry(n)), ...names.filter((n) => !slotted.includes(n)).map((n) => entry(n))];
    }
    const out = rank(["*", ...names], q, { text: (n) => (n === "*" ? "all namespaces" : n) }).map((r) => entry(r.item, r.positions));
    // listing may be forbidden or still syncing: the typed name is accepted as it is (§8.1)
    if (!names.includes(q) && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(q)) {
      out.push({ value: q, row: { key: `typed:${q}`, label: q, slot: "", tag: "use as typed" } });
    }
    return out;
  }, [names, slots, text, current]);

  const list = usePickerList(entries, text);
  const use = (i: number) => {
    const e = entries[i];
    if (!e) return;
    dismiss();
    if (allPanes) setNamespaceAllPanes(e.value);
    else if (pane) setNamespace(e.value, pane);
    noteNamespaceUsed(e.value);
  };
  const controller: ListController = {
    down: list.down,
    up: list.up,
    accept: () => use(list.selected),
    close: dismiss,
    complete: () => {
      if (list.ghost) {
        setText(list.label);
        list.setSel(null);
      }
    },
    extra: {
      pin: () => {
        const e = entries[list.selected];
        if (e && e.value !== "*") toggleNamespacePin(e.value);
      },
    },
  };
  useOverlaySession(LAYERS.pickerNamespace, controller);

  return (
    <ListOverlay
      label={allPanes ? "Namespace, all panes" : "Namespace"}
      size="picker"
      text={text}
      onText={(t) => {
        setText(t);
        list.setSel(null);
      }}
      ghost={list.ghost}
      rows={list.rows}
      selected={list.selected}
      onPick={(i) => use(i)}
      onHover={list.setSel}
      error={forbidden ? "Listing namespaces is forbidden: type the name" : null}
      empty={synced ? "No matching namespace" : "syncing"}
    />
  );
}

const STATUS_WORD = { idle: "idle", connecting: "connecting", connected: "connected", offline: "offline" } as const;

/**
 * Enter switches the window (§8.2), or with `paneOnly` (leader C, `:pane ctx`) puts the focused
 * pane in that context. Ctrl/⌘+Enter and Alt+Enter open the focused pane's view beside it, in
 * that context (§8.3).
 */
function ContextPicker({ paneOnly }: { paneOnly: boolean }) {
  const [text, setText] = useState(typedAhead);
  const contexts = useCluster((s) => s.contexts);
  const pane = currentSnapshot().pane;
  const paneCtx = usePaneContext(pane);
  const windowCtx = useCluster((s) => s.context);
  const active = paneOnly ? paneCtx : windowCtx;
  const status = useCluster((s) => (active ? (s.conns[active]?.status ?? "idle") : "idle"));
  const flags = useSettings((s) => s.contexts);

  // the kubeconfig may have changed since startup
  useEffect(() => {
    refreshContexts().catch((e: unknown) => toasts.error(`Reading contexts failed: ${String(e)}`));
  }, []);

  const entries = useMemo(() => {
    const entry = (name: string, positions: readonly number[] = []): Entry => {
      const c = contexts.find((x) => x.name === name);
      const f = flags[name];
      const labels = [f?.protected ? "PROTECTED" : "", f?.readOnly ? "READ ONLY" : ""].filter(Boolean);
      // an alias is the row's name; the kubeconfig name leads the detail (§8.2)
      const detail = c ? contextDetail(c.cluster, c.user) : undefined;
      return {
        value: name,
        row: {
          key: name, label: f?.alias ?? name, positions, current: name === active, slot: "",
          detail: f?.alias ? [name, detail].filter(Boolean).join(" · ") : detail,
          labels: labels.length > 0 ? labels : undefined,
          tag: name === active ? STATUS_WORD[status] : undefined,
        },
      };
    };
    const names = contexts.map((c) => c.name);
    const q = text.trim();
    if (q === "") return names.map((n) => entry(n));
    return rank(names, q, { text: (n) => flags[n]?.alias ?? n, keywords: (n) => (flags[n]?.alias ? [n] : []) }).map((r) => entry(r.item, r.positions));
  }, [contexts, active, status, flags, text]);

  const list = usePickerList(entries, text);
  const use = (i: number, newPane: NewPane = null) => {
    const e = entries[i];
    if (!e) return;
    dismiss();
    if (newPane) openPaneInContext(e.value, newPane, pane ?? undefined);
    else if (paneOnly) setPaneContext(e.value, { pane: pane ?? undefined });
    else switchContext(e.value).catch((err: unknown) => toasts.error(String(err)));
  };
  const controller: ListController = {
    down: list.down,
    up: list.up,
    accept: (newPane) => use(list.selected, newPane),
    close: dismiss,
    complete: () => {
      if (list.ghost) {
        setText(list.label);
        list.setSel(null);
      }
    },
    extra: {
      protect: () => {
        const e = entries[list.selected];
        if (e) void toggleProtected(e.value);
      },
      rename: () => {
        const e = entries[list.selected];
        if (e) showOverlay(CONTEXT_ALIAS_OVERLAY, { context: e.value });
      },
    },
  };
  useOverlaySession(LAYERS.pickerContext, controller);

  return (
    <ListOverlay
      label={paneOnly ? "Context, this pane" : "Context"}
      size="picker"
      text={text}
      onText={(t) => {
        setText(t);
        list.setSel(null);
      }}
      ghost={list.ghost}
      rows={list.rows}
      selected={list.selected}
      onPick={(i) => use(i)}
      onHover={list.setSel}
      empty="No matching context"
    />
  );
}
