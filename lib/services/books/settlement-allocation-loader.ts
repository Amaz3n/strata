import "server-only"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { collectBooksRows } from "@/lib/services/books/paging"
import { allocatedSettlementEvidenceSchema, type AllocatedSettlementEvidence } from "@/lib/services/books/settlement-evidence"

/** Scope each target and take ownership from its document, not allocation-supplied project IDs. */
export async function loadPaymentAllocationEvidence(orgId: string, payments: Array<{ id: string; amount_cents: unknown; invoice_id?: string | null; bill_id?: string | null }>) {
  const service = createServiceSupabaseClient()
  const evidence = new Map<string, AllocatedSettlementEvidence>()
  const errors = new Map<string, string>()
  for (let start = 0; start < payments.length; start += 200) {
    const batch = payments.slice(start, start + 200)
    const allocations = await collectBooksRows((from, to) => service.from("payment_allocations")
      .select("id,payment_id,invoice_id,bill_id,project_id,amount_cents").eq("org_id", orgId).in("payment_id", batch.map(row => row.id)).order("id").range(from, to))
    const documents = new Map<string, { projectId: string | null; deposit: boolean }>()
    for (const [table, key] of [["invoices", "invoice_id"], ["vendor_bills", "bill_id"]] as const) {
      const ids = [...new Set(allocations.map(row => row[key]).filter((id): id is string => Boolean(id)))].sort()
      for (let offset = 0; offset < ids.length; offset += 200) {
        const documentIds = ids.slice(offset, offset + 200)
        if (table === "invoices") {
          const rows = await collectBooksRows((from, to) => service.from("invoices")
            .select("id,project_id,metadata").eq("org_id", orgId).in("id", documentIds).order("id").range(from, to))
          for (const row of rows) documents.set(`${key}:${row.id}`, {
            projectId: row.project_id ?? null,
            deposit: (row.metadata as Record<string, unknown> | null)?.invoice_kind === "earnest_deposit",
          })
        } else {
          const rows = await collectBooksRows((from, to) => service.from("vendor_bills")
            .select("id,project_id").eq("org_id", orgId).in("id", documentIds).order("id").range(from, to))
          for (const row of rows) documents.set(`${key}:${row.id}`, { projectId: row.project_id ?? null, deposit: false })
        }
      }
    }
    const byPayment = new Map<string, typeof allocations>()
    for (const row of allocations) { const group = byPayment.get(row.payment_id) ?? []; group.push(row); byPayment.set(row.payment_id, group) }
    for (const payment of batch) {
      const rows = byPayment.get(payment.id)
      if (!rows?.length) continue
      try {
        const captured = rows.map(row => {
          const key = row.invoice_id ? "invoice_id" : "bill_id"
          const document = documents.get(`${key}:${row[key]}`)
          if (!document) throw new Error("Settlement allocation document is outside this organization")
          if (document.deposit) throw new Error("Earnest-deposit allocations require the deposit workflow")
          if (row.project_id && row.project_id !== document.projectId) throw new Error("Settlement allocation project does not match its document")
          return { allocation_id: row.id, invoice_id: row.invoice_id ?? null, bill_id: row.bill_id ?? null, project_id: document.projectId, amount_cents: Number(row.amount_cents) }
        })
        const proof = allocatedSettlementEvidenceSchema.parse({ version: 2, kind: "allocated", payment_id: payment.id, payment_amount_cents: Number(payment.amount_cents), allocations: captured })
        if ((payment.invoice_id && !captured.some(row => row.invoice_id === payment.invoice_id)) || (payment.bill_id && !captured.some(row => row.bill_id === payment.bill_id))) throw new Error("Direct payment document is absent from its allocation evidence")
        if ((payment.invoice_id && captured[0].bill_id) || (payment.bill_id && captured[0].invoice_id)) throw new Error("Direct payment side conflicts with its allocations")
        evidence.set(payment.id, proof)
      } catch (error) { errors.set(payment.id, error instanceof Error ? error.message : String(error)) }
    }
  }
  return { evidence, errors }
}
