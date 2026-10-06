import {
  calculateCommercialEstimateTotals,
  type EstimateCommercial,
} from "./estimate-commercial";
import { estimateLineAmountCents } from "./estimate-totals";

export type DraftPriceLine = {
  item_type: "line" | "group";
  quantity: number | string;
  unit_cost: number | string;
  markup_pct: number | string;
  is_optional: boolean;
};

export function draftMoneyLine(
  line: DraftPriceLine,
  defaultMarkup: number | string,
  commercial: EstimateCommercial,
) {
  return {
    item_type: line.item_type,
    quantity: line.quantity === "" ? 1 : Number(line.quantity) || 0,
    unit_cost_cents: Math.round((Number(line.unit_cost) || 0) * 100),
    markup_pct:
      commercial.billing_model === "cost_plus_fixed_fee"
        ? 0
        : line.markup_pct === ""
          ? Number(defaultMarkup) || 0
          : Number(line.markup_pct) || 0,
    is_optional: line.is_optional,
  };
}

/** The editor uses the same per-line cents rounding as persisted estimates and PDFs. */
export function estimateDraftTotals(
  lines: DraftPriceLine[],
  defaultMarkup: number | string,
  contingency: number | string,
  commercial: EstimateCommercial,
  taxRate = 0,
) {
  const moneyLines = lines.map((line) =>
    draftMoneyLine(line, defaultMarkup, commercial),
  );
  const totals = calculateCommercialEstimateTotals(
    moneyLines,
    taxRate,
    Number(contingency) || 0,
    commercial,
  );
  let cost = 0,
    optional = 0;
  for (const line of moneyLines) {
    if (line.item_type === "group") continue;
    if (line.is_optional) optional += estimateLineAmountCents(line) ?? 0;
    else cost += Math.round(line.quantity * line.unit_cost_cents);
  }
  return {
    total: totals.subtotal / 100,
    grandTotal: totals.total / 100,
    contingencyTotal: totals.contingency / 100,
    costTotal: cost / 100,
    optionalTotal: optional / 100,
  };
}
