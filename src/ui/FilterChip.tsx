// Filter chip (docs/ux.md §11.4): Etikett XS mode + UI XS value on --k-bg-chip, no frame.
import { memo } from "react";
import { Icon } from "./Glyph";
import { tip } from "./Tooltip";

export interface FilterChipProps {
  /** RE, NOT, LABEL, FUZZY, FAULTS ... */
  mode: string;
  /** untrusted text from the user or the cluster; rendered as text */
  value?: string;
  /** keyboard chip focus (filter.chipFocusLeft/Right); draws the 2px ring */
  focused?: boolean;
  /** mouse parity for filter.chipRemove */
  onRemove?: () => void;
}

export const FilterChip = memo(function FilterChip({ mode, value, focused, onRemove }: FilterChipProps) {
  return (
    <span
      className="k-fchip"
      data-focus={focused || undefined}
      data-removable={onRemove ? true : undefined}
      // the click must not blur a filter input next to the chip (that would close it mid-click)
      onMouseDown={onRemove ? (e) => e.preventDefault() : undefined}
      onClick={onRemove}
      {...(onRemove ? tip("Remove filter") : undefined)}
    >
      <span className="t-label">{mode}</span>
      {value !== undefined && value !== "" && <span className="k-fchip-value t-ui">{value}</span>}
      {onRemove && <Icon name="close" />}
    </span>
  );
});
