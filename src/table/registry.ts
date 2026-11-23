// The focused pane's table model, for the action handlers. Tiny and eager: the model class itself
// lives in the lazy table chunk and is only referenced as a type here.
import { focusedPane } from "../foundation";
import type { PaneId } from "../types";
import type { TableModel } from "./model";

const models = new Map<PaneId, TableModel>();

export function attachModel(pane: PaneId, model: TableModel): void {
  models.set(pane, model);
}
export function detachModel(pane: PaneId, model: TableModel): void {
  if (models.get(pane) === model) models.delete(pane);
}
/** The model of a pane (default: the focused pane), if a table view is mounted there. */
export function modelOf(pane?: PaneId | null): TableModel | undefined {
  const id = pane ?? focusedPane();
  return id ? models.get(id) : undefined;
}
