// The settings view (docs/ux.md §11.10). Rows change themselves through the store; the keymap
// rows at the end get the `settings.keymap` layer (rebind, unbind, reset) while the cursor is on one.
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { registry } from "../../actions";
import { LAYERS, useCluster, useScopeLayer, type ViewProps } from "../../foundation";
import { keymap } from "../../keys";
import { useNames } from "../../dev/names";
import { useSettings } from "../../store/settings";
import { useCatalog } from "../../catalog/store";
import { EmptyState } from "../../ui";
import { takeKeysJump } from "./controllers";
import { ListPane } from "./ListPane";
import type { ItemRow } from "./list-model";
import { buildSettingsRows } from "./settings-model";

const subscribeKeymap = (fn: () => void) => keymap.subscribe(fn);
const subscribeRegistry = (fn: () => void) => {
  const off = registry.subscribe(fn);
  return () => void off();
};

export default function SettingsView({ pane, focused }: ViewProps<"settings">) {
  const settings = useSettings((s) => s);
  const contexts = useCluster((s) => s.contexts);
  // bindings change with overrides and k9s-mode; the list of built actions with late registrations
  const keymapVersion = useSyncExternalStore(subscribeKeymap, keymap.version);
  const registryVersion = useSyncExternalStore(subscribeRegistry, registry.version);
  const names = useMemo(() => contexts.map((c) => c.name), [contexts]);
  const proxy = useNames((s) => s.status);
  const catalog = useCatalog((s) => s);
  const rows = useMemo(() => buildSettingsRows(settings, names, proxy, catalog), [settings, names, proxy, catalog, keymapVersion, registryVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const [onKeymapRow, setOnKeymapRow] = useState(false);
  const onCurrent = useCallback((row: ItemRow | undefined, filtering: boolean) => setOnKeymapRow(!!row?.actionId && !filtering), []);
  useScopeLayer(LAYERS.keymapEditor, focused && onKeymapRow);

  const [initialKey] = useState(() => (takeKeysJump() ? rows.find((r) => r.type === "item" && r.actionId)?.key : undefined));

  return <ListPane pane={pane} focused={focused} name="settings" rows={rows} empty={<EmptyState compact>No settings</EmptyState>} onCurrent={onCurrent} initialKey={initialKey} />;
}
