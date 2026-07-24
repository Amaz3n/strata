import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { resolveAccountingTarget } from "@/lib/services/accounting-target"
import { getProvider } from "@/lib/integrations/accounting/registry"
import type { PushResult } from "@/lib/integrations/accounting/provider"
import { accountingPushBlockReason } from "@/lib/services/accounting-rules"

export type AccountingPushEntityType = "invoice" | "payment" | "project_expense" | "vendor_bill" | "bill_payment"

export { ACCOUNTING_JOB_TYPES, LEGACY_ACCOUNTING_JOB_TYPES } from "@/lib/services/accounting-job-types"

const ENTITY_CONFIG: Record<AccountingPushEntityType, { payloadKey: string; jobType: string; paymentSetting: boolean }> = {
  invoice: { payloadKey: "invoice_id", jobType: "accounting_push_invoice", paymentSetting: false },
  payment: { payloadKey: "payment_id", jobType: "accounting_push_payment", paymentSetting: true },
  project_expense: { payloadKey: "expense_id", jobType: "accounting_push_project_expense", paymentSetting: false },
  vendor_bill: { payloadKey: "bill_id", jobType: "accounting_push_vendor_bill", paymentSetting: false },
  bill_payment: { payloadKey: "payment_id", jobType: "accounting_push_bill_payment", paymentSetting: true },
}

async function resolveProjectId(orgId: string, entityType: AccountingPushEntityType, entityId: string): Promise<string | null> {
  const supabase = createServiceSupabaseClient()
  if (entityType === "invoice" || entityType === "project_expense" || entityType === "vendor_bill") {
    const table = entityType === "invoice" ? "invoices" : entityType === "project_expense" ? "project_expenses" : "vendor_bills"
    const { data } = await supabase.from(table).select("project_id").eq("org_id", orgId).eq("id", entityId).maybeSingle()
    return data?.project_id ?? null
  }
  const { data } = await supabase
    .from("payments")
    .select("invoice:invoices(project_id),bill:vendor_bills(project_id)")
    .eq("org_id", orgId)
    .eq("id", entityId)
    .maybeSingle()
  const invoice = Array.isArray(data?.invoice) ? data.invoice[0] : data?.invoice
  const bill = Array.isArray(data?.bill) ? data.bill[0] : data?.bill
  return entityType === "bill_payment" ? bill?.project_id ?? null : invoice?.project_id ?? null
}

export async function enqueueAccountingPush(input: { orgId: string; entityType: AccountingPushEntityType; entityId: string }) {
  const supabase = createServiceSupabaseClient()
  const projectId = await resolveProjectId(input.orgId, input.entityType, input.entityId)
  const target = await resolveAccountingTarget({ orgId: input.orgId, projectId })
  if (!target) return { queued: false as const, reason: "unconnected" as const }

  const ledgerType = input.entityType === "vendor_bill" ? "bill" : input.entityType
  const { data: existingRows } = await supabase
    .from("accounting_sync_records")
    .select("pushable,connection_id")
    .eq("org_id", input.orgId)
    .eq("entity_type", ledgerType)
    .eq("entity_id", input.entityId)
  const existing = existingRows?.find((row) => row.connection_id === target.connection.id)
    ?? existingRows?.find((row) => row.connection_id !== target.connection.id)
  const config = ENTITY_CONFIG[input.entityType]
  const enabled = config.paymentSetting
    ? target.connection.settings.sync_payments !== false
    : target.connection.settings.auto_sync !== false
  const blockReason = accountingPushBlockReason({
    hasTarget: true,
    healthy: target.healthy,
    pushable: existing?.pushable,
    existingConnectionId: existing?.connection_id,
    targetConnectionId: target.connection.id,
    enabled,
  })
  if (blockReason === "connection_mismatch") {
    await supabase.from("accounting_sync_records").update({ status: "needs_review", error_message: "Resolved accounting connection differs from the connection that owns this transaction." }).eq("org_id", input.orgId).eq("connection_id", existing?.connection_id ?? "").eq("entity_type", ledgerType).eq("entity_id", input.entityId)
    return { queued: false as const, reason: "connection_mismatch" as const }
  }
  if (blockReason) return { queued: false as const, reason: blockReason }

  const queued = await enqueueOutboxJob({
    orgId: input.orgId,
    jobType: config.jobType,
    payload: { [config.payloadKey]: input.entityId },
    dedupeByPayloadKeys: [config.payloadKey],
  })
  if (queued.reason === "error") {
    await markAccountingSyncError(input.orgId, ledgerType, input.entityId, target.connection.id, target.connection.provider, "Unable to enqueue accounting sync job.")
    return { queued: false as const, reason: "error" as const }
  }
  return { queued: true as const, reason: queued.reason }
}

export async function markAccountingSyncError(orgId: string, entityType: string, entityId: string, connectionId: string, provider: string, message: string) {
  const supabase = createServiceSupabaseClient()
  const { error } = await supabase.from("accounting_sync_records").upsert({
    org_id: orgId, connection_id: connectionId, provider, entity_type: entityType,
    entity_id: entityId, external_id: "", status: "error", error_message: message.slice(0, 4000),
    last_synced_at: new Date().toISOString(),
  }, { onConflict: "org_id,connection_id,entity_type,entity_id" })
  if (error) throw new Error(`Unable to record accounting sync failure: ${error.message}`)
}

export async function processAccountingPush(input: { orgId: string; entityType: AccountingPushEntityType; entityId: string }): Promise<PushResult> {
  const projectId = await resolveProjectId(input.orgId, input.entityType, input.entityId)
  const target = await resolveAccountingTarget({ orgId: input.orgId, projectId })
  if (!target) throw new Error("No accounting connection is mapped to this transaction")
  if (!target.healthy) throw new Error(`Accounting connection ${target.connection.label} is ${target.connection.status}`)
  const provider = getProvider(target.connection.provider)
  const connectionId = target.connection.id
  if (input.entityType === "invoice") return provider.pushInvoice({ orgId: input.orgId, connectionId, invoiceId: input.entityId })
  if (input.entityType === "payment") return provider.pushPayment({ orgId: input.orgId, connectionId, paymentId: input.entityId })
  if (input.entityType === "project_expense") return provider.pushExpense({ orgId: input.orgId, connectionId, expenseId: input.entityId })
  if (input.entityType === "vendor_bill") {
    const supabase = createServiceSupabaseClient()
    const { data: payable } = await supabase.from("vendor_bills").select("metadata").eq("org_id", input.orgId).eq("id", input.entityId).maybeSingle()
    const isVendorCredit = (payable?.metadata as { source?: string } | null)?.source === "vendor_credit"
    if (isVendorCredit) {
      if (!provider.capabilities.supportsVendorCredits || !provider.pushVendorCredit) {
        throw new Error(`${target.connection.label} does not support vendor credits`)
      }
      return provider.pushVendorCredit({ orgId: input.orgId, connectionId, creditId: input.entityId })
    }
    return provider.pushVendorBill({ orgId: input.orgId, connectionId, billId: input.entityId })
  }
  return provider.pushBillPayment({ orgId: input.orgId, connectionId, paymentId: input.entityId })
}

export async function retryFailedAccountingSyncJobs(orgId: string) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("accounting_sync_records")
    .select("entity_type,entity_id").eq("org_id", orgId).in("status", ["error", "needs_review"]).eq("pushable", true).limit(200)
  if (error) throw new Error(`Unable to load failed accounting syncs: ${error.message}`)
  let retried = 0
  for (const row of data ?? []) {
    const entityType = row.entity_type === "bill" ? "vendor_bill" : row.entity_type
    if (!["invoice","payment","project_expense","vendor_bill","bill_payment"].includes(entityType)) continue
    const result = await enqueueAccountingPush({ orgId, entityType: entityType as AccountingPushEntityType, entityId: row.entity_id })
    if (result.queued) retried += 1
  }
  return { retried }
}

export const enqueueInvoiceSync = (invoiceId: string, orgId: string) => enqueueAccountingPush({ orgId, entityType: "invoice", entityId: invoiceId })
export const enqueuePaymentSync = (paymentId: string, orgId: string) => enqueueAccountingPush({ orgId, entityType: "payment", entityId: paymentId })
export const enqueueProjectExpenseSync = (expenseId: string, orgId: string) => enqueueAccountingPush({ orgId, entityType: "project_expense", entityId: expenseId })
export const enqueueVendorBillSync = (billId: string, orgId: string) => enqueueAccountingPush({ orgId, entityType: "vendor_bill", entityId: billId })
export const enqueueBillPaymentSync = (paymentId: string, orgId: string) => enqueueAccountingPush({ orgId, entityType: "bill_payment", entityId: paymentId })
