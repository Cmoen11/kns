// Feature: context packs (docs/plan-features.md §3 G). Owner: G. `leader c` / `:pack` / the row
// bar's "copy for agent" open a redacted pack of "this" (./actions) in the generic `text` view
// (src/views/text, also G's), through the `pack` text source (./source). The pack is made in Rust
// (pack.rs), which MCP `make_pack` uses too.
import { registerTextSource } from "../views/text";
import "./actions";
import { loadPack } from "./source";

export function register(): void {
  registerTextSource("pack", loadPack);
}
