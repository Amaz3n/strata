'use server'

import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { requireOrgContext } from "@/lib/services/context"
import {
  getAccountingInvoiceItemConfiguration,
  updateAccountingInvoiceItemConfiguration,
} from "@/lib/services/accounting-invoice-items"
import { requirePermission } from "@/lib/services/permissions"
import { updateAccountingConnectionSettings } from "@/lib/services/accounting-connections"
import { recordEvent } from "@/lib/services/events"

const itemReference = z.object({
  id: z.string().trim().min(1).max(255),
  name: z.string().trim().max(255).nullable(),
})

const updateSchema = z.object({
  connectionId: z.string().uuid(),
  defaultItem: itemReference.nullable(),
  incomeAccountMappings: z.record(z.string().trim().min(1).max(255), itemReference),
})

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

export async function getAccountingInvoiceItemConfigurationAction(connectionId: string) {
  return run(async () => {
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("org.admin", { supabase, orgId, userId })
    return getAccountingInvoiceItemConfiguration(connectionId, orgId)
  })
}

export async function updateAccountingInvoiceItemConfigurationAction(input: unknown) {
  return run(async () => {
    const parsed = updateSchema.parse(input)
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("org.admin", { supabase, orgId, userId })
    return updateAccountingInvoiceItemConfiguration({ ...parsed, orgId })
  })
}

export async function updateInvoiceSyncEnabledAction(input: unknown) {
  return run(async () => {
    const parsed = z.object({ connectionId: z.string().uuid(), enabled: z.boolean() }).parse(input)
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("org.admin", { supabase, orgId, userId })
    return updateAccountingConnectionSettings(parsed.connectionId, { sync_invoices: parsed.enabled }, orgId)
  })
}

/** Explicitly transfer one imported invoice from QBO-owned to Arc-owned. */
export async function adoptImportedInvoiceForOutboundAction(input: unknown) {
  return run(async () => {
    const parsed = z.object({ connectionId: z.string().uuid(), invoiceId: z.string().uuid() }).parse(input)
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("invoice.write", { supabase, orgId, userId })

    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .select("id,metadata")
      .eq("org_id", orgId)
      .eq("id", parsed.invoiceId)
      .maybeSingle()
    if (invoiceError || !invoice) throw new Error(invoiceError?.message ?? "Invoice not found")
    const metadata = (invoice.metadata as Record<string, unknown> | null) ?? {}
    if (metadata.imported_from_qbo !== true) throw new Error("Only a QBO-imported invoice requires outbound adoption")

    const { data: syncRecord, error: syncError } = await supabase
      .from("accounting_sync_records")
      .select("id,metadata")
      .eq("org_id", orgId)
      .eq("connection_id", parsed.connectionId)
      .eq("entity_type", "invoice")
      .eq("entity_id", parsed.invoiceId)
      .maybeSingle()
    if (syncError || !syncRecord) throw new Error(syncError?.message ?? "Invoice accounting link not found")

    const adoptedAt = new Date().toISOString()
    const { error: updateInvoiceError } = await supabase
      .from("invoices")
      .update({ metadata: { ...metadata, accounting_push_adopted: true, accounting_push_adopted_at: adoptedAt } })
      .eq("org_id", orgId)
      .eq("id", parsed.invoiceId)
    if (updateInvoiceError) throw new Error(`Unable to adopt invoice: ${updateInvoiceError.message}`)

    const { error: updateSyncError } = await supabase
      .from("accounting_sync_records")
      .update({
        pushable: true,
        metadata: {
          ...((syncRecord.metadata as Record<string, unknown> | null) ?? {}),
          ownership: "outbound",
          adopted_at: adoptedAt,
          adopted_by: userId,
        },
      })
      .eq("org_id", orgId)
      .eq("id", syncRecord.id)
    if (updateSyncError) throw new Error(`Unable to adopt invoice accounting link: ${updateSyncError.message}`)

    await recordEvent({
      orgId,
      actorId: userId,
      eventType: "qbo_imported_invoice_adopted_for_outbound",
      entityType: "invoice",
      entityId: parsed.invoiceId,
      payload: { connection_id: parsed.connectionId },
      channel: "integration",
    })
    return { adopted: true }
  })
}
