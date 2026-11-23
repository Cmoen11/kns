// Titlebar: the current context's health in one word ("3 failing" in the error hue, "2 warnings"),
// a click opens the faults view of every namespace (health.faults). Absent while healthy, unknown
// or turned off: the titlebar stays quiet when there is nothing to look at.
import { engine } from "../keys";
import { actionTip, Glyph, keepFocus } from "../ui";
import { useHealth } from "./health";

export function HealthSummary() {
  const t = useHealth((s) => s.totals);
  if (t.count === 0 || !t.severity) return null;
  const word = t.failing > 0 ? `${t.failing} failing` : `${t.count} warning${t.count === 1 ? "" : "s"}`;
  const where = `${t.namespaces} namespace${t.namespaces === 1 ? "" : "s"}`;
  return (
    <button
      type="button"
      className="health-summary t-ui num"
      data-state={t.severity}
      tabIndex={-1}
      onMouseDown={keepFocus}
      aria-label={`${word} in ${where}. Show the faults`}
      {...actionTip("health.faults", `${word} in ${where}`, t.failing > 0 && t.count > t.failing ? `${t.count - t.failing} more warning${t.count - t.failing === 1 ? "" : "s"}` : undefined)}
      onClick={(e) => engine.run("health.faults", { source: "pointer", newPane: e.ctrlKey || e.metaKey ? "right" : null })}
    >
      <Glyph state={t.severity} />
      {word}
    </button>
  );
}
