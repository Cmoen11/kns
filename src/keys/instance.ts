// The app's singletons. Tests build their own with createRegistry/createKeymap/createEngine.
import { registry } from "../actions/registry";
import { createEngine } from "./engine";
import { createKeymap } from "./keymap";
import { detectPlatform } from "./platform";

export const platform = detectPlatform();
export const keymap = createKeymap(registry);
export const engine = createEngine({ registry, keymap, platform });
