// Export / copy-as dialog of the env view (docs/plan-features.md §3 B-dev): format, destination
// (file in a save dialog Rust opens, or the clipboard); on a protected context the workload name
// must be typed (tier 2). B2: "Mounted files" writes the workload's ConfigMap / Secret volumes to a
// folder Rust asks for (humans only; Secret volumes start unticked).
import { useEffect, useState } from "react";
import { backend, type OverlayProps } from "../foundation";
import type { EnvFormat, VolumeInfo } from "../ipc/types";
import { Checkbox, Dialog, Facts, Field, Literal, RadioGroup } from "../ui";
import { cleanUntrusted } from "../ui/untrusted";
import type { ExportProps } from "./flows";
import { errorText } from "./store";

const FORMATS: readonly { value: EnvFormat; label: string }[] = [
  { value: "dotenv", label: ".env (KEY=value)" },
  { value: "powershell", label: "PowerShell ($env:KEY = 'value')" },
  { value: "posix", label: "POSIX shell (export KEY='value')" },
];

/** `config · configmap/orders · 2 files → /config` */
export function volumeLabel(v: VolumeInfo): string {
  const what = `${v.source === "secret" ? "secret" : "configmap"}/${cleanUntrusted(v.object, 120)}`;
  const files = v.readable ? `${v.files.length} file${v.files.length === 1 ? "" : "s"}` : `not readable${v.message ? ` (${cleanUntrusted(v.message, 80)})` : ""}`;
  return `${cleanUntrusted(v.id, 120)} · ${what} · ${files}${v.mountPath ? ` → ${cleanUntrusted(v.mountPath, 120)}` : ""}`;
}

export default function ExportDialog({ props, close }: OverlayProps<ExportProps>) {
  const { workload, context, keys, secretKeys, clipboardOnly, typeToConfirm, volumesOf, onExport, onExportVolumes, onCancel } = props;
  const [what, setWhat] = useState<"env" | "volumes">("env");
  const [format, setFormat] = useState<EnvFormat>("dotenv");
  const [destination, setDestination] = useState<"file" | "clipboard">(clipboardOnly ? "clipboard" : "file");
  const [typed, setTyped] = useState("");
  const [volumes, setVolumes] = useState<VolumeInfo[] | null>(null);
  const [volError, setVolError] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (what !== "volumes" || volumes !== null || !volumesOf) return;
    let alive = true;
    backend.volumesList(volumesOf.ref, volumesOf.container).then(
      (r) => {
        if (!alive) return;
        setVolumes(r.volumes);
        // ConfigMaps ticked; Secret data only when the human ticks it
        setPicked(new Set(r.volumes.filter((v) => v.readable && v.source === "configMap" && v.files.length > 0).map((v) => v.id)));
      },
      (e: unknown) => alive && setVolError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [what, volumes, volumesOf]);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  const chosen = (volumes ?? []).filter((v) => picked.has(v.id));
  const files = chosen.reduce((n, v) => n + v.files.length, 0);
  const secretFiles = chosen.filter((v) => v.source === "secret").reduce((n, v) => n + v.files.length, 0);

  const typedReason = typeToConfirm !== undefined && typed.trim() !== typeToConfirm ? `type ${typeToConfirm}` : null;
  const volReason = what !== "volumes" ? null : volumes === null ? (volError ? "the volumes could not be read" : "loading volumes") : chosen.length === 0 ? "tick a volume" : null;
  const reason = volReason ?? typedReason;
  const title = clipboardOnly ? "Copy env as" : what === "volumes" ? "Export mounted files" : "Export env";
  return (
    <Dialog
      title={title}
      confirmLabel={what === "volumes" ? "Choose folder…" : destination === "file" ? "Choose file…" : "Copy"}
      confirmDisabled={reason !== null}
      confirmDisabledReason={reason ?? undefined}
      onConfirm={() => {
        if (reason !== null) return;
        close();
        // the typed name goes to Rust, which checks it again on a protected context
        const confirmText = typeToConfirm !== undefined ? typed.trim() : undefined;
        if (what === "volumes") onExportVolumes?.(chosen.map((v) => v.id), confirmText);
        else onExport(format, destination, confirmText);
      }}
      onCancel={() => {
        close();
        onCancel();
      }}
    >
      <Facts
        facts={[
          { label: "workload", value: workload },
          { label: "context", value: context },
          what === "volumes" ? { label: "files", value: `${files} (${secretFiles} from secrets)` } : { label: "keys", value: `${keys} (${secretKeys} from secrets)` },
        ]}
      />
      {volumesOf && onExportVolumes && (
        <RadioGroup
          legend="What"
          name="env-what"
          value={what}
          options={[
            { value: "env", label: "The env (keys and values)" },
            { value: "volumes", label: "Mounted files (ConfigMap and Secret volumes) to a folder" },
          ]}
          onChange={setWhat}
        />
      )}
      {what === "env" && (
        <>
          <RadioGroup legend="Format" name="env-format" value={format} options={FORMATS} onChange={setFormat} />
          {!clipboardOnly && (
            <RadioGroup
              legend="Destination"
              name="env-dest"
              value={destination}
              options={[
                { value: "file", label: "A file (save dialog)" },
                { value: "clipboard", label: "The clipboard (clears itself)" },
              ]}
              onChange={setDestination}
            />
          )}
          {secretKeys > 0 && <p className="t-ui-multi">{secretKeys === 1 ? "The secret value is" : `The ${secretKeys} secret values are`} written in plain text. Untick keys in the env view to leave them out.</p>}
        </>
      )}
      {what === "volumes" && (
        <>
          {volumes !== null && volumes.length === 0 && <p className="t-ui-multi">The container mounts no ConfigMap or Secret.</p>}
          {(volumes ?? []).map((v) => (
            <Checkbox key={v.id} label={volumeLabel(v)} checked={picked.has(v.id)} disabled={!v.readable || v.files.length === 0} onChange={(e) => toggle(v.id, e.target.checked)} />
          ))}
          {volError && (
            <p className="t-ui-multi" role="alert">
              {volError}
            </p>
          )}
          <p className="t-ui-multi">
            Each volume goes to its own subfolder. Files are written as they are mounted{secretFiles > 0 ? ", Secret data in plain text" : ""}; anything running as you can read
            them. A folder inside a git work tree must be git-ignored, or kns asks first.
          </p>
        </>
      )}
      {typeToConfirm !== undefined && (
        <Field
          label={
            <>
              Protected context: type <Literal>{typeToConfirm}</Literal>
            </>
          }
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      )}
    </Dialog>
  );
}
