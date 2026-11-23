// Bottom-row indicator `pf N` (docs/ux.md §2.5, §13.5). Eager and tiny; renders nothing with no forwards.
import { useEffect } from "react";
import { engine } from "../../foundation";
import { actionTip, Glyph, keepFocus } from "../../ui";
import { refreshForwards, useForwards } from "./forwards";
import "./indicator.css";

export function PfIndicator() {
  const count = useForwards((s) => s.list.length);
  const broken = useForwards((s) => s.list.some((f) => f.status === "error"));
  // forwards may outlive a window reload: ask once at start
  useEffect(() => void refreshForwards(), []);
  if (count === 0) return null;
  return (
    <button type="button" className="pf-indicator t-ui" tabIndex={-1} {...actionTip("pf.open", "Port-forwards")} aria-label={`Port-forwards, ${count}`} onMouseDown={keepFocus} onClick={() => engine.run("pf.open", { source: "pointer" })}>
      {broken && <Glyph state="error" />}
      pf {count}
    </button>
  );
}
