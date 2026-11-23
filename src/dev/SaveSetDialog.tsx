// "Save as dev set" (`s` in the env view, `:dev save`): name and start-with-kns; what is saved is
// listed. Rust validates and stores it; a human save is approved as saved.
import { useState } from "react";
import type { OverlayProps } from "../foundation";
import { Checkbox, Dialog, Field } from "../ui";
import type { SaveSetProps } from "./flows";
import { validSetName } from "./model";

export default function SaveSetDialog({ props, close }: OverlayProps<SaveSetProps>) {
  const [name, setName] = useState(props.name);
  const [autoStart, setAutoStart] = useState(props.autoStart);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ok = validSetName(name.trim());
  const reason = busy ? "saving" : !ok ? "1-40 of a-z 0-9 -" : null;
  return (
    <Dialog
      title={props.title}
      confirmLabel="Save"
      confirmDisabled={reason !== null}
      confirmDisabledReason={reason ?? undefined}
      onConfirm={() => {
        if (reason !== null) return;
        setBusy(true);
        setError(null);
        void props.onSave(name.trim(), autoStart).then((err) => {
          setBusy(false);
          if (err) setError(err);
          else close();
        });
      }}
      onCancel={() => {
        close();
        props.onCancel();
      }}
    >
      <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} error={name !== "" && !ok ? "1-40 of a-z 0-9 -" : undefined} />
      <Checkbox label="Start with kns (after connecting this context)" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
      <div className="t-ui-multi dev-lines" dir="ltr">
        {props.lines.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
      {error && (
        <p className="t-ui-multi" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
