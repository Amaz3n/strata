import { readLocalFingerprint } from "@/lib/integrations/accounting/local-change"
import { AccountingDeliveryError, withAccountingDelivery, persistAccountingDelivery } from "@/lib/services/accounting-delivery"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { resolveAccountingTarget } from "@/lib/services/accounting-target"
import { getProvider } from "@/lib/integrations/accounting/registry"
import type { PushResult } from "@/lib/integrations/accounting/provider"
import { accountingPushBlockReason } from "@/lib/services/accounting-rules"
import { isExternalLedgerAuthoritative } from "@/lib/services/books/authority"
import { recordEvent } from "@/lib/services/events"
import { recordAccountingSyncAttempt } from "@/lib/services/accounting-sync-attempts"
import { logAccounting } from "@/lib/services/accounting-logger"
import { recordAudit } from "@/lib/services/audit"
import {
  ACCOUNTING_PUSH_CONFIG,
  persistAccountingEnqueueDecision,
  type AccountingEnqueueResult,
  type AccountingPushEntityType,
} from "@/lib/services/accounting-enqueue"

export type { AccountingEnqueueResult, AccountingPushEntityType } from "@/lib/services/accounting-enqueue"

import { ACCOUNTING_JOB_TYPES } from "@/lib/services/accounting-job-types"
export { ACCOUNTING_JOB_TYPES, LEGACY_ACCOUNTING_JOB_TYPES } from "@/lib/services/accounting-job-types"

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
  const { data, error } = await supabase.from("vendor_bills").select("project_id, metadata").eq("org_id", orgId).eq("id", billId).maybeSingle()
  if (error || !data) throw new Error("Unable to resolve accounting payable ownership")
  return {
    projectId: data?.project_id ?? null,
    ledgerType: (data?.metadata as { source?: string } | null)?.source === "vendor_credit" ? "vendor_credit" : "bill",
  }
}

async function resolveProjectId(orgId: string, entityType: AccountingPushEntityType, entityId: string): Promise<string | null> {
  const supabase = createServiceSupabaseClient()
  if (entityType === "invoice" || entityType === "project_expense" || entityType === "vendor_bill") {
    const table = entityType === "invoice" ? "invoices" : entityType === "project_expense" ? "project_expenses" : "vendor_bills"
    const { data, error } = await supabase.from(table).select("project_id").eq("org_id", orgId).eq("id", entityId).maybeSingle()
    if (error || !data) throw new Error("Unable to resolve accounting document ownership")
    return data.project_id ?? null
  }
  const { data, error } = await supabase
    .from("payments")
    .select("invoice:invoices(project_id),bill:vendor_bills(project_id)")
    .eq("org_id", orgId)
    .eq("id", entityId)
    .maybeSingle()
  if (error || !data) throw new Error("Unable to resolve accounting payment ownership")
  const invoice = Array.isArray(data?.invoice) ? data.invoice[0] : data?.invoice
  const bill = Array.isArray(data?.bill) ? data.bill[0] : data?.bill
  return entityType === "bill_payment" ? bill?.project_id ?? null : invoice?.project_id ?? null
}

export async function enqueueAccountingPush(input: { orgId: string; entityType: AccountingPushEntityType; entityId: string }): Promise<AccountingEnqueueResult> {
  if (!await pushAllowedForEnqueue(input.orgId)) return { queued: false as const, reason: "books_authoritative" as const }
  const supabase = createServiceSupabaseClient()
  const billContext = input.entityType === "vendor_bill" ? await resolveVendorBillLedgerContext(input.orgId, input.entityId) : null
  const projectId = billContext ? billContext.projectId : await resolveProjectId(input.orgId, input.entityType, input.entityId)
  const target = await resolveAccountingTarget({ orgId: input.orgId, projectId })
  const ledgerType = billContext ? billContext.ledgerType : input.entityType

  if (!target) {
    try {
      return await persistAccountingEnqueueDecision({
        orgId: input.orgId,
        connectionId: null,
        provider: null,
        pushType: input.entityType,
        ledgerType,
        entityId: input.entityId,
        blockedReason: "no_target",
      })
    } catch (error) {
      logAccounting("error", "accounting_enqueue_intent_failed", {
        orgId: input.orgId,
        entityType: ledgerType,
        entityId: input.entityId,
        reason: "no_target",
        error: error instanceof Error ? error.message : String(error),
      })
      return { queued: false, reason: "error" }
    }
  }

  // A freeze strands transactions that were meant to post, and the freeze is
  // lifted long after the person who approved them has moved on. Recording it
  // per entity is what makes the backlog findable afterwards instead of leaving
  // the row indistinguishable from one that simply has not run yet.
  if (typeof target.connection.settings.cutover_freeze_run_id === "string") {
    return persistAccountingEnqueueDecision({
      orgId: input.orgId,
      connectionId: target.connection.id,
      provider: target.connection.provider,
      pushType: input.entityType,
      ledgerType,
      entityId: input.entityId,
      blockedReason: "cutover_freeze",
    })
  }
  const { data: existingRows, error: existingError } = await supabase
    .from("accounting_sync_records")
    .select("pushable,connection_id,provider")
    .eq("org_id", input.orgId)
    .eq("entity_type", ledgerType)
    .eq("entity_id", input.entityId)
  if (existingError) throw new Error(`Unable to inspect accounting identity: ${existingError.message}`)
  const existing = existingRows?.find((row) => row.connection_id === target.connection.id)
    ?? existingRows?.find((row) => row.connection_id !== target.connection.id)
  const config = ACCOUNTING_PUSH_CONFIG[input.entityType]
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
  try {
    if (blockReason) {
      const ownsExistingRecord = blockReason === "connection_mismatch" && existing?.connection_id
      return await persistAccountingEnqueueDecision({
        orgId: input.orgId,
        connectionId: ownsExistingRecord ? existing.connection_id : target.connection.id,
        provider: ownsExistingRecord ? existing.provider : target.connection.provider,
        pushType: input.entityType,
        ledgerType,
        entityId: input.entityId,
        blockedReason: blockReason,
      })
    }
    return await persistAccountingEnqueueDecision({
      orgId: input.orgId,
      connectionId: target.connection.id,
      provider: target.connection.provider,
      pushType: input.entityType,
      ledgerType,
      entityId: input.entityId,
    })
  } catch (error) {
    logAccounting("error", "accounting_enqueue_intent_failed", {
      orgId: input.orgId,
      connectionId: target.connection.id,
      entityType: ledgerType,
      entityId: input.entityId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { queued: false, reason: "error" }
  }
}

/**
 * Attach a blocked AP enqueue to the payable's durable activity trail. The sync
 * ledger remains the state source; this audit row answers when and why a normal
 * bill/payment mutation could not hand work to the worker.
 */
export async function recordPayableAccountingEnqueueResult(input: {
  orgId: string
  billId: string
  entityType: "vendor_bill" | "bill_payment"
  entityId: string
  result: AccountingEnqueueResult
}) {
  if (input.result.queued || input.result.reason === "books_authoritative") return
  await recordAudit({
    orgId: input.orgId,
    action: "update",
    entityType: "vendor_bill",
    entityId: input.billId,
    source: "accounting_sync_enqueue",
    after: {
      accounting_entity_type: input.entityType,
      accounting_entity_id: input.entityId,
      accounting_sync_status: "needs_review",
      accounting_sync_reason: input.result.reason,
    },
  })
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
  reason?: string | null
  attemptId?: string | null
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
      .update({
        status: input.status,
        ...(input.reason !== undefined ? { status_reason: input.reason } : {}),
        error_message: errorMessage,
        ...(input.attemptId !== undefined ? { last_attempt_id: input.attemptId } : {}),
      })
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
    status_reason: input.reason ?? null,
    error_message: errorMessage,
    last_attempt_id: input.attemptId ?? null,
    last_synced_at: null,
  })
  if (!insertError) return null

  // Lost the race to create the row — a concurrent push recorded it, possibly
  // with a real external id. Fall back to the status-only update rather than
  // failing, which is what the old upsert did except that it also wiped the id.
  const { error: updateError } = await supabase
    .from("accounting_sync_records")
    .update({
      status: input.status,
      ...(input.reason !== undefined ? { status_reason: input.reason } : {}),
      error_message: errorMessage,
      ...(input.attemptId !== undefined ? { last_attempt_id: input.attemptId } : {}),
    })
    .eq("org_id", input.orgId)
    .eq("connection_id", input.connectionId)
    .eq("entity_type", input.entityType)
    .eq("entity_id", input.entityId)
  return updateError ?? insertError
}

/** A transaction that cannot post right now, and that a human has to come back to. */
export async function markAccountingSyncNeedsReview(
  orgId: string,
  entityType: string,
  entityId: string,
  connectionId: string,
  provider: string,
  message: string,
  reason: string | null = null,
) {
  const error = await markAccountingSyncStatus({ orgId, entityType, entityId, connectionId, provider, status: "needs_review", message, reason })
  if (error) throw new Error(`Unable to record accounting review state: ${error.message}`)
}

export async function markAccountingSyncError(
  orgId: string,
  entityType: string,
  entityId: string,
  connectionId: string,
  provider: string,
  message: string,
  attemptId?: string | null,
) {
  const error = await markAccountingSyncStatus({
    orgId,
    entityType,
    entityId,
    connectionId,
    provider,
    status: "error",
    message,
    reason: "provider_error",
    attemptId,
  })
  if (error) throw new Error(`Unable to record accounting sync failure: ${error.message}`)
}

async function markAccountingSyncDelivered(input: {
  orgId: string
  connectionId: string
  provider: string
  entityType: string
  entityId: string
  externalId: string | null
  externalVersion?: string | null
  attemptId: string | null
  deferred?: boolean
}) {
  if (input.deferred) return
  await persistAccountingDelivery({ ...input, status: input.provider === "file" ? "accrued" : "synced", reason: input.provider === "file" ? "file_accrued_unconfirmed" : null })
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

export async function processAccountingPush(input: { orgId: string; entityType: AccountingPushEntityType; entityId: string; connectionId?: string; deadline?: number }): Promise<AccountingPushOutcome> {
  if (!await isExternalLedgerAuthoritative(input.orgId)) return { externalId: null, skipped: true, skippedReason: "books_authoritative" }
  const billContext = input.entityType === "vendor_bill" ? await resolveVendorBillLedgerContext(input.orgId, input.entityId) : null
  const projectId = billContext ? billContext.projectId : await resolveProjectId(input.orgId, input.entityType, input.entityId)
  const target = await resolveAccountingTarget({ orgId: input.orgId, projectId })
  if (!target) throw new Error("No accounting connection is mapped to this transaction")
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
  const delivery = await withAccountingDelivery(traceBase, input.deadline ?? Date.now() + 85_000, async () => {
    try {
      if (Date.now() >= (input.deadline ?? Infinity)) throw new AccountingDeliveryError("Accounting delivery deadline reached", true, "deadline")
      const { data: linked, error } = await createServiceSupabaseClient().from("accounting_sync_records")
        .select("connection_id,pushable,external_id").eq("org_id", input.orgId).eq("entity_type", traceBase.entityType).eq("entity_id", input.entityId)
      if (error) throw new Error(`Unable to validate accounting identity: ${error.message}`)
      const mismatch = (input.connectionId && input.connectionId !== connectionId) || linked?.some(row => row.connection_id !== connectionId && row.external_id)
      const record = linked?.find(row => row.connection_id === connectionId)
      const config = ACCOUNTING_PUSH_CONFIG[input.entityType]
      const reason = mismatch ? "connection_mismatch"
        : typeof target.connection.settings.cutover_freeze_run_id === "string" ? "cutover_freeze"
        : accountingPushBlockReason({ hasTarget: true, healthy: target.healthy, pushable: record?.pushable, existingConnectionId: record?.connection_id, targetConnectionId: connectionId, enabled: config.paymentSetting ? target.connection.settings.sync_payments !== false : target.connection.settings.auto_sync !== false })
      if (reason) throw new AccountingDeliveryError(`Accounting delivery blocked: ${reason}`, false, reason)
      const snapshotInput = { supabase: createServiceSupabaseClient(), orgId: input.orgId, entityType: traceBase.entityType, entityId: input.entityId }
      const fingerprint = await readLocalFingerprint(snapshotInput)
      const result = await dispatch()
      if (!result.deferred && !result.skipped && fingerprint && await readLocalFingerprint(snapshotInput) !== fingerprint) {
        const attemptId = await recordAccountingSyncAttempt({ ...traceBase, externalId: result.externalId, outcome: "deferred", message: "The source changed during delivery; the newer revision remains queued" })
        await persistAccountingDelivery({ ...traceBase, externalId: result.externalId, externalVersion: result.externalVersion, status: "pending", reason: "source_changed_during_delivery", attemptId })
        return { ...result, deferred: true }
      }
      if (!result.deferred && fingerprint) await persistAccountingDelivery({ ...traceBase, fingerprint })
      const attemptId = await recordAccountingSyncAttempt({ ...traceBase, externalId: result.externalId, outcome: result.deferred ? "deferred" : result.skipped ? "skipped" : "synced" })
      if (!result.deferred) {
        // Legitimate no-ops do not manufacture an external posting.
        if (result.skipped && !result.externalId) await persistAccountingDelivery({ ...traceBase, status: "skipped", reason: "provider_noop", attemptId })
        else await markAccountingSyncDelivered({ ...traceBase, externalId: result.externalId, externalVersion: result.externalVersion, attemptId })
      }
      return result
    } catch (error) {
      const classified = provider.classifyError?.(error)
      const failure = error instanceof AccountingDeliveryError ? error : new AccountingDeliveryError(classified?.message ?? (error instanceof Error ? error.message : String(error)), classified?.retryable ?? true, classified?.reason ?? "provider_error")
      const attemptId = await recordAccountingSyncAttempt({ ...traceBase, outcome: "error", message: failure.message })
      await persistAccountingDelivery({ ...traceBase, status: failure.retryable ? "error" : "needs_review", message: failure.message, reason: failure.reason, attemptId })
      throw failure
    }
  })
  return delivery.deferred ? { externalId: null, skipped: true, deferred: true } : delivery.result
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
    "permanent_provider_error",
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
  const statuses = ["pending", "error", "needs_review", "conflict"] as const
  const [counts, jobs, booksAuthoritative, target] = await Promise.all([
    Promise.all(statuses.map(status => supabase.from("accounting_sync_records").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("status", status))),
    supabase.from("outbox").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("status", "failed").in("job_type", [...ACCOUNTING_JOB_TYPES]),
    isExternalLedgerAuthoritative(orgId).then(external => !external),
    resolveAccountingTarget({ orgId, projectId: null }),
  ])
  if (counts.some(result => result.error) || jobs.error) throw new Error("Unable to inspect accounting backlog")
  const [pendingCount, errorCount, needsReviewCount, conflictCount] = counts.map(result => result.count ?? 0)
  const failedJobCount = jobs.count ?? 0
  return {
    pendingCount,
    errorCount,
    needsReviewCount,
    conflictCount,
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
export const enqueueBillPaymentVoid = async (input: { paymentId: string; orgId: string; reason: string }) => {
  const projectId = await resolveProjectId(input.orgId, "bill_payment", input.paymentId)
  const target = await resolveAccountingTarget({ orgId: input.orgId, projectId })
  if (!target) throw new Error("No accounting connection is mapped to this reversal")
  return enqueueOutboxJob({ orgId: input.orgId, jobType: "accounting_void_bill_payment", payload: { payment_id: input.paymentId, reason: input.reason, connection_id: target.connection.id, provider: target.connection.provider }, dedupeByPayloadKeys: ["payment_id"] })
}

/**
 * Reverse a bill payment in the accounting system after an ACH return.
 *
 * Called by the durable accounting outbox after Arc has committed the return.
 */
export async function voidBillPaymentInAccounting(input: { orgId: string; paymentId: string; reason: string; connectionId?: string; deadline?: number }) {
  if (!await isExternalLedgerAuthoritative(input.orgId)) return { voided: false as const, reason: "books_authoritative" as const }
  const projectId = await resolveProjectId(input.orgId, "bill_payment", input.paymentId)
  const target = await resolveAccountingTarget({ orgId: input.orgId, projectId })
  if (!target) return { voided: false as const, reason: "unconnected" as const }
  const provider = getProvider(target.connection.provider)
  const identity = { orgId: input.orgId, connectionId: target.connection.id, entityType: "bill_payment", entityId: input.paymentId }
  const delivery = await withAccountingDelivery(identity, input.deadline ?? Date.now() + 85_000, async () => {
    try {
      const { data: records, error } = await createServiceSupabaseClient().from("accounting_sync_records").select("connection_id,external_id").eq("org_id", input.orgId).eq("entity_type", "bill_payment").eq("entity_id", input.paymentId)
      if (error) throw new Error(`Unable to inspect reversal identity: ${error.message}`)
      if ((input.connectionId && input.connectionId !== target.connection.id) || records?.some(row => row.external_id && row.connection_id !== target.connection.id)) throw new AccountingDeliveryError("The payment belongs to another accounting connection", false, "connection_mismatch")
      if (!target.healthy || typeof target.connection.settings.cutover_freeze_run_id === "string") throw new AccountingDeliveryError("Accounting reversal is held by connection health or cutover freeze", false, "reversal_blocked")
      const linked = records?.find(row => row.connection_id === target.connection.id && row.external_id)
      if (!linked) {
        await recordAccountingSyncAttempt({ ...identity, provider: target.connection.provider, direction: "outbound", outcome: "skipped", message: "Payment never posted to this connection" })
        return { voided: false as const, reason: "never_posted" as const }
      }
      if (!provider.capabilities.supportsBillPaymentVoid || !provider.voidBillPayment) throw new AccountingDeliveryError(`${target.connection.label} cannot reverse this payment; a reviewed manual reversal is required`, false, "unsupported")
      const result = await provider.voidBillPayment({ orgId: input.orgId, connectionId: target.connection.id, paymentId: input.paymentId, reason: input.reason })
      if (result.deferred) return { voided: false as const, reason: "deferred" as const }
      const attemptId = await recordAccountingSyncAttempt({ ...identity, provider: target.connection.provider, direction: "outbound", externalId: result.externalId, outcome: result.skipped ? "skipped" : "synced" })
      await persistAccountingDelivery({ ...identity, provider: target.connection.provider, externalId: result.externalId, externalVersion: result.externalVersion, status: "synced", reason: "reversed", attemptId })
      return { voided: true as const }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const attemptId = await recordAccountingSyncAttempt({ ...identity, provider: target.connection.provider, direction: "outbound", outcome: "error", message })
      await persistAccountingDelivery({ ...identity, provider: target.connection.provider, status: "needs_review", message, reason: "reversal_failed", attemptId })
      throw error
    }
  })
  return delivery.deferred ? { voided: false as const, reason: "deferred" as const } : delivery.result
}
