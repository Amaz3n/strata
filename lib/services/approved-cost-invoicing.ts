import { randomUUID } from "crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

import { buildApprovedCostInvoiceIdempotencyKey } from "@/lib/financials/approved-cost-rules"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { assertApprovedCostsMeetProjectFinancialRules } from "@/lib/services/project-financial-setup"
import { enqueueInvoiceSync } from "@/lib/services/accounting-sync"
import type { InvoiceDraft } from "@/lib/services/cost-plus"

type ApprovedCostInvoiceStatus = "draft" | "saved" | "sent" | "partial" | "paid" | "overdue" | "void"

export type CreateApprovedCostInvoiceParams = {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  actorId: string
  invoiceNumber: string
  token?: string | null
  title: string
  issueDate: string
  dueDate: string
  fromDate: string
  toDate: string
  groupBy: "cost_code" | "detail"
  costIds: string[]
  preview: InvoiceDraft
  idempotencyKey?: string | null
  reservationId?: string | null
  status?: ApprovedCostInvoiceStatus
  clientVisible?: boolean
  notes?: string | null
  sentToEmails?: string[] | null
  metadata?: Record<string, any>
  auditLabel?: string
}

function normalizePreview(preview: InvoiceDraft): InvoiceDraft {
  return {
    ...preview,
    lines: preview.lines.map((line, index) => ({
      ...line,
      sort_order: (line as any).sort_order ?? index,
    })),
  } as InvoiceDraft
}

export async function createApprovedCostInvoiceFromPreview(params: CreateApprovedCostInvoiceParams) {
  const uniqueCostIds = Array.from(new Set(params.costIds))
  if (uniqueCostIds.length === 0) {
    throw new Error("Select approved costs before creating an approved-cost invoice")
  }
  if (uniqueCostIds.length !== params.costIds.length) {
    throw new Error("Approved-cost invoice includes duplicate costs. Refresh and try again.")
  }

  const preview = normalizePreview(params.preview)
  await assertApprovedCostsMeetProjectFinancialRules({
    supabase: params.supabase,
    orgId: params.orgId,
    projectId: params.projectId,
    costIds: uniqueCostIds,
  })

  const idempotencyKey =
    params.idempotencyKey ??
    buildApprovedCostInvoiceIdempotencyKey({
      orgId: params.orgId,
      projectId: params.projectId,
      invoiceNumber: params.invoiceNumber,
      costIds: uniqueCostIds,
      preview,
      reservationId: params.reservationId,
    })

  const { data: rpcResult, error: rpcError } = await params.supabase.rpc("create_invoice_from_billable_costs_atomic", {
    p_org_id: params.orgId,
    p_project_id: params.projectId,
    p_actor_id: params.actorId,
    p_invoice_number: params.invoiceNumber,
    p_token: params.token ?? randomUUID(),
    p_title: params.title,
    p_issue_date: params.issueDate,
    p_due_date: params.dueDate,
    p_from_date: params.fromDate,
    p_to_date: params.toDate,
    p_group_by: params.groupBy,
    p_cost_ids: uniqueCostIds,
    p_preview: preview,
    p_idempotency_key: idempotencyKey,
    p_reservation_id: params.reservationId ?? null,
    p_status: params.status ?? "saved",
    p_client_visible: params.clientVisible ?? false,
    p_notes: params.notes ?? null,
    p_sent_to_emails: params.sentToEmails ?? null,
    p_metadata: params.metadata ?? {},
  })

  if (rpcError) {
    throw new Error(`Failed to create approved-cost invoice: ${rpcError.message}`)
  }

  const invoiceId = (rpcResult as any)?.invoiceId
  if (!invoiceId) throw new Error("Failed to create approved-cost invoice: missing invoice id")

  await recordEvent({
    orgId: params.orgId,
    eventType: "invoice_created",
    entityType: "invoice",
    entityId: invoiceId,
    payload: {
      invoice_number: params.invoiceNumber,
      project_id: params.projectId,
      total_cents: preview.totals.billable_cents,
      source_type: "from_costs",
      billable_cost_ids: uniqueCostIds,
      idempotency_key: idempotencyKey,
    },
  })

  await recordAudit({
    orgId: params.orgId,
    actorId: params.actorId,
    action: "insert",
    entityType: "invoice",
    entityId: invoiceId,
    after: {
      invoice_number: params.invoiceNumber,
      project_id: params.projectId,
      source_type: "from_costs",
      source_label: params.auditLabel ?? "approved_cost_invoice",
      billable_cost_ids: uniqueCostIds,
      totals: preview.totals,
      idempotency_key: idempotencyKey,
    },
  })

  if (params.clientVisible || ["saved", "sent", "partial", "paid", "overdue"].includes(params.status ?? "saved")) {
    await enqueueInvoiceSync(invoiceId, params.orgId)
  }

  return {
    invoiceId,
    invoicePreview: (rpcResult as any)?.invoicePreview ?? preview,
    idempotencyKey,
  }
}
