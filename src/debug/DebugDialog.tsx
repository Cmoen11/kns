// The debug dialog (`B`, `:debug`, `:debug copy`): image (presets from settings.debugImages and
// recent ones, editable), the target container, and what the write does. Enter adds / creates.
import { useState } from "react";
import type { OverlayProps } from "../foundation";
import { Dialog, Facts, Field, RadioGroup } from "../ui";
import type { DebugDialogProps } from "./flows";
import { floatingTag, fullImage, validImage } from "./model";

const NONE = "";

export default function DebugDialog({ props, close }: OverlayProps<DebugDialogProps>) {
  const copy = props.mode === "copy";
  const [image, setImage] = useState(copy ? NONE : (props.images[0] ?? ""));
  const [target, setTarget] = useState(props.target ?? props.containers[0] ?? "");
  const trimmed = image.trim();
  const ok = copy ? trimmed === NONE || validImage(trimmed) : validImage(trimmed);
  const done = (r: { image: string; target?: string } | null) => {
    props.resolve(r);
    close();
  };
  const presets = [...(copy ? [{ value: NONE, label: "No extra container" }] : []), ...props.images.map((i) => ({ value: i, label: i }))];
  const radioValue = presets.some((p) => p.value === trimmed) ? trimmed : "other";
  const options = radioValue === "other" ? [...presets, { value: "other", label: "Other (typed above)" }] : presets;

  return (
    <Dialog
      title={copy ? `Debug a copy of ${props.pod}` : `Debug container in ${props.pod}`}
      confirmLabel={copy ? "Next" : props.protected ? "Next" : "Add and open shell"}
      confirmDisabled={!ok}
      confirmDisabledReason={ok ? undefined : "not an image reference"}
      onConfirm={() => ok && done({ image: trimmed, target: target || undefined })}
      onCancel={() => done(null)}
    >
      <Facts
        facts={[
          { label: "pod", value: props.pod },
          { label: "namespace", value: props.namespace },
          { label: "context", value: props.protected ? `${props.context}  PROTECTED` : props.context },
        ]}
      />
      <Field
        label={copy ? "Debug image (empty: none)" : "Image"}
        value={image}
        spellCheck={false}
        onChange={(e) => setImage(e.target.value)}
        error={trimmed !== "" && !validImage(trimmed) ? "no spaces or control characters, at most 255" : undefined}
      />
      <RadioGroup legend="Presets" name="debug-image" value={radioValue} options={options} onChange={(v) => v !== "other" && setImage(v)} />
      {props.containers.length > 1 && (
        <RadioGroup
          legend={copy ? "Container that sleeps instead of running" : "Share processes with"}
          name="debug-target"
          value={target}
          options={props.containers.map((c) => ({ value: c, label: c }))}
          onChange={setTarget}
        />
      )}
      <div className="t-ui-multi debug-lines" dir="ltr">
        {trimmed !== "" && validImage(trimmed) && (
          <div>
            pulls <span className="t-mono selectable">{fullImage(trimmed)}</span>
            {floatingTag(trimmed) ? " (floating tag: pin a version)" : ""}
          </div>
        )}
        {copy ? (
          <>
            <div>
              Creates pod <span className="t-mono">{props.pod}-debug-xxxxx</span>: every label dropped (no Service or ReplicaSet picks it up), probes removed,{" "}
              <span className="t-mono">{target}</span> runs <span className="t-mono">sleep 3600</span>, deleted after 1 h at the latest.
            </div>
            {trimmed !== NONE && <div>The debug image runs as an extra container sharing the process namespace.</div>}
            <div>Delete it from Activity → Debug pods.</div>
          </>
        ) : (
          <div>Ephemeral containers cannot be removed; it goes away with the pod.</div>
        )}
      </div>
    </Dialog>
  );
}
