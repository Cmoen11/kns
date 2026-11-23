// The titlebar's ⋯ menu. Its own module so the Tools hub can list it as a mouse path without
// importing the titlebar component.
import type { MenuEntry } from "../foundation";

export const WINDOW_MENU: readonly MenuEntry[] = [
  "fav.saveView", "fav.saveLayout", "fav.picker", "|", "aliases.show", "messages.open", "pf.open",
  // feature tools (plan-features §2.10a); each shows up once its package builds it
  "|", "hub.open", "dev.picker", "agents.open", "trap.list",
];
