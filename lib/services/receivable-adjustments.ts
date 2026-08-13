import "server-only"

import { z } from "zod"

import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type { ReceivableAdjustment } from "@/lib/types"

const adjustmentSchema = z.object({
  invoiceId: z.string().uuid(),
  adjustmentType: z.enum(["credit_memo", "write_off"]),
  amountCents: z.number().int().positive(),
  taxCents: z.number().int().nonnegative().default(0),
  effectiveDate: z.string().date(),
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
})

export type CreateReceivableAdjustmentInput = z.input<typeof adjustmentSchema>

export async function createReceivableAdjustment(input: CreateReceivableAdjustmentInput) {
  const parsed = adjustmentSchema.parse(input)
  if (parsed.taxCents > parsed.amountCents) {
    throw new Error("The tax reversal cannot exceed the adjustment")
  }

  const { orgId, userId, supabase } = await requireOrgContext()
  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("id, project_id")
    .eq("org_id", orgId)
    .eq("id", parsed.invoiceId)
    .maybeSingle()
  if (invoiceError) throw new Error(`Failed to load invoice: ${invoiceError.message}`)
  if (!invoice) throw new Error("Invoice not found")

  await requireAuthorization({
    permission: "invoice.write",
    userId,
    orgId,
    projectId: invoice.project_id ?? undefined,
    supabase,
    logDecision: true,
    resourceType: "invoice",
    resourceId: parsed.invoiceId,
  })

  const service = createServiceSupabaseClient()
  const { data, error } = await service.rpc("create_receivable_adjustment_atomic", {
    p_org_id: orgId,
    p_invoice_id: parsed.invoiceId,
    p_adjustment_type: parsed.adjustmentType,
    p_amount_cents: parsed.amountCents,
    p_tax_cents: parsed.taxCents,
    p_effective_date: parsed.effectiveDate,
    p_reason: parsed.reason,
    p_actor_id: userId,
    p_idempotency_key: parsed.idempotencyKey ?? null,
    p_metadata: {},
  })
  if (error) throw new Error(`Failed to post receivable adjustment: ${error.message}`)
  const adjustment = data as ReceivableAdjustment

  await recordEvent({
    eventType: "receivable_adjustment_posted",
    entityType: "invoice",
    entityId: parsed.invoiceId,
    channel: "activity",
    payload: {
      adjustment_id: adjustment.id,
      adjustment_type: parsed.adjustmentType,
      amount_cents: parsed.amountCents,
      tax_cents: parsed.taxCents,
      reason: parsed.reason,
    },
  })
  return adjustment
}

export async function voidReceivableAdjustment(adjustmentId: string) {
  const parsedId = z.string().uuid().parse(adjustmentId)
  const { orgId, userId, supabase } = await requireOrgContext()
  const { data: adjustment, error: adjustmentError } = await supabase
    .from("receivable_adjustments")
    .select("id, invoice_id, project_id")
    .eq("org_id", orgId)
    .eq("id", parsedId)
    .maybeSingle()
  if (adjustmentError) throw new Error(`Failed to load receivable adjustment: ${adjustmentError.message}`)
  if (!adjustment) throw new Error("Receivable adjustment not found")

  await requireAuthorization({
    permission: "invoice.write",
    userId,
    orgId,
    projectId: adjustment.project_id ?? undefined,
    supabase,
    logDecision: true,
    resourceType: "invoice",
    resourceId: adjustment.invoice_id,
  })

  const service = createServiceSupabaseClient()
  const { data, error } = await service.rpc("void_receivable_adjustment_atomic", {
    p_org_id: orgId,
    p_adjustment_id: parsedId,
    p_actor_id: userId,
  })
  if (error) throw new Error(`Failed to void receivable adjustment: ${error.message}`)
  const result = data as ReceivableAdjustment

  await recordEvent({
    eventType: "receivable_adjustment_voided",
    entityType: "invoice",
    entityId: adjustment.invoice_id,
    channel: "activity",
    payload: { adjustment_id: parsedId },
  })
  return result
}

export async function listInvoiceReceivableAdjustments(invoiceId: string, orgId: string) {
  const service = createServiceSupabaseClient()
  const { data, error } = await service
    .from("receivable_adjustments")
    .select("id, org_id, project_id, invoice_id, adjustment_type, status, amount_cents, tax_cents, effective_date, reason, created_by, voided_by, voided_at, metadata, created_at, updated_at")
    .eq("org_id", orgId)
    .eq("invoice_id", invoiceId)
    .order("created_at", { ascending: false })
  if (error) throw new Error(`Failed to load receivable adjustments: ${error.message}`)
  return (data ?? []) as ReceivableAdjustment[]
}
