// What the dev-set and env actions do (docs/plan-features.md §3 B-dev). Eager and small: dialogs
// are lazy overlays, opened with a resolve callback.
import { backend, confirm, contextFlags, focusedContext, flash, getSettings, openView, recordAction, showOverlay, toast, toasts } from "../foundation";
import type { DevSet, DevSetDraft, EnvExportRequest, EnvExportResult, EnvFormat, EnvReport, EnvSpec, ObjRef, VolumesExportRequest } from "../ipc/types";
import { getForwards, refreshForwards } from "../views/shell/forwards";
import { approved, draftFromForwards, secretKeysOf } from "./model";
import { devSetById, errorText, refreshDevSets } from "./store";

export const OVERLAY = {
  picker: "dev.picker",
  approve: "dev.approve",
  export: "dev.export",
  save: "dev.save",
} as const;

// ── approval list ──

export interface ApproveChoice {
  /** secret-sourced keys ticked (export only) */
  includeSecrets: string[];
  /** typed text, when tier 2 */
  typed?: string;
  /** the hash of the set as shown */
  shownHash: string;
}

/** Props of ApproveSetDialog (also used by H2 for agent proposals). */
export interface ApproveSetProps {
  set: DevSet;
  /** "requested by: claude-code (token …)" etc.; shown as facts */
  facts?: { label: string; value: string }[];
  /** agent's note, untrusted */
  reason?: string;
  /** side-effect warnings of the set's env workload */
  warnings?: string[];
  /** with an export: secret-sourced keys, shown unticked */
  exportSecrets?: string[];
  /** the context is protected: type its name */
  protectedContext?: boolean;
  confirmLabel?: string;
  onApprove: (choice: ApproveChoice) => void;
  onCancel: () => void;
}

/** Shows the approval list; resolves with the choice, or null when cancelled. */
export function askApproval(props: Omit<ApproveSetProps, "onApprove" | "onCancel">): Promise<ApproveChoice | null> {
  return new Promise((resolve) => {
    showOverlay(OVERLAY.approve, { ...props, onApprove: resolve, onCancel: () => resolve(null) } satisfies ApproveSetProps);
  });
}

/** The env report of a set's workload (warnings, secret keys); null when it has no env or fails. */
async function envOf(set: DevSet): Promise<EnvReport | null> {
  if (!set.env) return null;
  const w = set.env.workload;
  try {
    return await backend.envResolve({ context: set.context, gvr: w.gvr, namespace: w.namespace, name: w.name }, set.env.container);
  } catch {
    return null;
  }
}

// ── start / stop / delete ──

/** Starts a set: an approved, unchanged set at once; anything else after the approval list. */
export async function startSet(set: DevSet): Promise<void> {
  let hash = set.hash;
  if (!approved(set)) {
    const report = await envOf(set);
    const choice = await askApproval({
      set,
      warnings: report?.warnings,
      protectedContext: contextFlags(set.context).protected,
      confirmLabel: "Start",
    });
    if (!choice) return;
    hash = choice.shownHash;
  }
  try {
    const started = await backend.devSetUp(set.id, hash);
    void refreshForwards();
    void refreshDevSets();
    const waiting = started.filter((f) => f.status === "waiting").length;
    recordAction({ text: `dev set ${set.name} up · ${started.length} forward${started.length === 1 ? "" : "s"}${waiting ? ` · ${waiting} waiting` : ""}`, state: waiting ? "warn" : "ok", context: set.context, target: { kind: "devset", id: set.id } });
    toast({ kind: waiting ? "warn" : "ok", text: `Dev set ${set.name} up · ${started.length} forward${started.length === 1 ? "" : "s"}${waiting ? ` · ${waiting} waiting` : ""}` });
  } catch (e) {
    recordAction({ text: `dev set ${set.name} up failed`, state: "error", error: errorText(e), context: set.context, target: { kind: "devset", id: set.id } });
    toasts.error(`Could not start dev set ${set.name}: ${errorText(e)}`);
    void refreshDevSets();
  }
}

export async function stopSet(set: Pick<DevSet, "id" | "name">): Promise<void> {
  try {
    await backend.devSetDown(set.id);
    recordAction({ text: `dev set ${set.name} down`, state: "info", target: { kind: "devset", id: set.id } });
    toast({ kind: "ok", text: `Stopped dev set ${set.name}` });
  } catch (e) {
    recordAction({ text: `dev set ${set.name} down failed`, state: "error", error: errorText(e), target: { kind: "devset", id: set.id } });
    toasts.error(`Could not stop dev set ${set.name}: ${errorText(e)}`);
  }
  void refreshForwards();
}

export async function deleteSet(set: DevSet): Promise<void> {
  const running = getForwards().filter((f) => f.devSet === set.id).length;
  const ok = await confirm({
    tier: 1,
    title: `Delete dev set ${set.name}`,
    body: running > 0 ? `Its ${running} running forward${running === 1 ? "" : "s"} stop.` : "Nothing in the cluster changes.",
    confirmLabel: "Delete",
  });
  if (!ok) return;
  try {
    await backend.devSetDelete(set.id);
    toast({ kind: "ok", text: `Deleted dev set ${set.name}` });
  } catch (e) {
    toasts.error(`Could not delete dev set ${set.name}: ${errorText(e)}`);
  }
  void refreshDevSets();
  void refreshForwards();
}

/** F2 / `e`: a set with an env opens its env view (saving there updates the set); else the devsets view. */
export function editSet(set: DevSet, newPane: "right" | "down" | null): void {
  if (set.env) {
    const w = set.env.workload;
    openView({ kind: "env", ref: { gvr: w.gvr, namespace: w.namespace, name: w.name }, container: set.env.container, devSet: set.id }, { newPane });
  } else {
    openView({ kind: "devsets", selected: set.id }, { newPane });
  }
}

// ── save ──

export interface SaveSetProps {
  /** the suggested name */
  name: string;
  /** a set from running forwards: autoStart is not offered (nothing to rewrite) */
  title: string;
  autoStart: boolean;
  /** what is saved, as lines */
  lines: string[];
  onSave: (name: string, autoStart: boolean) => Promise<string | null>;
  onCancel: () => void;
}

export async function saveDraft(draft: DevSetDraft): Promise<DevSet | null> {
  try {
    const { set, warnings } = await backend.devSetSave(draft);
    void refreshDevSets();
    toast({ kind: "ok", text: `Saved dev set ${set.name} · ${set.forwards.length} forward${set.forwards.length === 1 ? "" : "s"}${warnings.length ? ` · ${warnings[0]}` : ""}` });
    return set;
  } catch (e) {
    throw new Error(errorText(e));
  }
}

/** `:dev save [<name>]` and the devsets toolbar: the running forwards without a set become one. */
export function saveRunning(name?: string): void {
  const context = focusedContext();
  const draft = draftFromForwards(name ?? "", context, getForwards());
  if (draft.forwards.length === 0) {
    flash("no running forward outside a dev set in this context", "warn");
    return;
  }
  if (name) {
    void saveDraft({ ...draft, name }).catch((e: unknown) => toasts.error(`Could not save: ${errorText(e)}`));
    return;
  }
  showOverlay(OVERLAY.save, {
    name: "my-forwards",
    title: "Save running forwards as a dev set",
    autoStart: false,
    lines: draft.forwards.map((f) => `${f.key}: ${f.target.kind}/${f.target.name}:${f.remotePort} → 127.0.0.1:${f.localPort}`),
    onSave: async (n) => {
      try {
        await saveDraft({ ...draft, name: n });
        return null;
      } catch (e) {
        return errorText(e);
      }
    },
    onCancel: () => {},
  } satisfies SaveSetProps);
}

// ── export ──

export interface ExportProps {
  /** `deploy/orders` */
  workload: string;
  context: string;
  keys: number;
  secretKeys: number;
  /** copy-as: clipboard only */
  clipboardOnly: boolean;
  /** protected context: type the workload name */
  typeToConfirm?: string;
  /** `confirmText`: the typed workload name on a protected context (Rust checks it) */
  onExport: (format: EnvFormat, destination: "file" | "clipboard", confirmText?: string) => void;
  /** B2: the workload whose mounted ConfigMap / Secret volumes can go to a folder (export only) */
  volumesOf?: { ref: ObjRef; container?: string };
  onExportVolumes?: (ids: string[], confirmText?: string) => void;
  onCancel: () => void;
}

/** Says what an export did. */
function reportExport(r: EnvExportResult): void {
  if (r.cancelled) return flash("export cancelled");
  for (const w of r.warnings ?? []) toast({ kind: "warn", text: w });
  const what = `${r.keys} key${r.keys === 1 ? "" : "s"} (${r.secretKeys} secret)`;
  if (r.path) toast({ kind: "ok", text: `Wrote ${what} to ${r.path}` });
  else if (r.clearSeconds !== undefined) {
    toast({ kind: "ok", text: `copied ${what}, ${r.historyExcluded ? "kept out of clipboard history, " : ""}clears in ${r.clearSeconds}s` });
  }
}

/** Runs an export request, with the tier-2 question when Rust says the path is not git-ignored. */
export async function runExport(req: EnvExportRequest, workloadName: string): Promise<void> {
  try {
    let r = await backend.envExport(req);
    if (r.confirm) {
      const ok = await confirm({
        tier: 2,
        title: "Write secrets into a git work tree?",
        body: `${r.confirm.reason}. A commit could publish the values.`,
        typeToConfirm: r.confirm.typeToConfirm || workloadName,
        confirmLabel: "Write",
      });
      if (!ok) return flash("export cancelled");
      // Rust compares the typed text too (not a UI-only guard)
      r = await backend.envExport({ ...req, confirmToken: r.confirm.token, confirmText: r.confirm.typeToConfirm || workloadName });
    }
    reportExport(r);
  } catch (e) {
    toasts.error(`Export failed: ${errorText(e)}`);
  }
}

/** B2: runs a mounted-volumes export, with the tier-2 question when Rust asks (repo path, replacing files). */
export async function runVolumesExport(req: VolumesExportRequest, workloadName: string): Promise<void> {
  try {
    let r = await backend.volumesExport(req);
    if (r.confirm) {
      const ok = await confirm({
        tier: 2,
        title: "Write the mounted files here?",
        body: `${r.confirm.reason}.${r.secretFiles ? ` ${r.secretFiles} file${r.secretFiles === 1 ? " holds" : "s hold"} Secret data.` : ""}`,
        typeToConfirm: r.confirm.typeToConfirm || workloadName,
        confirmLabel: "Write",
      });
      if (!ok) return flash("export cancelled");
      r = await backend.volumesExport({ ...req, confirmToken: r.confirm.token, confirmText: r.confirm.typeToConfirm || workloadName });
    }
    if (r.cancelled) return flash("export cancelled");
    for (const w of r.warnings ?? []) toast({ kind: "warn", text: w });
    toast({ kind: "ok", text: `Wrote ${r.files} file${r.files === 1 ? "" : "s"} (${r.secretFiles} from secrets) to ${r.path ?? "the folder"}` });
  } catch (e) {
    toasts.error(`Export failed: ${errorText(e)}`);
  }
}

/** The export dialog for an env view's state. */
export function openExport(args: { spec: EnvSpec; context: string; devSet?: string; report: EnvReport; clipboardOnly: boolean }): void {
  const { spec, context, report } = args;
  const w = spec.workload;
  const included = report.rows.filter((r) => r.source !== "field" && r.source !== "resourceField" && (spec.include ? spec.include.includes(r.key) : true));
  const secretKeys = included.filter((r) => r.source === "secret" && (spec.includeSecrets ?? []).includes(r.key)).length;
  const keys = included.filter((r) => r.source !== "secret").length + secretKeys + (spec.overrides ?? []).filter((o) => !included.some((r) => r.key === o.key)).length;
  showOverlay(OVERLAY.export, {
    workload: `${w.gvr.resource}/${w.name}`,
    context,
    keys,
    secretKeys,
    clipboardOnly: args.clipboardOnly,
    typeToConfirm: contextFlags(context).protected ? w.name : undefined,
    volumesOf: args.clipboardOnly ? undefined : { ref: { context, gvr: w.gvr, namespace: w.namespace, name: w.name }, container: report.container },
    onExportVolumes: (volumes, confirmText) =>
      void runVolumesExport({ ref: { context, gvr: w.gvr, namespace: w.namespace, name: w.name }, container: report.container, volumes, confirmText }, w.name),
    onExport: (format, destination, confirmText) => {
      const s = { ...spec, format };
      const req: EnvExportRequest = args.devSet
        ? { devSet: args.devSet, spec: s, rewrites: [], destination, clearSeconds: getSettings().clipboardClearSeconds, confirmText }
        : {
            spec: s,
            context,
            rewrites: report.deps.map((d) => d.suggestedRewrite),
            forwards: report.deps.map((d) => d.suggestedForward),
            destination,
            clearSeconds: getSettings().clipboardClearSeconds,
            confirmText,
          };
      void runExport(req, w.name);
    },
    onCancel: () => {},
  } satisfies ExportProps);
}

export { devSetById, secretKeysOf };
