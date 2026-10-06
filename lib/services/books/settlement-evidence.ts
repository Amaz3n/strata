import { z } from "zod"

export function paymentProjectionSourceKeys(paymentId: string) {
  return ["bill_payment", "invoice_payment", "customer_deposit_receipt", "customer_deposit_application"].map(source => `${source}:${paymentId}`)
}

export const directSettlementEvidenceSchema = z.object({
  version: z.literal(1),
  kind: z.literal("direct"),
  payment_id: z.string().uuid(),
  invoice_id: z.string().uuid().nullable(),
  bill_id: z.string().uuid().nullable(),
}).refine(row => Boolean(row.invoice_id) !== Boolean(row.bill_id), "Settlement evidence requires exactly one document")

export const settlementAllocationSchema = z.object({
  allocation_id: z.string().uuid(),
  invoice_id: z.string().uuid().nullable(),
  bill_id: z.string().uuid().nullable(),
  project_id: z.string().uuid().nullable(),
  amount_cents: z.number().int().safe().positive(),
}).refine(row => Boolean(row.invoice_id) !== Boolean(row.bill_id), "Allocation requires exactly one document")

export const allocatedSettlementEvidenceSchema = z.object({
  version: z.literal(2), kind: z.literal("allocated"), payment_id: z.string().uuid(),
  payment_amount_cents: z.number().int().safe().positive(),
  allocations: z.array(settlementAllocationSchema).min(1),
}).superRefine((row, context) => {
  if (row.allocations.reduce((sum, item) => sum + BigInt(item.amount_cents), BigInt(0)) !== BigInt(row.payment_amount_cents)) context.addIssue({ code: "custom", message: "Settlement allocations must equal the payment amount" })
  const sides = new Set(row.allocations.map(item => item.invoice_id ? "invoice" : "bill"))
  if (sides.size !== 1) context.addIssue({ code: "custom", message: "A settlement cannot mix invoices and vendor bills" })
  const ids = new Set(row.allocations.map(item => item.invoice_id ?? item.bill_id))
  if (ids.size !== row.allocations.length) context.addIssue({ code: "custom", message: "Duplicate settlement document allocation" })
  if (new Set(row.allocations.map(item => item.allocation_id)).size !== row.allocations.length) context.addIssue({ code: "custom", message: "Duplicate settlement allocation identity" })
})
export const settlementEvidenceSchema = z.union([directSettlementEvidenceSchema, allocatedSettlementEvidenceSchema])
export type AllocatedSettlementEvidence = z.infer<typeof allocatedSettlementEvidenceSchema>

/** Captures a direct source link, not a reconstructed allocation or historical tax determination. */
export function directSettlementEvidence(row: { paymentId: string; invoiceId?: string | null; billId?: string | null }) {
  return directSettlementEvidenceSchema.parse({ version: 1, kind: "direct", payment_id: row.paymentId, invoice_id: row.invoiceId ?? null, bill_id: row.billId ?? null })
}

export function settlementDimensions(sourceType: string, value: unknown) {
  if (!["bill_payment", "invoice_payment", "customer_deposit_receipt", "customer_deposit_application", "customer_deposit_reversal"].includes(sourceType)) throw new Error("Unsupported settlement accounting source")
  const evidence = directSettlementEvidenceSchema.parse(value)
  if ((sourceType === "bill_payment" && !evidence.bill_id) ||
    (["invoice_payment", "customer_deposit_receipt", "customer_deposit_application", "customer_deposit_reversal"].includes(sourceType) && !evidence.invoice_id)) {
    throw new Error("Settlement document does not match its accounting source")
  }
  return { payment_id: evidence.payment_id, ...(evidence.invoice_id ? { invoice_id: evidence.invoice_id } : {}), ...(evidence.bill_id ? { bill_id: evidence.bill_id } : {}) }
}
