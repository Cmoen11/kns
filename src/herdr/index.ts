// Feature: kns in Herdr (docs/herdr.md). `:herdr add` (also the App menu's "Add to Herdr" and
// Settings → Herdr) installs the Herdr app's kns panel and the herdr TUI plugin from kns itself
// (herdr.rs); `:herdr remove` takes them out again; `:herdr` says what is set up.
import { backend, flash, registerActions, type ActionContext } from "../foundation";
import { addToHerdr, removeFromHerdr } from "../views/tools/herdr-settings";

async function run(ctx: ActionContext): Promise<void> {
  const sub = String(ctx.args?.[0] ?? "status").toLowerCase();
  if (sub === "add" || sub === "install") return addToHerdr(() => {});
  if (sub === "remove" || sub === "uninstall") return removeFromHerdr(() => {});
  if (sub !== "status") return flash(`:herdr ${sub}: use add, remove or status`, "warn");
  try {
    const s = await backend.herdrStatus();
    if (s.modInstalled) flash(s.modCurrent ? `kns is in Herdr (${s.modDir ?? ""})` : "kns is in Herdr with an older panel: :herdr add updates it");
    else if (s.appFound || s.tuiFound) flash("Herdr is installed: :herdr add puts kns in it");
    else flash("Herdr is not installed", "warn");
  } catch (e) {
    flash(String((e as { message?: string })?.message ?? e), "warn");
  }
}

export function register(): void {
  registerActions({ "herdr.command": { run } });
}
