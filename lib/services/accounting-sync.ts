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

async function operationalPushAllowed(orgId: string) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("books_settings").select("ledger_authority, external_sync_posture").eq("org_id", orgId).maybeSingle()
  // Additive-rollout compatibility: before the Books migration exists, preserve
  // the existing provider integration behavior.
  if (error) return true
  return !data || data.ledger_authority === "external"
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
  if (!await operationalPushAllowed(input.orgId)) return { queued: false as const, reason: "books_authoritative" as const }
  const supabase = createServiceSupabaseClient()
  const projectId = await resolveProjectId(input.orgId, input.entityType, input.entityId)
  const target = await resolveAccountingTarget({ orgId: input.orgId, projectId })
  if (!target) return { queued: false as const, reason: "unconnected" as const }

  const ledgerType = input.entityType === "vendor_bill" ? "bill" : input.entityType

  // A freeze strands transactions that were meant to post, and the freeze is
  // lifted long after the person who approved them has moved on. Recording it
  // per entity is what makes the backlog findable afterwards instead of leaving
  // the row indistinguishable from one that simply has not run yet.
  if (typeof target.connection.settings.cutover_freeze_run_id === "string") {
    await markAccountingSyncNeedsReview(
      input.orgId,
      ledgerType,
      input.entityId,
      target.connection.id,
      target.connection.provider,
      "Held by an accounting cutover freeze. It will not post until the freeze is lifted.",
    )
    return { queued: false as const, reason: "cutover_freeze" as const }
  }
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

/** A transaction that cannot post right now, and that a human has to come back to. */
export async function markAccountingSyncNeedsReview(orgId: string, entityType: string, entityId: string, connectionId: string, provider: string, message: string) {
  const supabase = createServiceSupabaseClient()
  await supabase.from("accounting_sync_records").upsert({
    org_id: orgId, connection_id: connectionId, provider, entity_type: entityType,
    entity_id: entityId, external_id: "", status: "needs_review", error_message: message.slice(0, 4000),
  }, { onConflict: "org_id,connection_id,entity_type,entity_id" })
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
  if (!await operationalPushAllowed(input.orgId)) return { externalId: null, skipped: true }
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

/**
 * A push that has run out of retries.
 *
 * The outbox marked the job `failed` and stopped, which was the end of it: no
 * event, no notification, and no per-row trace. The transaction's badge kept
 * saying "not synced", which is also what a job that has not run yet says, so
 * a permanent failure and a thirty-second wait looked identical.
 */
export async function markAccountingPushExhausted(input: {
  orgId: string
  entityType: AccountingPushEntityType
  entityId: string
  message: string
}) {
  const projectId = await resolveProjectId(input.orgId, input.entityType, input.entityId)
  const target = await resolveAccountingTarget({ orgId: input.orgId, projectId })
  if (!target) return
  const ledgerType = input.entityType === "vendor_bill" ? "bill" : input.entityType
  await markAccountingSyncError(
    input.orgId,
    ledgerType,
    input.entityId,
    target.connection.id,
    target.connection.provider,
    `Sync gave up after repeated failures and will not retry on its own: ${input.message}`,
  )
}

export interface AccountingSyncPosture {
  /** Transactions waiting to post, or that failed and need a person. */
  pendingCount: number
  errorCount: number
  needsReviewCount: number
  /** Outbox jobs that exhausted their retries and will never run again. */
  failedJobCount: number
  /** Set when pushes are suppressed org-wide rather than per transaction. */
  suppressedReason: "books_authoritative" | "unconnected" | "cutover_freeze" | null
}

/**
 * What the org's accounting sync is actually doing.
 *
 * Settings showed connection health and nothing else, so "connected, synced 4
 * minutes ago" was displayed over a backlog of transactions that had failed
 * permanently or were frozen mid-cutover. Nothing counted them anywhere a user
 * could see.
 */
export async function getAccountingSyncPosture(orgId: string): Promise<AccountingSyncPosture> {
  const supabase = createServiceSupabaseClient()
  const [{ data: records }, { count: failedJobCount }, booksAuthoritative, target] = await Promise.all([
    supabase.from("accounting_sync_records").select("status").eq("org_id", orgId).in("status", ["pending", "error", "needs_review"]).limit(1000),
    supabase.from("outbox").select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "failed")
      .in("job_type", Object.values(ENTITY_CONFIG).map((config) => config.jobType))
      .then((result) => ({ count: result.count ?? 0 })),
    operationalPushAllowed(orgId).then((allowed) => !allowed),
    resolveAccountingTarget({ orgId, projectId: null }),
  ])

  const rows = records ?? []
  return {
    pendingCount: rows.filter((row) => row.status === "pending").length,
    errorCount: rows.filter((row) => row.status === "error").length,
    needsReviewCount: rows.filter((row) => row.status === "needs_review").length,
    failedJobCount,
    suppressedReason: booksAuthoritative
      ? "books_authoritative"
      : !target
        ? "unconnected"
        : typeof target.connection.settings.cutover_freeze_run_id === "string"
          ? "cutover_freeze"
          : null,
  }
}

export const enqueueInvoiceSync = (invoiceId: string, orgId: string) => enqueueAccountingPush({ orgId, entityType: "invoice", entityId: invoiceId })
export const enqueuePaymentSync = (paymentId: string, orgId: string) => enqueueAccountingPush({ orgId, entityType: "payment", entityId: paymentId })
export const enqueueProjectExpenseSync = (expenseId: string, orgId: string) => enqueueAccountingPush({ orgId, entityType: "project_expense", entityId: expenseId })
export const enqueueVendorBillSync = (billId: string, orgId: string) => enqueueAccountingPush({ orgId, entityType: "vendor_bill", entityId: billId })
export const enqueueBillPaymentSync = (paymentId: string, orgId: string) => enqueueAccountingPush({ orgId, entityType: "bill_payment", entityId: paymentId })

/**
 * Reverse a bill payment in the accounting system after an ACH return.
 *
 * Runs inline rather than through the outbox: it is called from the provider
 * event that already reopened the bill, and the window where Arc says "open" and
 * the GL says "paid" should be as short as possible. A failure raises so the
 * webhook retries, because leaving the two ledgers disagreeing silently is the
 * outcome this exists to prevent.
 */
export async function voidBillPaymentInAccounting(input: { orgId: string; paymentId: string; reason: string }) {
  if (!await operationalPushAllowed(input.orgId)) return { voided: false as const, reason: "books_authoritative" as const }
  const projectId = await resolveProjectId(input.orgId, "bill_payment", input.paymentId)
  const target = await resolveAccountingTarget({ orgId: input.orgId, projectId })
  if (!target) return { voided: false as const, reason: "unconnected" as const }
  const provider = getProvider(target.connection.provider)
  if (!provider.capabilities.supportsBillPaymentVoid || !provider.voidBillPayment) {
    // Never silent: an unsupported target still has to leave a durable trace
    // that a human owes this reversal by hand.
    await markAccountingSyncError(
      input.orgId,
      "bill_payment",
      input.paymentId,
      target.connection.id,
      target.connection.provider,
      `${target.connection.label} cannot reverse a posted bill payment. Reverse it manually — this payment was returned: ${input.reason}`,
    )
    return { voided: false as const, reason: "unsupported" as const }
  }
  await provider.voidBillPayment({ orgId: input.orgId, connectionId: target.connection.id, paymentId: input.paymentId, reason: input.reason })
  return { voided: true as const }
}
