// Feature: command palette, `:` command line, `/` filter bar, pickers, favourites, the which-key
// panel, the context menu and the help overlay (docs/ux.md §5.5, §6, §7, §8, §11.10).
// Owner: the palette team; edit only inside src/palette. No view kinds.
import { registerOverlay, registerShellItem } from "../foundation";
import "./actions";
import { CONTEXT_ALIAS_OVERLAY } from "./overlays";
import { LayoutName } from "./LayoutName";

export function register(): void {
  // which-key panel, the pane-header bars and the namespace recency tracker
  registerOverlay("palette.host", () => import("./Host"), { always: true });
  registerOverlay("palette", () => import("./Palette"));
  registerOverlay("palette.picker", () => import("./Picker"));

  registerOverlay("palette.menu", () => import("./Menu"));
  registerOverlay("palette.save", () => import("./SaveDialog"));
  registerOverlay(CONTEXT_ALIAS_OVERLAY, () => import("./ContextAliasDialog"));
  registerShellItem({ id: "layout", area: "titlebar", component: LayoutName });

  // warm the chunks once the first frame is out, so the first Ctrl/Cmd+K is instant
  if (typeof window !== "undefined") {
    const warm = () => {
      void import("./Palette");
      void import("./Picker");
      void import("./Menu");
    };
    if ("requestIdleCallback" in window) window.requestIdleCallback(warm, { timeout: 3000 });
    else setTimeout(warm, 1500);
  }
}

// For the table team (docs/frontend.md says features import from src/foundation.ts: these need a
// re-export there). namespace.favN reads the slot; the header's `FAV n` label reads the match.
export { namespaceInSlot, noteNamespaceUsed, favouriteFor } from "./favourites/store";

