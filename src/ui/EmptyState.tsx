// Empty state (docs/ux.md §11.10): nodelinje block, 28px gap, serif 28px title, one line
// with the one-key fix. Panes smaller than 320x240 pass compact and get the text line only.
import type { ReactNode } from "react";
import { Nodelinje } from "./Glyph";

export interface EmptyStateProps {
  /** serif title; wrap at most one word in <em> */
  title?: ReactNode;
  /** the one-line explanation, usually <><Keys action="filter.clear"/> clears the filter</> */
  children: ReactNode;
  /** text line only (small panes, or while the first snapshot is pending: "syncing") */
  compact?: boolean;
  /** buttons, for the rare empty state that needs them */
  actions?: ReactNode;
}

export function EmptyState({ title, children, compact, actions }: EmptyStateProps) {
  return (
    <div className="k-empty" role="status">
      {!compact && <Nodelinje size={8} />}
      {!compact && title && <h2 className="k-empty-title t-title">{title}</h2>}
      <p className="k-empty-line t-body">{children}</p>
      {!compact && actions && <div className="k-empty-actions">{actions}</div>}
    </div>
  );
}
