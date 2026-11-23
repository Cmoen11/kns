// The protected flag of a context (docs/ux.md §8.2). Turning it off is tier 2: type the name.
import { confirm, toast } from "../foundation";
import { contextFlags, setContextFlags } from "../store/settings";

export async function setProtected(context: string, on: boolean): Promise<void> {
  if (contextFlags(context).protected === on) return;
  if (!on) {
    const ok = await confirm({
      tier: 2,
      title: "Remove protection",
      body: "Writes on this context will no longer ask for a typed confirmation.",
      facts: [{ label: "context", value: context }],
      typeToConfirm: context,
      confirmLabel: "Unprotect",
    });
    if (!ok) return;
  }
  setContextFlags(context, { protected: on });
  toast(on ? `${context} is protected` : `${context} is no longer protected`);
}

export const toggleProtected = (context: string): Promise<void> => setProtected(context, !contextFlags(context).protected);
