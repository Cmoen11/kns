// Opening things from the tool views.
import type { ApiResource } from "../../ipc/types";
import { getWorkspace, openView, tableView } from "../../foundation";
import { recentTables } from "./home-model";

/** A tool view has no namespace of its own: tables open in the namespace last looked at. */
export function lastNamespace(): string {
  return recentTables(getWorkspace(), 1)[0]?.namespace ?? "*";
}

export function openResource(res: ApiResource, newPane: "right" | "down" | null): void {
  openView(tableView(res.gvr, res.namespaced ? lastNamespace() : "*"), { newPane });
}

const two = (n: number): string => (n < 10 ? `0${n}` : String(n));
/** HH:MM:SS, local time. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
