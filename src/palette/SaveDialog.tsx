// Save view (Ctrl/Cmd+Shift+S) and save layout (Ctrl/Cmd+Shift+L), docs/ux.md §7.1, §7.2.
// Name + Enter is enough. An occupied slot names its occupant, and Enter then asks once.
import { useState } from "react";
import { crumbsOf, getWorkspace, paneView, toast, type OverlayProps } from "../foundation";
import type { Slot } from "../types";
import { Checkbox, Dialog, Field } from "../ui";
import { treeSummary, toSavedLayout } from "./favourites/model";
import { replaceQuestion } from "./favourites/save";
import { nextFreeSlot, occupant, parseSlot } from "./favourites/slots";
import { getFav, saveFavouriteView, saveLayout } from "./favourites/store";
import { currentSnapshot, dismiss } from "./session";

export interface SaveProps {
  kind: "view" | "layout";
}

function defaultName(kind: "view" | "layout"): string {
  if (kind === "view") {
    const v = paneView(currentSnapshot().pane ?? undefined);
    return v ? crumbsOf(v).map((c) => c.label).join(" ") : "";
  }
  const ws = getWorkspace();
  if (!ws) return "";
  const active = getFav().layouts.find((l) => l.id === ws.layoutId);
  if (active) return active.name;
  const l = toSavedLayout(ws, "", "");
  return treeSummary(l.root, l.views);
}

export default function SaveDialog({ props }: OverlayProps<SaveProps>) {
  const { kind } = props;
  const list: readonly { id: string; name: string; slot?: Slot }[] = kind === "view" ? getFav().favorites : getFav().layouts;
  const [name, setName] = useState(() => defaultName(kind));
  const [slotText, setSlotText] = useState(() => String(nextFreeSlot(list) ?? ""));
  const [current, setCurrent] = useState(false);
  /** the replace question that was shown; the next Enter with the same question saves */
  const [asked, setAsked] = useState<string | null>(null);

  const slot = parseSlot(slotText);
  const slotError = slotText.trim() !== "" && slot === undefined ? "1 to 9, or empty for no slot" : undefined;
  const taken = occupant(list, slot, list.find((i) => i.name === name.trim())?.id);
  const ready = name.trim() !== "" && !slotError;
  const question = ready ? replaceQuestion(kind, name, slot) : null;

  const save = () => {
    if (!ready) return;
    if (question && asked !== question) return setAsked(question);
    if (kind === "view") {
      const view = paneView(currentSnapshot().pane ?? undefined);
      if (view?.kind !== "table") return dismiss();
      const fav = saveFavouriteView(name, slot, view, current);
      toast({ kind: "ok", text: fav.slot ? `Saved favourite ${fav.name} in slot ${fav.slot}` : `Saved favourite ${fav.name}` });
    } else {
      const layout = saveLayout(name, slot);
      if (layout) toast({ kind: "ok", text: layout.slot ? `Saved layout ${layout.name} in slot ${layout.slot}` : `Saved layout ${layout.name}` });
    }
    dismiss();
  };

  return (
    <Dialog
      title={kind === "view" ? "Save view as favourite" : "Save layout"}
      confirmLabel={asked && asked === question ? "Replace" : "Save"}
      confirmDisabled={!ready}
      confirmDisabledReason={name.trim() === "" ? "type a name" : slotError}
      onConfirm={save}
      onCancel={dismiss}
    >
      <Field
        label="Name"
        value={name}
        // the suggested name is selected by the dialog, so typing replaces it (J1: Ctrl+Shift+L, type, Enter)
        onChange={(e) => {
          setName(e.target.value);
          setAsked(null);
        }}
      />
      <Field
        label="Slot 1-9 (optional)"
        value={slotText}
        error={slotError}
        inputMode="numeric"
        maxLength={1}
        onChange={(e) => {
          setSlotText(e.target.value);
          setAsked(null);
        }}
      />
      {kind === "view" && <Checkbox label="Use the pane's current namespace at recall" checked={current} onChange={(e) => setCurrent(e.target.checked)} />}
      {asked && asked === question ? <p role="alert">{question}</p> : taken && slot ? <p>Slot {slot} is taken by {taken.name}.</p> : null}
    </Dialog>
  );
}
