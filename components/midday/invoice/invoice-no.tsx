"use client";

import { cn } from "@midday/ui/cn";
import { useFormContext } from "react-hook-form";
import { Input as BaseInput } from "@midday/ui/input";
import { LabelInput } from "./label-input";

export function InvoiceNo() {
  const {
    register,
    formState: { errors },
  } = useFormContext();
  const updateTemplateMutation = { mutate: (_: any) => {} };

  return (
    <div className="flex space-x-1 items-center">
      <div className="flex items-center flex-shrink-0">
        <LabelInput
          name="template.invoiceNoLabel"
          onSave={(value) => {
            updateTemplateMutation.mutate({ invoiceNoLabel: value });
          }}
          className="truncate"
        />
        <span className="text-[11px] text-[#878787] flex-shrink-0">:</span>
      </div>

      <div className="flex flex-col gap-1">
        <BaseInput
          {...register("invoiceNumber")}
          className={cn(
            "w-28 flex-shrink p-0 border-none text-[11px] h-4.5 overflow-hidden",
            errors.invoiceNumber ? "text-red-500" : "",
          )}
        />
        {errors.invoiceNumber && (
          <p className="text-[11px] text-red-500">Invoice number already exists</p>
        )}
      </div>
    </div>
  );
}
