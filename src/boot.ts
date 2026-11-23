// Must be the first import of main.tsx: sets data-tema / data-modus / zoom on <html> before the
// first paint, so there is no flash of the wrong theme (docs/ux.md §9.1).
import { bootAppearance } from "./store/appearance";

bootAppearance();
