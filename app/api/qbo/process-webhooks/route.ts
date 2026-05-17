import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"

import type { QBOClient, QBOPaymentSnapshot } from "@/lib/integrations/accounting/qbo-api"
import { QBOClient as QBOClientFactory } from "@/lib/integrations/accounting/qbo-api"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { logQBO } from "@/lib/services/qbo-logger"
import { rememberQBOInvoiceNumberCursor } from "@/lib/services/invoice-numbers"

const CRON_SECRET = process.env.CRON_SECRET
const BATCH_SIZE = 50

type WebhookEventRow = {
  id: string
  event_id: string
  realm_id: string | null
  entity_name: string | null
  entity_qbo_id: string | null
  operation: string | null
}

type ActiveConnection = {
  id: string
  org_id: string
}

function isAuthorizedCronRequest(request: NextRequest) {
  const isDev = process.env.NODE_ENV !== "production"
  if (isDev) return true

  const authHeader = request.headers.get("authorization") ?? request.headers.get("Authorization")
  const bearer = typeof authHeader === "string" ? authHeader.trim() : ""
  const legacyHeader = request.headers.get("x-cron-secret")
  const isVercelCron = request.headers.get("x-vercel-cron") === "1"

  const secretOk =
    (!!CRON_SECRET && bearer === `Bearer ${CRON_SECRET}`) ||
    (!!CRON_SECRET && legacyHeader === CRON_SECRET)

  if (CRON_SECRET) return secretOk
  return isVercelCron
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

function isPastDue(dateIso: string | null) {
  if (!dateIso) return false
  const due = new Date(dateIso)
  if (Number.isNaN(due.getTime())) return false
  due.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return due < today
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

async function resolveLocalInvoiceIdByQboId(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  qboInvoiceId: string,
) {
  const { data: invoiceSync } = await supabase
    .from("qbo_sync_records")
    .select("entity_id")
    .eq("org_id", orgId)
    .eq("entity_type", "invoice")
    .eq("qbo_id", qboInvoiceId)
    .maybeSingle()

  if (invoiceSync?.entity_id) return invoiceSync.entity_id as string

  const { data: invoiceRow } = await supabase
    .from("invoices")
    .select("id")
    .eq("org_id", orgId)
    .eq("qbo_id", qboInvoiceId)
    .maybeSingle()

  return (invoiceRow?.id as string | undefined) ?? null
}

async function upsertInvoiceSyncRecord(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  connectionId: string
  invoiceId: string
  qboInvoiceId: string
  qboSyncToken?: string | null
}) {
  const nowIso = new Date().toISOString()

  await params.supabase.from("qbo_sync_records").upsert(
    {
      org_id: params.orgId,
      connection_id: params.connectionId,
      entity_type: "invoice",
      entity_id: params.invoiceId,
      qbo_id: params.qboInvoiceId,
      qbo_sync_token: params.qboSyncToken ?? null,
      last_synced_at: nowIso,
      status: "synced",
      error_message: null,
    },
    { onConflict: "org_id,entity_type,entity_id" },
  )
}

async function reconcileInvoiceFromQbo(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  client: QBOClient
  orgId: string
  connectionId: string
  qboInvoiceId: string
  operation?: string | null
}) {
  const nowIso = new Date().toISOString()
  const invoiceId = await resolveLocalInvoiceIdByQboId(params.supabase, params.orgId, params.qboInvoiceId)
  if (!invoiceId) {
    return { reconciled: false as const, reason: "No local invoice mapping" }
  }

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

  const { error: updateError } = await params.supabase
    .from("invoices")
    .update(invoiceUpdate)
    .eq("org_id", params.orgId)
    .eq("id", invoiceId)

  if (updateError) {
    return { reconciled: false as const, reason: updateError.message }
  }

  if (nextLines.length > 0) {
    const { error: deleteError } = await params.supabase
      .from("invoice_lines")
      .delete()
      .eq("org_id", params.orgId)
      .eq("invoice_id", invoiceId)

    if (deleteError) {
      return { reconciled: false as const, reason: deleteError.message }
    }

    const { error: insertError } = await params.supabase.from("invoice_lines").insert(
      nextLines.map((line) => ({
        org_id: params.orgId,
        invoice_id: invoiceId,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unit_price_cents: line.unit_price_cents,
        metadata: line.metadata,
      })),
    )

    if (insertError) {
      return { reconciled: false as const, reason: insertError.message }
    }
  }

  if (typeof qboInvoice.DocNumber === "string" && qboInvoice.DocNumber.trim().length > 0) {
    await rememberQBOInvoiceNumberCursor(params.orgId, qboInvoice.DocNumber.trim())
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

async function resolveLocalExpenseIdByQboId(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  qboId: string,
) {
  const { data: sync } = await supabase
    .from("qbo_sync_records")
    .select("entity_id")
    .eq("org_id", orgId)
    .eq("entity_type", "project_expense")
    .eq("qbo_id", qboId)
    .maybeSingle()

  if (sync?.entity_id) return sync.entity_id as string

  const { data: expense } = await supabase
    .from("project_expenses")
    .select("id")
    .eq("org_id", orgId)
    .eq("qbo_id", qboId)
    .maybeSingle()

  return (expense?.id as string | undefined) ?? null
}

async function reconcileProjectExpenseFromQbo(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  client: QBOClient
  orgId: string
  connectionId: string
  qboId: string
  entityName: "purchase" | "bill"
  operation?: string | null
}) {
  const expenseId = await resolveLocalExpenseIdByQboId(params.supabase, params.orgId, params.qboId)
  if (!expenseId) {
    return { reconciled: false as const, reason: "No local expense mapping" }
  }
  const { data: localExpense } = await params.supabase
    .from("project_expenses")
    .select("amount_cents, tax_cents, status")
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

  const firstAccountLine = (qboTxn.Line ?? []).find((line: any) => line?.AccountBasedExpenseLineDetail?.AccountRef)
  const accountRef = firstAccountLine?.AccountBasedExpenseLineDetail?.AccountRef
  const vendorRef = qboTxn.VendorRef ?? qboTxn.EntityRef
  const totalCents = toCents(qboTxn.TotalAmt)
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

  await params.supabase.from("qbo_sync_records").upsert(
    {
      org_id: params.orgId,
      connection_id: params.connectionId,
      entity_type: "project_expense",
      entity_id: expenseId,
      qbo_id: params.qboId,
      qbo_sync_token: qboTxn.SyncToken ?? null,
      last_synced_at: nowIso,
      status: "synced",
      error_message: null,
    },
    { onConflict: "org_id,entity_type,entity_id" },
  )

  return { reconciled: true as const }
}

async function resolveLocalVendorBillIdByQboId(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  qboId: string,
) {
  const { data: sync } = await supabase
    .from("qbo_sync_records")
    .select("entity_id")
    .eq("org_id", orgId)
    .eq("entity_type", "vendor_bill")
    .eq("qbo_id", qboId)
    .maybeSingle()

  if (sync?.entity_id) return sync.entity_id as string

  const { data: bill } = await supabase
    .from("vendor_bills")
    .select("id")
    .eq("org_id", orgId)
    .eq("qbo_id", qboId)
    .maybeSingle()

  return (bill?.id as string | undefined) ?? null
}

async function reconcileVendorBillFromQbo(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  client: QBOClient
  orgId: string
  connectionId: string
  qboId: string
  operation?: string | null
}) {
  const billId = await resolveLocalVendorBillIdByQboId(params.supabase, params.orgId, params.qboId)
  if (!billId) {
    return { reconciled: false as const, reason: "No local vendor bill mapping" }
  }

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

  await params.supabase.from("qbo_sync_records").upsert(
    {
      org_id: params.orgId,
      connection_id: params.connectionId,
      entity_type: "vendor_bill",
      entity_id: billId,
      qbo_id: params.qboId,
      qbo_sync_token: qboBill.SyncToken ?? null,
      last_synced_at: nowIso,
      status: "synced",
      error_message: null,
    },
    { onConflict: "org_id,entity_type,entity_id" },
  )

  return { reconciled: true as const }
}

async function reconcileBillPaymentFromQbo(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  client: QBOClient
  orgId: string
  connectionId: string
  qboBillPaymentId: string
  operation?: string | null
}) {
  const normalizedOp = String(params.operation ?? "").toLowerCase()
  if (normalizedOp === "delete") {
    await params.supabase
      .from("qbo_sync_records")
      .update({
        status: "conflict",
        error_message: "The linked QuickBooks bill payment was deleted.",
        last_synced_at: new Date().toISOString(),
      })
      .eq("org_id", params.orgId)
      .eq("entity_type", "bill_payment")
      .eq("qbo_id", params.qboBillPaymentId)
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

  let updated = 0
  for (const qboBillId of linkedBillIds) {
    const { data: bill } = await params.supabase
      .from("vendor_bills")
      .select("id, total_cents, paid_cents")
      .eq("org_id", params.orgId)
      .eq("qbo_id", qboBillId)
      .maybeSingle()
    if (!bill?.id) continue

    const paymentCents = toCents(billPayment.TotalAmt) ?? 0
    const currentPaid = Number((bill as any).paid_cents ?? 0)
    const totalCents = Number((bill as any).total_cents ?? 0)
    const nextPaid = Math.min(totalCents || currentPaid + paymentCents, Math.max(currentPaid, paymentCents))
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

  await params.supabase.from("qbo_sync_records").upsert(
    {
      org_id: params.orgId,
      connection_id: params.connectionId,
      entity_type: "bill_payment",
      entity_id: randomUUID(),
      qbo_id: params.qboBillPaymentId,
      qbo_sync_token: billPayment.SyncToken ?? null,
      last_synced_at: new Date().toISOString(),
      status: "synced",
      error_message: null,
      metadata: { source: "qbo_inbound" },
    },
    { onConflict: "org_id,entity_type,entity_id" },
  )

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

export async function POST(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceSupabaseClient()
  const { data: events, error } = await supabase
    .from("qbo_webhook_events")
    .select("id, event_id, realm_id, entity_name, entity_qbo_id, operation")
    .eq("process_status", "pending")
    .order("received_at", { ascending: true })
    .limit(BATCH_SIZE)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (events ?? []) as WebhookEventRow[]
  if (rows.length === 0) {
    return NextResponse.json({ processed: 0, reconciled: 0 })
  }

  let reconciled = 0
  let processed = 0
  const clientsByOrgId = new Map<string, QBOClient | null>()

  for (const row of rows) {
    try {
      const { data: claimed } = await supabase
        .from("qbo_webhook_events")
        .update({
          process_status: "processing",
          process_error: null,
        })
        .eq("id", row.id)
        .eq("process_status", "pending")
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
        .from("qbo_connections")
        .select("id, org_id")
        .eq("realm_id", row.realm_id)
        .eq("status", "active")
        .maybeSingle()

      const typedConnection = connection as ActiveConnection | null
      if (!typedConnection?.org_id || !typedConnection?.id) {
        await markEventProcessed(supabase, row.id, "ignored", "No active org connection for realm")
        processed += 1
        continue
      }

      const entityName = row.entity_name.toLowerCase()
      const orgId = typedConnection.org_id
      let client = clientsByOrgId.get(orgId)
      if (client === undefined) {
        client = await QBOClientFactory.forOrg(orgId)
        clientsByOrgId.set(orgId, client)
      }

      if (!client) {
        await markEventProcessed(supabase, row.id, "error", "Unable to initialize QBO client")
        processed += 1
        continue
      }

      if (entityName === "invoice") {
        const result = await reconcileInvoiceFromQbo({
          supabase,
          client,
          orgId,
          connectionId: typedConnection.id,
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
            .from("qbo_sync_records")
            .select("entity_id")
            .eq("org_id", orgId)
            .eq("entity_type", "payment")
            .eq("qbo_id", row.entity_qbo_id)
            .maybeSingle()

          if (paymentSync?.entity_id) {
            const { data: paymentRow } = await supabase
              .from("payments")
              .select("invoice:invoices(qbo_id)")
              .eq("org_id", orgId)
              .eq("id", paymentSync.entity_id)
              .maybeSingle()
            const invoice = Array.isArray((paymentRow as any)?.invoice)
              ? (paymentRow as any).invoice[0]
              : (paymentRow as any)?.invoice
            if (typeof invoice?.qbo_id === "string" && invoice.qbo_id.length > 0) {
              linkedInvoiceQboIds = [invoice.qbo_id]
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
            connectionId: typedConnection.id,
            qboInvoiceId: invoiceQboId,
          })
          if (result.reconciled) reconciledInvoices += 1
        }

        await supabase
          .from("qbo_sync_records")
          .update({
            status: "synced",
            error_message: null,
            last_synced_at: new Date().toISOString(),
          })
          .eq("org_id", orgId)
          .eq("entity_type", "payment")
          .eq("qbo_id", row.entity_qbo_id)

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
                connectionId: typedConnection.id,
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
              connectionId: typedConnection.id,
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
          connectionId: typedConnection.id,
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
    } catch (eventError: any) {
      await markEventProcessed(supabase, row.id, "error", eventError?.message ?? "Webhook processing failed")
      processed += 1
    }
  }

  logQBO("info", "process_webhooks_complete", { processed, reconciled })
  return NextResponse.json({ processed, reconciled })
}

async function markEventProcessed(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  eventId: string,
  status: "reconciled" | "ignored" | "error",
  error?: string,
) {
  await supabase
    .from("qbo_webhook_events")
    .update({
      process_status: status,
      process_error: error ?? null,
      processed_at: new Date().toISOString(),
    })
    .eq("id", eventId)
}

export const runtime = "nodejs"
