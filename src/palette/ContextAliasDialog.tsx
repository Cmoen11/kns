// Naming a context (docs/ux.md §8.2): the alias kns shows on tabs, pickers and pane crumbs, and
// accepts after `:ctx` and `@`. The kubeconfig name stays the key everything is stored under and
// is what a protected context's typed confirmation asks for. Empty clears the alias.
import { useState } from "react";
import { Dialog, Facts, Field, getCluster, toast, type OverlayProps } from "../foundation";
import { ALIAS_MAX, aliasProblem, contextFlags, setContextAlias } from "../store/settings";

export default function ContextAliasDialog({ props, close }: OverlayProps<{ context: string }>) {
  const context = props.context;
  const [value, setValue] = useState(contextFlags(context).alias ?? "");
  const problem = aliasProblem(context, value, getCluster().contexts.map((c) => c.name));
  const save = () => {
    if (problem) return;
    const alias = value.trim();
    const before = contextFlags(context).alias;
    setContextAlias(context, alias);
    close();
    if ((alias || undefined) !== before) toast(alias && alias !== context ? `${context} is shown as ${alias}` : `${context} is shown by its own name`);
  };
  return (
    <Dialog title="Context alias" confirmLabel="Save" confirmDisabled={problem !== null} confirmDisabledReason={problem ?? undefined} onConfirm={save} onCancel={close}>
      <Facts facts={[{ label: "context", value: context }]} />
      <Field
        label="Alias (empty: the kubeconfig name)"
        value={value}
        maxLength={ALIAS_MAX}
        placeholder={context}
        error={problem ?? undefined}
        onChange={(e) => setValue(e.target.value)}
      />
    </Dialog>
  );
}
