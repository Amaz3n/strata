import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { resolveAccountingTarget } from "@/lib/services/accounting-target"
import { getProvider } from "@/lib/integrations/accounting/registry"
import type { PushResult } from "@/lib/integrations/accounting/provider"
import { accountingPushBlockReason } from "@/lib/services/accounting-rules"
import { isExternalLedgerAuthoritative } from "@/lib/services/books/authority"
import { recordEvent } from "@/lib/services/events"
import { recordAccountingSyncAttempt } from "@/lib/services/accounting-sync-attempts"

export type AccountingPushEntityType = "invoice" | "payment" | "project_expense" | "vendor_bill" | "bill_payment"

import { ACCOUNTING_JOB_TYPES } from "@/lib/services/accounting-job-types"
export { ACCOUNTING_JOB_TYPES, LEGACY_ACCOUNTING_JOB_TYPES } from "@/lib/services/accounting-job-types"

const ENTITY_CONFIG: Record<AccountingPushEntityType, { payloadKey: string; jobType: string; paymentSetting: boolean }> = {
  invoice: { payloadKey: "invoice_id", jobType: "accounting_push_invoice", paymentSetting: false },
  payment: { payloadKey: "payment_id", jobType: "accounting_push_payment", paymentSetting: true },
  project_expense: { payloadKey: "expense_id", jobType: "accounting_push_project_expense", paymentSetting: false },
  vendor_bill: { payloadKey: "bill_id", jobType: "accounting_push_vendor_bill", paymentSetting: false },
  bill_payment: { payloadKey: "payment_id", jobType: "accounting_push_bill_payment", paymentSetting: true },
}

/**
 * Whether this org's ledger authority still permits writing to the external
 * accounting system. Fails CLOSED: `isExternalLedgerAuthoritative` throws on an
 * unreadable authority row rather than assuming "external", so a transient blip
 * can never hand an Arc-authoritative org's data to its external system.
 *
 * Enqueueing is deliberately more forgiving than pushing. Queueing writes
 * nothing externally and `processAccountingPush` re-checks the gate before it
 * does, so a read failure here queues the job rather than failing the user
 * mutation that triggered it — the durable gate is the one at push time.
 */
async function pushAllowedForEnqueue(orgId: string) {
  try {
    return await isExternalLedgerAuthoritative(orgId)
  } catch {
    return true
  }
}

/**
 * A vendor_bills row is either a bill or a vendor credit (metadata.source), and
 * the sync ledger keys them under different entity types ("bill" vs
 * "vendor_credit"). Every write against the ledger for a vendor_bill must use
 * this resolved type, or an imported credit's inbound-only record is invisible
 * and a second record gets created under "bill".
 */
async function resolveVendorBillLedgerContext(orgId: string, billId: string): Promise<{ projectId: string | null; ledgerType: "bill" | "vendor_credit" }> {
  const supabase = createServiceSupabaseClient()
  const { data } = await supabase.from("vendor_bills").select("project_id, metadata").eq("org_id", orgId).eq("id", billId).maybeSingle()
  return {
    projectId: data?.project_id ?? null,
    ledgerType: (data?.metadata as { source?: string } | null)?.source === "vendor_credit" ? "vendor_credit" : "bill",
  }
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
  if (!await pushAllowedForEnqueue(input.orgId)) return { queued: false as const, reason: "books_authoritative" as const }
  const supabase = createServiceSupabaseClient()
  const billContext = input.entityType === "vendor_bill" ? await resolveVendorBillLedgerContext(input.orgId, input.entityId) : null
  const projectId = billContext ? billContext.projectId : await resolveProjectId(input.orgId, input.entityType, input.entityId)
  const target = await resolveAccountingTarget({ orgId: input.orgId, projectId })
  if (!target) return { queued: false as const, reason: "unconnected" as const }

  const ledgerType = billContext ? billContext.ledgerType : input.entityType

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

/**
 * Record a status against a transaction's sync ledger row **without touching the
 * external id it already carries.**
 *
 * These two functions used to `upsert` with `external_id: ""`, which on conflict
 * overwrote a recorded QuickBooks id with the empty string. Every path that
 * reaches them — retry exhaustion, an enqueue failure, and the cutover freeze,
 * which fires on *every* enqueue while frozen including entities already linked
 * in QuickBooks — therefore erased the only durable record that the transaction
 * exists over there. Nothing broke yet because the push paths still fall back to
 * the legacy `qbo_id` column; the moment that column is dropped, a wiped link
 * means the next push takes the create branch and posts a **second** invoice or
 * bill into the customer's books. Status is status; identity is identity.
 */
async function markAccountingSyncStatus(input: {
  orgId: string
  entityType: string
  entityId: string
  connectionId: string
  provider: string
  status: "error" | "needs_review"
  message: string
}) {
  const supabase = createServiceSupabaseClient()
  const errorMessage = input.message.slice(0, 4000)
  const { data: existing } = await supabase
    .from("accounting_sync_records")
    .select("id")
    .eq("org_id", input.orgId)
    .eq("connection_id", input.connectionId)
    .eq("entity_type", input.entityType)
    .eq("entity_id", input.entityId)
    .maybeSingle()

  if (existing?.id) {
    const { error } = await supabase
      .from("accounting_sync_records")
      .update({ status: input.status, error_message: errorMessage, last_synced_at: new Date().toISOString() })
      .eq("id", existing.id)
    return error
  }

  const { error: insertError } = await supabase.from("accounting_sync_records").insert({
    org_id: input.orgId,
    connection_id: input.connectionId,
    provider: input.provider,
    entity_type: input.entityType,
    entity_id: input.entityId,
    // Only ever written on a row that did not exist, so it can never displace a
    // real external id.
    external_id: "",
    status: input.status,
    error_message: errorMessage,
    last_synced_at: new Date().toISOString(),
  })
  if (!insertError) return null

  // Lost the race to create the row — a concurrent push recorded it, possibly
  // with a real external id. Fall back to the status-only update rather than
  // failing, which is what the old upsert did except that it also wiped the id.
  const { error: updateError } = await supabase
    .from("accounting_sync_records")
    .update({ status: input.status, error_message: errorMessage, last_synced_at: new Date().toISOString() })
    .eq("org_id", input.orgId)
    .eq("connection_id", input.connectionId)
    .eq("entity_type", input.entityType)
    .eq("entity_id", input.entityId)
  return updateError ?? insertError
}

/** A transaction that cannot post right now, and that a human has to come back to. */
export async function markAccountingSyncNeedsReview(orgId: string, entityType: string, entityId: string, connectionId: string, provider: string, message: string) {
  await markAccountingSyncStatus({ orgId, entityType, entityId, connectionId, provider, status: "needs_review", message })
}

export async function markAccountingSyncError(orgId: string, entityType: string, entityId: string, connectionId: string, provider: string, message: string) {
  const error = await markAccountingSyncStatus({ orgId, entityType, entityId, connectionId, provider, status: "error", message })
  if (error) throw new Error(`Unable to record accounting sync failure: ${error.message}`)
}

/**
 * Mark an already-linked transaction for a fresh push after local accounting
 * coding changes. An entity with no ledger row stays unlinked; its first push
 * will create the row through the normal claim path.
 */
export async function markAccountingEntityPending(input: {
  orgId: string
  entityType: "invoice" | "project_expense" | "bill" | "vendor_credit"
  entityId: string
  projectId: string | null
}) {
  const target = await resolveAccountingTarget({ orgId: input.orgId, projectId: input.projectId })
  if (!target) return
  const supabase = createServiceSupabaseClient()
  const { error } = await supabase
    .from("accounting_sync_records")
    .update({ status: "pending", error_message: null })
    .eq("org_id", input.orgId)
    .eq("connection_id", target.connection.id)
    .eq("entity_type", input.entityType)
    .eq("entity_id", input.entityId)
  if (error) throw new Error(`Unable to mark accounting sync pending: ${error.message}`)
}

/** PushResult, plus why nothing was pushed when the skip is an org-wide policy rather than a per-entity condition. */
export type AccountingPushOutcome = PushResult & { skippedReason?: "books_authoritative" }

export async function processAccountingPush(input: { orgId: string; entityType: AccountingPushEntityType; entityId: string }): Promise<AccountingPushOutcome> {
  if (!await isExternalLedgerAuthoritative(input.orgId)) return { externalId: null, skipped: true, skippedReason: "books_authoritative" }
  const billContext = input.entityType === "vendor_bill" ? await resolveVendorBillLedgerContext(input.orgId, input.entityId) : null
  const projectId = billContext ? billContext.projectId : await resolveProjectId(input.orgId, input.entityType, input.entityId)
  const target = await resolveAccountingTarget({ orgId: input.orgId, projectId })
  if (!target) throw new Error("No accounting connection is mapped to this transaction")
  if (!target.healthy) throw new Error(`Accounting connection ${target.connection.label} is ${target.connection.status}`)
  const provider = getProvider(target.connection.provider)
  const connectionId = target.connection.id
  const dispatch = (): Promise<PushResult> => {
    if (input.entityType === "invoice") return provider.pushInvoice({ orgId: input.orgId, connectionId, invoiceId: input.entityId })
    if (input.entityType === "payment") return provider.pushPayment({ orgId: input.orgId, connectionId, paymentId: input.entityId })
    if (input.entityType === "project_expense") return provider.pushExpense({ orgId: input.orgId, connectionId, expenseId: input.entityId })
    if (input.entityType === "vendor_bill") {
      if (billContext?.ledgerType === "vendor_credit") {
        if (!provider.capabilities.supportsVendorCredits || !provider.pushVendorCredit) {
          throw new Error(`${target.connection.label} does not support vendor credits`)
        }
        return provider.pushVendorCredit({ orgId: input.orgId, connectionId, creditId: input.entityId })
      }
      return provider.pushVendorBill({ orgId: input.orgId, connectionId, billId: input.entityId })
    }
    return provider.pushBillPayment({ orgId: input.orgId, connectionId, paymentId: input.entityId })
  }

  // Every attempt leaves a trace row — the sync record only keeps the LAST
  // state, which is why "why did this post twice at 03:14" was unanswerable.
  const traceBase = {
    orgId: input.orgId,
    connectionId,
    provider: target.connection.provider,
    entityType: billContext ? billContext.ledgerType : input.entityType,
    entityId: input.entityId,
    direction: "outbound" as const,
  }
  try {
    const result = await dispatch()
    await recordAccountingSyncAttempt({
      ...traceBase,
      externalId: result.externalId,
      outcome: result.deferred ? "deferred" : result.skipped ? "skipped" : "synced",
    })
    return result
  } catch (error) {
    await recordAccountingSyncAttempt({
      ...traceBase,
      outcome: "error",
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * A push that has run out of retries.
 *
 * The outbox marks the job `failed` and stops — so this is the moment a human
 * inherits the problem, and the moment they get told: the sync row flips to a
 * terminal error AND an `accounting_push_dead_lettered` notification goes to
 * the people who keep the books tied out.
 */
export async function markAccountingPushExhausted(input: {
  orgId: string
  entityType: AccountingPushEntityType
  entityId: string
  message: string
}) {
  const billContext = input.entityType === "vendor_bill" ? await resolveVendorBillLedgerContext(input.orgId, input.entityId) : null
  const projectId = billContext ? billContext.projectId : await resolveProjectId(input.orgId, input.entityType, input.entityId)
  const target = await resolveAccountingTarget({ orgId: input.orgId, projectId })
  if (!target) return
  const ledgerType = billContext ? billContext.ledgerType : input.entityType
  await markAccountingSyncError(
    input.orgId,
    ledgerType,
    input.entityId,
    target.connection.id,
    target.connection.provider,
    `Sync gave up after repeated failures and will not retry on its own: ${input.message}`,
  )
  await recordEvent({
    orgId: input.orgId,
    eventType: "accounting_push_dead_lettered",
    entityType: ledgerType,
    entityId: input.entityId,
    payload: { provider: target.connection.provider, message: input.message },
    channel: "notification",
  }).catch(() => {
    // The sync row already carries the terminal state; a failed notification
    // must not fail the marking itself.
  })
}

/**
 * A push that failed for a reason retrying cannot cure.
 *
 * Distinct from `markAccountingPushExhausted`, which is "we tried three times
 * and gave up": this one is known on the first failure, so the transaction stops
 * burning retries and immediately becomes `needs_review` carrying the sentence
 * that names the fix. A 610 for an inactive QuickBooks object is the archetype —
 * the only cure is a person reactivating it over there.
 */
export async function markAccountingPushPermanentlyFailed(input: {
  orgId: string
  entityType: AccountingPushEntityType
  entityId: string
  message: string
}) {
  const billContext = input.entityType === "vendor_bill" ? await resolveVendorBillLedgerContext(input.orgId, input.entityId) : null
  const projectId = billContext ? billContext.projectId : await resolveProjectId(input.orgId, input.entityType, input.entityId)
  const target = await resolveAccountingTarget({ orgId: input.orgId, projectId })
  if (!target) return
  const ledgerType = billContext ? billContext.ledgerType : input.entityType
  await markAccountingSyncNeedsReview(
    input.orgId,
    ledgerType,
    input.entityId,
    target.connection.id,
    target.connection.provider,
    input.message,
  )
  await recordEvent({
    orgId: input.orgId,
    eventType: "accounting_push_dead_lettered",
    entityType: ledgerType,
    entityId: input.entityId,
    payload: { provider: target.connection.provider, message: input.message, permanent: true },
    channel: "notification",
  }).catch(() => {
    // See markAccountingPushExhausted: notify best-effort, never fail the mark.
  })
}

export interface AccountingSyncPosture {
  /** Transactions waiting to post, or that failed and need a person. */
  pendingCount: number
  errorCount: number
  needsReviewCount: number
  /** Arc and the accounting system disagree (e.g. the provider deleted a posted payment). */
  conflictCount: number
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
    supabase.from("accounting_sync_records").select("status").eq("org_id", orgId).in("status", ["pending", "error", "needs_review", "conflict"]).limit(1000),
    supabase.from("outbox").select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "failed")
      // Includes the legacy qbo_sync_* names: jobs enqueued before the rename
      // can still fail, and counting only the new names hid them.
      .in("job_type", [...ACCOUNTING_JOB_TYPES])
      .then((result) => ({ count: result.count ?? 0 })),
    isExternalLedgerAuthoritative(orgId).then((external) => !external),
    resolveAccountingTarget({ orgId, projectId: null }),
  ])

  const rows = records ?? []
  return {
    pendingCount: rows.filter((row) => row.status === "pending").length,
    errorCount: rows.filter((row) => row.status === "error").length,
    needsReviewCount: rows.filter((row) => row.status === "needs_review").length,
    conflictCount: rows.filter((row) => row.status === "conflict").length,
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
  if (!await isExternalLedgerAuthoritative(input.orgId)) return { voided: false as const, reason: "books_authoritative" as const }
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
