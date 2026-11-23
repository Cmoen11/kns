// Window-chrome pieces of the side panels: the two titlebar toggles (pointer users) and the
// bottom-row count of everything live. Eager and tiny.
import { useEffect } from "react";
import { engine } from "../keys";
import { actionTip, Glyph, keepFocus, useActionState } from "../ui";
import { refreshForwards } from "../views/shell/forwards";
import { useLiveCounts } from "./activity";
import type { Side } from "./model";
import { useShown } from "./store";

/** A window outline with the panel's column filled when it is open. */
function PanelIcon({ side, open }: { side: Side; open: boolean }) {
  return (
    <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden="true" focusable="false">
      <path d="M0 0H12V10H0ZM1 1V9H11V1Z" fill="currentColor" fillRule="evenodd" />
      {open ? <rect x={side === "left" ? 1 : 8} y="1" width="3" height="8" fill="currentColor" /> : <rect x={side === "left" ? 4 : 7} y="1" width="1" height="8" fill="currentColor" />}
    </svg>
  );
}

// keepFocus on the toggles: a click must not move DOM focus, or on a narrow window the focusout
// would hide the panel first

/** Titlebar, far left: shows / hides the context sidebar. */
export function SidebarToggle() {
  const shown = useShown("left");
  const state = useActionState("sidebar.toggle");
  return (
    <button type="button" className="side-toggle" tabIndex={-1} onMouseDown={keepFocus} aria-pressed={shown} {...actionTip("sidebar.toggle", "Context sidebar", state.reason)} aria-label="Context sidebar" onClick={() => engine.run("sidebar.toggle", { source: "pointer" })}>
      <PanelIcon side="left" open={shown} />
    </button>
  );
}

/** Titlebar, far right: shows / hides the activity panel; carries the live count. */
export function ActivityToggle() {
  const shown = useShown("right");
  const { total, broken } = useLiveCounts();
  const state = useActionState("activity.toggle");
  return (
    <button type="button" className="side-toggle t-ui" tabIndex={-1} onMouseDown={keepFocus} aria-pressed={shown} {...actionTip("activity.toggle", "Activity", state.reason)} aria-label={`Activity, ${total} live`} onClick={() => engine.run("activity.toggle", { source: "pointer" })}>
      {broken && <Glyph state="error" />}
      {total > 0 && <span className="num">{total}</span>}
      <PanelIcon side="right" open={shown} />
    </button>
  );
}

/**
 * Bottom row: what is live while the activity panel is hidden (`pf 2  sh 1  log 1  op 1`). It takes
 * the place of the shell feature's port-forward indicator, so forwards are counted once, under an
 * id of its own ("live") that no width rule hides; a click opens the panel. Renders nothing when
 * nothing is live or the panel is showing.
 */
export function ActivityIndicator() {
  const shown = useShown("right");
  const c = useLiveCounts();
  // forwards may outlive a window reload: ask once at start
  useEffect(() => void refreshForwards(), []);
  if (shown || c.total === 0) return null;
  const parts: [string, number][] = [["pf", c.forwards], ["sh", c.sessions], ["log", c.logs], ["op", c.operations]];
  return (
    <button type="button" className="side-indicator t-ui" tabIndex={-1} onMouseDown={keepFocus} {...actionTip("activity.focus", "Show activity")} aria-label={`Activity, ${c.total} live`} onClick={() => engine.run("activity.focus", { source: "pointer" })}>
      {c.broken && <Glyph state="error" />}
      {parts
        .filter(([, n]) => n > 0)
        .map(([word, n]) => (
          <span key={word}>
            {word} {n}
          </span>
        ))}
    </button>
  );
}
