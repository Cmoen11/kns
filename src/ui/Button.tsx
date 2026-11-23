// Buttons (docs/ux.md §11.8). Only in dialogs, settings and empty states; one primary per
// surface. A button shows the key chip of the action it stands for after its label.
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import type { ActionId } from "../actions";
import { Keys } from "./KeyChip";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant?: "primary" | "secondary" | "tertiary";
  /** the action whose key this button mirrors; its chip is shown after the label */
  action?: ActionId;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = "secondary", action, children, className, type = "button", ...rest }: ButtonProps) {
  return (
    <button {...rest} type={type} className={className ? `k-btn ${className}` : "k-btn"} data-variant={variant}>
      <span className="k-btn-label t-button">{children}</span>
      {action && <Keys action={action} disabled={rest.disabled} />}
    </button>
  );
}
