import { CurrencyInput } from "@midday/ui/currency-input";
import { useRef } from "react";
import { useController, useFormContext } from "react-hook-form";

export function TaxInput() {
  const { control } = useFormContext();
  const lastSavedValueRef = useRef<number | undefined>(undefined);
  const updateTemplateMutation = { mutate: (_: any) => {} };

  const {
    field: { value, onChange },
  } = useController({
    name: "template.taxRate",
    control,
  });

  return (
    <div className="flex items-center text-[11px] text-foreground">
      <span>(</span>
      <CurrencyInput
        autoComplete="off"
        value={value ?? ""}
        placeholder="0"
        onChange={(event) => {
          const newValue = Number(event.target.value) || 0;
          onChange(newValue);
        }}
        onBlur={() => {
          const currentValue = value ?? 0;
          if (currentValue !== lastSavedValueRef.current) {
            lastSavedValueRef.current = currentValue;
            updateTemplateMutation.mutate({ taxRate: currentValue });
          }
        }}
        inputMode="decimal"
        className="px-0 py-0 border-none bg-transparent text-[11px] text-foreground focus:outline-none focus:ring-0 focus:border-transparent appearance-none leading-none w-auto"
        style={{ boxShadow: "none" }}
      />
      <span>%)</span>
    </div>
  );
}
