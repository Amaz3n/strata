"use server"

import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { listInvoices } from "@/lib/services/invoices"
import {
  forceSyncInvoiceToQBO,
  syncBillPaymentToQBO,
  syncPaymentToQBO,
  syncProjectExpenseToQBO,
  syncVendorBillToQBO,
} from "@/lib/services/qbo-sync"

export type QboSyncEntityType = "invoice" | "expense" | "bill" | "payment" | "bill_payment" | "webhook_event"

export type QboSyncItem = {
  id: string
  entityType: QboSyncEntityType
  projectId: string | null
  label: string
  sublabel: string | null
  amountCents: number
  status: "pending" | "error" | "needs_review"
  error: string | null
  qboId: string | null
  lastAttemptAt: string | null
  date: string | null
}

export type QboSyncQueue = {
  connected: boolean
  items: QboSyncItem[]
}

export type QboSyncHistoryItem = {
  id: string
  entityType: string
  entityId: string
  projectId: string | null
  label: string
  status: string
  direction: string
  qboId: string | null
  error: string | null
  syncedAt: string | null
}

function mapStatus(value?: string | null): "pending" | "error" | "needs_review" {
  if (value === "error") return "error"
  if (value === "needs_review") return "needs_review"
  return "pending"
}

/**
 * Everything currently waiting to reach QuickBooks (pending) or that failed (error), across every
 * entity type. Invoices/expenses/bills carry their own qbo_sync_status; payments live only in the
 * shared qbo_sync_records ledger. Org-scoped on every query (service client bypasses RLS).
 */
export async function listQboSyncQueueAction(params?: { projectId?: string | null }): Promise<QboSyncQueue> {
  const { orgId } = await requireOrgContext()
  const supabase = createServiceSupabaseClient()
  const projectId = params?.projectId ?? null

  const [{ data: connection }, { data: projectRows }] = await Promise.all([
    supabase.from("qbo_connections").select("id, realm_id").eq("org_id", orgId).eq("status", "active").maybeSingle(),
    supabase.from("projects").select("id, name").eq("org_id", orgId),
  ])
  const connected = Boolean(connection)
  const projectName = new Map<string, string>(
    ((projectRows ?? []) as any[]).map((row) => [row.id as string, row.name as string]),
  )

  const [invoicesAll, expensesRes, billsRes, paymentRecordsRes, webhookEventsRes] = await Promise.all([
    listInvoices({ orgId }),
    supabase
      .from("project_expenses")
      .select(
        "id, project_id, description, vendor_name_text, expense_date, amount_cents, tax_cents, qbo_sync_status, qbo_sync_error, vendor_company:companies(name)",
      )
      .eq("org_id", orgId)
      .in("qbo_sync_status", ["pending", "error", "needs_review"])
      .order("expense_date", { ascending: false }),
    supabase
      .from("vendor_bills")
      .select(
        "id, project_id, bill_number, bill_date, total_cents, qbo_sync_status, qbo_sync_error, commitment:commitments(title, company:companies(name))",
      )
      .eq("org_id", orgId)
      .in("qbo_sync_status", ["pending", "error", "needs_review"])
      .order("bill_date", { ascending: false }),
    supabase
      .from("qbo_sync_records")
      .select("entity_id, entity_type, status, error_message, qbo_id, last_synced_at, created_at")
      .eq("org_id", orgId)
      .in("entity_type", ["payment", "bill_payment"])
      .in("status", ["pending", "error", "needs_review"]),
    supabase
      .from("qbo_webhook_events")
      .select("id, entity_name, entity_qbo_id, operation, process_error, attempts, received_at, processed_at")
      .eq("realm_id", typeof connection?.realm_id === "string" ? connection.realm_id : "")
      .eq("process_status", "error")
      .order("received_at", { ascending: false })
      .limit(25),
  ])

  const invoices = invoicesAll.filter(
    (invoice) =>
      (invoice.qbo_sync_status === "pending" || invoice.qbo_sync_status === "error" || invoice.qbo_sync_status === "needs_review") &&
      (!projectId || invoice.project_id === projectId),
  )
  const expenses = ((expensesRes.data ?? []) as any[]).filter((expense) => !projectId || expense.project_id === projectId)
  const bills = ((billsRes.data ?? []) as any[]).filter((bill) => !projectId || bill.project_id === projectId)
  const paymentRecords = (paymentRecordsRes.data ?? []) as any[]
  const deadLetterEvents = projectId ? [] : ((webhookEventsRes.data ?? []) as any[])

  // Latest sync record per entity (for qbo id / last attempt / error) on invoices, expenses, bills.
  const recordLookup = new Map<string, { qboId: string | null; lastAttemptAt: string | null; error: string | null }>()
  const idsByType: Record<string, string[]> = {
    invoice: invoices.map((i) => i.id),
    project_expense: expenses.map((e) => e.id as string),
    bill: bills.map((b) => b.id as string),
  }
  await Promise.all(
    Object.entries(idsByType).map(async ([entityType, ids]) => {
      if (ids.length === 0) return
      const { data } = await supabase
        .from("qbo_sync_records")
        .select("entity_id, qbo_id, last_synced_at, created_at, error_message")
        .eq("org_id", orgId)
        .eq("entity_type", entityType)
        .in("entity_id", ids)
        .order("last_synced_at", { ascending: false })
      for (const record of data ?? []) {
        const key = `${entityType}:${record.entity_id}`
        if (recordLookup.has(key)) continue
        recordLookup.set(key, {
          qboId: record.qbo_id ?? null,
          lastAttemptAt: (record.last_synced_at ?? record.created_at) as string | null,
          error: record.error_message ?? null,
        })
      }
    }),
  )

  const items: QboSyncItem[] = []

  for (const invoice of invoices) {
    const record = recordLookup.get(`invoice:${invoice.id}`)
    items.push({
      id: invoice.id,
      entityType: "invoice",
      projectId: invoice.project_id ?? null,
      label: invoice.invoice_number || invoice.title || "Invoice",
      sublabel: invoice.project_id ? projectName.get(invoice.project_id) ?? null : null,
      amountCents: invoice.total_cents ?? invoice.totals?.total_cents ?? 0,
      status: mapStatus(invoice.qbo_sync_status),
      error: record?.error ?? null,
      qboId: record?.qboId ?? null,
      lastAttemptAt: record?.lastAttemptAt ?? null,
      date: invoice.issue_date ?? null,
    })
  }

  for (const expense of expenses) {
    const record = recordLookup.get(`project_expense:${expense.id}`)
    const vendor = (expense.vendor_company as { name?: string } | null)?.name ?? expense.vendor_name_text ?? null
    items.push({
      id: expense.id as string,
      entityType: "expense",
      projectId: (expense.project_id as string | null) ?? null,
      label: (expense.description as string)?.trim() || vendor || "Expense",
      sublabel: vendor ?? (expense.project_id ? projectName.get(expense.project_id as string) ?? null : null),
      amountCents: Number(expense.amount_cents ?? 0) + Number(expense.tax_cents ?? 0),
      status: mapStatus(expense.qbo_sync_status as string),
      error: (expense.qbo_sync_error as string | null) ?? record?.error ?? null,
      qboId: record?.qboId ?? null,
      lastAttemptAt: record?.lastAttemptAt ?? null,
      date: (expense.expense_date as string) ?? null,
    })
  }

  for (const bill of bills) {
    const record = recordLookup.get(`bill:${bill.id}`)
    const commitment = bill.commitment as { title?: string; company?: { name?: string } } | null
    items.push({
      id: bill.id as string,
      entityType: "bill",
      projectId: (bill.project_id as string | null) ?? null,
      label: bill.bill_number ? `Bill ${bill.bill_number}` : commitment?.title || "Vendor bill",
      sublabel: commitment?.company?.name ?? (bill.project_id ? projectName.get(bill.project_id as string) ?? null : null),
      amountCents: Number(bill.total_cents ?? 0),
      status: mapStatus(bill.qbo_sync_status as string),
      error: (bill.qbo_sync_error as string | null) ?? record?.error ?? null,
      qboId: record?.qboId ?? null,
      lastAttemptAt: record?.lastAttemptAt ?? null,
      date: (bill.bill_date as string) ?? null,
    })
  }

  // Payments and bill payments — sourced from the sync ledger, enriched from the payments table.
  if (paymentRecords.length > 0) {
    const paymentIds = paymentRecords.map((record) => record.entity_id as string).filter(Boolean)
    const { data: paymentRows } = await supabase
      .from("payments")
      .select(
        "id, amount_cents, received_at, created_at, invoice:invoices(invoice_number, title, project_id), bill:vendor_bills(bill_number, project_id)",
      )
      .eq("org_id", orgId)
      .in("id", paymentIds)
    const paymentById = new Map<string, any>((paymentRows ?? []).map((row) => [row.id as string, row]))

    for (const record of paymentRecords) {
      const payment = paymentById.get(record.entity_id as string)
      const isBillPayment = record.entity_type === "bill_payment"
      const paymentProjectId = (isBillPayment ? payment?.bill?.project_id : payment?.invoice?.project_id) ?? null
      if (projectId && paymentProjectId !== projectId) continue
      const reference = isBillPayment
        ? payment?.bill?.bill_number
          ? `Bill ${payment.bill.bill_number}`
          : "vendor bill"
        : payment?.invoice?.invoice_number || payment?.invoice?.title || "invoice"
      items.push({
        id: record.entity_id as string,
        entityType: isBillPayment ? "bill_payment" : "payment",
        projectId: paymentProjectId,
        label: `Payment · ${reference}`,
        sublabel: null,
        amountCents: Number(payment?.amount_cents ?? 0),
        status: mapStatus(record.status as string),
        error: record.error_message ?? null,
        qboId: record.qbo_id ?? null,
        lastAttemptAt: (record.last_synced_at ?? record.created_at) as string | null,
        date: (payment?.received_at ?? payment?.created_at) as string | null,
      })
    }
  }

  for (const event of deadLetterEvents) {
    items.push({
      id: event.id as string,
      entityType: "webhook_event",
      projectId: null,
      label: `${String(event.entity_name ?? "Webhook")} ${String(event.entity_qbo_id ?? "")}`.trim(),
      sublabel: String(event.operation ?? "inbound"),
      amountCents: 0,
      status: "error",
      error: (event.process_error as string | null) ?? "Webhook processing failed",
      qboId: (event.entity_qbo_id as string | null) ?? null,
      lastAttemptAt: ((event.processed_at ?? event.received_at) as string | null) ?? null,
      date: (event.received_at as string | null) ?? null,
    })
  }

  return { connected, items }
}

/** Push a single item to QuickBooks immediately. Throws on failure so the UI can surface it. */
export async function syncQboItemAction(entityType: QboSyncEntityType, id: string) {
  const { orgId } = await requireOrgContext()
  switch (entityType) {
    case "invoice":
      await forceSyncInvoiceToQBO(id, orgId)
      return
    case "expense":
      await syncProjectExpenseToQBO(id, orgId)
      return
    case "bill":
      await syncVendorBillToQBO(id, orgId)
      return
    case "payment":
      await syncPaymentToQBO(id, orgId)
      return
    case "bill_payment":
      await syncBillPaymentToQBO(id, orgId)
      return
    case "webhook_event":
      {
        const result = await retryQboWebhookEventAction(id)
        if (!result.success) throw new Error(result.error ?? "Unable to retry webhook event")
      }
      return
  }
}

/** Push every pending/failed item now. Returns a summary; never throws on individual failures. */
export async function syncAllQboPendingAction(params?: { projectId?: string | null }): Promise<{ synced: number; failed: number; errors: string[] }> {
  const { orgId } = await requireOrgContext()
  const { items } = await listQboSyncQueueAction({ projectId: params?.projectId })

  let synced = 0
  let failed = 0
  const errors: string[] = []
  for (const item of items) {
    try {
      switch (item.entityType) {
        case "invoice":
          await forceSyncInvoiceToQBO(item.id, orgId)
          break
        case "expense":
          await syncProjectExpenseToQBO(item.id, orgId)
          break
        case "bill":
          await syncVendorBillToQBO(item.id, orgId)
          break
        case "payment":
          await syncPaymentToQBO(item.id, orgId)
          break
        case "bill_payment":
          await syncBillPaymentToQBO(item.id, orgId)
          break
        case "webhook_event":
          {
            const result = await retryQboWebhookEventAction(item.id)
            if (!result.success) throw new Error(result.error ?? "Unable to retry webhook event")
          }
          break
      }
      synced += 1
    } catch (error) {
      failed += 1
      errors.push(`${item.label}: ${error instanceof Error ? error.message : "Sync failed"}`)
    }
  }
  return { synced, failed, errors }
}

export async function retryQboWebhookEventAction(id: string): Promise<{ success: boolean; error: string | null }> {
  await requireOrgContext()
  const supabase = createServiceSupabaseClient()
  const { error } = await supabase
    .from("qbo_webhook_events")
    .update({
      process_status: "pending",
      process_error: null,
      attempts: 0,
      next_attempt_at: null,
      processed_at: null,
    })
    .eq("id", id)
    .eq("process_status", "error")

  if (error) return { success: false, error: error.message }
  return { success: true, error: null }
}

export async function listQboSyncHistoryAction(params?: { projectId?: string | null; limit?: number }): Promise<QboSyncHistoryItem[]> {
  const { orgId } = await requireOrgContext()
  const supabase = createServiceSupabaseClient()
  const projectId = params?.projectId ?? null
  const limit = params?.limit ?? 50

  const { data: records } = await supabase
    .from("qbo_sync_records")
    .select("id, entity_type, entity_id, qbo_id, last_synced_at, sync_direction, status, error_message, created_at")
    .eq("org_id", orgId)
    .order("last_synced_at", { ascending: false })
    .limit(limit)

  const rows = (records ?? []) as any[]
  if (rows.length === 0) return []

  const idsByType = rows.reduce<Record<string, string[]>>((acc, row) => {
    const key = String(row.entity_type ?? "")
    if (!acc[key]) acc[key] = []
    acc[key].push(String(row.entity_id))
    return acc
  }, {})

  const [invoiceRows, expenseRows, billRows, paymentRows] = await Promise.all([
    idsByType.invoice?.length
      ? supabase.from("invoices").select("id, project_id, invoice_number, title").eq("org_id", orgId).in("id", idsByType.invoice)
      : Promise.resolve({ data: [] as any[] }),
    idsByType.project_expense?.length
      ? supabase.from("project_expenses").select("id, project_id, description, vendor_name_text").eq("org_id", orgId).in("id", idsByType.project_expense)
      : Promise.resolve({ data: [] as any[] }),
    idsByType.bill?.length
      ? supabase.from("vendor_bills").select("id, project_id, bill_number").eq("org_id", orgId).in("id", idsByType.bill)
      : Promise.resolve({ data: [] as any[] }),
    idsByType.payment?.length || idsByType.bill_payment?.length
      ? supabase
          .from("payments")
          .select("id, project_id, amount_cents")
          .eq("org_id", orgId)
          .in("id", [...(idsByType.payment ?? []), ...(idsByType.bill_payment ?? [])])
      : Promise.resolve({ data: [] as any[] }),
  ])

  const invoiceById = new Map((invoiceRows.data ?? []).map((row: any) => [row.id, row]))
  const expenseById = new Map((expenseRows.data ?? []).map((row: any) => [row.id, row]))
  const billById = new Map((billRows.data ?? []).map((row: any) => [row.id, row]))
  const paymentById = new Map((paymentRows.data ?? []).map((row: any) => [row.id, row]))

  return rows
    .map((row): QboSyncHistoryItem => {
      const entityType = String(row.entity_type ?? "")
      const entityId = String(row.entity_id)
      const invoice = invoiceById.get(entityId)
      const expense = expenseById.get(entityId)
      const bill = billById.get(entityId)
      const payment = paymentById.get(entityId)
      const projectIdForRow = invoice?.project_id ?? expense?.project_id ?? bill?.project_id ?? payment?.project_id ?? null
      const label =
        invoice?.invoice_number ??
        invoice?.title ??
        expense?.description ??
        expense?.vendor_name_text ??
        (bill?.bill_number ? `Bill ${bill.bill_number}` : null) ??
        (payment ? "Payment" : null) ??
        entityType.replaceAll("_", " ")

      return {
        id: row.id,
        entityType,
        entityId,
        projectId: projectIdForRow,
        label,
        status: row.status ?? "synced",
        direction: row.sync_direction ?? "outbound",
        qboId: row.qbo_id ?? null,
        error: row.error_message ?? null,
        syncedAt: row.last_synced_at ?? row.created_at ?? null,
      }
    })
    .filter((item) => !projectId || item.projectId === projectId)
}
