"use client";

import { calculateLineItemTotal } from "@midday/invoice/utils/calculate";
import { Button } from "@midday/ui/button";
import { Icons } from "@midday/ui/icons";
import { Reorder, useDragControls } from "framer-motion";
import { useFieldArray, useFormContext, useWatch } from "react-hook-form";
import type { InvoiceFormValues } from "./form-context";
import { LabelInput } from "./label-input";
import { ProductAutocomplete } from "./product-autocomplete";
import { ProductAwareAmountInput } from "./product-aware-amount-input";
import { ProductAwareUnitInput } from "./product-aware-unit-input";
import { QuantityInput } from "./quantity-input";
import { FormatAmount } from "../format-amount";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CostCode } from "@/lib/types";

export function LineItems({ costCodes }: { costCodes?: CostCode[] }) {
  const { control } = useFormContext();
  const currency = useWatch({ control, name: "template.currency" });

  const updateTemplateMutation = { mutate: (_: any) => {} };

  const includeDecimals = useWatch({
    control,
    name: "template.includeDecimals",
  });

  const includeUnits = useWatch({
    control,
    name: "template.includeUnits",
  });

  const maximumFractionDigits = includeDecimals ? 2 : 0;

  const { fields, append, remove, swap } = useFieldArray({
    control,
    name: "lineItems",
  });

  const reorderList = (newFields: typeof fields) => {
    const firstDiffIndex = fields.findIndex(
      (field, index) => field.id !== newFields[index]?.id,
    );

    if (firstDiffIndex !== -1) {
      const newIndex = newFields.findIndex(
        (field) => field.id === fields[firstDiffIndex]?.id,
      );

      if (newIndex !== -1) {
        swap(firstDiffIndex, newIndex);
      }
    }
  };

  const handleRemove = (index: number) => {
    if (fields.length > 1) {
      remove(index);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[1.1fr_1.6fr_0.9fr_1fr_0.9fr] gap-4 items-end mb-2">
        <span className="text-[11px] text-[#878787] font-medium">Cost code</span>
        <LabelInput name="template.descriptionLabel" onSave={() => {}} className="truncate" />
        <LabelInput name="template.quantityLabel" onSave={() => {}} className="truncate" />
        <LabelInput name="template.priceLabel" onSave={() => {}} className="truncate" />
        <LabelInput name="template.totalLabel" onSave={() => {}} className="text-right truncate" />
      </div>

      <Reorder.Group
        axis="y"
        values={fields}
        onReorder={reorderList}
        className="!m-0"
        transition={{ duration: 0 }}
      >
        {fields.map((field, index) => (
          <LineItemRow
            key={field.id}
            // @ts-expect-error
            item={field}
            index={index}
            handleRemove={handleRemove}
            isReorderable={fields.length > 1}
            currency={currency}
            maximumFractionDigits={maximumFractionDigits}
            includeUnits={includeUnits}
            costCodes={costCodes}
          />
        ))}
      </Reorder.Group>

      <button
        type="button"
        onClick={() =>
          append({
            name: "",
            quantity: 0,
            price: 0,
          })
        }
        className="flex items-center space-x-2 text-xs text-[#878787] font-mono"
      >
        <Icons.Add />
        <span className="text-[11px]">Add item</span>
      </button>
    </div>
  );
}

function LineItemRow({
  index,
  handleRemove,
  isReorderable,
  item,
  currency,
  maximumFractionDigits,
  includeUnits,
  costCodes,
}: {
  index: number;
  handleRemove: (index: number) => void;
  isReorderable: boolean;
  item: InvoiceFormValues["lineItems"][number];
  currency: string;
  maximumFractionDigits: number;
  includeUnits?: boolean;
  costCodes?: CostCode[];
}) {
  const controls = useDragControls();
  const { control, watch, setValue } = useFormContext();

  const locale = useWatch({ control, name: "template.locale" });

  const price = useWatch({
    control,
    name: `lineItems.${index}.price`,
  });

  const quantity = useWatch({
    control,
    name: `lineItems.${index}.quantity`,
  });

  const lineItemName = watch(`lineItems.${index}.name`);

  return (
    <Reorder.Item
      className="grid grid-cols-[1.1fr_1.6fr_0.9fr_1fr_0.9fr] gap-4 items-start relative group mb-2 w-full"
      value={item}
      dragListener={false}
      dragControls={controls}
      transition={{ duration: 0 }}
      onKeyDown={(e: React.KeyboardEvent<HTMLLIElement>) => {
        // Don't interfere with arrow keys when they're used for autocomplete navigation
        if (
          e.key === "ArrowDown" ||
          e.key === "ArrowUp" ||
          e.key === "Enter" ||
          e.key === "Escape"
        ) {
          e.stopPropagation();
        }
      }}
    >
      {isReorderable && (
        <Button
          type="button"
          className="absolute -left-9 -top-[4px] opacity-0 group-hover:opacity-100 transition-opacity hover:bg-transparent cursor-grab"
          onPointerDown={(e) => controls.start(e)}
          variant="ghost"
        >
          <Icons.DragIndicator className="size-4 text-[#878787]" />
        </Button>
      )}

      <Select
        value={watch(`lineItems.${index}.costCodeId`) ?? "none"}
        onValueChange={(val) => {
          setValue(`lineItems.${index}.costCodeId`, val === "none" ? null : val, {
            shouldValidate: true,
            shouldDirty: true,
          });
        }}
      >
        <SelectTrigger className="h-8 text-xs">
          <SelectValue placeholder="Code" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Unassigned</SelectItem>
          {(costCodes ?? []).map((code) => (
            <SelectItem key={code.id} value={code.id}>
              {code.code ? `${code.code} — ${code.name}` : code.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <ProductAutocomplete
        index={index}
        value={lineItemName || ""}
        onChange={(value: string) => {
          setValue(`lineItems.${index}.name`, value, {
            shouldValidate: true,
            shouldDirty: true,
          });
        }}
      />

      <QuantityInput name={`lineItems.${index}.quantity`} />

      <div className="flex items-center gap-2">
        <ProductAwareAmountInput
          name={`lineItems.${index}.price`}
          lineItemIndex={index}
        />
        {includeUnits && <span className="text-xs text-[#878787]">/</span>}
        {includeUnits && (
          <ProductAwareUnitInput
            name={`lineItems.${index}.unit`}
            lineItemIndex={index}
          />
        )}
      </div>

      <div className="text-right">
        <span className="text-xs text-primary font-mono">
          <FormatAmount
            amount={calculateLineItemTotal({
              price,
              quantity,
            })}
            currency={currency}
            locale={locale ?? "en-US"}
            maximumFractionDigits={maximumFractionDigits}
          />
        </span>
      </div>

      {index !== 0 && (
        <Button
          type="button"
          onClick={() => handleRemove(index)}
          className="absolute -right-9 -top-[4px] opacity-0 group-hover:opacity-100 transition-opacity hover:bg-transparent text-[#878787]"
          variant="ghost"
        >
          <Icons.Close />
        </Button>
      )}
    </Reorder.Item>
  );
}
