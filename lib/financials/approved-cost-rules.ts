import { createHash } from "crypto"
import type { InvoiceDraft } from "@/lib/services/cost-plus"

export function buildApprovedCostInvoiceIdempotencyKey(params: {
  orgId: string
  projectId: string
  invoiceNumber: string
  costIds: string[]
  preview: InvoiceDraft
  reservationId?: string | null
}) {
  const hash = createHash("sha256")
  hash.update(params.orgId)
  hash.update(params.projectId)
  hash.update(params.invoiceNumber)
  hash.update(params.reservationId ?? "")
  hash.update(JSON.stringify([...params.costIds].sort()))
  hash.update(JSON.stringify(params.preview.totals))
  return `approved_cost_invoice:${hash.digest("hex").slice(0, 48)}`
}
