// "Copy connection string" (docs/plan-features.md §3 B2, `pf.copyUrl`): no credentials, or a Secret
// key the human picks (key names only reach the webview). Rust builds the string; with a Secret it
// writes the clipboard itself and the dialog's caller only gets a masked preview. The pick is kept
// in the forward's dev set while that set is approved, else for this forward until it stops.
import { useEffect, useMemo, useState } from "react";
import { backend, type OverlayProps } from "../foundation";
import type { SecretKeyRef, SecretKeys } from "../ipc/types";
import { Checkbox, Dialog, Facts, Field, RadioGroup } from "../ui";
import { cleanUntrusted } from "../ui/untrusted";
import type { ConnProps } from "./conn";
import { errorText } from "./store";

const MAX_SECRETS = 10;

export default function ConnDialog({ props, close }: OverlayProps<ConnProps>) {
  const { forward: f, info, setName, onCopy } = props;
  const [mode, setMode] = useState<"none" | "secret">(info.remembered ? "secret" : "none");
  const [secrets, setSecrets] = useState<SecretKeys[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [secret, setSecret] = useState(info.remembered?.name ?? "");
  const [key, setKey] = useState(info.remembered?.key ?? "");
  const [remember, setRemember] = useState(true);

  useEffect(() => {
    if (mode !== "secret" || secrets !== null) return;
    let alive = true;
    backend.connSecretsList(f.context, f.namespace).then(
      (list) => alive && setSecrets(list),
      (e: unknown) => alive && setError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [mode, secrets, f.context, f.namespace]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (secrets ?? []).filter((s) => !q || s.name.toLowerCase().includes(q));
    // the picked one stays visible
    const picked = list.find((s) => s.name === secret);
    const head = list.filter((s) => s !== picked).slice(0, picked ? MAX_SECRETS - 1 : MAX_SECRETS);
    return picked ? [picked, ...head] : head;
  }, [secrets, filter, secret]);
  const chosen = secrets?.find((s) => s.name === secret);
  const keyOk = chosen?.keys.includes(key) ?? false;
  const pick: SecretKeyRef | undefined = mode === "secret" && chosen && keyOk ? { namespace: f.namespace, name: chosen.name, key } : undefined;
  const changed = pick !== undefined && (pick.name !== info.remembered?.name || pick.key !== info.remembered?.key);

  const reason: string | null = mode !== "secret" ? null : !chosen ? (secrets === null ? "loading Secrets" : "pick a Secret") : !keyOk ? "pick a key" : null;
  const rememberLabel =
    info.devSet && info.devSetApproved ? `Remember it in dev set ${setName ?? info.devSet}` : "Remember it for this forward (until it stops)";

  return (
    <Dialog
      title="Copy connection string"
      confirmLabel="Copy"
      confirmDisabled={reason !== null}
      confirmDisabledReason={reason ?? undefined}
      onConfirm={() => {
        if (reason) return;
        close();
        onCopy({ plain: mode === "none", secret: changed ? pick : undefined, remember: changed ? remember : undefined });
      }}
      onCancel={close}
    >
      <Facts
        facts={[
          { label: "forward", value: `${f.target.kind}/${f.target.name} → ${f.address}:${f.localPort}` },
          { label: "kind", value: info.kind },
          { label: "plain", value: info.plain },
        ]}
      />
      <RadioGroup
        legend="Credentials"
        name="conn-mode"
        value={mode}
        options={[
          { value: "none", label: `None: ${info.plain}` },
          { value: "secret", label: `From a Secret in ${f.namespace} (URL, DSN or password)` },
        ]}
        onChange={setMode}
      />
      {mode === "secret" && (
        <>
          {(secrets?.length ?? 0) > MAX_SECRETS && <Field label="Filter Secrets" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="name" />}
          {secrets !== null && secrets.length === 0 && <p className="t-ui-multi">No Secret in {f.namespace}.</p>}
          {shown.length > 0 && (
            <RadioGroup
              legend="Secret"
              name="conn-secret"
              value={secret}
              options={shown.map((s) => ({ value: s.name, label: `${cleanUntrusted(s.name, 120)} · ${s.keys.length} key${s.keys.length === 1 ? "" : "s"}` }))}
              onChange={(v) => {
                setSecret(v);
                const keys = secrets?.find((s) => s.name === v)?.keys ?? [];
                setKey(keys.find((k) => /url|dsn|uri/i.test(k)) ?? keys.find((k) => /pass/i.test(k)) ?? keys[0] ?? "");
              }}
            />
          )}
          {chosen && chosen.keys.length > 0 && (
            <RadioGroup legend="Key" name="conn-key" value={key} options={chosen.keys.map((k) => ({ value: k, label: cleanUntrusted(k, 120) }))} onChange={setKey} />
          )}
          {changed && <Checkbox label={rememberLabel} checked={remember} onChange={(e) => setRemember(e.target.checked)} />}
          <p className="t-ui-multi">
            kns reads the value, builds the string and copies it; the clipboard clears itself. Values are never shown here.
          </p>
        </>
      )}
      {error && (
        <p className="t-ui-multi" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
