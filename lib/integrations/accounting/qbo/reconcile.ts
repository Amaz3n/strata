import { createHash } from "crypto"

import type { QBOClient, QBOPaymentSnapshot } from "@/lib/integrations/accounting/qbo/client"
import { QBOClient as QBOClientFactory } from "@/lib/integrations/accounting/qbo/client"
import { extractIntuitEntityEvents, verifyIntuitWebhookSignature } from "@/lib/integrations/accounting/qbo/webhook"
import { qboPurchaseIsCredit } from "@/lib/integrations/accounting/qbo/import-rules"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { logQBO } from "@/lib/services/accounting-logger"
import { rememberAccountingInvoiceNumberCursor } from "@/lib/services/invoice-numbers"

const CDC_ENTITIES = ["Invoice", "Payment", "Purchase", "Bill", "BillPayment"]
const CDC_OVERLAP_MINUTES = 5
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

function isPastDue(dateIso: string | null) {
  if (!dateIso) return false
  const due = new Date(dateIso)
  if (Number.isNaN(due.getTime())) return false
  due.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return due < today
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

function deriveInvoiceStatusFromQbo(params: {
  operation?: string | null
  totalCents: number | null
  balanceCents: number | null
  dueDate: string | null
}) {
  const operation = String(params.operation ?? "").toLowerCase()
  if (operation === "delete") return "void"

  const total = params.totalCents ?? 0
  const balance = params.balanceCents ?? total

  if (total > 0 && balance <= 0) return "paid"
  if (total > 0 && balance > 0 && balance < total) return "partial"
  if (balance > 0 && isPastDue(params.dueDate)) return "overdue"
  return "sent"
}

async function resolveLocalSyncMapping(
  supabase: ServiceClient,
  orgId: string,
  connectionId: string,
  entityType: string,
  externalId: string,
): Promise<{ entityId: string; externalVersion: string | null } | null> {
  const { data: rows } = await supabase
    .from("accounting_sync_records")
    .select("entity_id, external_version, status, last_synced_at")
    .eq("org_id", orgId)
    .eq("connection_id", connectionId)
    .eq("entity_type", entityType)
    .eq("external_id", externalId)
    .order("last_synced_at", { ascending: false })
    .limit(10)

  const match = (rows ?? []).find((row) => row.status === "synced") ?? rows?.[0]
  if (!match?.entity_id) return null
  return { entityId: match.entity_id as string, externalVersion: (match.external_version as string | null) ?? null }
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
}

export async function reconcileInvoiceFromQbo(params: {
  supabase: ServiceClient
  client: QBOClient
  orgId: string
  connectionId: string
  qboInvoiceId: string
  operation?: string | null
}) {
  const nowIso = new Date().toISOString()
  const mapping = await resolveLocalSyncMapping(params.supabase, params.orgId, params.connectionId, "invoice", params.qboInvoiceId)
  if (!mapping) {
    return { reconciled: false as const, reason: "No local invoice mapping" }
  }
  const invoiceId = mapping.entityId

  const normalizedOp = String(params.operation ?? "").toLowerCase()
  if (normalizedOp === "delete") {
    const { error: updateError } = await params.supabase
      .from("invoices")
      .update({
        status: "void",
        balance_due_cents: 0,
        qbo_id: params.qboInvoiceId,
        qbo_sync_status: "synced",
        qbo_synced_at: nowIso,
      })
      .eq("org_id", params.orgId)
      .eq("id", invoiceId)

    if (updateError) {
      return { reconciled: false as const, reason: updateError.message }
    }

    await upsertInvoiceSyncRecord({
      supabase: params.supabase,
      orgId: params.orgId,
      connectionId: params.connectionId,
      invoiceId,
      qboInvoiceId: params.qboInvoiceId,
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
  const nextStatus = deriveInvoiceStatusFromQbo({
    operation: params.operation,
    totalCents,
    balanceCents,
    dueDate,
  })

  const { data: localInvoice } = await params.supabase
    .from("invoices")
    .select("updated_at, qbo_synced_at, subtotal_cents, tax_cents, total_cents, balance_due_cents")
    .eq("org_id", params.orgId)
    .eq("id", invoiceId)
    .maybeSingle()
  const localUpdatedAt = localInvoice?.updated_at ? new Date(localInvoice.updated_at).getTime() : 0
  const localSyncedAt = localInvoice?.qbo_synced_at ? new Date(localInvoice.qbo_synced_at).getTime() : 0
  const arcChangedAfterSync = localUpdatedAt > localSyncedAt
  const amountsDiffer =
    (totalCents !== null && Number(localInvoice?.total_cents ?? 0) !== totalCents) ||
    (balanceCents !== null && Number(localInvoice?.balance_due_cents ?? 0) !== Math.max(balanceCents, 0)) ||
    Number(localInvoice?.subtotal_cents ?? 0) !== subtotalCents ||
    Number(localInvoice?.tax_cents ?? 0) !== taxCents

  if (arcChangedAfterSync && amountsDiffer) {
    const reason = "Both Arc and QuickBooks changed this invoice since the last sync."
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

  const invoiceUpdate: Record<string, unknown> = {
    qbo_id: params.qboInvoiceId,
    qbo_sync_status: "synced",
    qbo_synced_at: nowIso,
    status: nextStatus,
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
  if (balanceCents !== null) invoiceUpdate.balance_due_cents = Math.max(balanceCents, 0)

  const { error: reconcileError } = await params.supabase.rpc("replace_invoice_lines_atomic", {
    p_org_id: params.orgId,
    p_invoice_id: invoiceId,
    p_invoice_update: invoiceUpdate,
    p_lines: nextLines,
  })

  if (reconcileError) {
    return { reconciled: false as const, reason: reconcileError.message }
  }

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
}) {
  const mapping = await resolveLocalSyncMapping(params.supabase, params.orgId, params.connectionId, "project_expense", params.qboId)
  if (!mapping) {
    return { reconciled: false as const, reason: "No local expense mapping" }
  }
  const expenseId = mapping.entityId
  const { data: localExpense } = await params.supabase
    .from("project_expenses")
    .select("amount_cents, tax_cents, status, metadata")
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
        qbo_sync_error: "The linked QuickBooks transaction was deleted.",
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

  return { reconciled: true as const }
}

async function reconcileVendorBillFromQbo(params: {
  supabase: ServiceClient
  client: QBOClient
  orgId: string
  connectionId: string
  qboId: string
  operation?: string | null
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
        qbo_sync_error: "The linked QuickBooks bill was deleted.",
        qbo_synced_at: nowIso,
      })
      .eq("org_id", params.orgId)
      .eq("id", billId)
    return { reconciled: true as const }
  }

  const [qboBill, localResult] = await Promise.all([
    params.client.getBillById(params.qboId),
    params.supabase.from("vendor_bills").select("total_cents, status").eq("org_id", params.orgId).eq("id", billId).maybeSingle(),
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
  if (qboTotalCents !== null && localTotalCents > 0 && qboTotalCents !== localTotalCents && ["approved", "partial", "paid"].includes(String(local?.status ?? ""))) {
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

  const firstAccountLine = (qboBill.Line ?? []).find((line: any) => line?.AccountBasedExpenseLineDetail?.AccountRef)
  const accountRef = firstAccountLine?.AccountBasedExpenseLineDetail?.AccountRef
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
    await params.supabase
      .from("accounting_sync_records")
      .update({
        status: "conflict",
        error_message: "The linked QuickBooks bill payment was deleted.",
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
    if (!error) inserted += 1
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

  const settings = (connection.settings as Record<string, unknown> | null) ?? {}
  const storedCursor = typeof settings.qbo_cdc_last_synced_at === "string" ? settings.qbo_cdc_last_synced_at : null
  const cursorMs =
    input.lookbackMinutes != null
      ? Date.now() - input.lookbackMinutes * 60 * 1000
      : storedCursor
      ? new Date(storedCursor).getTime()
      : Date.now() - 24 * 60 * 60 * 1000
  const changedSince = new Date(cursorMs - CDC_OVERLAP_MINUTES * 60 * 1000).toISOString()

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
          lastUpdated: String(entity.MetaData?.LastUpdatedTime ?? new Date().toISOString()),
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
    // Same event-id shape as webhook deliveries, so a change that arrives via both
    // webhook and CDC collapses into one queue row instead of being reconciled twice.
    const eventId = `${connection.external_account_id}:${row.entityName}:${row.id}:${operation}:${row.lastUpdated}`
    const { error: insertError } = await supabase.from("qbo_webhook_events").upsert({
      event_id: eventId,
      payload_hash: createHash("sha256").update(eventId).digest("hex"),
      realm_id: connection.external_account_id,
      entity_name: row.entityName,
      entity_qbo_id: row.id,
      operation,
      last_updated: new Date(row.lastUpdated).toISOString(),
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
 * Drain the inbound event queue: claim events with a lease, re-fetch each entity from
 * QBO, and reconcile it into Arc. Events stranded in `processing` past their lease are
 * recovered to `retry` first.
 */
export async function drainQboInboundEvents(input: { limit: number }): Promise<{ processed: number; reconciled: number }> {
  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()

  await supabase
    .from("qbo_webhook_events")
    .update({ process_status: "retry" })
    .eq("process_status", "processing")
    .lt("next_attempt_at", nowIso)

  const { data: events, error } = await supabase
    .from("qbo_webhook_events")
    .select("id, event_id, realm_id, entity_name, entity_qbo_id, operation, attempts")
    .or(`process_status.eq.pending,and(process_status.in.(error,retry),attempts.lt.${MAX_EVENT_ATTEMPTS},next_attempt_at.lte.${nowIso})`)
    .order("received_at", { ascending: true })
    .limit(input.limit)

  if (error) throw new Error(`Unable to load inbound accounting events: ${error.message}`)

  const rows = (events ?? []) as WebhookEventRow[]
  if (rows.length === 0) return { processed: 0, reconciled: 0 }

  let reconciled = 0
  let processed = 0
  const clientsByConnectionId = new Map<string, QBOClient | null>()

  for (const row of rows) {
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
        await markEventProcessed(supabase, row.id, "ignored", "Missing webhook context")
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
        await markEventProcessed(supabase, row.id, "ignored", "No active org connection for realm")
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
        await markEventProcessed(supabase, row.id, "error", "Unable to initialize QBO client", row.attempts ?? 0)
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
          await markEventProcessed(supabase, row.id, "reconciled")
        } else {
          await markEventProcessed(supabase, row.id, "ignored", result.reason)
        }
      } else if (entityName === "payment") {
        const normalizedOperation = String(row.operation ?? "").toLowerCase()
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
          await markEventProcessed(supabase, row.id, "ignored", "No linked invoice found for payment")
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
          await markEventProcessed(supabase, row.id, "reconciled")
        } else {
          await markEventProcessed(supabase, row.id, "ignored", "Payment event had no local invoice to reconcile")
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
          await markEventProcessed(supabase, row.id, "reconciled")
        } else {
          await markEventProcessed(supabase, row.id, "ignored", result.reason)
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
          await markEventProcessed(supabase, row.id, "reconciled")
        } else {
          await markEventProcessed(supabase, row.id, "ignored", result.reason)
        }
      } else {
        await markEventProcessed(supabase, row.id, "ignored", `Entity ${row.entity_name} not handled`)
      }

      processed += 1
    } catch (eventError) {
      await markEventProcessed(
        supabase,
        row.id,
        "error",
        eventError instanceof Error ? eventError.message : "Webhook processing failed",
        row.attempts ?? 0,
      )
      processed += 1
    }
  }

  logQBO("info", "process_webhooks_complete", { processed, reconciled })
  return { processed, reconciled }
}
