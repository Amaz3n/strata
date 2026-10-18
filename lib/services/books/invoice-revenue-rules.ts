import type { RevenueRecognitionBasis } from "@/lib/financials/billing-model"

export type InvoiceRevenueBasis = RevenueRecognitionBasis | "on_invoice"
export type InvoiceRevenueLine = {
  account_code: string
  amount_cents: number
  dimensions?: Record<string, unknown>
}

/** General service invoices have no project WIP schedule to earn deferred billings. */
export function invoiceRevenueBasis(projectId: string | null, projectBasis?: RevenueRecognitionBasis): InvoiceRevenueBasis {
  return projectId ? projectBasis ?? "percentage_of_completion" : "on_invoice"
}

/** A fully retained progress billing still creates retainage AR and deferred revenue. */
export function invoiceHasAccountingPrincipal(netCents: number, retainageCents: number, basis: InvoiceRevenueBasis) {
  return netCents !== 0 || (basis === "percentage_of_completion" && retainageCents > 0)
}

/** Allocate a partial credit to the original revenue grain, including discount lines. */
export function allocateInvoiceRevenue(amountCents: number, lines: InvoiceRevenueLine[]): InvoiceRevenueLine[] {
  if (!Number.isSafeInteger(amountCents)) throw new Error("Revenue amount must use integer cents")
  if (!lines.length) return []
  if (lines.some(line => !Number.isSafeInteger(line.amount_cents) || !line.account_code)) throw new Error("Invalid invoice revenue allocation")
  const total = lines.reduce((sum, line) => sum + BigInt(line.amount_cents), BigInt(0))
  if (total === BigInt(0)) {
    if (amountCents !== 0) throw new Error("Cannot allocate revenue against a zero invoice basis")
    return lines.map(line => ({ ...line, amount_cents: 0 }))
  }
  const parts = lines.map((line, index) => {
    const numerator = BigInt(amountCents) * BigInt(line.amount_cents)
    return { line, index, amount: numerator / total, remainder: numerator % total }
  })
  let remainder = BigInt(amountCents) - parts.reduce((sum, part) => sum + part.amount, BigInt(0))
  const direction = remainder < BigInt(0) ? BigInt(-1) : BigInt(1)
  const ordered = [...parts].sort((a,b) => {
    const difference = (a.remainder - b.remainder) * (total < BigInt(0) ? BigInt(-1) : BigInt(1)) * direction
    return difference > BigInt(0) ? -1 : difference < BigInt(0) ? 1 : a.index - b.index
  })
  for (const part of ordered) {
    if (remainder === BigInt(0)) break
    part.amount += direction; remainder -= direction
  }
  return parts.map(part => {
    const amount_cents = Number(part.amount)
    if (!Number.isSafeInteger(amount_cents)) throw new Error("Revenue allocation exceeds safe integer cents")
    return { ...part.line, amount_cents }
  })
}
