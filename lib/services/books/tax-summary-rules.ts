import { isSystemGeneratedRetainageLine } from "@/lib/financials/invoice-totals"

export function invoiceTaxBases(lines: Array<{ quantity: number; unit_price_cents: number; description: string; unit: string | null; metadata: unknown }>, discountCents: number) {
  const result = { taxableSalesCents: 0, exemptSalesCents: 0, unclassifiedSalesCents: 0 }
  for (const line of lines) {
    if (isSystemGeneratedRetainageLine(line)) continue
    const amount = Math.round(Number(line.quantity) * Number(line.unit_price_cents))
    const taxable = line.metadata && typeof line.metadata === "object" ? Reflect.get(line.metadata, "taxable") : undefined
    if (taxable === true) result.taxableSalesCents += amount
    else if (taxable === false) result.exemptSalesCents += amount
    else result.unclassifiedSalesCents += amount
  }
  const total = result.taxableSalesCents + result.exemptSalesCents + result.unclassifiedSalesCents
  if (total > 0 && discountCents > 0) {
    const discount = Math.min(discountCents, total)
    const taxableShare = Math.round(discount * result.taxableSalesCents / total)
    const exemptShare = result.unclassifiedSalesCents === 0 ? discount - taxableShare : Math.round(discount * result.exemptSalesCents / total)
    result.taxableSalesCents -= taxableShare
    result.exemptSalesCents -= exemptShare
    result.unclassifiedSalesCents -= discount - taxableShare - exemptShare
  }
  return result
}
