import { calculateTotal } from "@midday/invoice/utils/calculate";
import * as React from "react";
import { useCallback, useEffect, useMemo } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { FormatAmount } from "../format-amount";
import { AmountInput } from "./amount-input";
import { LabelInput } from "./label-input";
import { TaxInput } from "./tax-input";
import { VATInput } from "./vat-input";
import { NumberFlowLite, partitionParts } from "number-flow";
import { useRef } from "react";

export function Summary() {
  const { control, setValue } = useFormContext();

  // No-op template updater (we don't persist template mutations yet)
  const updateTemplateMutation = { mutate: (_: any) => {} };

  const includeDecimals = useWatch({
    control,
    name: "template.includeDecimals",
  });

  const maximumFractionDigits = includeDecimals ? 2 : 0;

  const currency = useWatch({
    control,
    name: "template.currency",
  });

  const locale = useWatch({
    control,
    name: "template.locale",
  });

  const includeTax = useWatch({
    control,
    name: "template.includeTax",
  });

  const taxRate = useWatch({
    control,
    name: "template.taxRate",
  });

  const vatRate = useWatch({
    control,
    name: "template.vatRate",
  });

  const includeVat = useWatch({
    control,
    name: "template.includeVat",
  });

  const includeDiscount = useWatch({
    control,
    name: "template.includeDiscount",
  });

  const lineItems = useWatch({
    control,
    name: "lineItems",
  });

  const discount = useWatch({
    control,
    name: "discount",
  });

  const {
    subTotal,
    total,
    vat: totalVAT,
    tax: totalTax,
  } = calculateTotal({
    lineItems,
    taxRate,
    vatRate,
    includeVat,
    includeTax,
    discount: discount ?? 0,
  });

  const updateFormValues = useCallback(() => {
    setValue("amount", total, { shouldValidate: true });
    setValue("vat", totalVAT, { shouldValidate: true });
    setValue("tax", totalTax, { shouldValidate: true });
    setValue("subtotal", subTotal, { shouldValidate: true });
    setValue("discount", discount ?? 0, { shouldValidate: true });
  }, [total, totalVAT, totalTax, subTotal, discount, setValue]);

  useEffect(() => {
    updateFormValues();
  }, [updateFormValues]);

  useEffect(() => {
    if (!includeTax) {
      setValue("template.taxRate", 0, {
        shouldValidate: true,
        shouldDirty: true,
      });
    }
  }, [includeTax, setValue]);

  useEffect(() => {
    if (!includeVat) {
      setValue("template.vatRate", 0, {
        shouldValidate: true,
        shouldDirty: true,
      });
    }
  }, [includeVat, setValue]);

  useEffect(() => {
    if (!includeDiscount) {
      setValue("discount", 0, { shouldValidate: true, shouldDirty: true });
    }
  }, [includeDiscount, setValue]);

  return (
    <div className="w-[320px] flex flex-col">
      <div className="flex justify-between items-center py-1">
        <LabelInput
          className="flex-shrink-0 min-w-6"
          name="template.subtotalLabel"
          onSave={(value) => {
            updateTemplateMutation.mutate({ subtotalLabel: value });
          }}
        />
        <span className="text-right text-[11px] text-[#878787]">
          <FormatAmount
            amount={subTotal}
            maximumFractionDigits={maximumFractionDigits}
            currency={currency}
            locale={locale}
          />
        </span>
      </div>

      {includeDiscount && (
        <div className="flex justify-between items-center py-1">
          <LabelInput
            name="template.discountLabel"
            onSave={(value) => {
              updateTemplateMutation.mutate({ discountLabel: value });
            }}
          />

          <AmountInput
            placeholder="0"
            name="discount"
            className="text-right text-[11px] text-[#878787] border-none"
          />
        </div>
      )}

      {includeVat && (
        <div className="flex justify-between items-center py-1">
          <div className="flex items-center gap-1">
            <LabelInput
              className="flex-shrink-0 min-w-5"
              name="template.vatLabel"
              onSave={(value) => {
                updateTemplateMutation.mutate({ vatLabel: value });
              }}
            />

            <VATInput />
          </div>

          <span className="text-right text-[11px] text-[#878787]">
            <FormatAmount
              amount={totalVAT}
              maximumFractionDigits={2}
              currency={currency}
              locale={locale}
            />
          </span>
        </div>
      )}

      {includeTax && (
        <div className="flex justify-between items-center py-1">
          <div className="flex items-center gap-1">
            <LabelInput
              className="flex-shrink-0 min-w-5"
              name="template.taxLabel"
              onSave={(value) => {
                updateTemplateMutation.mutate({ taxLabel: value });
              }}
            />

            <TaxInput />
          </div>

          <span className="text-right text-[11px] text-[#878787]">
            <FormatAmount
              amount={totalTax}
              maximumFractionDigits={2}
              currency={currency}
              locale={locale}
            />
          </span>
        </div>
      )}

      <div className="flex justify-between items-center py-4 mt-2 border-t border-border">
        <LabelInput
          name="template.totalSummaryLabel"
          onSave={(value) => {
            updateTemplateMutation.mutate({ totalSummaryLabel: value });
          }}
        />
        <span className="text-right font-medium text-[21px]">
          <NumberFlow total={total ?? 0} currency={currency} maxFrac={includeTax || includeVat ? 2 : maximumFractionDigits} locale={locale ?? "en-US"} />
        </span>
      </div>
    </div>
  );
}

function NumberFlow({
  total,
  currency,
  maxFrac,
  locale,
}: {
  total: number;
  currency: string;
  maxFrac: number;
  locale: string;
}) {
  const ref = useRef<any>(null);

  useEffect(() => {
    if (typeof customElements !== "undefined" && !customElements.get("number-flow")) {
      NumberFlowLite.define?.();
    }
  }, []);

  const formatter = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        maximumFractionDigits: maxFrac,
      }),
    [currency, locale, maxFrac],
  );

  const parts = useMemo(() => partitionParts(total, formatter), [total, formatter]);

  useEffect(() => {
    if (ref.current && parts) {
      ref.current.parts = parts;
    }
  }, [parts]);

  return React.createElement('number-flow', { ref, root: true });
}
