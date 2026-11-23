// Titlebar item: the name of the saved layout on screen, with a mark once it was edited (§7.2).
import { tip, useWorkspace } from "../foundation";
import { useFav } from "./favourites/store";

export function LayoutName() {
  const id = useWorkspace((ws) => ws?.layoutId);
  const dirty = useWorkspace((ws) => ws?.dirty === true);
  const name = useFav((s) => (id ? s.layouts.find((l) => l.id === id)?.name : undefined));
  if (!name) return null;
  return (
    <span className="t-ui" {...tip("Layout", { reason: dirty ? "edited since it was saved" : undefined })}>
      {name}
      {dirty ? " (edited)" : ""}
    </span>
  );
}
