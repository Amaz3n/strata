import { createHash } from "crypto"

import type { QBOClient, QBOPaymentSnapshot } from "@/lib/integrations/accounting/qbo/client"
import { QBOClient as QBOClientFactory } from "@/lib/integrations/accounting/qbo/client"
import { extractIntuitEntityEvents, normalizeEventTimestamp, verifyIntuitWebhookSignature } from "@/lib/integrations/accounting/qbo/webhook"
import { qboPurchaseIsCredit } from "@/lib/integrations/accounting/qbo/import-rules"
import {
  arcChangedSinceSync,
  computeLocalFingerprint,
  stampLocalFingerprint,
  storedLocalFingerprint,
} from "@/lib/integrations/accounting/local-change"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { isPayableVendorBillStatus } from "@/lib/financials/ledger-status"
import { logQBO } from "@/lib/services/accounting-logger"
import { resolveLedgerAuthority, type LedgerAuthority } from "@/lib/services/books/authority"
import { recordEvent } from "@/lib/services/events"
import { recalcInvoiceBalanceAndStatus } from "@/lib/services/invoice-balance"
import { recordAccountingSyncAttempt } from "@/lib/services/accounting-sync-attempts"
import { rememberAccountingInvoiceNumberCursor } from "@/lib/services/invoice-numbers"

const CDC_ENTITIES = ["Invoice", "Payment", "Purchase", "Bill", "BillPayment", "VendorCredit", "JournalEntry"]
const CDC_OVERLAP_MINUTES = 5
/** Intuit rejects `changedSince` older than 30 days; stay safely inside it. */
const CDC_MAX_LOOKBACK_DAYS = 29
const EVENT_CLAIM_LEASE_MINUTES = 30
const MAX_EVENT_ATTEMPTS = 5

type ServiceClient = ReturnType<typeof createServiceSupabaseClient>

type WebhookEventRow = {
  id: string
  event_id: string
  realm_id: string | null
  entity_name: string | null
  entity_qbo_id: string | null
  operation: string | null
  attempts: number | null
}

function toCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100)
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.round(parsed * 100)
  }
  return null
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().split("T")[0]
}

function deriveInvoiceLinesFromQbo(qboInvoice: Awaited<ReturnType<QBOClient["getInvoiceById"]>>) {
  const lines = (qboInvoice?.Line ?? [])
    .filter((line) => line && typeof line === "object" && line.DetailType === "SalesItemLineDetail")
    .map((line) => {
      const qty = Number(line.SalesItemLineDetail?.Qty ?? 1)
      const normalizedQty = Number.isFinite(qty) && qty !== 0 ? qty : 1
      const rawLineAmount = Number(line.Amount ?? 0)
      const rawUnitPrice =
        line.SalesItemLineDetail?.UnitPrice != null
          ? Number(line.SalesItemLineDetail.UnitPrice)
          : rawLineAmount / normalizedQty
      const unitPrice = Number.isFinite(rawUnitPrice) ? rawUnitPrice : 0
      const normalizedUnitPrice = Number.isFinite(unitPrice) ? unitPrice : 0
      const taxCode = String(line.SalesItemLineDetail?.TaxCodeRef?.value ?? "").toUpperCase()

      return {
        description: String(line.Description ?? ""),
        quantity: normalizedQty,
        unit: "ea",
        unit_price_cents: Math.round(normalizedUnitPrice * 100),
        metadata: {
          taxable: taxCode !== "NON",
          qbo_item_id: line.SalesItemLineDetail?.ItemRef?.value ?? null,
          qbo_item_name: line.SalesItemLineDetail?.ItemRef?.name ?? null,
        },
      }
    })

  return lines.filter((line) => line.description.length > 0 || line.unit_price_cents !== 0)
}

async function resolveLocalSyncMapping(
  supabase: ServiceClient,
  orgId: string,
  connectionId: string,
  entityType: string,
  externalId: string,
): Promise<{ entityId: string; externalVersion: string | null; localFingerprint: string | null } | null> {
  const { data: rows } = await supabase
    .from("accounting_sync_records")
    .select("entity_id, external_version, status, last_synced_at, metadata")
    .eq("org_id", orgId)
    .eq("connection_id", connectionId)
    .eq("entity_type", entityType)
    .eq("external_id", externalId)
    .order("last_synced_at", { ascending: false })
    .limit(10)

  const match = (rows ?? []).find((row) => row.status === "synced") ?? rows?.[0]
  if (!match?.entity_id) return null
  return {
    entityId: match.entity_id as string,
    externalVersion: (match.external_version as string | null) ?? null,
    localFingerprint: storedLocalFingerprint(match.metadata),
  }
}

/**
 * A needs_review outcome is work only a person can finish, so it must reach a
 * person: the sync row's status alone was invisible unless somebody happened to
 * open the sync sheet. Best-effort — a failed notification never fails the
 * reconcile that produced it.
 */
async function emitNeedsReviewEvent(orgId: string, entityType: string, entityId: string, reason: string) {
  await recordEvent({
    orgId,
    eventType: "accounting_sync_needs_review",
    entityType,
    entityId,
    payload: { provider: "qbo", message: reason },
    channel: "notification",
  }).catch((eventError) => {
    logQBO("warn", "needs_review_event_failed", { entityType, entityId, error: String(eventError) })
  })
}

/**
 * True when the remote entity has not changed since the version we last synced.
 * Reconciling anyway would overwrite newer local edits with a stale remote copy,
 * so callers skip the write entirely.
 */
function remoteUnchangedSinceLastSync(remoteSyncToken: unknown, storedVersion: string | null) {
  if (storedVersion == null || storedVersion === "") return false
  if (typeof remoteSyncToken !== "string" || remoteSyncToken.length === 0) return false
  return remoteSyncToken === storedVersion
}

async function upsertInvoiceSyncRecord(params: {
  supabase: ServiceClient
  orgId: string
  connectionId: string
  invoiceId: string
  qboInvoiceId: string
  qboSyncToken?: string | null
}) {
  const nowIso = new Date().toISOString()

  await params.supabase.from("accounting_sync_records").upsert(
    {
      org_id: params.orgId,
      connection_id: params.connectionId,
      entity_type: "invoice",
      entity_id: params.invoiceId,
      provider: "qbo",
      external_id: params.qboInvoiceId,
      external_version: params.qboSyncToken ?? null,
      last_synced_at: nowIso,
      status: "synced",
      error_message: null,
    },
    { onConflict: "org_id,connection_id,entity_type,entity_id" },
  )

  // Runs after the invoice row itself has been written, so the recorded
  // fingerprint describes the reconciled state. Anything that differs from it
  // later was moved by a person.
  await stampLocalFingerprint({
    supabase: params.supabase,
    orgId: params.orgId,
    connectionId: params.connectionId,
    entityType: "invoice",
    entityId: params.invoiceId,
  })
}

export async function reconcileInvoiceFromQbo(params: {
  supabase: ServiceClient
  client: QBOClient
  orgId: string
  connectionId: string
  qboInvoiceId: string
  operation?: string | null
  /** "Take QuickBooks": apply the remote copy even though Arc also changed. */
  force?: boolean
}) {
  const nowIso = new Date().toISOString()
  const mapping = await resolveLocalSyncMapping(params.supabase, params.orgId, params.connectionId, "invoice", params.qboInvoiceId)
  if (!mapping) {
    return { reconciled: false as const, reason: "No local invoice mapping" }
  }
  const invoiceId = mapping.entityId

  const normalizedOp = String(params.operation ?? "").toLowerCase()
  if (normalizedOp === "delete") {
    // Void through the same atomic path the app uses so draws, fee billings,
    // billed costs, retainage, and billing periods release with the invoice —
    // a bare status UPDATE left them all stranded as "invoiced".
    const { error: voidError } = await params.supabase.rpc("void_invoice_atomic", {
      p_org_id: params.orgId,
      p_invoice_id: invoiceId,
      p_actor_id: null,
    })

    if (voidError) {
      // Payments recorded or a posted pay app — this cannot be voided cleanly,
      // so flag it for a human instead of silently mismarking it.
      const reason = `QuickBooks deleted this invoice but Arc could not void it: ${voidError.message}`
      await params.supabase
        .from("invoices")
        .update({ qbo_sync_status: "needs_review" })
        .eq("org_id", params.orgId)
        .eq("id", invoiceId)
      await params.supabase.from("accounting_sync_records").upsert(
        {
          org_id: params.orgId,
          connection_id: params.connectionId,
          entity_type: "invoice",
          entity_id: invoiceId,
          provider: "qbo",
          external_id: params.qboInvoiceId,
          last_synced_at: nowIso,
          status: "needs_review",
          error_message: reason,
        },
        { onConflict: "org_id,connection_id,entity_type,entity_id" },
      )
      return { reconciled: false as const, reason }
    }

    await upsertInvoiceSyncRecord({
      supabase: params.supabase,
      orgId: params.orgId,
      connectionId: params.connectionId,
      invoiceId,
      qboInvoiceId: params.qboInvoiceId,
      // Preserve the last known version rather than nulling it: a null stored
      // version reads as "never compared", which re-ran the full reconcile on
      // every subsequent event for this invoice.
      qboSyncToken: mapping.externalVersion,
    })
    return { reconciled: true as const }
  }

  const qboInvoice = await params.client.getInvoiceById(params.qboInvoiceId)
  if (!qboInvoice) {
    return { reconciled: false as const, reason: "QBO invoice not found" }
  }

  if (remoteUnchangedSinceLastSync(qboInvoice.SyncToken, mapping.externalVersion)) {
    return { reconciled: true as const, unchanged: true as const }
  }

  const totalCents = toCents(qboInvoice.TotalAmt)
  const balanceCents = toCents(qboInvoice.Balance)
  const taxCents = toCents(qboInvoice.TxnTaxDetail?.TotalTax ?? 0) ?? 0
  const dueDate = normalizeDate(qboInvoice.DueDate)
  const issueDate = normalizeDate(qboInvoice.TxnDate)
  const nextLines = deriveInvoiceLinesFromQbo(qboInvoice)
  const subtotalCents =
    totalCents !== null
      ? Math.max(totalCents - taxCents, 0)
      : nextLines.reduce((sum, line) => sum + Math.round(line.quantity * line.unit_price_cents), 0)

  const { data: localInvoice } = await params.supabase
    .from("invoices")
    .select("subtotal_cents, tax_cents, total_cents, balance_due_cents")
    .eq("org_id", params.orgId)
    .eq("id", invoiceId)
    .maybeSingle()
  // A QuickBooks VOID arrives as an Update with the amounts zeroed, not as a
  // Delete. Left on the normal path it became a live "$0 / sent" invoice that
  // AR aging kept counting; route it through the same atomic void as a delete.
  const looksVoided =
    totalCents === 0 &&
    balanceCents === 0 &&
    Number(localInvoice?.total_cents ?? 0) > 0 &&
    (typeof qboInvoice.PrivateNote !== "string" || /void/i.test(qboInvoice.PrivateNote) || nextLines.every((line) => line.unit_price_cents === 0))
  if (looksVoided) {
    const { error: voidError } = await params.supabase.rpc("void_invoice_atomic", {
      p_org_id: params.orgId,
      p_invoice_id: invoiceId,
      p_actor_id: null,
    })
    if (!voidError) {
      await upsertInvoiceSyncRecord({
        supabase: params.supabase,
        orgId: params.orgId,
        connectionId: params.connectionId,
        invoiceId,
        qboInvoiceId: params.qboInvoiceId,
        qboSyncToken: qboInvoice.SyncToken ?? null,
      })
      return { reconciled: true as const }
    }
    // Fall through: an invoice that cannot void cleanly (payments recorded)
    // continues into the conflict check below and lands in needs_review.
  }

  const arcChangedAfterSync = arcChangedSinceSync({
    storedFingerprint: mapping.localFingerprint,
    currentFingerprint: computeLocalFingerprint("invoice", localInvoice),
  })
  const amountsDiffer =
    (totalCents !== null && Number(localInvoice?.total_cents ?? 0) !== totalCents) ||
    (balanceCents !== null && Number(localInvoice?.balance_due_cents ?? 0) !== Math.max(balanceCents, 0)) ||
    Number(localInvoice?.subtotal_cents ?? 0) !== subtotalCents ||
    Number(localInvoice?.tax_cents ?? 0) !== taxCents

  if (!params.force && arcChangedAfterSync && amountsDiffer) {
    const reason = "Both Arc and QuickBooks changed this invoice since the last sync."
    await emitNeedsReviewEvent(params.orgId, "invoice", invoiceId, reason)
    await params.supabase
      .from("invoices")
      .update({ qbo_sync_status: "needs_review" })
      .eq("org_id", params.orgId)
      .eq("id", invoiceId)
    await params.supabase.from("accounting_sync_records").upsert(
      {
        org_id: params.orgId,
        connection_id: params.connectionId,
        entity_type: "invoice",
        entity_id: invoiceId,
        provider: "qbo",
        external_id: params.qboInvoiceId,
        external_version: qboInvoice.SyncToken ?? null,
        last_synced_at: nowIso,
        status: "needs_review",
        error_message: reason,
      },
      { onConflict: "org_id,connection_id,entity_type,entity_id" },
    )
    return { reconciled: false as const, reason }
  }

  // Document fields only — status and balance belong to the unified status
  // engine (invoice_paid_cents/derive_invoice_status). Writing QBO's Balance
  // here just got silently reverted by the next recalc, so instead the QBO
  // payment import creates the payment rows and the recalc below converges.
  const invoiceUpdate: Record<string, unknown> = {
    qbo_id: params.qboInvoiceId,
    qbo_sync_status: "synced",
    qbo_synced_at: nowIso,
    subtotal_cents: subtotalCents,
    tax_cents: taxCents,
  }

  if (typeof qboInvoice.DocNumber === "string" && qboInvoice.DocNumber.trim().length > 0) {
    invoiceUpdate.invoice_number = qboInvoice.DocNumber.trim()
  }
  if (issueDate) invoiceUpdate.issue_date = issueDate
  if (dueDate) invoiceUpdate.due_date = dueDate
  if (typeof qboInvoice.PrivateNote === "string") invoiceUpdate.notes = qboInvoice.PrivateNote
  if (totalCents !== null) invoiceUpdate.total_cents = totalCents

  const { error: reconcileError } = await params.supabase.rpc("replace_invoice_lines_atomic", {
    p_org_id: params.orgId,
    p_invoice_id: invoiceId,
    p_invoice_update: invoiceUpdate,
    p_lines: nextLines,
  })

  if (reconcileError) {
    return { reconciled: false as const, reason: reconcileError.message }
  }

  await recalcInvoiceBalanceAndStatus({
    supabase: params.supabase,
    orgId: params.orgId,
    invoiceId,
  })

  if (typeof qboInvoice.DocNumber === "string" && qboInvoice.DocNumber.trim().length > 0) {
    await rememberAccountingInvoiceNumberCursor(params.connectionId, params.orgId, qboInvoice.DocNumber.trim())
  }

  await upsertInvoiceSyncRecord({
    supabase: params.supabase,
    orgId: params.orgId,
    connectionId: params.connectionId,
    invoiceId,
    qboInvoiceId: params.qboInvoiceId,
    qboSyncToken: qboInvoice.SyncToken ?? null,
  })

  return { reconciled: true as const }
}

async function reconcileProjectExpenseFromQbo(params: {
  supabase: ServiceClient
  client: QBOClient
  orgId: string
  connectionId: string
  qboId: string
  entityName: "purchase" | "bill"
  operation?: string | null
  /** "Take QuickBooks": apply the remote copy even though Arc also changed. */
  force?: boolean
}) {
  const mapping = await resolveLocalSyncMapping(params.supabase, params.orgId, params.connectionId, "project_expense", params.qboId)
  if (!mapping) {
    return { reconciled: false as const, reason: "No local expense mapping" }
  }
  const expenseId = mapping.entityId
  const { data: localExpense } = await params.supabase
    .from("project_expenses")
    .select("amount_cents, tax_cents, status, metadata, expense_date, accounting_coding, qbo_vendor_id, qbo_expense_account_id")
    .eq("org_id", params.orgId)
    .eq("id", expenseId)
    .maybeSingle()

  const nowIso = new Date().toISOString()
  const normalizedOp = String(params.operation ?? "").toLowerCase()
  if (normalizedOp === "delete") {
    await params.supabase
      .from("project_expenses")
      .update({
        qbo_sync_status: "needs_review",
        qbo_sync_error:
          "The linked QuickBooks transaction was deleted. Its cost is still posted to job-cost actuals in Arc — delete or reassign the expense to release it.",
        qbo_synced_at: nowIso,
      })
      .eq("org_id", params.orgId)
      .eq("id", expenseId)
    return { reconciled: true as const }
  }

  const qboTxn =
    params.entityName === "bill"
      ? await params.client.getBillById(params.qboId)
      : await params.client.getPurchaseById(params.qboId)

  if (!qboTxn) {
    return { reconciled: false as const, reason: "QBO transaction not found" }
  }

  if (remoteUnchangedSinceLastSync(qboTxn.SyncToken, mapping.externalVersion)) {
    return { reconciled: true as const, unchanged: true as const }
  }

  const firstAccountLine = (qboTxn.Line ?? []).find((line: any) => line?.AccountBasedExpenseLineDetail?.AccountRef)
  const accountRef = firstAccountLine?.AccountBasedExpenseLineDetail?.AccountRef
  const vendorRef = qboTxn.VendorRef ?? qboTxn.EntityRef
  const rawTotalCents = toCents(qboTxn.TotalAmt)
  const isExpenseCredit = params.entityName === "purchase" && qboPurchaseIsCredit(qboTxn)
  const totalCents = rawTotalCents == null ? null : isExpenseCredit ? Math.abs(rawTotalCents) : rawTotalCents
  const txnDate = normalizeDate(qboTxn.TxnDate)

  const localTotalCents = Number((localExpense as any)?.amount_cents ?? 0) + Number((localExpense as any)?.tax_cents ?? 0)
  const localStatus = String((localExpense as any)?.status ?? "")

  // Both-sides check, same standard as invoices: when Arc edited this expense
  // after the last sync AND QBO's payload differs materially, neither side may
  // silently win. When Arc has not changed, QBO still wins below.
  const localData = localExpense as any
  const arcChangedAfterSync = arcChangedSinceSync({
    storedFingerprint: mapping.localFingerprint,
    currentFingerprint: computeLocalFingerprint("project_expense", localExpense),
  })
  const qboVendorId = vendorRef?.value != null ? String(vendorRef.value) : null
  const materiallyDiffers =
    (totalCents !== null && localTotalCents > 0 && totalCents !== localTotalCents) ||
    (qboVendorId !== null && localData?.qbo_vendor_id != null && qboVendorId !== String(localData.qbo_vendor_id)) ||
    (txnDate !== null && localData?.expense_date != null && txnDate !== String(localData.expense_date)) ||
    (accountRef?.value != null && localData?.qbo_expense_account_id != null && String(accountRef.value) !== String(localData.qbo_expense_account_id))
  if (!params.force && arcChangedAfterSync && materiallyDiffers) {
    const reason = `Both Arc and QuickBooks changed this ${params.entityName === "bill" ? "bill" : "expense"} since the last sync.`
    await emitNeedsReviewEvent(params.orgId, "project_expense", expenseId, reason)
    await params.supabase
      .from("project_expenses")
      .update({ qbo_sync_status: "needs_review", qbo_sync_error: reason })
      .eq("org_id", params.orgId)
      .eq("id", expenseId)
    await params.supabase.from("accounting_sync_records").upsert(
      {
        org_id: params.orgId,
        connection_id: params.connectionId,
        entity_type: "project_expense",
        entity_id: expenseId,
        provider: "qbo",
        external_id: params.qboId,
        external_version: qboTxn.SyncToken ?? null,
        last_synced_at: nowIso,
        status: "needs_review",
        error_message: reason,
      },
      { onConflict: "org_id,connection_id,entity_type,entity_id" },
    )
    return { reconciled: false as const, reason }
  }

  if (totalCents !== null && localTotalCents > 0 && totalCents !== localTotalCents && ["approved", "invoiced", "locked"].includes(localStatus)) {
    await params.supabase
      .from("project_expenses")
      .update({
        qbo_sync_status: "needs_review",
        qbo_sync_error: `QuickBooks changed this ${params.entityName} amount from ${(localTotalCents / 100).toFixed(2)} to ${(totalCents / 100).toFixed(2)}.`,
        qbo_synced_at: nowIso,
      })
      .eq("org_id", params.orgId)
      .eq("id", expenseId)
    return { reconciled: true as const }
  }

  const update: Record<string, unknown> = {
    qbo_id: params.qboId,
    qbo_transaction_type: params.entityName === "bill" ? "bill" : "purchase",
    qbo_sync_status: "synced",
    qbo_sync_error: null,
    qbo_synced_at: nowIso,
    qbo_vendor_id: vendorRef?.value ?? null,
    qbo_vendor_name: vendorRef?.name ?? null,
  }

  if (totalCents !== null) {
    update.amount_cents = Math.max(totalCents, 0)
    update.tax_cents = 0
  }
  if (isExpenseCredit) {
    update.metadata = {
      ...(((localExpense as any)?.metadata as Record<string, unknown> | null) ?? {}),
      source: "expense_credit",
      imported_from_qbo: true,
      qbo_purchase_credit: true,
      qbo_credit_total_cents: totalCents == null ? null : -Math.abs(totalCents),
    }
  }
  if (txnDate) update.expense_date = txnDate
  if (typeof qboTxn.PrivateNote === "string") update.description = qboTxn.PrivateNote
  if (accountRef?.value) {
    update.qbo_expense_account_id = String(accountRef.value)
    update.qbo_expense_account_name = accountRef.name ? String(accountRef.name) : null
  }

  const { error } = await params.supabase
    .from("project_expenses")
    .update(update)
    .eq("org_id", params.orgId)
    .eq("id", expenseId)

  if (error) {
    return { reconciled: false as const, reason: error.message }
  }

  await params.supabase.from("accounting_sync_records").upsert(
    {
      org_id: params.orgId,
      connection_id: params.connectionId,
      entity_type: "project_expense",
      entity_id: expenseId,
      provider: "qbo",
      external_id: params.qboId,
      external_version: qboTxn.SyncToken ?? null,
      last_synced_at: nowIso,
      status: "synced",
      error_message: null,
    },
    { onConflict: "org_id,connection_id,entity_type,entity_id" },
  )

  await stampLocalFingerprint({
    supabase: params.supabase,
    orgId: params.orgId,
    connectionId: params.connectionId,
    entityType: "project_expense",
    entityId: expenseId,
  })

  return { reconciled: true as const }
}

async function reconcileVendorBillFromQbo(params: {
  supabase: ServiceClient
  client: QBOClient
  orgId: string
  connectionId: string
  qboId: string
  operation?: string | null
  /** "Take QuickBooks": apply the remote copy even though Arc also changed. */
  force?: boolean
}) {
  const mapping = await resolveLocalSyncMapping(params.supabase, params.orgId, params.connectionId, "bill", params.qboId)
  if (!mapping) {
    return { reconciled: false as const, reason: "No local vendor bill mapping" }
  }
  const billId = mapping.entityId

  const nowIso = new Date().toISOString()
  const normalizedOp = String(params.operation ?? "").toLowerCase()
  if (normalizedOp === "delete") {
    await params.supabase
      .from("vendor_bills")
      .update({
        qbo_sync_status: "needs_review",
        qbo_sync_error:
          "The linked QuickBooks bill was deleted. Its cost is still posted to job-cost actuals in Arc — void or reassign the bill to release it.",
        qbo_synced_at: nowIso,
      })
      .eq("org_id", params.orgId)
      .eq("id", billId)
    return { reconciled: true as const }
  }

  const [qboBill, localResult] = await Promise.all([
    params.client.getBillById(params.qboId),
    params.supabase
      .from("vendor_bills")
      .select("total_cents, status, qbo_vendor_id, bill_date, due_date, accounting_coding, qbo_expense_account_id")
      .eq("org_id", params.orgId)
      .eq("id", billId)
      .maybeSingle(),
  ])
  if (!qboBill) {
    return { reconciled: false as const, reason: "QBO bill not found" }
  }

  if (remoteUnchangedSinceLastSync(qboBill.SyncToken, mapping.externalVersion)) {
    return { reconciled: true as const, unchanged: true as const }
  }

  const local = localResult.data as any
  const qboTotalCents = toCents(qboBill.TotalAmt)
  const localTotalCents = Number(local?.total_cents ?? 0)
  const firstAccountLine = (qboBill.Line ?? []).find((line: any) => line?.AccountBasedExpenseLineDetail?.AccountRef)
  const accountRef = firstAccountLine?.AccountBasedExpenseLineDetail?.AccountRef

  // Both-sides check, same standard as invoices: when Arc edited this bill after
  // the last sync AND QBO's payload differs materially, neither side may silently
  // win — a person picks. When Arc has not changed, QBO still wins below.
  const arcChangedAfterSync = arcChangedSinceSync({
    storedFingerprint: mapping.localFingerprint,
    currentFingerprint: computeLocalFingerprint("bill", local),
  })
  const qboBillDate = normalizeDate(qboBill.TxnDate)
  const qboDueDate = normalizeDate(qboBill.DueDate)
  const qboVendorId = qboBill.VendorRef?.value != null ? String(qboBill.VendorRef.value) : null
  const materiallyDiffers =
    (qboTotalCents !== null && qboTotalCents !== localTotalCents) ||
    (qboVendorId !== null && local?.qbo_vendor_id != null && qboVendorId !== String(local.qbo_vendor_id)) ||
    (qboBillDate !== null && local?.bill_date != null && qboBillDate !== String(local.bill_date)) ||
    (qboDueDate !== null && local?.due_date != null && qboDueDate !== String(local.due_date)) ||
    (accountRef?.value != null && local?.qbo_expense_account_id != null && String(accountRef.value) !== String(local.qbo_expense_account_id))
  if (!params.force && arcChangedAfterSync && materiallyDiffers) {
    const reason = "Both Arc and QuickBooks changed this bill since the last sync."
    await emitNeedsReviewEvent(params.orgId, "vendor_bill", billId, reason)
    await params.supabase
      .from("vendor_bills")
      .update({ qbo_sync_status: "needs_review", qbo_sync_error: reason })
      .eq("org_id", params.orgId)
      .eq("id", billId)
    await params.supabase.from("accounting_sync_records").upsert(
      {
        org_id: params.orgId,
        connection_id: params.connectionId,
        entity_type: "bill",
        entity_id: billId,
        provider: "qbo",
        external_id: params.qboId,
        external_version: qboBill.SyncToken ?? null,
        last_synced_at: nowIso,
        status: "needs_review",
        error_message: reason,
      },
      { onConflict: "org_id,connection_id,entity_type,entity_id" },
    )
    return { reconciled: false as const, reason }
  }

  // Only a bill Arc already treats as an incurred payable is worth stopping a
  // person for — the GL set, not the sync set, because the risk being guarded is
  // QuickBooks silently repricing something Arc has already posted.
  if (qboTotalCents !== null && localTotalCents > 0 && qboTotalCents !== localTotalCents && isPayableVendorBillStatus(local?.status)) {
    await params.supabase
      .from("vendor_bills")
      .update({
        qbo_sync_status: "needs_review",
        qbo_sync_error: `QuickBooks changed this bill amount from ${(localTotalCents / 100).toFixed(2)} to ${(qboTotalCents / 100).toFixed(2)}.`,
        qbo_synced_at: nowIso,
      })
      .eq("org_id", params.orgId)
      .eq("id", billId)
    return { reconciled: true as const }
  }

  const update: Record<string, unknown> = {
    qbo_id: params.qboId,
    qbo_sync_status: "synced",
    qbo_sync_error: null,
    qbo_synced_at: nowIso,
    qbo_vendor_id: qboBill.VendorRef?.value ?? null,
    qbo_vendor_name: qboBill.VendorRef?.name ?? null,
  }
  if (qboTotalCents !== null) update.total_cents = qboTotalCents
  if (normalizeDate(qboBill.TxnDate)) update.bill_date = normalizeDate(qboBill.TxnDate)
  if (normalizeDate(qboBill.DueDate)) update.due_date = normalizeDate(qboBill.DueDate)
  if (typeof qboBill.DocNumber === "string") update.bill_number = qboBill.DocNumber
  if (accountRef?.value) {
    update.qbo_expense_account_id = String(accountRef.value)
    update.qbo_expense_account_name = accountRef.name ? String(accountRef.name) : null
  }
  if (qboBill.APAccountRef?.value) {
    update.qbo_ap_account_id = String(qboBill.APAccountRef.value)
    update.qbo_ap_account_name = qboBill.APAccountRef.name ? String(qboBill.APAccountRef.name) : null
  }

  const { error } = await params.supabase
    .from("vendor_bills")
    .update(update)
    .eq("org_id", params.orgId)
    .eq("id", billId)

  if (error) return { reconciled: false as const, reason: error.message }

  await params.supabase.from("accounting_sync_records").upsert(
    {
      org_id: params.orgId,
      connection_id: params.connectionId,
      entity_type: "bill",
      entity_id: billId,
      provider: "qbo",
      external_id: params.qboId,
      external_version: qboBill.SyncToken ?? null,
      last_synced_at: nowIso,
      status: "synced",
      error_message: null,
    },
    { onConflict: "org_id,connection_id,entity_type,entity_id" },
  )

  await stampLocalFingerprint({
    supabase: params.supabase,
    orgId: params.orgId,
    connectionId: params.connectionId,
    entityType: "bill",
    entityId: billId,
  })

  return { reconciled: true as const }
}

async function reconcileBillPaymentFromQbo(params: {
  supabase: ServiceClient
  client: QBOClient
  orgId: string
  connectionId: string
  qboBillPaymentId: string
  operation?: string | null
}) {
  const normalizedOp = String(params.operation ?? "").toLowerCase()
  if (normalizedOp === "delete") {
    // Terminal by nature: the object this row points at is gone from QuickBooks
    // and no sync can bring it back, so the message has to say what the person
    // is choosing between rather than just reporting the disagreement.
    await params.supabase
      .from("accounting_sync_records")
      .update({
        status: "conflict",
        error_message:
          "The linked QuickBooks bill payment was deleted, but Arc still shows this vendor payment as made. " +
          "Syncing cannot resolve this. Either re-enter the payment in QuickBooks, or void it in Arc if the money did not move.",
        last_synced_at: new Date().toISOString(),
      })
      .eq("org_id", params.orgId)
      .eq("connection_id", params.connectionId)
      .eq("entity_type", "bill_payment")
      .eq("external_id", params.qboBillPaymentId)
    return { reconciled: true as const }
  }

  const billPayment = await params.client.getBillPaymentById(params.qboBillPaymentId)
  if (!billPayment) return { reconciled: false as const, reason: "QBO bill payment not found" }

  const linkedBillIds = new Set<string>()
  for (const line of billPayment.Line ?? []) {
    for (const linkedTxn of line.LinkedTxn ?? []) {
      if (String(linkedTxn.TxnType ?? "").toLowerCase() !== "bill") continue
      if (linkedTxn.TxnId) linkedBillIds.add(String(linkedTxn.TxnId))
    }
  }
  if (linkedBillIds.size === 0) return { reconciled: false as const, reason: "No linked bill found" }

  // A webhook is a reconciliation signal, not an import. Only reconcile a bill payment after the
  // import/sync pipeline has created a real Arc payment row for it. Older code inserted a random
  // placeholder entity_id here, which made the import sheet hide transactions that had never been
  // added to the payment ledger.
  const { data: syncRows } = await params.supabase
    .from("accounting_sync_records")
    .select("entity_id")
    .eq("org_id", params.orgId)
    .eq("connection_id", params.connectionId)
    .eq("entity_type", "bill_payment")
    .eq("external_id", params.qboBillPaymentId)
  const mappedPaymentIds = Array.from(
    new Set((syncRows ?? []).map((row) => row.entity_id).filter((id): id is string => Boolean(id))),
  )
  if (mappedPaymentIds.length === 0) {
    return { reconciled: false as const, reason: "Bill payment is available for manual import" }
  }
  const { data: mappedPayments } = await params.supabase
    .from("payments")
    .select("id")
    .eq("org_id", params.orgId)
    .in("id", mappedPaymentIds)
  if (!mappedPayments || mappedPayments.length === 0) {
    return { reconciled: false as const, reason: "Bill payment is available for manual import" }
  }

  let updated = 0
  for (const qboBillId of linkedBillIds) {
    const { data: billSync } = await params.supabase
      .from("accounting_sync_records")
      .select("entity_id")
      .eq("org_id", params.orgId)
      .eq("connection_id", params.connectionId)
      .eq("entity_type", "bill")
      .eq("external_id", qboBillId)
      .maybeSingle()
    if (!billSync?.entity_id) continue
    const { data: bill } = await params.supabase
      .from("vendor_bills")
      .select("id, total_cents, paid_cents")
      .eq("org_id", params.orgId)
      .eq("id", billSync.entity_id)
      .maybeSingle()
    if (!bill?.id) continue

    const totalCents = Number((bill as any).total_cents ?? 0)
    const { data: ledgerRows } = await params.supabase
      .from("payments")
      .select("amount_cents")
      .eq("org_id", params.orgId)
      .eq("bill_id", bill.id)
      .in("status", ["processing", "succeeded", "completed"])
    const ledgerPaid = (ledgerRows ?? []).reduce((sum, payment) => sum + Number(payment.amount_cents ?? 0), 0)
    const nextPaid = totalCents > 0 ? Math.min(totalCents, ledgerPaid) : ledgerPaid
    await params.supabase
      .from("vendor_bills")
      .update({
        paid_cents: nextPaid,
        status: totalCents > 0 && nextPaid >= totalCents ? "paid" : "partial",
        paid_at: totalCents > 0 && nextPaid >= totalCents ? new Date().toISOString() : null,
      })
      .eq("org_id", params.orgId)
      .eq("id", bill.id)
    updated += 1
  }

  await params.supabase
    .from("accounting_sync_records")
    .update({
      connection_id: params.connectionId,
      external_version: billPayment.SyncToken ?? null,
      last_synced_at: new Date().toISOString(),
      status: "synced",
      error_message: null,
    })
    .eq("org_id", params.orgId)
    .eq("connection_id", params.connectionId)
    .eq("entity_type", "bill_payment")
    .eq("external_id", params.qboBillPaymentId)

  return updated > 0 ? { reconciled: true as const } : { reconciled: false as const, reason: "No local bill matched linked QBO bill" }
}

function extractLinkedInvoiceQboIds(payment: QBOPaymentSnapshot | null) {
  const invoiceQboIds = new Set<string>()
  for (const line of payment?.Line ?? []) {
    for (const linkedTxn of line.LinkedTxn ?? []) {
      if (String(linkedTxn.TxnType ?? "").toLowerCase() !== "invoice") continue
      if (!linkedTxn.TxnId) continue
      invoiceQboIds.add(String(linkedTxn.TxnId))
    }
  }
  return Array.from(invoiceQboIds)
}

async function reverseDeletedQboPayment(params: {
  supabase: ServiceClient
  orgId: string
  connectionId: string
  qboPaymentId: string
}) {
  const { data: mappings, error: mappingError } = await params.supabase
    .from("accounting_sync_records")
    .select("entity_id")
    .eq("org_id", params.orgId)
    .eq("connection_id", params.connectionId)
    .eq("entity_type", "payment")
    .eq("external_id", params.qboPaymentId)
  if (mappingError) throw new Error(mappingError.message)

  const paymentIds = Array.from(new Set((mappings ?? []).map((row) => String(row.entity_id)).filter(Boolean)))
  if (paymentIds.length === 0) return { reversed: 0, invoiceIds: [] as string[] }
  const { data: payments, error: paymentError } = await params.supabase
    .from("payments")
    .select("id, project_id, invoice_id, amount_cents, status")
    .eq("org_id", params.orgId)
    .in("id", paymentIds)
  if (paymentError) throw new Error(paymentError.message)

  const invoiceIds = new Set<string>()
  let reversed = 0
  for (const payment of payments ?? []) {
    if (!payment.invoice_id || !["succeeded", "completed", "paid"].includes(String(payment.status))) continue
    const providerReversalId = `qbo-delete:${params.qboPaymentId}:${payment.id}`
    const { error: reversalError } = await params.supabase.from("payment_reversals").upsert(
      {
        org_id: params.orgId,
        project_id: payment.project_id ?? null,
        invoice_id: payment.invoice_id,
        payment_id: payment.id,
        amount_cents: Number(payment.amount_cents),
        reversal_type: "correction",
        status: "succeeded",
        provider_reversal_id: providerReversalId,
        reason: "Payment deleted in QuickBooks",
        metadata: { source: "qbo_webhook", qbo_payment_id: params.qboPaymentId },
        occurred_at: new Date().toISOString(),
      },
      { onConflict: "org_id,provider_reversal_id" },
    )
    if (reversalError) throw new Error(reversalError.message)
    const { error: recalcError } = await params.supabase.rpc("recalc_invoice_balance_atomic", {
      p_org_id: params.orgId,
      p_invoice_id: payment.invoice_id,
    })
    if (recalcError) throw new Error(recalcError.message)
    invoiceIds.add(String(payment.invoice_id))
    reversed += 1
    await recordEvent({
      orgId: params.orgId,
      eventType: "payment_reversed_from_qbo",
      entityType: "payment",
      entityId: String(payment.id),
      payload: {
        invoice_id: payment.invoice_id,
        amount_cents: Number(payment.amount_cents),
        qbo_payment_id: params.qboPaymentId,
      },
    })
  }
  return { reversed, invoiceIds: Array.from(invoiceIds) }
}

async function markEventProcessed(
  supabase: ServiceClient,
  eventId: string,
  status: "reconciled" | "ignored" | "error",
  error?: string,
  previousAttempts = 0,
) {
  const attempts = status === "error" ? previousAttempts + 1 : previousAttempts
  const retryDelaySeconds = Math.min(60 * 60, 2 ** Math.max(attempts - 1, 0) * 60)
  const nextAttemptAt = status === "error" && attempts < MAX_EVENT_ATTEMPTS
    ? new Date(Date.now() + retryDelaySeconds * 1000).toISOString()
    : null
  await supabase
    .from("qbo_webhook_events")
    .update({
      process_status: status,
      process_error: error ?? null,
      processed_at: status === "error" && attempts < MAX_EVENT_ATTEMPTS ? null : new Date().toISOString(),
      attempts,
      next_attempt_at: nextAttemptAt,
    })
    .eq("id", eventId)
}

/**
 * Accept, verify, and persist an Intuit webhook delivery into the inbound event queue.
 * Returns null when the signature is invalid (caller responds 401).
 */
export async function receiveQboWebhook(input: {
  rawBody: string
  headers: Record<string, string | null>
}): Promise<{ received: number; inserted: number } | null> {
  const signature = input.headers["intuit-signature"] ?? null
  const isValid = verifyIntuitWebhookSignature({
    payload: input.rawBody,
    signatureHeader: signature,
    verifierToken: process.env.QBO_WEBHOOK_VERIFIER_TOKEN,
  })
  if (!isValid) {
    logQBO("warn", "webhook_invalid_signature", { hasSignature: Boolean(signature) })
    return null
  }

  const supabase = createServiceSupabaseClient()
  const payloadHash = createHash("sha256").update(input.rawBody).digest("hex")
  const events = extractIntuitEntityEvents(JSON.parse(input.rawBody || "{}"))
  let inserted = 0
  for (const event of events) {
    // ignoreDuplicates: a redelivered event must not reset an already-processed row to pending.
    const { error } = await supabase.from("qbo_webhook_events").upsert({
      event_id: event.eventId,
      payload_hash: payloadHash,
      realm_id: event.realmId,
      entity_name: event.entityName,
      entity_qbo_id: event.entityId,
      operation: event.operation,
      last_updated: event.lastUpdated !== "unknown-time" ? new Date(event.lastUpdated).toISOString() : null,
      received_at: new Date().toISOString(),
      process_status: "pending",
      process_error: null,
      processed_at: null,
    }, {
      onConflict: "event_id",
      ignoreDuplicates: true,
    })
    if (!error) {
      inserted += 1
    } else {
      // A duplicate is silently ignored by the upsert; reaching here is a real
      // insert failure and must not be indistinguishable from one.
      logQBO("error", "webhook_event_insert_failed", { eventId: event.eventId, error: error.message })
    }
  }
  return { received: events.length, inserted }
}

/**
 * Poll QBO change-data-capture for one connection and enqueue changes into the
 * inbound event queue. Advances the per-connection cursor on success.
 */
export async function ingestQboCdcChanges(input: {
  connectionId: string
  lookbackMinutes?: number | null
}): Promise<{ scanned: number; inserted: number }> {
  const supabase = createServiceSupabaseClient()
  const { data: connection } = await supabase
    .from("accounting_connections")
    .select("id, org_id, external_account_id, settings")
    .eq("id", input.connectionId)
    .eq("status", "active")
    .maybeSingle()
  if (!connection?.org_id) return { scanned: 0, inserted: 0 }

  // Fails closed: an unreadable authority row throws rather than letting an
  // Arc-authoritative org's ledger be overwritten from outside. CDC ingestion is
  // cron-driven, so the throw surfaces on the job run and the next pass retries.
  if ((await resolveLedgerAuthority(connection.org_id, supabase)) === "arc") {
    return { scanned: 0, inserted: 0 }
  }

  const settings = (connection.settings as Record<string, unknown> | null) ?? {}
  const storedCursor = typeof settings.qbo_cdc_last_synced_at === "string" ? settings.qbo_cdc_last_synced_at : null
  const rawCursorMs =
    input.lookbackMinutes != null
      ? Date.now() - input.lookbackMinutes * 60 * 1000
      : storedCursor
      ? new Date(storedCursor).getTime()
      : Date.now() - 24 * 60 * 60 * 1000
  // Intuit rejects changedSince older than 30 days, so an idle month (paused
  // org, cron outage, a reconnect carrying the old cursor forward) used to
  // fail EVERY poll forever — the cursor could never advance to heal itself.
  // Clamping forfeits changes older than the window, which the reconciliation
  // digest reports as drift; an unfixable poll loop reported nothing.
  const cdcFloorMs = Date.now() - CDC_MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  const cursorMs = Math.max(Number.isFinite(rawCursorMs) ? rawCursorMs : cdcFloorMs, cdcFloorMs)
  if (rawCursorMs < cdcFloorMs) {
    logQBO("warn", "qbo_cdc_cursor_clamped", {
      connectionId: connection.id,
      storedCursor,
      clampedTo: new Date(cdcFloorMs).toISOString(),
    })
  }
  const changedSince = new Date(Math.max(cursorMs - CDC_OVERLAP_MINUTES * 60 * 1000, cdcFloorMs)).toISOString()

  const client = await QBOClientFactory.forConnection(connection.id)
  if (!client) return { scanned: 0, inserted: 0 }

  const payload = await client.changeDataCapture(CDC_ENTITIES, changedSince)
  const response = (payload as any)?.CDCResponse?.[0]?.QueryResponse ?? []
  const rows: Array<{ entityName: string; id: string; lastUpdated: string; deleted: boolean }> = []
  for (const queryResponse of response) {
    for (const entityName of CDC_ENTITIES) {
      const entities = queryResponse?.[entityName]
      if (!Array.isArray(entities)) continue
      for (const entity of entities) {
        if (!entity?.Id) continue
        rows.push({
          entityName,
          id: String(entity.Id),
          // No wall-clock fallback: stamping now() minted a brand-new event id
          // for the same unchanged entity on every poll — unbounded queue rows
          // plus repeated reconciliation. The sentinel keeps the id stable.
          lastUpdated: entity.MetaData?.LastUpdatedTime ? String(entity.MetaData.LastUpdatedTime) : "unknown-time",
          deleted: String(entity.status ?? "") === "Deleted",
        })
      }
    }
  }

  let inserted = 0
  let insertFailed = false
  const nowIso = new Date().toISOString()
  for (const row of rows) {
    const operation = row.deleted ? "Delete" : "Update"
    // Same event-id shape as webhook deliveries — with the timestamp ISO-
    // normalized on BOTH paths (see normalizeEventTimestamp) — so a change that
    // arrives via webhook and CDC collapses into one queue row instead of being
    // reconciled twice.
    const idTimestamp = row.lastUpdated === "unknown-time" ? row.lastUpdated : normalizeEventTimestamp(row.lastUpdated)
    const eventId = `${connection.external_account_id}:${row.entityName}:${row.id}:${operation}:${idTimestamp}`
    const { error: insertError } = await supabase.from("qbo_webhook_events").upsert({
      event_id: eventId,
      payload_hash: createHash("sha256").update(eventId).digest("hex"),
      realm_id: connection.external_account_id,
      entity_name: row.entityName,
      entity_qbo_id: row.id,
      operation,
      last_updated: row.lastUpdated === "unknown-time" ? null : new Date(row.lastUpdated).toISOString(),
      received_at: nowIso,
      process_status: "pending",
      process_error: null,
      processed_at: null,
    }, {
      onConflict: "event_id",
      ignoreDuplicates: true,
    })
    if (insertError) insertFailed = true
    else inserted += 1
  }

  // Advance the cursor whenever the fetch and all inserts succeeded — duplicates are
  // ignored (not errors), so an all-duplicate overlap window can no longer stall it.
  if (!insertFailed) {
    const maxUpdatedAt = rows.reduce<string | null>((max, row) => {
      const iso = new Date(row.lastUpdated).toISOString()
      return !max || iso > max ? iso : max
    }, null)
    await supabase.rpc("update_qbo_cdc_cursor", {
      p_connection_id: connection.id,
      p_cursor: maxUpdatedAt && maxUpdatedAt > nowIso ? maxUpdatedAt : nowIso,
    })
  }

  return { scanned: rows.length, inserted }
}

/**
 * Conservative reconcile for entity types Arc imports but has no field-level
 * merge for (vendor credits, journal entries). Before this they were
 * import-once-and-diverge: a QBO-side edit or deletion after import was never
 * picked up by anything. The goal here is honesty rather than auto-merge — a
 * remote change flips the imported record's sync row to needs_review so a
 * person sees the divergence, and an echo of Arc's own push is suppressed by
 * the SyncToken comparison exactly like the invoice path.
 */
async function reconcileImportedRecordFromQbo(params: {
  supabase: ServiceClient
  client: QBOClient
  orgId: string
  connectionId: string
  entityName: "vendorcredit" | "journalentry"
  qboId: string
  operation: string | null
}): Promise<{ reconciled: boolean; reason?: string }> {
  const { supabase, orgId, connectionId } = params
  const ledgerType = params.entityName === "vendorcredit" ? "vendor_credit" : "journal_entry"
  const { data: sync } = await supabase
    .from("accounting_sync_records")
    .select("id, entity_id, external_version")
    .eq("org_id", orgId)
    .eq("connection_id", connectionId)
    .eq("entity_type", ledgerType)
    .eq("external_id", params.qboId)
    .maybeSingle()
  if (!sync?.entity_id) {
    return { reconciled: false, reason: `No local ${ledgerType} mapping — available for manual import` }
  }

  const nowIso = new Date().toISOString()
  const markNeedsReview = async (message: string, externalVersion?: string | null) => {
    await supabase
      .from("accounting_sync_records")
      .update({
        status: "needs_review",
        error_message: message,
        ...(externalVersion !== undefined ? { external_version: externalVersion } : {}),
        last_synced_at: nowIso,
      })
      .eq("id", sync.id)
    await emitNeedsReviewEvent(orgId, ledgerType, sync.entity_id as string, message)
  }

  const remote =
    String(params.operation ?? "").toLowerCase() === "delete"
      ? null
      : params.entityName === "vendorcredit"
        ? await params.client.getVendorCreditById(params.qboId)
        : await params.client.getJournalEntryById(params.qboId)

  if (!remote) {
    await markNeedsReview("Deleted in QuickBooks — the imported record still exists in Arc and may need reversal.")
    return { reconciled: true }
  }

  const remoteVersion = remote.SyncToken ? String(remote.SyncToken) : null
  if (remoteVersion && sync.external_version && remoteVersion === sync.external_version) {
    return { reconciled: false, reason: "Remote unchanged since last sync" }
  }
  await markNeedsReview("Changed in QuickBooks after import — review the Arc copy for divergence.", remoteVersion)
  return { reconciled: true }
}

/**
 * "Take QuickBooks" for a conflicted record: re-run the reconcile with the
 * both-sides guard released, so the remote copy is applied and the sync row
 * returns to synced. The stored SyncToken makes this safe — the caller only
 * offers it on rows already flagged needs_review/conflict.
 */
export async function forceReconcileFromQbo(input: {
  orgId: string
  connectionId: string
  entityType: "invoice" | "project_expense" | "bill"
  externalId: string
}): Promise<{ reconciled: boolean; reason?: string }> {
  const supabase = createServiceSupabaseClient()
  const client = await QBOClientFactory.forConnection(input.connectionId)
  if (!client) return { reconciled: false, reason: "QuickBooks connection is unavailable" }
  if (input.entityType === "invoice") {
    return reconcileInvoiceFromQbo({ supabase, client, orgId: input.orgId, connectionId: input.connectionId, qboInvoiceId: input.externalId, force: true })
  }
  if (input.entityType === "bill") {
    return reconcileVendorBillFromQbo({ supabase, client, orgId: input.orgId, connectionId: input.connectionId, qboId: input.externalId, force: true })
  }
  // A project expense may live in QBO as a Purchase or a Bill; try both shapes.
  const asBill = await reconcileProjectExpenseFromQbo({ supabase, client, orgId: input.orgId, connectionId: input.connectionId, qboId: input.externalId, entityName: "bill", operation: null, force: true })
  if (asBill.reconciled) return asBill
  return reconcileProjectExpenseFromQbo({ supabase, client, orgId: input.orgId, connectionId: input.connectionId, qboId: input.externalId, entityName: "purchase", operation: null, force: true })
}

/**
 * Drain the inbound event queue: claim events with a lease, re-fetch each entity from
 * QBO, and reconcile it into Arc. Events stranded in `processing` past their lease are
 * recovered to `retry` first.
 */
export async function drainQboInboundEvents(input: { limit: number }): Promise<{ processed: number; reconciled: number; ignored: number; errored: number }> {
  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()

  // Local counters ride along with every terminal outcome — "processed" alone
  // counted dropped work as done, hiding how much inbound was being ignored.
  let ignored = 0
  let errored = 0
  // Per-row trace context, set once the event's connection resolves; null for
  // events that never matched a connection (nothing to attribute them to).
  let currentTrace: { orgId: string; connectionId: string; entityName: string | null; externalId: string | null } | null = null
  const finishEvent = async (
    eventId: string,
    status: "reconciled" | "ignored" | "error",
    processError?: string,
    attempts?: number,
  ) => {
    if (status === "ignored") ignored += 1
    if (status === "error") errored += 1
    await markEventProcessed(supabase, eventId, status, processError, attempts)
    if (currentTrace) {
      await recordAccountingSyncAttempt({
        orgId: currentTrace.orgId,
        connectionId: currentTrace.connectionId,
        provider: "qbo",
        entityType: currentTrace.entityName?.toLowerCase() ?? "unknown",
        entityId: null,
        externalId: currentTrace.externalId,
        direction: "inbound",
        outcome: status === "reconciled" ? "synced" : status === "ignored" ? "skipped" : "error",
        message: processError ?? null,
      })
    }
  }

  // Retention: the queue table had none, so it grew by one row per change per
  // connection forever. Terminal rows older than 60 days carry no operational
  // value (the sync ledger keeps the durable state); deleting a bounded batch
  // per drain keeps each pass cheap while draining the backlog over time.
  const retentionCutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
  const { data: expiredRows } = await supabase
    .from("qbo_webhook_events")
    .select("id")
    .in("process_status", ["reconciled", "ignored"])
    .lt("received_at", retentionCutoff)
    .limit(500)
  if (expiredRows && expiredRows.length > 0) {
    await supabase
      .from("qbo_webhook_events")
      .delete()
      .in("id", expiredRows.map((expired) => expired.id))
  }

  // Reclaim leases abandoned by a crashed worker — and CHARGE the attempt.
  // A hard crash (timeout, OOM) bypasses markEventProcessed, so without the
  // increment a poison event cycled processing→retry forever at the head of
  // the oldest-first drain, occupying batch slots on every run.
  const { data: stranded } = await supabase
    .from("qbo_webhook_events")
    .select("id, attempts")
    .eq("process_status", "processing")
    .lt("next_attempt_at", nowIso)
  for (const strandedRow of stranded ?? []) {
    const attempts = (strandedRow.attempts ?? 0) + 1
    const exhausted = attempts >= MAX_EVENT_ATTEMPTS
    await supabase
      .from("qbo_webhook_events")
      .update({
        process_status: exhausted ? "error" : "retry",
        attempts,
        ...(exhausted
          ? { process_error: "Processing crashed repeatedly (lease expired without a result)", processed_at: new Date().toISOString() }
          : {}),
      })
      .eq("id", strandedRow.id)
      .eq("process_status", "processing")
  }

  const { data: events, error } = await supabase
    .from("qbo_webhook_events")
    .select("id, event_id, realm_id, entity_name, entity_qbo_id, operation, attempts")
    .or(`process_status.eq.pending,and(process_status.in.(error,retry),attempts.lt.${MAX_EVENT_ATTEMPTS},next_attempt_at.lte.${nowIso})`)
    .order("received_at", { ascending: true })
    .limit(input.limit)

  if (error) throw new Error(`Unable to load inbound accounting events: ${error.message}`)

  const rows = (events ?? []) as WebhookEventRow[]
  if (rows.length === 0) return { processed: 0, reconciled: 0, ignored: 0, errored: 0 }

  let reconciled = 0
  let processed = 0
  const clientsByConnectionId = new Map<string, QBOClient | null>()

  for (const row of rows) {
    currentTrace = null
    try {
      // The claim writes a lease into next_attempt_at so a crashed worker's events
      // are recovered by the sweep above instead of stranding in `processing`.
      const { data: claimed } = await supabase
        .from("qbo_webhook_events")
        .update({
          process_status: "processing",
          process_error: null,
          next_attempt_at: new Date(Date.now() + EVENT_CLAIM_LEASE_MINUTES * 60 * 1000).toISOString(),
        })
        .eq("id", row.id)
        .in("process_status", ["pending", "error", "retry"])
        .select("id")
        .maybeSingle()

      if (!claimed?.id) {
        continue
      }

      if (!row.realm_id || !row.entity_name || !row.entity_qbo_id) {
        await finishEvent(row.id, "ignored", "Missing webhook context")
        processed += 1
        continue
      }

      const { data: connection } = await supabase
        .from("accounting_connections")
        .select("id, org_id")
        .eq("provider", "qbo")
        .eq("external_account_id", row.realm_id)
        .eq("status", "active")
        .maybeSingle()

      if (!connection?.org_id || !connection?.id) {
        await finishEvent(row.id, "ignored", "No active org connection for realm")
        processed += 1
        continue
      }
      currentTrace = {
        orgId: connection.org_id,
        connectionId: connection.id,
        entityName: row.entity_name,
        externalId: row.entity_qbo_id,
      }

      // Fails closed: without knowing who owns the ledger this event must not be
      // applied. Erroring the single event reschedules it on the backoff rather
      // than aborting the rest of the drain.
      let ledgerAuthority: LedgerAuthority
      try {
        ledgerAuthority = await resolveLedgerAuthority(connection.org_id, supabase)
      } catch (authorityError) {
        const message = authorityError instanceof Error ? authorityError.message : "Unable to resolve ledger authority"
        await finishEvent(row.id, "error", message, row.attempts ?? 0)
        processed += 1
        continue
      }

      if (ledgerAuthority === "arc") {
        await finishEvent(row.id, "ignored", "Arc is authoritative; external changes are drift-only")
        // Activity-only: "books.external_drift_detected" is not a NotificationType,
        // so a notification channel produced a raw-string-titled notification for
        // an empty audience. The real user-facing alert is the reconciliation
        // digest's accounting_reconciliation_drift.
        await recordEvent({
          orgId: connection.org_id,
          eventType: "books.external_drift_detected",
          entityType: "accounting_connection",
          entityId: connection.id,
          payload: { provider: "qbo", entity_name: row.entity_name, external_id: row.entity_qbo_id, operation: row.operation },
        })
        processed += 1
        continue
      }

      const entityName = row.entity_name.toLowerCase()
      const orgId = connection.org_id as string
      const connectionId = connection.id as string
      let client = clientsByConnectionId.get(connectionId)
      if (client === undefined) {
        client = await QBOClientFactory.forConnection(connectionId)
        clientsByConnectionId.set(connectionId, client)
      }

      if (!client) {
        await finishEvent(row.id, "error", "Unable to initialize QBO client", row.attempts ?? 0)
        processed += 1
        continue
      }

      if (entityName === "invoice") {
        const result = await reconcileInvoiceFromQbo({
          supabase,
          client,
          orgId,
          connectionId,
          qboInvoiceId: row.entity_qbo_id,
          operation: row.operation,
        })

        if (result.reconciled) {
          reconciled += 1
          await finishEvent(row.id, "reconciled")
        } else {
          await finishEvent(row.id, "ignored", result.reason)
        }
      } else if (entityName === "payment") {
        const normalizedOperation = String(row.operation ?? "").toLowerCase()
        if (normalizedOperation === "delete") {
          try {
            const reversal = await reverseDeletedQboPayment({
              supabase,
              orgId,
              connectionId,
              qboPaymentId: row.entity_qbo_id,
            })
            await supabase
              .from("accounting_sync_records")
              .update({
                status: "synced",
                error_message: null,
                last_synced_at: new Date().toISOString(),
              })
              .eq("org_id", orgId)
              .eq("connection_id", connectionId)
              .eq("entity_type", "payment")
              .eq("external_id", row.entity_qbo_id)
            await finishEvent(row.id,
              reversal.reversed > 0 ? "reconciled" : "ignored",
              reversal.reversed > 0 ? undefined : "Deleted QBO payment had no settled Arc payment mapping",
            )
            if (reversal.reversed > 0) reconciled += 1
          } catch (error) {
            await finishEvent(row.id,
              "error",
              error instanceof Error ? error.message : String(error),
              row.attempts ?? 0,
            )
          }
          processed += 1
          continue
        }
        const payment = normalizedOperation === "delete" ? null : await client.getPaymentById(row.entity_qbo_id)
        let linkedInvoiceQboIds = extractLinkedInvoiceQboIds(payment)

        if (linkedInvoiceQboIds.length === 0) {
          const { data: paymentSync } = await supabase
            .from("accounting_sync_records")
            .select("entity_id")
            .eq("org_id", orgId)
            .eq("connection_id", connectionId)
            .eq("entity_type", "payment")
            .eq("external_id", row.entity_qbo_id)
            .maybeSingle()

          if (paymentSync?.entity_id) {
            const { data: paymentRow } = await supabase
              .from("payments")
              .select("invoice_id")
              .eq("org_id", orgId)
              .eq("id", paymentSync.entity_id)
              .maybeSingle()
            if (paymentRow?.invoice_id) {
              const { data: invoiceSync } = await supabase.from("accounting_sync_records")
                .select("external_id")
                .eq("org_id", orgId)
                .eq("connection_id", connectionId)
                .eq("entity_type", "invoice")
                .eq("entity_id", paymentRow.invoice_id)
                .maybeSingle()
              if (invoiceSync?.external_id) linkedInvoiceQboIds = [invoiceSync.external_id]
            }
          }
        }

        if (linkedInvoiceQboIds.length === 0) {
          await finishEvent(row.id, "ignored", "No linked invoice found for payment")
          processed += 1
          continue
        }

        let reconciledInvoices = 0
        for (const invoiceQboId of linkedInvoiceQboIds) {
          const result = await reconcileInvoiceFromQbo({
            supabase,
            client,
            orgId,
            connectionId,
            qboInvoiceId: invoiceQboId,
          })
          if (result.reconciled) reconciledInvoices += 1
        }

        await supabase
          .from("accounting_sync_records")
          .update({
            status: "synced",
            error_message: null,
            last_synced_at: new Date().toISOString(),
          })
          .eq("org_id", orgId)
          .eq("connection_id", connectionId)
          .eq("entity_type", "payment")
          .eq("external_id", row.entity_qbo_id)

        if (reconciledInvoices > 0) {
          reconciled += 1
          await finishEvent(row.id, "reconciled")
        } else {
          await finishEvent(row.id, "ignored", "Payment event had no local invoice to reconcile")
        }
      } else if (entityName === "purchase" || entityName === "bill") {
        const vendorBillResult =
          entityName === "bill"
            ? await reconcileVendorBillFromQbo({
                supabase,
                client,
                orgId,
                connectionId,
                qboId: row.entity_qbo_id,
                operation: row.operation,
              })
            : { reconciled: false as const, reason: "Not a QBO bill" }

        const result = vendorBillResult.reconciled
          ? vendorBillResult
          : await reconcileProjectExpenseFromQbo({
              supabase,
              client,
              orgId,
              connectionId,
              qboId: row.entity_qbo_id,
              entityName: entityName as "purchase" | "bill",
              operation: row.operation,
            })

        if (result.reconciled) {
          reconciled += 1
          await finishEvent(row.id, "reconciled")
        } else {
          await finishEvent(row.id, "ignored", result.reason)
        }
      } else if (entityName === "billpayment") {
        const result = await reconcileBillPaymentFromQbo({
          supabase,
          client,
          orgId,
          connectionId,
          qboBillPaymentId: row.entity_qbo_id,
          operation: row.operation,
        })

        if (result.reconciled) {
          reconciled += 1
          await finishEvent(row.id, "reconciled")
        } else {
          await finishEvent(row.id, "ignored", result.reason)
        }
      } else if (entityName === "vendorcredit" || entityName === "journalentry") {
        const result = await reconcileImportedRecordFromQbo({
          supabase,
          client,
          orgId,
          connectionId,
          entityName,
          qboId: row.entity_qbo_id,
          operation: row.operation,
        })

        if (result.reconciled) {
          reconciled += 1
          await finishEvent(row.id, "reconciled")
        } else {
          await finishEvent(row.id, "ignored", result.reason)
        }
      } else {
        await finishEvent(row.id, "ignored", `Entity ${row.entity_name} not handled`)
      }

      processed += 1
    } catch (eventError) {
      await finishEvent(row.id,
        "error",
        eventError instanceof Error ? eventError.message : "Webhook processing failed",
        row.attempts ?? 0,
      )
      processed += 1
    }
  }

  logQBO("info", "process_webhooks_complete", { processed, reconciled, ignored, errored })
  return { processed, reconciled, ignored, errored }
}
