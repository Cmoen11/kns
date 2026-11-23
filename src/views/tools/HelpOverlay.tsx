// The help overlay (`?`, docs/ux.md §11.10): every built action with its live keys, grouped, in
// two columns; disabled ones say why; unbuilt ones are listed as plain text (principle 12).
// It is a dialog surface: Esc and Enter close it, Tab reaches the list, which scrolls natively.
import { useMemo, useState } from "react";
import { registry, type ActionDef } from "../../actions";
import { engine, paneView, type OverlayProps } from "../../foundation";
import { toolForView } from "../../hub/catalog";
import { keymap, platform, type AvailableAction } from "../../keys";
import { Button, CLIP_DELAY, Dialog, Field, KeyChip, Keys, keepFocus, tip } from "../../ui";
import "./tools.css";

export interface HelpProps {
  /** engine.available() from just before the overlay opened: the focused pane's actions and reasons */
  available: readonly AvailableAction[];
}

interface HelpRow {
  def: ActionDef;
  bindings: string[][];
  /** applicable in the pane the overlay was opened from */
  here: boolean;
  reason?: string;
  search: string;
}

function buildRows(available: readonly AvailableAction[]): { groups: { name: string; rows: HelpRow[] }[]; missing: { name: string; labels: string[] }[] } {
  const live = new Map(available.map((a) => [a.action.id, a]));
  const groups = new Map<string, HelpRow[]>();
  const missing = new Map<string, string[]>();
  for (const def of registry.list()) {
    if (def.alias) continue;
    if (!def.built) {
      const l = missing.get(def.group);
      if (l) l.push(def.label);
      else missing.set(def.group, [def.label]);
      continue;
    }
    const bindings = keymap.display(def.id, platform);
    const a = live.get(def.id);
    const row: HelpRow = {
      def,
      bindings,
      here: !!a,
      reason: a && !a.enabled ? a.reason : undefined,
      search: `${def.label} ${def.id} ${def.group} ${def.command ? `:${def.command}` : ""} ${bindings.map((b) => b.join(" ")).join(" ")}`.toLowerCase(),
    };
    const l = groups.get(def.group);
    if (l) l.push(row);
    else groups.set(def.group, [row]);
  }
  return {
    groups: [...groups].map(([name, rows]) => ({ name, rows })),
    missing: [...missing].map(([name, labels]) => ({ name, labels })),
  };
}

export default function HelpOverlay({ props, close }: OverlayProps<HelpProps>) {
  const [query, setQuery] = useState("");
  const all = useMemo(() => buildRows(props?.available ?? []), [props]);
  const groups = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return all.groups;
    return all.groups
      .map((g) => ({ name: g.name, rows: g.rows.filter((r) => terms.every((t) => r.search.includes(t))) }))
      .filter((g) => g.rows.length > 0);
  }, [all, query]);
  const overrides = keymap.overrides();
  // Tools hub lines (I): the tool the focused view belongs to, and the hub with its key
  const thisTool = toolForView(paneView());
  const hubBuilt = !!registry.get("hub.open")?.built;
  const openHub = (args: string[]) => {
    close();
    engine.run("hub.open", { source: "pointer", args });
  };

  return (
    <div className="help">
      <Dialog title="Keys" confirmLabel="Close" cancelLabel="Cancel" onConfirm={close} onCancel={close}>
        {thisTool && hubBuilt && (
          <p className="t-ui">
            Tools hub entry for this view: {thisTool.title}.{" "}
            <Button variant="tertiary" tabIndex={-1} onMouseDown={keepFocus} onClick={() => openHub([thisTool.id])}>
              Open it
            </Button>
          </p>
        )}
        <Field label="Search keys and actions" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="help-list" tabIndex={0} role="list" aria-label="Actions">
          {groups.map((g) => (
            <section className="help-group" key={g.name}>
              <h3 className="help-group-label t-label">{g.name}</h3>
              {g.rows.map((r) => (
                <div className="help-row t-row" role="listitem" key={r.def.id} data-disabled={r.reason ? true : undefined} {...tip(r.def.id, { plain: true, delay: CLIP_DELAY })}>
                  <span className="help-label">{r.def.label}</span>
                  <span className="help-reason t-ui">
                    {r.reason ?? (r.def.command && r.bindings.length === 0 ? `:${r.def.command}` : overrides[r.def.id] ? "remapped" : "")}
                  </span>
                  <span className="help-keys">
                    {r.bindings.slice(0, 2).map((b, i) => (
                      <KeyChip key={i} binding={b} disabled={!!r.reason} />
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
          {groups.length === 0 && <p className="t-body">Nothing matches “{query}”</p>}
          {query === "" && all.missing.length > 0 && (
            <div className="help-missing t-ui-multi">
              <h3 className="t-label">Not in kns yet</h3>
              {all.missing.map((m) => (
                <p key={m.name}>
                  {m.name}: {m.labels.join(", ")}
                </p>
              ))}
              {platform === "win" && <p>Alt chords need the left Alt key; the right one is AltGr.</p>}
            </div>
          )}
        </div>
        {hubBuilt && (
          <p className="t-ui">
            <Button variant="tertiary" tabIndex={-1} onMouseDown={keepFocus} onClick={() => openHub([])}>
              Tools hub
            </Button>{" "}
            <Keys action="hub.open" /> every tool: what it answers and how to start it
          </p>
        )}
      </Dialog>
    </div>
  );
}
