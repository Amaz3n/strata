"use client";

import { useFormContext } from "react-hook-form";
import { Input } from "./input";

type Props = {
  name: string;
  lineItemIndex: number;
};

export function ProductAwareUnitInput({
  lineItemIndex,
  name,
  ...props
}: Props) {
  const { watch } = useFormContext();

  // Observe fields to keep RHF subscriptions active
  watch(`lineItems.${lineItemIndex}.name`);

  return (
    <Input
      {...props}
      name={name}
      onBlur={() => {
        // noop persistence
      }}
    />
  );
}
