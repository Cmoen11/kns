// Container picker shown before a shell opens in a pod with several containers (docs/ux.md §13.4).
// A dialog with one radio group: arrows choose, Enter opens, Esc cancels (the dialog.* actions).
import { useEffect, useRef, useState } from "react";
import type { OverlayProps } from "../../foundation";
import { Dialog, RadioGroup } from "../../ui";
import type { ContainerPickProps } from "./open";

const SUFFIX = { container: "", ephemeral: " (ephemeral)", init: " (init)" } as const;

export default function ContainerDialog({ props, close }: OverlayProps<ContainerPickProps>) {
  const [value, setValue] = useState(props.options[0]?.name ?? "");
  const body = useRef<HTMLDivElement>(null);
  const done = (container: string | null) => {
    props.resolve(container);
    close();
  };
  // the Dialog focuses its primary button; start on the choice instead so the arrows work at once
  useEffect(() => {
    body.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
  }, []);
  return (
    <Dialog
      title={props.kind === "attach" ? `Attach to ${props.pod}` : `Shell in ${props.pod}`}
      confirmLabel="Open"
      onConfirm={() => done(value)}
      onCancel={() => done(null)}
    >
      <div ref={body}>
        <RadioGroup
          legend="Container"
          name="shell-container"
          value={value}
          options={props.options.map((o) => ({ value: o.name, label: `${o.name}${SUFFIX[o.group]}` }))}
          onChange={setValue}
        />
      </div>
    </Dialog>
  );
}
