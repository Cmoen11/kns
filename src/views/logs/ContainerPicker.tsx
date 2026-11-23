// Container picker (`o`, docs/ux.md §13.3): all containers or one, init and ephemeral included.
// An overlay, because pane frames clip their content; its keys are the dialog.* actions.
import { useEffect, useMemo, useRef, useState } from "react";
import { paneView, patchView, type OverlayProps } from "../../foundation";
import type { PaneId } from "../../types";
import { Dialog, RadioGroup } from "../../ui";
import { logsOf } from "./sessions";
import { containerChoices } from "./targets";

export default function ContainerPicker({ props, close }: OverlayProps<{ pane: PaneId }>) {
  const pane = props.pane;
  const pl = logsOf(pane);
  const view = paneView(pane);
  const current = view?.kind === "logs" ? view.container : "*";
  const choices = useMemo(() => {
    const out = containerChoices(pl?.streams.pods ?? []);
    // a container that no resolved pod has (yet) stays selectable
    return out.some((c) => c.value === current) ? out : [...out, { value: current, label: current }];
  }, [pl, current]);
  const [value, setValue] = useState(current);
  const body = useRef<HTMLDivElement>(null);
  const usable = !!pl && view?.kind === "logs";

  useEffect(() => {
    if (!usable) close();
    // the arrow keys act on the focused radio; this runs after the dialog's own focus
    else body.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
  }, [usable, close]);

  if (!usable) return null;
  const confirm = () => {
    if (value !== "*") pl.lastContainer = value;
    if (value !== current) patchView(pane, "logs", { container: value });
    close();
  };
  return (
    <Dialog title="Container" confirmLabel="Show" onConfirm={confirm} onCancel={close}>
      <div ref={body}>
        <RadioGroup legend="Stream logs from" name="logs-container" value={value} options={choices} onChange={setValue} />
      </div>
    </Dialog>
  );
}
