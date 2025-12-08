import { CurrencyInput } from "@midday/ui/currency-input";
import { useRef } from "react";
import { useController, useFormContext } from "react-hook-form";

export function VATInput() {
  const { control } = useFormContext();
  const lastSavedValueRef = useRef<number | undefined>(undefined);
  const updateTemplateMutation = { mutate: (_: any) => {} };

  const {
    field: { value, onChange },
  } = useController({
    name: "template.vatRate",
    control,
  });

  return (
    <CurrencyInput
      autoComplete="off"
      value={value ?? ""}
      onChange={(event) => {
        const newValue = Number(event.target.value) || 0;
        onChange(newValue);
      }}
      onBlur={() => {
        const currentValue = value ?? 0;
        // Only save if the value has actually changed
        if (currentValue !== lastSavedValueRef.current) {
          lastSavedValueRef.current = currentValue;
          updateTemplateMutation.mutate({ vatRate: currentValue });
        }
      }}
      className="p-0 border-0 h-6 text-xs !bg-transparent flex-shrink-0 w-16 text-[11px] text-[#878787]"
      inputMode="decimal"
      min={0}
      max={100}
      step={0.01}
    />
  );
}
