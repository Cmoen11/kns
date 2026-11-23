// `:x` without a name: the snippets that fit the container (made for its image first), and the
// container when the pod has several. Arrows choose, Enter runs.
import { useEffect, useMemo, useRef, useState } from "react";
import type { OverlayProps } from "../foundation";
import { Dialog, RadioGroup } from "../ui";
import type { SnippetDialogProps } from "./flows";
import { snippetsFor } from "./model";

export default function SnippetDialog({ props, close }: OverlayProps<SnippetDialogProps>) {
  const [container, setContainer] = useState(props.container);
  const image = props.containers.find((c) => c.name === container)?.image ?? "";
  const list = useMemo(() => snippetsFor(props.user, image), [props.user, image]);
  const [id, setId] = useState(list[0]?.id ?? "");
  const chosen = list.find((s) => s.id === id) ?? list[0];
  const body = useRef<HTMLDivElement>(null);
  const done = (ok: boolean) => {
    props.resolve(ok && chosen ? { snippet: chosen, container } : null);
    close();
  };
  // start on the choice so the arrows work at once (the Dialog focuses its primary)
  useEffect(() => {
    body.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
  }, []);
  return (
    <Dialog title={`Run a snippet in ${props.pod}`} confirmLabel="Run" confirmDisabled={!chosen} onConfirm={() => done(true)} onCancel={() => done(false)}>
      <div ref={body}>
        <RadioGroup
          legend="Snippet"
          name="snippet"
          value={chosen?.id ?? ""}
          options={list.map((s) => ({ value: s.id, label: `${s.id} · ${s.title}${s.builtIn ? "" : " (yours)"}` }))}
          onChange={setId}
        />
        {props.containers.length > 1 && (
          <RadioGroup
            legend="Container"
            name="snippet-container"
            value={container}
            options={props.containers.map((c) => ({ value: c.name, label: `${c.name} · ${c.image}` }))}
            onChange={setContainer}
          />
        )}
        {chosen && (
          <div className="t-ui-multi debug-lines" dir="ltr">
            <div>
              Runs <span className="t-mono selectable">sh -c {chosen.command}</span> once as an exec in <span className="t-mono">{container}</span>.
            </div>
            <div>The output opens as text, with secret-looking values masked. Save your own with :x save &lt;name&gt; &lt;command&gt;.</div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
