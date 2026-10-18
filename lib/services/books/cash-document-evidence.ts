import { z } from "zod"
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts"
import type { CashDocumentBasis } from "@/lib/services/books/cash-settlement-rules"

const schema = z.object({
  total_cents: z.number().int().safe().nonnegative(),
  tax_cents: z.number().int().safe().nonnegative(),
  retainage_cents: z.number().int().safe().nonnegative().optional(),
  revenue_basis: z.enum(["percentage_of_completion", "on_invoice", "closing"]),
  revenue_lines: z.array(z.object({ account_code: z.string().min(1), amount_cents: z.number().int().safe(), dimensions: z.record(z.unknown()).optional() })),
  project_id: z.string().nullable().optional(),
  project_dimensions: z.record(z.record(z.unknown())).optional(),
  dimensions: z.record(z.unknown()).optional(),
})

/** No live document fallback: absent legacy evidence needs explicit migration review. */
export function cashIncomeBasisFromInvoiceFact(fact: {
  id: string; sourceId: string; accountingDate: string; payload: Record<string, unknown>
}, completeSettlementHistory = false): CashDocumentBasis {
  if (!("revenue_lines" in fact.payload)) throw new Error("Invoice fact has no frozen income evidence; reviewed historical attribution is required")
  const payload = schema.parse(fact.payload)
  const gross = BigInt(payload.total_cents) + (payload.revenue_basis === "percentage_of_completion" ? BigInt(payload.retainage_cents ?? 0) : BigInt(0))
  if (gross > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(payload.tax_cents) >= gross) throw new Error("Invoice income basis requires safe positive net income")
  const income: z.infer<typeof schema>["revenue_lines"] = payload.revenue_lines.length ? payload.revenue_lines : [{ account_code: SYSTEM_ACCOUNT_CODES.constructionRevenue, amount_cents: Number(gross - BigInt(payload.tax_cents)) }]
  if (income.reduce((sum, row) => sum + BigInt(row.amount_cents), BigInt(0)) + BigInt(payload.tax_cents) !== gross) throw new Error("Frozen invoice income and tax do not equal its gross principal")
  const sourceDimensions = { ...(payload.project_id ? { project_id: payload.project_id, ...payload.project_dimensions?.[payload.project_id] } : {}), ...payload.dimensions }
  return {
    documentId: fact.sourceId, snapshotId: fact.id, issuedOn: fact.accountingDate,
    grossCents: Number(gross), completeSettlementHistory,
    components: [
      ...income.map((row, i) => ({ id: `income:${i}`, kind: "income" as const, accountCode: row.account_code, amountCents: row.amount_cents,
        ...(Object.keys(sourceDimensions).length || row.dimensions ? { dimensions: { ...sourceDimensions, ...row.dimensions } } : {}) })),
      ...(payload.tax_cents ? [{ id: "sales_tax", kind: "sales_tax" as const, accountCode: SYSTEM_ACCOUNT_CODES.salesUseTaxPayable, amountCents: payload.tax_cents,
        ...(Object.keys(sourceDimensions).length ? { dimensions: sourceDimensions } : {}) }] : []),
    ],
  }
}
