import "server-only"

import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { projectJournal } from "@/lib/services/books/projector"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

async function requireDepositManager(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "books.adjust",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "customer_deposit",
    resourceId: context.orgId,
    logDecision: true,
  })
  return context
}

export async function getCustomerDepositWorkspace(orgId?: string) {
  const context = await requireDepositManager(orgId)
  const service = createServiceSupabaseClient()
  const [{ data: depositInvoices, error: depositError }, { data: applications, error: applicationError }, { data: targets, error: targetError }] = await Promise.all([
    service
      .from("invoices")
      .select("id, invoice_number, title, project_id, metadata, total_cents, status, payments(id, amount_cents, status, received_at, payment_reversals(amount_cents,status))")
      .eq("org_id", context.orgId)
      .contains("metadata", { invoice_kind: "earnest_deposit" })
      .order("created_at", { ascending: false })
      .limit(250),
    service
      .from("payments")
      .select("id, amount_cents, status, metadata")
      .eq("org_id", context.orgId)
      .contains("metadata", { customer_deposit_application: true })
      .in("status", ["succeeded", "completed"])
      .limit(1000),
    service
      .from("invoices")
      .select("id, invoice_number, title, project_id, metadata, total_cents, balance_due_cents, status")
      .eq("org_id", context.orgId)
      .in("status", ["sent", "partial", "overdue"])
      .order("issue_date", { ascending: false })
      .limit(500),
  ])
  const error = depositError ?? applicationError ?? targetError
  if (error) throw new Error(`Failed to load customer deposits: ${error.message}`)
  const appliedByPayment = new Map<string, number>()
  for (const row of applications ?? []) {
    const paymentId = (row.metadata as Record<string, unknown> | null)?.deposit_payment_id
    if (typeof paymentId !== "string") continue
    appliedByPayment.set(paymentId, (appliedByPayment.get(paymentId) ?? 0) + Number(row.amount_cents ?? 0))
  }
  const deposits = (depositInvoices ?? []).flatMap((invoice: any) =>
    (invoice.payments ?? [])
      .filter((payment: any) => ["succeeded", "completed"].includes(String(payment.status)))
      .map((payment: any) => {
        const refundedCents = (payment.payment_reversals ?? [])
          .filter((row: any) => row.status === "succeeded")
          .reduce((sum: number, row: any) => sum + Number(row.amount_cents ?? 0), 0)
        const appliedCents = appliedByPayment.get(String(payment.id)) ?? 0
        return {
          paymentId: String(payment.id),
          invoiceId: String(invoice.id),
          invoiceNumber: String(invoice.invoice_number ?? "Deposit"),
          title: String(invoice.title ?? "Customer deposit"),
          projectId: invoice.project_id ? String(invoice.project_id) : null,
          customerId: typeof (invoice.metadata as Record<string, unknown> | null)?.customer_id === "string"
            ? String((invoice.metadata as Record<string, unknown>).customer_id)
            : null,
          receivedAt: String(payment.received_at),
          receivedCents: Number(payment.amount_cents ?? 0),
          appliedCents,
          refundedCents,
          availableCents: Number(payment.amount_cents ?? 0) - appliedCents - refundedCents,
        }
      }),
  )
  const targetInvoices = (targets ?? []).map((invoice) => ({
    ...invoice,
    customer_id:
      typeof (invoice.metadata as Record<string, unknown> | null)?.customer_id === "string"
        ? String((invoice.metadata as Record<string, unknown>).customer_id)
        : null,
  }))
  return { deposits, targetInvoices }
}

export async function applyCustomerDeposit(input: {
  depositPaymentId: string
  targetInvoiceId: string
  amountCents: number
  appliedAt?: string
}, orgId?: string) {
  const context = await requireDepositManager(orgId)
  const parsed = z.object({
    depositPaymentId: z.string().uuid(),
    targetInvoiceId: z.string().uuid(),
    amountCents: z.number().int().positive(),
    appliedAt: z.string().datetime({ offset: true }).optional(),
  }).parse(input)
  const service = createServiceSupabaseClient()
  const { data, error } = await service.rpc("apply_customer_deposit_atomic", {
    p_org_id: context.orgId,
    p_deposit_payment_id: parsed.depositPaymentId,
    p_target_invoice_id: parsed.targetInvoiceId,
    p_amount_cents: parsed.amountCents,
    p_actor_id: context.userId,
    p_received_at: parsed.appliedAt ?? new Date().toISOString(),
  })
  if (error || !data) throw new Error(`Failed to apply customer deposit: ${error?.message ?? "No payment returned"}`)
  const paymentId = String((data as { id?: unknown }).id ?? "")
  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: "insert",
    entityType: "customer_deposit_application",
    entityId: paymentId || parsed.depositPaymentId,
    after: parsed,
    source: "books.customer_deposits",
  })
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "customer_deposit_applied",
    entityType: "payment",
    entityId: paymentId || parsed.depositPaymentId,
    payload: { deposit_payment_id: parsed.depositPaymentId, invoice_id: parsed.targetInvoiceId, amount_cents: parsed.amountCents },
  })
  await projectJournal(context.orgId, { full: false })
  return { paymentId }
}
