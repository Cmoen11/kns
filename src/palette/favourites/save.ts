// Saving favourites from the command line: `:fav save <name> [slot]`, `:layout save <name> [slot]`
// (docs/ux.md §6.2, §7). The dialog (SaveDialog.tsx) covers Ctrl/Cmd+Shift+S and +L.
import { confirm, flash, paneView, toast } from "../../foundation";
import type { PaneId, Slot } from "../../types";
import { findByName, nextFreeSlot, occupant, parseSlot } from "./slots";
import { getFav, saveFavouriteView, saveLayout } from "./store";

/** `web 3` -> name "web", slot 3; `web pods` -> name "web pods". */
export function nameAndSlot(args: readonly string[]): { name: string; slot?: Slot } {
  const slot = args.length > 1 ? parseSlot(args[args.length - 1]) : undefined;
  return { name: (slot ? args.slice(0, -1) : args).join(" ").trim(), slot };
}

/** The question to ask before a save replaces something, or null. */
export function replaceQuestion(kind: "view" | "layout", name: string, slot: Slot | undefined): string | null {
  const list: readonly { id: string; name: string; slot?: Slot }[] = kind === "view" ? getFav().favorites : getFav().layouts;
  const existing = findByName(list, name);
  const taken = occupant(list, slot, existing?.id);
  if (taken) return `Replace slot ${slot} (${taken.name})? It stays in the list without a slot.`;
  if (existing && kind === "layout") return `Overwrite layout ${existing.name}?`;
  if (existing) return `Overwrite favourite ${existing.name}?`;
  return null;
}

export async function saveViewDirect(pane: PaneId | undefined, args: readonly string[]): Promise<void> {
  const view = paneView(pane);
  if (view?.kind !== "table") return flash("only table views can be saved as favourites", "warn");
  const { name, slot: asked } = nameAndSlot(args);
  if (name === "") return flash("usage: :fav save <name> [slot]", "warn");
  const existing = findByName(getFav().favorites, name);
  const slot = asked ?? existing?.slot ?? nextFreeSlot(getFav().favorites);
  const question = replaceQuestion("view", name, slot);
  if (question && !(await confirm({ tier: 1, title: "Save favourite", body: question, confirmLabel: "Replace" }))) return;
  const fav = saveFavouriteView(name, slot, view, false);
  toast({ kind: "ok", text: fav.slot ? `Saved favourite ${fav.name} in slot ${fav.slot}` : `Saved favourite ${fav.name}` });
}

export async function saveLayoutDirect(args: readonly string[]): Promise<void> {
  const { name, slot: asked } = nameAndSlot(args);
  if (name === "") return flash("usage: :layout save <name> [slot]", "warn");
  const existing = findByName(getFav().layouts, name);
  const slot = asked ?? existing?.slot ?? nextFreeSlot(getFav().layouts);
  const question = replaceQuestion("layout", name, slot);
  if (question && !(await confirm({ tier: 1, title: "Save layout", body: question, confirmLabel: "Replace" }))) return;
  const layout = saveLayout(name, slot);
  if (layout) toast({ kind: "ok", text: layout.slot ? `Saved layout ${layout.name} in slot ${layout.slot}` : `Saved layout ${layout.name}` });
}
