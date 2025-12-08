"use client";

import { useFormContext } from "react-hook-form";
import { AmountInput } from "./amount-input";

type Props = Omit<
  React.ComponentProps<typeof AmountInput>,
  "value" | "onChange"
> & {
  name: string;
  lineItemIndex: number;
};

export function ProductAwareAmountInput({
  lineItemIndex,
  name,
  ...props
}: Props) {
  const { watch } = useFormContext();

  // Get current line item data (unused but kept for potential future wiring)
  watch(`lineItems.${lineItemIndex}.name`);

  return (
    <AmountInput
      {...props}
      name={name}
      onBlur={(e) => {
        // Call original onBlur if it exists
        props.onBlur?.(e);
      }}
    />
  );
}
