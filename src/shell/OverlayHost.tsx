// Mounts the overlays features registered (palette, help, pickers, which-key panel).
import { Suspense } from "react";
import { closeOverlay, useShell } from "./slots";

export function OverlayHost() {
  const overlays = useShell((s) => s.overlays);
  const open = useShell((s) => s.open);
  return (
    <Suspense fallback={null}>
      {overlays
        .filter((o) => o.always)
        .map((o) => (
          <o.component key={o.name} props={undefined} close={() => closeOverlay(o.name)} />
        ))}
      {open.map((entry) => {
        const def = overlays.find((o) => o.name === entry.name && !o.always);
        return def ? <def.component key={entry.key} props={entry.props} close={() => closeOverlay(entry.name)} /> : null;
      })}
    </Suspense>
  );
}
