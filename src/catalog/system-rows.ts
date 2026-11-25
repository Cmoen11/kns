// The "System" section of the context sidebar (docs/catalog.md): what the catalog says about the
// focused pane's namespace. Who owns it and where to reach them, its repositories, and what it
// is expected to have. Pure apart from the link opener.
import { backend } from "../ipc";
import type { CatalogLink, CatalogSystem } from "../ipc/types";
import type { PanelRow } from "../sidepanels/model";
import { toasts } from "../ui/toast";
import type { CatalogScope } from "./store";

const open = (url: string) => () => backend.catalogOpen(url).catch((e: unknown) => toasts.error((e as { message?: string }).message ?? String(e)));

function linkRow(key: string, l: CatalogLink, detail: string): PanelRow {
  return { key, section: "system", label: l.title, detail, activate: open(l.url), open: open(l.url), stay: true };
}

/** Rows for `system` (null: no section). */
export function systemRows(system: CatalogSystem | undefined, scope: CatalogScope): PanelRow[] {
  if (!system) return [];
  const team = scope.catalog?.teams.find((t) => t.name === system.owner);
  const out: PanelRow[] = [
    {
      key: "sys:about",
      section: "system",
      label: system.title,
      detail: [system.description, scope.env && system.environments.length ? `runs in ${system.environments.join(", ")}` : ""].filter(Boolean).join(" · ") || undefined,
      labels: scope.teams.includes(system.owner ?? "") ? ["TEAM"] : undefined,
      stay: true,
    },
  ];
  if (team || system.owner) {
    out.push({ key: "sys:team", section: "system", label: team?.title ?? system.owner!, detail: `owner${team ? ` · ${team.members.length} members` : ""}`, stay: true });
    for (const [i, l] of (team?.links ?? []).entries()) out.push(linkRow(`sys:team:${i}`, l, "team"));
  }
  for (const [i, l] of system.links.entries()) out.push(linkRow(`sys:link:${i}`, l, "system"));
  for (const c of system.components) {
    const url = c.repo ? `https://github.com/${c.repo}` : c.links[0]?.url;
    const what = c.gitops ? `GitOps (${c.gitops.tool})` : c.type || "component";
    const row: PanelRow = { key: `sys:c:${c.name}`, section: "system", label: c.name, detail: [what, c.description].filter(Boolean).join(" · "), stay: true };
    if (url) Object.assign(row, { activate: open(url), open: open(url) });
    out.push(row);
  }
  if (system.expectedSecrets.length > 0) {
    out.push({ key: "sys:secrets", section: "system", label: "Expected secrets", detail: system.expectedSecrets.join(", "), stay: true });
  }
  return out;
}
