// Feature: resource tables (docs/ux.md §11.2-11.3, §12). View kinds: table, containers.
// The actions file is small and eager, so keys work before the lazy table chunk has loaded.
import { registerView } from "../foundation";
import "./actions";
import { initWarmTabs } from "./warm";

export function register(): void {
  registerView({
    kinds: ["table", "containers"],
    component: () => import("./TableView"),
  });
  initWarmTabs();
}
