import { z } from "zod"
import { allocateInvoiceRevenue, type InvoiceRevenueLine } from "@/lib/services/books/invoice-revenue-rules"
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts"

export const pocRevenueAllocationSchema = z.object({
  account_id: z.string().uuid(),
  account_code: z.string().trim().min(1),
  contract_cents: z.number().int().safe().positive(),
  contract_id: z.string().uuid().nullable().optional(),
  cost_code_id: z.string().uuid().nullable().optional(),
})
export type PocRevenueAllocation = z.infer<typeof pocRevenueAllocationSchema>

function key(line: InvoiceRevenueLine) {
  return JSON.stringify([line.account_code, line.dimensions?.contract_id ?? null, line.dimensions?.cost_code_id ?? null])
}

/** Cumulative targets avoid rounding drift and reverse earlier mappings when estimates change. */
export function pocRevenueAllocationDeltas(
  earnedCents: number,
  allocations: PocRevenueAllocation[],
  recognized: InvoiceRevenueLine[],
  /** A contract-scoped position earns into its contract's bucket by default. */
  contractId: string | null = null,
): InvoiceRevenueLine[] {
  if (!Number.isSafeInteger(earnedCents) || earnedCents < 0) throw new Error("POC earned revenue must be nonnegative safe integer cents")
  const weights = allocations.length ? z.array(pocRevenueAllocationSchema).parse(allocations).map(row => ({
    account_code: row.account_code,
    amount_cents: row.contract_cents,
    dimensions: { ...(row.contract_id ? { contract_id: row.contract_id } : {}), ...(row.cost_code_id ? { cost_code_id: row.cost_code_id } : {}) },
  })) : [{ account_code: SYSTEM_ACCOUNT_CODES.constructionRevenue, amount_cents: 1, ...(contractId ? { dimensions: { contract_id: contractId } } : {}) }]
  const target = allocateInvoiceRevenue(earnedCents, weights)
  const amounts = new Map<string, { line: InvoiceRevenueLine; cents: bigint }>()
  for (const [rows, sign] of [[target, BigInt(1)], [recognized, BigInt(-1)]] as const) {
    for (const row of rows) {
      if (!Number.isSafeInteger(row.amount_cents)) throw new Error("Recognized POC revenue exceeds safe integer cents")
      const bucket = key(row)
      const existing = amounts.get(bucket)
      // Only economic allocation dimensions belong to a cumulative bucket.
      const dimensions = { ...(row.dimensions?.contract_id ? { contract_id: row.dimensions.contract_id } : {}), ...(row.dimensions?.cost_code_id ? { cost_code_id: row.dimensions.cost_code_id } : {}) }
      amounts.set(bucket, { line: { account_code: row.account_code, amount_cents: 0, dimensions }, cents: (existing?.cents ?? BigInt(0)) + sign * BigInt(row.amount_cents) })
    }
  }
  return [...amounts.values()].filter(row => row.cents !== BigInt(0)).map(row => {
    const cents = Number(row.cents)
    if (!Number.isSafeInteger(cents)) throw new Error("POC revenue allocation delta exceeds safe integer cents")
    return { ...row.line, amount_cents: cents }
  })
}
