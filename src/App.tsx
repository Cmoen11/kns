// The window frame (docs/ux.md §2): titlebar 32, pane area, bottom row 20, plus the hosts every
// feature relies on (dialogs, toasts, overlays, the live region). The two side panels sit beside
// the pane tree and render nothing while closed.
import { PaneTree } from "./panes/PaneTree";
import { BottomRow } from "./shell/BottomRow";
import { OverlayHost } from "./shell/OverlayHost";
import { SidePanel } from "./sidepanels";
import { Titlebar } from "./shell/Titlebar";
import { DialogHost, GlyphSprite, LiveRegion, ToastHost, TooltipHost } from "./ui";

export default function App() {
  return (
    <>
      <GlyphSprite />
      <div className="app">
        <Titlebar />
        <main className="app-main">
          <SidePanel side="left" />
          <PaneTree />
          <SidePanel side="right" />
        </main>
        <BottomRow />
      </div>
      <OverlayHost />
      <DialogHost />
      <ToastHost />
      <LiveRegion />
      {/* last: the one tooltip paints over everything, dialogs and menus included */}
      <TooltipHost />
    </>
  );
}
