// The command palette (docs/ux.md §6.1) and, with the `'` prefix, the favourites picker (§7.3).
// Prefixes: none = everything, `:` = command grammar, `>` = actions, `'` = favourites, `?` = keys.
import { useMemo, useState } from "react";
import { LAYERS } from "../actions";
import { confirm, flash, toasts, type OverlayProps } from "../foundation";
import { Dialog, Field, Keys } from "../ui";
import { parseCommand, suggest } from "./command/parse";
import { commandEnv, runCommand } from "./command/run";
import { deleteFavourite, getFav, moveFavouriteSlot, noteRecent, renameFavourite, useFav } from "./favourites/store";
import { currentSnapshot, dismiss, typedAhead, useOverlaySession, type ListController, type NewPane } from "./session";
import { actionItems, buildRows, contextItems, favouriteItems, namespaceItems, paneItems, resourceItems, toolItems, undoItems, type Built, type Item } from "./sources";
import { OBJECT_QUERY_MIN, useObjectItems } from "./objects";
import { first, step, type RowAction } from "./ui/ListBox";
import { ListOverlay } from "./ui/ListOverlay";

export interface PaletteProps {
  /** initial input, e.g. "'" for the favourites picker or ":" for commands */
  text?: string;
  /** set when opened after the `+` prefix: Enter opens beside */
  newPane?: NewPane;
}

type Mode = "" | ":" | ">" | "'" | "?";
const MODES: readonly string[] = [":", ">", "'", "?"];
const LABEL: Record<Mode, string> = { "": "Search or run", ":": "Command", ">": "Actions", "'": "Favourites", "?": "Keys" };
const EMPTY: Record<Mode, string> = {
  "": "No matches",
  ":": "No matching command",
  ">": "No matching action",
  "'": "No matching favourite",
  "?": "No matching key",
};

const FAV_ACTIONS: readonly RowAction[] = [
  { id: "rename", icon: "edit", label: "Rename" },
  { id: "delete", icon: "delete", label: "Delete" },
];

export default function Palette({ props }: OverlayProps<PaletteProps | undefined>) {
  // plus what was typed while this (lazy) component was on its way
  const [text, setTextRaw] = useState(() => (props?.text ?? "") + typedAhead());
  /** null = the first row; a number once the user moved */
  const [sel, setSel] = useState<number | null>(null);
  /** the selection was moved with the keys (not by the pointer passing over a row) */
  const [byKeys, setByKeys] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rename, setRename] = useState<{ kind: "view" | "layout"; id: string; name: string } | null>(null);

  const mode: Mode = MODES.includes(text[0]) ? (text[0] as Mode) : "";
  const query = mode ? text.slice(1) : text;
  const snapshot = currentSnapshot();
  const pane = snapshot.pane;
  const favourites = useFav((s) => s.favorites);
  const layouts = useFav((s) => s.layouts);
  const objects = useObjectItems(pane);

  // read once per open: the cluster, the snapshot and the recents do not change under the palette
  const base = useMemo(
    () => ({
      resources: resourceItems(pane),
      actions: actionItems(snapshot),
      keys: actionItems(snapshot, { all: true }),
      namespaces: namespaceItems(pane),
      contexts: contextItems(),
      panes: paneItems(),
      tools: toolItems(),
      undo: undoItems(),
      recents: getFav().recents,
      env: commandEnv(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const built: Built = useMemo(() => {
    if (mode === ":") {
      const body = query.trim();
      const lines = body === "" ? [...new Set(base.env.commands.map((c) => c.words.join(" ")))].sort() : suggest(query, base.env);
      return {
        rows: lines.map((l) => ({ key: l, label: l })),
        items: lines.map((l): Item => ({ key: `cmd:${l}`, group: "Commands", label: l, run: () => undefined })),
      };
    }
    if (mode === "'") {
      const b = buildRows(favouriteItems(favourites, layouts, pane, true), query, null);
      return { items: b.items, rows: b.rows.map((r, i) => (b.items[i]?.fav ? { ...r, actions: FAV_ACTIONS } : r)) };
    }
    if (mode === ">") return buildRows([...base.actions, ...base.undo], query, base.recents, "Actions");
    if (mode === "?") return buildRows(base.keys, query, null);
    return buildRows(
      [
        ...favouriteItems(favourites, layouts, pane, false), ...base.resources, ...base.actions, ...base.namespaces, ...base.contexts, ...base.panes, ...base.tools,
        ...(query.trim().length >= OBJECT_QUERY_MIN ? objects : []),
      ],
      query,
      base.recents,
    );
  }, [mode, query, base, favourites, layouts, pane, objects]);

  const { rows, items } = built;
  const selected = sel !== null && sel < rows.length && !rows[sel].group ? sel : first(rows);
  const label = selected >= 0 ? rows[selected].label : "";
  const typed = mode === ":" ? query.replace(/^\s+/, "") : query;
  const ghost = typed !== "" && label.length > typed.length && label.toLowerCase().startsWith(typed.toLowerCase()) ? label.slice(typed.length) : "";

  const setText = (t: string) => {
    setTextRaw(t);
    setSel(null);
    setByKeys(false);
    setError(null);
  };

  async function runLine(line: string, newPane: NewPane) {
    dismiss();
    const err = await runCommand(line, { pane: pane ?? undefined, newPane });
    if (err) flash(err, "warn");
  }

  function accept(newPane: NewPane) {
    const beside = newPane ?? props?.newPane ?? null;
    if (mode === ":") {
      const parsed = parseCommand(query, base.env);
      // Enter runs what was typed when it is a command; otherwise, or after moving, the selected completion
      // (a row the pointer merely rests on is not "after moving")
      if (!byKeys && parsed.type !== "error" && parsed.type !== "empty") return void runLine(query, beside);
      if (parsed.type === "empty" && !byKeys) return dismiss();
      if (selected >= 0) return void runLine(rows[selected].label, beside);
      setError(parsed.type === "error" ? parsed.message : null);
      return;
    }
    const item = selected >= 0 ? items[selected] : null;
    if (!item) return;
    if (item.disabled) {
      setError(`${item.label}: ${item.reason ?? "not available"}`);
      return;
    }
    dismiss();
    noteRecent(item.key);
    try {
      const r = item.run(beside);
      if (r instanceof Promise) r.catch((e: unknown) => toasts.error(String(e)));
    } catch (e) {
      toasts.error(String(e));
    }
  }

  const fav = mode === "'" && selected >= 0 ? items[selected]?.fav : undefined;
  const askDelete = (f: NonNullable<Item["fav"]>) => {
    void confirm({ tier: 1, title: `Delete ${f.kind === "view" ? "favourite" : "layout"}`, body: `${f.name} is removed. This cannot be undone.`, confirmLabel: "Delete" }).then((ok) => {
      if (ok) deleteFavourite(f.kind, f.id);
    });
  };
  const controller: ListController = {
    down: () => {
      setSel(step(rows, selected, 1));
      setByKeys(true);
    },
    up: () => {
      setSel(step(rows, selected, -1));
      setByKeys(true);
    },
    accept,
    close: dismiss,
    complete: () => {
      if (ghost) setText(mode + label);
    },
    extra: fav
      ? {
          rename: () => setRename(fav),
          delete: () => askDelete(fav),
          slotUp: () => moveFavouriteSlot(fav.kind, fav.id, -1),
          slotDown: () => moveFavouriteSlot(fav.kind, fav.id, 1),
        }
      : undefined,
  };
  useOverlaySession(mode === "'" ? LAYERS.pickerFavourites : mode === ":" ? LAYERS.command : LAYERS.palette, controller);

  return (
    <ListOverlay
      label={LABEL[mode]}
      size="palette"
      text={text}
      onText={setText}
      ghost={ghost}
      rows={rows}
      selected={selected}
      onPick={(i, newPane) => {
        setSel(i);
        // a click runs the row it hit, not the selection of the last render
        const item = items[i];
        if (mode === ":") void runLine(rows[i].label, newPane ?? props?.newPane ?? null);
        else if (item && !item.disabled) {
          dismiss();
          noteRecent(item.key);
          void Promise.resolve(item.run(newPane ?? props?.newPane ?? null)).catch((e: unknown) => toasts.error(String(e)));
        }
      }}
      onHover={setSel}
      onAction={(i, action) => {
        const f = items[i]?.fav;
        if (!f) return;
        if (action === "rename") setRename(f);
        else if (action === "delete") askDelete(f);
      }}
      footer={
        mode === "'" && (
          <>
            <span>
              <Keys action="picker.rename" /> rename
            </span>
            <span>
              <Keys action="picker.moveSlotUp" /> <Keys action="picker.moveSlotDown" /> slot
            </span>
            <span>
              <Keys action="picker.delete" /> delete
            </span>
          </>
        )
      }
      error={error}
      empty={
        mode === "'" && query.trim() === "" ? (
          // nothing saved yet: say how (the one-key fix of an empty state, §11.10)
          <>
            No favourites yet. <Keys action="fav.saveView" /> saves this view, <Keys action="fav.saveLayout" /> the layout.
          </>
        ) : (
          EMPTY[mode]
        )
      }
    >
      {rename && (
        <RenameDialog
          name={rename.name}
          onCancel={() => setRename(null)}
          onConfirm={(name) => {
            renameFavourite(rename.kind, rename.id, name);
            setRename(null);
          }}
        />
      )}
    </ListOverlay>
  );
}

function RenameDialog({ name, onConfirm, onCancel }: { name: string; onConfirm: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(name);
  const ok = value.trim() !== "";
  return (
    <Dialog title="Rename" confirmLabel="Rename" confirmDisabled={!ok} confirmDisabledReason="type a name" onConfirm={() => ok && onConfirm(value)} onCancel={onCancel}>
      <Field label="Name" value={value} onChange={(e) => setValue(e.target.value)} />
    </Dialog>
  );
}
