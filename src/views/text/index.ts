// Feature: the generic `text` view (docs/plan-features.md §2.8). A1 built it minimal; G owns it
// from wave 2 (section cursor and dropping, size line, redaction legend, copy, save). Sources are
// registered by their owners through registerTextSource: doc (I), bundle (C2), snippet (F), pack (G).
import { registerView } from "../../foundation";
import "./actions";

export { registerTextSource, textSourceLoader, type TextDoc, type TextLoader, type TextSection, type TextSourceBy } from "./sources";

export function register(): void {
  registerView({ kinds: ["text"], component: () => import("./TextView"), crumbs: (v) => [{ label: v.title }] });
}
