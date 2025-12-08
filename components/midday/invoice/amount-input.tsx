import { cn } from "@midday/ui/cn";
import { CurrencyInput } from "@midday/ui/currency-input";
import { useState } from "react";
import { useController, useFormContext } from "react-hook-form";

type AmountInputProps = Omit<
  React.ComponentProps<typeof CurrencyInput>,
  "value" | "onChange" | "type"
> & {
  name: string;
};

export function AmountInput({ className, name, ...props }: AmountInputProps) {
  const [isFocused, setIsFocused] = useState(false);
  const { control } = useFormContext();
  const {
    field: { value, onChange, onBlur },
  } = useController({
    name,
    control,
  });

  const isPlaceholder = !value && !isFocused;

  return (
    <div className="relative font-mono">
      <CurrencyInput
        autoComplete="off"
        value={value ?? ""}
        onChange={(event) => {
          const nextValue = parseFloat(event.target.value);
          onChange(Number.isFinite(nextValue) ? nextValue : 0, {
            shouldValidate: true,
          });
        }}
        onFocus={() => setIsFocused(true)}
        onBlur={(event) => {
          setIsFocused(false);
          onBlur();
          props.onBlur?.(event);
        }}
        {...props}
        className={cn(
          className,
          isPlaceholder && "opacity-0",
          "p-0 border-0 h-6 text-xs !bg-transparent border-b border-transparent focus:border-border",
        )}
        inputMode="decimal"
      />

      {isPlaceholder && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="h-full w-full bg-[repeating-linear-gradient(-60deg,#DBDBDB,#DBDBDB_1px,transparent_1px,transparent_5px)] dark:bg-[repeating-linear-gradient(-60deg,#2C2C2C,#2C2C2C_1px,transparent_1px,transparent_5px)]" />
        </div>
      )}
    </div>
  );
}
