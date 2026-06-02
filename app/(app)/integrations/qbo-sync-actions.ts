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

export type QboSyncEntityType = "invoice" | "expense" | "bill" | "payment" | "bill_payment"

export type QboSyncItem = {
  id: string
  entityType: QboSyncEntityType
  projectId: string | null
  label: string
  sublabel: string | null
  amountCents: number
  status: "pending" | "error"
  error: string | null
  qboId: string | null
  lastAttemptAt: string | null
  date: string | null
}

export type QboSyncQueue = {
  connected: boolean
  items: QboSyncItem[]
}

function mapStatus(value?: string | null): "pending" | "error" {
  return value === "error" ? "error" : "pending"
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
    supabase.from("qbo_connections").select("id").eq("org_id", orgId).eq("status", "active").maybeSingle(),
    supabase.from("projects").select("id, name").eq("org_id", orgId),
  ])
  const connected = Boolean(connection)
  const projectName = new Map<string, string>(
    ((projectRows ?? []) as any[]).map((row) => [row.id as string, row.name as string]),
  )

  const [invoicesAll, expensesRes, billsRes, paymentRecordsRes] = await Promise.all([
    listInvoices({ orgId }),
    supabase
      .from("project_expenses")
      .select(
        "id, project_id, description, vendor_name_text, expense_date, amount_cents, tax_cents, qbo_sync_status, qbo_sync_error, vendor_company:companies(name)",
      )
      .eq("org_id", orgId)
      .in("qbo_sync_status", ["pending", "error"])
      .order("expense_date", { ascending: false }),
    supabase
      .from("vendor_bills")
      .select(
        "id, project_id, bill_number, bill_date, total_cents, qbo_sync_status, qbo_sync_error, commitment:commitments(title, company:companies(name))",
      )
      .eq("org_id", orgId)
      .in("qbo_sync_status", ["pending", "error"])
      .order("bill_date", { ascending: false }),
    supabase
      .from("qbo_sync_records")
      .select("entity_id, entity_type, status, error_message, qbo_id, last_synced_at, created_at")
      .eq("org_id", orgId)
      .in("entity_type", ["payment", "bill_payment"])
      .in("status", ["pending", "error"]),
  ])

  const invoices = invoicesAll.filter(
    (invoice) =>
      (invoice.qbo_sync_status === "pending" || invoice.qbo_sync_status === "error") &&
      (!projectId || invoice.project_id === projectId),
  )
  const expenses = ((expensesRes.data ?? []) as any[]).filter((expense) => !projectId || expense.project_id === projectId)
  const bills = ((billsRes.data ?? []) as any[]).filter((bill) => !projectId || bill.project_id === projectId)
  const paymentRecords = (paymentRecordsRes.data ?? []) as any[]

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
  }
}

/** Push every pending/failed item now. Returns a summary; never throws on individual failures. */
export async function syncAllQboPendingAction(params?: { projectId?: string | null }): Promise<{ synced: number; failed: number }> {
  const { orgId } = await requireOrgContext()
  const { items } = await listQboSyncQueueAction({ projectId: params?.projectId })

  let synced = 0
  let failed = 0
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
      }
      synced += 1
    } catch {
      failed += 1
    }
  }
  return { synced, failed }
}
