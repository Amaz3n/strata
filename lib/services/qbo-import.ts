import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { QBOClient } from "@/lib/integrations/accounting/qbo-api"
import { recordEvent } from "@/lib/services/events"
import { recalcInvoiceBalanceAndStatus } from "@/lib/services/invoice-balance"
import { logQBO } from "@/lib/services/qbo-logger"

/**
 * QBO → Arc historical / drift import.
 *
 * The normal sync only *reconciles* QBO records that already have a local mapping; it never creates
 * Arc records for transactions that originated in QuickBooks (historical jobs, or anything a user
 * mistakenly created directly in QBO after going live). This module backfills that gap: it lists
 * QBO transactions that have no Arc counterpart, and creates them on demand, pre-linked as already
 * synced so the existing two-way sync adopts them and never re-pushes a duplicate.
 */

// Arc-facing entity classification for an importable QBO transaction.
export type QboImportEntityType = "invoice" | "expense" | "bill" | "payment" | "bill_payment" | "journal_entry"

// QBO transaction entity name → Arc entity classification.
const QBO_ENTITY_BY_TYPE: Record<QboImportEntityType, "Invoice" | "Purchase" | "Bill" | "Payment" | "BillPayment" | "JournalEntry"> = {
  invoice: "Invoice",
  expense: "Purchase",
  bill: "Bill",
  payment: "Payment",
  bill_payment: "BillPayment",
  journal_entry: "JournalEntry",
}

export type QboImportRecord = {
  qboId: string
  entityType: QboImportEntityType
  /** DocNumber / reference shown to the user. */
  docNumber: string | null
  /** Customer (invoice/payment) or vendor (bill/purchase/bill payment) display name. */
  counterparty: string | null
  date: string | null
  amountCents: number
  /** Open balance, when QBO exposes one (invoices). */
  balanceCents: number | null
  /** True when QBO links this transaction to others we can resolve (used for payments). */
  hasLinks: boolean
  linkedEntityType?: "invoice" | "bill"
  linkedQboIds?: string[]
  dependencyStatus?: "already_in_arc" | "available_to_import" | "missing" | null
  dependencyMessage?: string | null
  possibleMatch?: string | null
  /**
   * The QBO customer/project this record is associated with — header CustomerRef for invoices/
   * payments, the first cost line's customer for bills/expenses/journal entries. Drives the
   * "filter import by QBO project" picker. Multi-project transactions surface their first line.
   */
  qboCustomerId?: string | null
  qboCustomerName?: string | null
}

export type QboImportListing = {
  connected: boolean
  records: QboImportRecord[]
}

export type QboImportResult = {
  imported: number
  skipped: number
  failed: number
  errors: { qboId: string; entityType: QboImportEntityType; message: string }[]
}

function toCents(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 100)
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.round(parsed * 100)
  }
  return 0
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().split("T")[0]
}

function refName(ref: { name?: string; value?: string } | null | undefined): string | null {
  if (!ref) return null
  return ref.name ?? null
}

/**
 * Map a QBO `Purchase.PaymentType` ("Cash" | "Check" | "CreditCard") to an Arc `payment_method`
 * that satisfies the `project_expenses_payment_method_check` constraint. Anything unrecognized
 * falls back to "other"; an empty value stays null.
 */
function mapQboPaymentMethod(paymentType: unknown): string | null {
  if (paymentType == null || String(paymentType).trim() === "") return null
  switch (String(paymentType).toLowerCase()) {
    case "cash":
      return "cash"
    case "check":
      return "check"
    case "creditcard":
      return "credit_card"
    default:
      return "other"
  }
}

function refValue(ref: { value?: string } | null | undefined): string | null {
  if (!ref?.value) return null
  return String(ref.value)
}

/** The customer/project ref on the first expense line of a Bill/Purchase, if any (job-costing link). */
function firstLineCustomerRef(lines: any[] | undefined): { value?: string; name?: string } | null {
  for (const line of lines ?? []) {
    const ref = line?.AccountBasedExpenseLineDetail?.CustomerRef ?? line?.ItemBasedExpenseLineDetail?.CustomerRef
    if (ref?.value) return ref
  }
  return null
}

/** The customer/project ref on a journal-entry line (Entity of type Customer), if any. */
function jeLineCustomerRef(line: any): { value?: string; name?: string } | null {
  const entity = line?.JournalEntryLineDetail?.Entity
  return String(entity?.Type ?? "").toLowerCase() === "customer" ? (entity?.EntityRef ?? null) : null
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

function deriveInvoiceStatus(totalCents: number, balanceCents: number, dueDate: string | null) {
  if (totalCents > 0 && balanceCents <= 0) return "paid"
  if (totalCents > 0 && balanceCents > 0 && balanceCents < totalCents) return "partial"
  if (balanceCents > 0 && isPastDue(dueDate)) return "overdue"
  return "sent"
}

function extractLinkedInvoiceQboIds(payment: any): string[] {
  const ids = new Set<string>()
  for (const line of (payment?.Line ?? []) as any[]) {
    for (const linked of (line?.LinkedTxn ?? []) as any[]) {
      if (String(linked?.TxnType ?? "").toLowerCase() !== "invoice") continue
      if (linked?.TxnId) ids.add(String(linked.TxnId))
    }
  }
  return Array.from(ids)
}

function extractLinkedBillQboIds(billPayment: any): string[] {
  const ids = new Set<string>()
  for (const line of (billPayment?.Line ?? []) as any[]) {
    for (const linked of (line?.LinkedTxn ?? []) as any[]) {
      if (String(linked?.TxnType ?? "").toLowerCase() !== "bill") continue
      if (linked?.TxnId) ids.add(String(linked.TxnId))
    }
  }
  return Array.from(ids)
}

type ResolvedContext = {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  userId: string
}

/** The set of QBO ids already linked to an Arc record, per entity classification. */
async function collectLinkedQboIds(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
): Promise<Record<QboImportEntityType, Set<string>>> {
  const linked: Record<QboImportEntityType, Set<string>> = {
    invoice: new Set(),
    expense: new Set(),
    bill: new Set(),
    payment: new Set(),
    bill_payment: new Set(),
    // Journal-entry imports dedupe at the line level (see listImportableQboRecords), not by JE id,
    // so this set is intentionally left empty.
    journal_entry: new Set(),
  }

  const [invoiceRows, expenseRows, billRows, syncRows] = await Promise.all([
    supabase.from("invoices").select("qbo_id").eq("org_id", orgId).not("qbo_id", "is", null),
    // Exclude JE-derived expenses: their qbo_id is the JournalEntry id (shared across lines) and must
    // not shadow a real Purchase that happens to share that numeric id.
    supabase
      .from("project_expenses")
      .select("qbo_id")
      .eq("org_id", orgId)
      .not("qbo_id", "is", null)
      .or("qbo_transaction_type.is.null,qbo_transaction_type.neq.journal_entry"),
    supabase.from("vendor_bills").select("qbo_id").eq("org_id", orgId).not("qbo_id", "is", null),
    supabase
      .from("qbo_sync_records")
      .select("entity_type, qbo_id, metadata")
      .eq("org_id", orgId)
      .in("entity_type", ["invoice", "project_expense", "bill", "payment", "bill_payment"]),
  ])

  for (const row of invoiceRows.data ?? []) if (row.qbo_id) linked.invoice.add(String(row.qbo_id))
  for (const row of expenseRows.data ?? []) if (row.qbo_id) linked.expense.add(String(row.qbo_id))
  for (const row of billRows.data ?? []) if (row.qbo_id) linked.bill.add(String(row.qbo_id))
  for (const row of syncRows.data ?? []) {
    const qboId = row.qbo_id ? String(row.qbo_id) : null
    if (!qboId) continue
    switch (row.entity_type) {
      case "invoice":
        linked.invoice.add(qboId)
        break
      case "project_expense":
        if ((row.metadata as { source?: string } | null)?.source === "journal_entry") break
        linked.expense.add(qboId)
        break
      case "bill":
        linked.bill.add(qboId)
        break
      case "payment":
        linked.payment.add(qboId)
        break
      case "bill_payment":
        linked.bill_payment.add(qboId)
        break
    }
  }

  return linked
}

/**
 * List QBO transactions that have no Arc counterpart yet, so a user can choose which to import into
 * a project. `sinceDate` (YYYY-MM-DD) bounds how far back we look; omit for the QBO default window.
 */
export async function listImportableQboRecords({
  orgId,
  sinceDate,
  types,
}: {
  orgId?: string
  sinceDate?: string | null
  types?: QboImportEntityType[]
} = {}): Promise<QboImportListing> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "bill.read", userId, orgId: resolvedOrgId, supabase, logDecision: true })

  const client = await QBOClient.forOrg(resolvedOrgId)
  if (!client) return { connected: false, records: [] }

  const wanted = types && types.length > 0 ? types : (Object.keys(QBO_ENTITY_BY_TYPE) as QboImportEntityType[])

  const [linked, ...results] = await Promise.all([
    collectLinkedQboIds(supabase, resolvedOrgId),
    ...wanted.map((type) =>
      client
        .listTransactionsForImport(QBO_ENTITY_BY_TYPE[type], { sinceDate })
        .then((rows) => ({ type, rows }))
        .catch((error) => {
          logQBO("warn", "qbo_import_list_failed", {
            orgId: resolvedOrgId,
            entity: QBO_ENTITY_BY_TYPE[type],
            error: error?.message ?? String(error),
          })
          return { type, rows: [] as any[] }
        }),
    ),
  ])

  // Journal-entry support needs the org's expense/COGS account ids (to keep only cost lines) and the
  // set of JE lines already imported (line-level dedup, since one JE maps to many Arc expenses).
  let jeExpenseAccountIds = new Set<string>()
  const importedJeLines = new Set<string>()
  if (wanted.includes("journal_entry")) {
    const [accounts, jeExpenseRows] = await Promise.all([
      client.listExpenseAccounts().catch(() => [] as { id: string }[]),
      supabase
        .from("project_expenses")
        .select("qbo_id, metadata")
        .eq("org_id", resolvedOrgId)
        .eq("qbo_transaction_type", "journal_entry"),
    ])
    jeExpenseAccountIds = new Set(accounts.map((account) => account.id))
    for (const row of jeExpenseRows.data ?? []) {
      const lineId = (row.metadata as { qbo_je_line_id?: string } | null)?.qbo_je_line_id
      if (row.qbo_id && lineId != null) importedJeLines.add(`${row.qbo_id}:${lineId}`)
    }
  }

  const records: QboImportRecord[] = []

  for (const { type, rows } of results) {
    for (const row of rows) {
      const qboId = row?.Id ? String(row.Id) : null
      if (!qboId || linked[type].has(qboId)) continue

      if (type === "journal_entry") {
        // Only debit/credit lines hitting an expense/COGS account are real project costs; the
        // balancing cash/AP/equity lines are skipped. Credits to an expense account reverse cost.
        const costLines = ((row.Line ?? []) as any[]).filter(
          (line) =>
            line?.DetailType === "JournalEntryLineDetail" &&
            jeExpenseAccountIds.has(refValue(line.JournalEntryLineDetail?.AccountRef) ?? ""),
        )
        const remaining = costLines.filter((line) => !importedJeLines.has(`${qboId}:${line.Id}`))
        if (remaining.length === 0) continue
        const amountCents = remaining.reduce((sum, line) => {
          const isCredit = String(line.JournalEntryLineDetail?.PostingType ?? "").toLowerCase() === "credit"
          return sum + toCents(line.Amount) * (isCredit ? -1 : 1)
        }, 0)
        records.push({
          qboId,
          entityType: type,
          docNumber: row.DocNumber ? String(row.DocNumber) : null,
          counterparty: row.PrivateNote
            ? String(row.PrivateNote)
            : `${remaining.length} cost ${remaining.length === 1 ? "line" : "lines"}`,
          date: normalizeDate(row.TxnDate),
          amountCents,
          balanceCents: null,
          hasLinks: false,
          qboCustomerId: refValue(jeLineCustomerRef(remaining[0])),
          qboCustomerName: refName(jeLineCustomerRef(remaining[0])),
        })
      } else if (type === "invoice") {
        records.push({
          qboId,
          entityType: type,
          docNumber: row.DocNumber ? String(row.DocNumber) : null,
          counterparty: refName(row.CustomerRef),
          date: normalizeDate(row.TxnDate),
          amountCents: toCents(row.TotalAmt),
          balanceCents: toCents(row.Balance),
          hasLinks: false,
          qboCustomerId: refValue(row.CustomerRef),
          qboCustomerName: refName(row.CustomerRef),
        })
      } else if (type === "expense") {
        const vendor = refName(row.EntityRef) ?? refName(row.AccountRef)
        const lineCustomer = firstLineCustomerRef(row.Line)
        records.push({
          qboId,
          entityType: type,
          docNumber: row.DocNumber ? String(row.DocNumber) : (row.PaymentType ? String(row.PaymentType) : null),
          counterparty: vendor,
          date: normalizeDate(row.TxnDate),
          amountCents: toCents(row.TotalAmt),
          balanceCents: null,
          hasLinks: false,
          qboCustomerId: refValue(lineCustomer),
          qboCustomerName: refName(lineCustomer),
        })
      } else if (type === "bill") {
        const lineCustomer = firstLineCustomerRef(row.Line)
        records.push({
          qboId,
          entityType: type,
          docNumber: row.DocNumber ? String(row.DocNumber) : null,
          counterparty: refName(row.VendorRef),
          date: normalizeDate(row.TxnDate),
          amountCents: toCents(row.TotalAmt),
          balanceCents: toCents(row.Balance),
          hasLinks: false,
          qboCustomerId: refValue(lineCustomer),
          qboCustomerName: refName(lineCustomer),
        })
      } else if (type === "payment") {
        const linkedQboIds = extractLinkedInvoiceQboIds(row)
        records.push({
          qboId,
          entityType: type,
          docNumber: row.PaymentRefNum ? String(row.PaymentRefNum) : null,
          counterparty: refName(row.CustomerRef),
          date: normalizeDate(row.TxnDate),
          amountCents: toCents(row.TotalAmt),
          balanceCents: null,
          hasLinks: linkedQboIds.length > 0,
          linkedEntityType: "invoice",
          linkedQboIds,
          qboCustomerId: refValue(row.CustomerRef),
          qboCustomerName: refName(row.CustomerRef),
        })
      } else if (type === "bill_payment") {
        const linkedQboIds = extractLinkedBillQboIds(row)
        records.push({
          qboId,
          entityType: type,
          docNumber: row.DocNumber ? String(row.DocNumber) : null,
          counterparty: refName(row.VendorRef),
          date: normalizeDate(row.TxnDate),
          amountCents: toCents(row.TotalAmt),
          balanceCents: null,
          hasLinks: linkedQboIds.length > 0,
          linkedEntityType: "bill",
          linkedQboIds,
        })
      }
    }
  }

  const qboIdsByType = records.reduce<Record<QboImportEntityType, Set<string>>>(
    (acc, record) => {
      acc[record.entityType].add(record.qboId)
      return acc
    },
    {
      invoice: new Set(),
      expense: new Set(),
      bill: new Set(),
      payment: new Set(),
      bill_payment: new Set(),
      journal_entry: new Set(),
    },
  )

  for (const record of records) {
    if (record.entityType !== "payment" && record.entityType !== "bill_payment") continue
    const parentType = record.linkedEntityType
    const linkedIds = record.linkedQboIds ?? []
    if (!parentType || linkedIds.length === 0) {
      record.dependencyStatus = "missing"
      record.dependencyMessage = record.entityType === "payment"
        ? "This payment is not linked to a QBO invoice."
        : "This bill payment is not linked to a QBO bill."
      continue
    }

    const alreadyLinked = linkedIds.some((id) => linked[parentType].has(id))
    const availableToImport = linkedIds.some((id) => qboIdsByType[parentType].has(id))
    if (alreadyLinked) {
      record.dependencyStatus = "already_in_arc"
      record.dependencyMessage = parentType === "invoice" ? "Linked invoice is already in Arc." : "Linked bill is already in Arc."
    } else if (availableToImport) {
      record.dependencyStatus = "available_to_import"
      record.dependencyMessage = parentType === "invoice" ? "Linked invoice is available in this list." : "Linked bill is available in this list."
    } else {
      record.dependencyStatus = "missing"
      record.dependencyMessage = parentType === "invoice"
        ? "Import the linked invoice first."
        : "Import the linked bill first."
    }
  }

  const [invoiceCandidates, expenseCandidates, billCandidates] = await Promise.all([
    records.some((record) => record.entityType === "invoice")
      ? supabase
          .from("invoices")
          .select("invoice_number, title, total_cents, issue_date")
          .eq("org_id", resolvedOrgId)
          .is("qbo_id", null)
          .limit(500)
      : Promise.resolve({ data: [] as any[] }),
    records.some((record) => record.entityType === "expense")
      ? supabase
          .from("project_expenses")
          .select("description, vendor_name_text, amount_cents, expense_date")
          .eq("org_id", resolvedOrgId)
          .is("qbo_id", null)
          .limit(500)
      : Promise.resolve({ data: [] as any[] }),
    records.some((record) => record.entityType === "bill")
      ? supabase
          .from("vendor_bills")
          .select("bill_number, total_cents, bill_date")
          .eq("org_id", resolvedOrgId)
          .is("qbo_id", null)
          .limit(500)
      : Promise.resolve({ data: [] as any[] }),
  ])

  for (const record of records) {
    if (record.entityType === "invoice") {
      const match = (invoiceCandidates.data ?? []).find((invoice: any) =>
        (record.docNumber && invoice.invoice_number === record.docNumber) ||
        (Number(invoice.total_cents ?? 0) === record.amountCents && normalizeDate(invoice.issue_date) === record.date),
      )
      if (match) record.possibleMatch = match.invoice_number ? `Invoice #${match.invoice_number}` : match.title ?? "Existing invoice"
    } else if (record.entityType === "expense") {
      const match = (expenseCandidates.data ?? []).find((expense: any) =>
        Number(expense.amount_cents ?? 0) === record.amountCents &&
        normalizeDate(expense.expense_date) === record.date &&
        (!record.counterparty || !expense.vendor_name_text || String(expense.vendor_name_text).toLowerCase() === record.counterparty.toLowerCase()),
      )
      if (match) record.possibleMatch = match.description ?? match.vendor_name_text ?? "Existing expense"
    } else if (record.entityType === "bill") {
      const match = (billCandidates.data ?? []).find((bill: any) =>
        (record.docNumber && bill.bill_number === record.docNumber) ||
        (Number(bill.total_cents ?? 0) === record.amountCents && normalizeDate(bill.bill_date) === record.date),
      )
      if (match) record.possibleMatch = match.bill_number ? `Bill #${match.bill_number}` : "Existing bill"
    }
  }

  records.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
  return { connected: true, records }
}

// ---------------------------------------------------------------------------
// Import (create-from-QBO) helpers
// ---------------------------------------------------------------------------

async function getActiveConnectionId(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("qbo_connections")
    .select("id")
    .eq("org_id", orgId)
    .eq("status", "active")
    .maybeSingle()
  return (data?.id as string | undefined) ?? null
}

/** Write the inbound sync-record link so the existing two-way sync adopts the record. */
async function linkSyncRecord(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  connectionId: string
  entityType: string
  entityId: string
  qboId: string
  syncToken?: string | null
  /** False for inbound-only shadow records (e.g. journal-entry lines) the outbound sync must never push. */
  pushable?: boolean
  metadata?: Record<string, unknown>
}) {
  await params.supabase.from("qbo_sync_records").upsert(
    {
      org_id: params.orgId,
      connection_id: params.connectionId,
      entity_type: params.entityType,
      entity_id: params.entityId,
      qbo_id: params.qboId,
      qbo_sync_token: params.syncToken ?? null,
      last_synced_at: new Date().toISOString(),
      sync_direction: "inbound",
      status: "synced",
      error_message: null,
      pushable: params.pushable ?? true,
      metadata: params.metadata ?? {},
    },
    { onConflict: "org_id,entity_type,entity_id" },
  )
}

/** Clear any "ignored / unmatched" webhook events for this QBO id so it leaves the drift queue. */
async function markEventsResolved(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  qboId: string,
) {
  await supabase
    .from("qbo_webhook_events")
    .update({ process_status: "reconciled", process_error: null, processed_at: new Date().toISOString() })
    .eq("entity_qbo_id", qboId)
    .in("process_status", ["ignored", "pending", "error"])
}

async function importInvoice(ctx: ResolvedContext, client: QBOClient, connectionId: string, projectId: string, qboId: string) {
  const { supabase, orgId } = ctx

  const { data: existing } = await supabase
    .from("invoices")
    .select("id")
    .eq("org_id", orgId)
    .eq("qbo_id", qboId)
    .maybeSingle()
  if (existing?.id) return { skipped: true as const }

  const qbo = await client.getInvoiceById(qboId)
  if (!qbo) throw new Error("Invoice not found in QuickBooks")

  const totalCents = toCents(qbo.TotalAmt)
  const taxCents = toCents(qbo.TxnTaxDetail?.TotalTax ?? 0)
  const balanceCents = qbo.Balance != null ? toCents(qbo.Balance) : totalCents
  const subtotalCents = Math.max(totalCents - taxCents, 0)
  const issueDate = normalizeDate(qbo.TxnDate)
  const dueDate = normalizeDate(qbo.DueDate)
  const status = deriveInvoiceStatus(totalCents, balanceCents, dueDate)
  const nowIso = new Date().toISOString()

  const lines = (qbo.Line ?? [])
    .filter((line) => line && line.DetailType === "SalesItemLineDetail")
    .map((line) => {
      const qty = Number(line.SalesItemLineDetail?.Qty ?? 1)
      const normalizedQty = Number.isFinite(qty) && qty !== 0 ? qty : 1
      const lineAmount = Number(line.Amount ?? 0)
      const rawUnit =
        line.SalesItemLineDetail?.UnitPrice != null
          ? Number(line.SalesItemLineDetail.UnitPrice)
          : lineAmount / normalizedQty
      const unitPrice = Number.isFinite(rawUnit) ? rawUnit : 0
      const taxCode = String(line.SalesItemLineDetail?.TaxCodeRef?.value ?? "").toUpperCase()
      return {
        description: String(line.Description ?? ""),
        quantity: normalizedQty,
        unit: "ea",
        unit_price_cents: Math.round(unitPrice * 100),
        taxable: taxCode !== "NON",
        qbo_item_id: refValue(line.SalesItemLineDetail?.ItemRef),
        qbo_item_name: refName(line.SalesItemLineDetail?.ItemRef),
        qbo_class_id: refValue(line.SalesItemLineDetail?.ClassRef),
        qbo_class_name: refName(line.SalesItemLineDetail?.ClassRef),
      }
    })
    .filter((line) => line.description.length > 0 || line.unit_price_cents !== 0)

  const { data: invoiceRow, error: invoiceError } = await supabase
    .from("invoices")
    .insert({
      org_id: orgId,
      project_id: projectId,
      invoice_number: qbo.DocNumber ? String(qbo.DocNumber) : null,
      title: qbo.PrivateNote ?? null,
      status,
      issue_date: issueDate,
      due_date: dueDate,
      subtotal_cents: subtotalCents,
      tax_cents: taxCents,
      total_cents: totalCents,
      balance_due_cents: balanceCents,
      currency: "usd",
      client_visible: false,
      notes: qbo.PrivateNote ?? null,
      metadata: { imported_from_qbo: true, qbo_imported_at: nowIso },
      qbo_id: qboId,
      qbo_synced_at: nowIso,
      qbo_sync_status: "synced",
    })
    .select("id")
    .single()

  if (invoiceError || !invoiceRow) throw new Error(invoiceError?.message ?? "Failed to create invoice")

  if (lines.length > 0) {
    const { error: linesError } = await supabase.from("invoice_lines").insert(
      lines.map((line) => ({
        org_id: orgId,
        invoice_id: invoiceRow.id,
        cost_code_id: null,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unit_price_cents: line.unit_price_cents,
        metadata: {
          taxable: line.taxable,
          qbo_income_account_id: line.qbo_item_id,
          qbo_income_account_name: line.qbo_item_name,
          qbo_class_id: line.qbo_class_id,
          qbo_class_name: line.qbo_class_name,
        },
      })),
    )
    if (linesError) {
      await supabase.from("invoices").delete().eq("org_id", orgId).eq("id", invoiceRow.id)
      throw new Error(`Failed to create invoice lines: ${linesError.message}`)
    }
  }

  await linkSyncRecord({ supabase, orgId, connectionId, entityType: "invoice", entityId: invoiceRow.id, qboId })
  await markEventsResolved(supabase, qboId)
  await recordEvent({
    orgId,
    actorId: ctx.userId,
    eventType: "invoice_imported_from_qbo",
    entityType: "invoice",
    entityId: invoiceRow.id,
    payload: { qbo_id: qboId, total_cents: totalCents, project_id: projectId },
  })

  return { skipped: false as const, entityId: invoiceRow.id }
}

async function importExpense(ctx: ResolvedContext, client: QBOClient, connectionId: string, projectId: string, qboId: string) {
  const { supabase, orgId } = ctx

  const { data: existing } = await supabase
    .from("project_expenses")
    .select("id")
    .eq("org_id", orgId)
    .eq("qbo_id", qboId)
    .maybeSingle()
  if (existing?.id) return { skipped: true as const }

  const qbo = await client.getPurchaseById(qboId)
  if (!qbo) throw new Error("Expense not found in QuickBooks")

  const totalCents = toCents(qbo.TotalAmt)
  const expenseDate = normalizeDate(qbo.TxnDate) ?? new Date().toISOString().split("T")[0]
  const vendorRef = qbo.EntityRef ?? qbo.VendorRef
  const firstLine = (qbo.Line ?? []).find((line: any) => line?.Description) ?? (qbo.Line ?? [])[0]
  const accountLine = (qbo.Line ?? []).find((line: any) => line?.AccountBasedExpenseLineDetail?.AccountRef)
  const accountRef = accountLine?.AccountBasedExpenseLineDetail?.AccountRef
  const classRef = accountLine?.AccountBasedExpenseLineDetail?.ClassRef
  const description = String(firstLine?.Description ?? qbo.PrivateNote ?? refName(accountRef) ?? "Imported QuickBooks expense")
  const nowIso = new Date().toISOString()

  const { data: expenseRow, error: expenseError } = await supabase
    .from("project_expenses")
    .insert({
      org_id: orgId,
      project_id: projectId,
      expense_date: expenseDate,
      description,
      amount_cents: Math.max(totalCents, 0),
      tax_cents: 0,
      is_billable: false,
      status: "approved",
      approved_by_pm_at: nowIso,
      approved_by_pm_user_id: ctx.userId,
      vendor_name_text: refName(vendorRef),
      payment_method: mapQboPaymentMethod(qbo.PaymentType),
      metadata: { imported_from_qbo: true, qbo_imported_at: nowIso },
      qbo_id: qboId,
      qbo_transaction_type: "purchase",
      qbo_synced_at: nowIso,
      qbo_sync_status: "synced",
      qbo_vendor_id: refValue(vendorRef),
      qbo_vendor_name: refName(vendorRef),
      qbo_expense_account_id: refValue(accountRef),
      qbo_expense_account_name: refName(accountRef),
      qbo_class_id: refValue(classRef),
      qbo_class_name: refName(classRef),
    })
    .select("id")
    .single()

  if (expenseError || !expenseRow) throw new Error(expenseError?.message ?? "Failed to create expense")

  await linkSyncRecord({ supabase, orgId, connectionId, entityType: "project_expense", entityId: expenseRow.id, qboId })
  await markEventsResolved(supabase, qboId)
  await recordEvent({
    orgId,
    actorId: ctx.userId,
    eventType: "expense_imported_from_qbo",
    entityType: "project_expense",
    entityId: expenseRow.id,
    payload: { qbo_id: qboId, amount_cents: totalCents, project_id: projectId },
  })

  return { skipped: false as const, entityId: expenseRow.id }
}

async function importBill(ctx: ResolvedContext, client: QBOClient, connectionId: string, projectId: string, qboId: string) {
  const { supabase, orgId } = ctx

  const { data: existing } = await supabase
    .from("vendor_bills")
    .select("id")
    .eq("org_id", orgId)
    .eq("qbo_id", qboId)
    .maybeSingle()
  if (existing?.id) return { skipped: true as const }

  const qbo = await client.getBillById(qboId)
  if (!qbo) throw new Error("Bill not found in QuickBooks")

  const totalCents = toCents(qbo.TotalAmt)
  const balanceCents = qbo.Balance != null ? toCents(qbo.Balance) : totalCents
  const paidCents = Math.max(totalCents - balanceCents, 0)
  const billDate = normalizeDate(qbo.TxnDate)
  const dueDate = normalizeDate(qbo.DueDate)
  const vendorRef = qbo.VendorRef
  const accountLine = (qbo.Line ?? []).find((line: any) => line?.AccountBasedExpenseLineDetail?.AccountRef)
  const accountRef = accountLine?.AccountBasedExpenseLineDetail?.AccountRef
  const classRef = accountLine?.AccountBasedExpenseLineDetail?.ClassRef
  const nowIso = new Date().toISOString()
  const status = balanceCents <= 0 && totalCents > 0 ? "paid" : "approved"

  const { data: billRow, error: billError } = await supabase
    .from("vendor_bills")
    .insert({
      org_id: orgId,
      project_id: projectId,
      bill_number: qbo.DocNumber ? String(qbo.DocNumber) : null,
      status,
      bill_date: billDate,
      due_date: dueDate,
      total_cents: totalCents,
      paid_cents: paidCents,
      currency: "usd",
      approved_at: nowIso,
      approved_by: ctx.userId,
      paid_at: status === "paid" ? nowIso : null,
      metadata: { imported_from_qbo: true, qbo_imported_at: nowIso },
      qbo_id: qboId,
      qbo_synced_at: nowIso,
      qbo_sync_status: "synced",
      qbo_vendor_id: refValue(vendorRef),
      qbo_vendor_name: refName(vendorRef),
      qbo_expense_account_id: refValue(accountRef),
      qbo_expense_account_name: refName(accountRef),
      qbo_class_id: refValue(classRef),
      qbo_class_name: refName(classRef),
    })
    .select("id")
    .single()

  if (billError || !billRow) throw new Error(billError?.message ?? "Failed to create bill")

  // Persist the bill's expense lines, allocating each to the Arc project that maps to the
  // line's QBO customer (so a bill job-costed across multiple projects in QBO keeps that
  // split in Arc). Lines without a resolvable customer fall back to the import target project.
  const expenseLines = (qbo.Line ?? []).filter((line: any) => line?.AccountBasedExpenseLineDetail)
  if (expenseLines.length > 0) {
    const customerIds = Array.from(
      new Set(
        expenseLines
          .map((line: any) => refValue(line.AccountBasedExpenseLineDetail?.CustomerRef))
          .filter((value: string | null): value is string => Boolean(value)),
      ),
    )
    const projectByCustomer = new Map<string, string>()
    if (customerIds.length > 0) {
      const { data: projectRows } = await supabase
        .from("projects")
        .select("id, qbo_customer_id")
        .eq("org_id", orgId)
        .in("qbo_customer_id", customerIds)
      for (const projectRow of projectRows ?? []) {
        if (projectRow.qbo_customer_id) projectByCustomer.set(String(projectRow.qbo_customer_id), projectRow.id)
      }
    }

    const lineRows = expenseLines.map((line: any, index: number) => {
      const detail = line.AccountBasedExpenseLineDetail
      const customerId = refValue(detail?.CustomerRef)
      const lineProjectId = (customerId && projectByCustomer.get(customerId)) || projectId
      return {
        org_id: orgId,
        bill_id: billRow.id,
        project_id: lineProjectId,
        cost_code_id: null,
        description: String(line.Description ?? refName(detail?.AccountRef) ?? "Imported QuickBooks line"),
        quantity: 1,
        unit: "LS",
        unit_cost_cents: toCents(line.Amount),
        sort_order: index,
        metadata: {
          source: "qbo_import",
          qbo_expense_account_id: refValue(detail?.AccountRef),
          qbo_expense_account_name: refName(detail?.AccountRef),
          qbo_class_id: refValue(detail?.ClassRef),
          qbo_class_name: refName(detail?.ClassRef),
        },
      }
    })

    const { error: linesError } = await supabase.from("bill_lines").insert(lineRows)
    if (linesError) {
      await supabase.from("vendor_bills").delete().eq("org_id", orgId).eq("id", billRow.id)
      throw new Error(`Failed to create bill lines: ${linesError.message}`)
    }
  }

  await linkSyncRecord({ supabase, orgId, connectionId, entityType: "bill", entityId: billRow.id, qboId })
  await markEventsResolved(supabase, qboId)
  await recordEvent({
    orgId,
    actorId: ctx.userId,
    eventType: "bill_imported_from_qbo",
    entityType: "vendor_bill",
    entityId: billRow.id,
    payload: { qbo_id: qboId, total_cents: totalCents, project_id: projectId },
  })

  return { skipped: false as const, entityId: billRow.id }
}

async function importPayment(ctx: ResolvedContext, client: QBOClient, connectionId: string, qboId: string) {
  const { supabase, orgId } = ctx

  const { data: existingSync } = await supabase
    .from("qbo_sync_records")
    .select("entity_id")
    .eq("org_id", orgId)
    .eq("entity_type", "payment")
    .eq("qbo_id", qboId)
    .maybeSingle()
  if (existingSync?.entity_id) return { skipped: true as const }

  const qbo = await client.getPaymentById(qboId)
  if (!qbo) throw new Error("Payment not found in QuickBooks")

  const linkedInvoiceQboIds = extractLinkedInvoiceQboIds(qbo)
  if (linkedInvoiceQboIds.length === 0) {
    throw new Error("This payment isn't linked to an invoice in QuickBooks.")
  }

  // The invoice the payment applies to must already exist in Arc.
  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, project_id")
    .eq("org_id", orgId)
    .in("qbo_id", linkedInvoiceQboIds)
    .maybeSingle()
  if (!invoice?.id) {
    throw new Error("Import the linked invoice first, then import this payment.")
  }

  const amountCents = toCents(qbo.TotalAmt)
  const receivedAt = normalizeDate(qbo.TxnDate)
  const nowIso = new Date().toISOString()

  const { data: paymentRow, error: paymentError } = await supabase
    .from("payments")
    .insert({
      org_id: orgId,
      project_id: invoice.project_id,
      invoice_id: invoice.id,
      amount_cents: amountCents,
      gross_cents: amountCents,
      net_cents: amountCents,
      currency: "usd",
      method: "other",
      provider: "qbo",
      provider_payment_id: `qbo_payment_${qboId}`,
      status: "succeeded",
      received_at: receivedAt ? new Date(receivedAt).toISOString() : nowIso,
      metadata: { imported_from_qbo: true, qbo_id: qboId, qbo_imported_at: nowIso },
    })
    .select("id")
    .single()

  if (paymentError || !paymentRow) throw new Error(paymentError?.message ?? "Failed to record payment")

  await linkSyncRecord({ supabase, orgId, connectionId, entityType: "payment", entityId: paymentRow.id, qboId })
  await recalcInvoiceBalanceAndStatus({ supabase, orgId, invoiceId: invoice.id })
  await markEventsResolved(supabase, qboId)
  await recordEvent({
    orgId,
    actorId: ctx.userId,
    eventType: "payment_imported_from_qbo",
    entityType: "payment",
    entityId: paymentRow.id,
    payload: { qbo_id: qboId, amount_cents: amountCents, invoice_id: invoice.id },
  })

  return { skipped: false as const, entityId: paymentRow.id }
}

async function importBillPayment(ctx: ResolvedContext, client: QBOClient, connectionId: string, qboId: string) {
  const { supabase, orgId } = ctx

  const { data: existingSync } = await supabase
    .from("qbo_sync_records")
    .select("entity_id")
    .eq("org_id", orgId)
    .eq("entity_type", "bill_payment")
    .eq("qbo_id", qboId)
    .maybeSingle()
  if (existingSync?.entity_id) return { skipped: true as const }

  const qbo = await client.getBillPaymentById(qboId)
  if (!qbo) throw new Error("Bill payment not found in QuickBooks")

  const linkedBillQboIds = extractLinkedBillQboIds(qbo)
  if (linkedBillQboIds.length === 0) {
    throw new Error("This bill payment isn't linked to a bill in QuickBooks.")
  }

  const { data: bill } = await supabase
    .from("vendor_bills")
    .select("id, project_id, total_cents, paid_cents")
    .eq("org_id", orgId)
    .in("qbo_id", linkedBillQboIds)
    .maybeSingle()
  if (!bill?.id) {
    throw new Error("Import the linked bill first, then import this bill payment.")
  }

  const amountCents = toCents(qbo.TotalAmt)
  const receivedAt = normalizeDate(qbo.TxnDate)
  const nowIso = new Date().toISOString()

  const { data: paymentRow, error: paymentError } = await supabase
    .from("payments")
    .insert({
      org_id: orgId,
      project_id: bill.project_id,
      bill_id: bill.id,
      amount_cents: amountCents,
      gross_cents: amountCents,
      net_cents: amountCents,
      currency: "usd",
      method: "other",
      provider: "qbo",
      provider_payment_id: `qbo_billpayment_${qboId}`,
      status: "succeeded",
      received_at: receivedAt ? new Date(receivedAt).toISOString() : nowIso,
      metadata: { imported_from_qbo: true, qbo_id: qboId, qbo_imported_at: nowIso },
    })
    .select("id")
    .single()

  if (paymentError || !paymentRow) throw new Error(paymentError?.message ?? "Failed to record bill payment")

  const nextPaid = Math.max(Number(bill.paid_cents ?? 0), 0) + amountCents
  const fullyPaid = bill.total_cents != null && nextPaid >= Number(bill.total_cents)
  await supabase
    .from("vendor_bills")
    .update({
      paid_cents: nextPaid,
      ...(fullyPaid ? { status: "paid", paid_at: nowIso } : {}),
    })
    .eq("org_id", orgId)
    .eq("id", bill.id)

  await linkSyncRecord({ supabase, orgId, connectionId, entityType: "bill_payment", entityId: paymentRow.id, qboId })
  await markEventsResolved(supabase, qboId)
  await recordEvent({
    orgId,
    actorId: ctx.userId,
    eventType: "bill_payment_imported_from_qbo",
    entityType: "payment",
    entityId: paymentRow.id,
    payload: { qbo_id: qboId, amount_cents: amountCents, bill_id: bill.id },
  })

  return { skipped: false as const, entityId: paymentRow.id }
}

/**
 * Import a QBO journal entry's cost lines as Arc project expenses. Unlike the other types this is a
 * 1:many, inbound-only projection: each qualifying line becomes its own expense (mapped to the Arc
 * project for the line's QBO customer, falling back to the import target), linked with
 * `pushable = false` so the outbound sync never tries to reconstruct the JE. Re-importing is
 * idempotent at the line level.
 */
async function importJournalEntry(
  ctx: ResolvedContext,
  client: QBOClient,
  connectionId: string,
  projectId: string,
  qboId: string,
  expenseAccountIds: Set<string>,
) {
  const { supabase, orgId } = ctx

  const qbo = await client.getJournalEntryById(qboId)
  if (!qbo) throw new Error("Journal entry not found in QuickBooks")

  const costLines = ((qbo.Line ?? []) as any[]).filter(
    (line) =>
      line?.DetailType === "JournalEntryLineDetail" &&
      expenseAccountIds.has(refValue(line.JournalEntryLineDetail?.AccountRef) ?? ""),
  )
  if (costLines.length === 0) return { skipped: true as const }

  // Skip lines already imported (idempotent re-import of the same JE).
  const { data: existingRows } = await supabase
    .from("project_expenses")
    .select("metadata")
    .eq("org_id", orgId)
    .eq("qbo_transaction_type", "journal_entry")
    .eq("qbo_id", qboId)
  const importedLineIds = new Set<string>()
  for (const row of existingRows ?? []) {
    const lineId = (row.metadata as { qbo_je_line_id?: string } | null)?.qbo_je_line_id
    if (lineId != null) importedLineIds.add(String(lineId))
  }
  const pending = costLines.filter((line) => !importedLineIds.has(String(line.Id)))
  if (pending.length === 0) return { skipped: true as const }

  // Resolve the Arc project for each line's QBO customer (job), so a JE spanning multiple projects
  // lands its lines in the right places.
  const customerIds = Array.from(
    new Set(
      pending
        .map((line) => {
          const entity = line.JournalEntryLineDetail?.Entity
          return String(entity?.Type ?? "").toLowerCase() === "customer" ? refValue(entity?.EntityRef) : null
        })
        .filter((value): value is string => Boolean(value)),
    ),
  )
  const projectByCustomer = new Map<string, string>()
  if (customerIds.length > 0) {
    const { data: projectRows } = await supabase
      .from("projects")
      .select("id, qbo_customer_id")
      .eq("org_id", orgId)
      .in("qbo_customer_id", customerIds)
    for (const projectRow of projectRows ?? []) {
      if (projectRow.qbo_customer_id) projectByCustomer.set(String(projectRow.qbo_customer_id), projectRow.id)
    }
  }

  const nowIso = new Date().toISOString()
  const jeDate = normalizeDate(qbo.TxnDate) ?? nowIso.split("T")[0]
  let created = 0

  for (const line of pending) {
    const detail = line.JournalEntryLineDetail
    const isCredit = String(detail?.PostingType ?? "").toLowerCase() === "credit"
    const amountCents = toCents(line.Amount) * (isCredit ? -1 : 1)
    const entity = detail?.Entity
    const entityType = String(entity?.Type ?? "").toLowerCase()
    const isCustomer = entityType === "customer"
    const isVendor = entityType === "vendor"
    const customerId = isCustomer ? refValue(entity?.EntityRef) : null
    const lineProjectId = (customerId && projectByCustomer.get(customerId)) || projectId
    const accountRef = detail?.AccountRef
    const classRef = detail?.ClassRef
    const description = String(
      line.Description ?? qbo.PrivateNote ?? refName(accountRef) ?? "Imported QuickBooks journal entry",
    )

    const { data: expenseRow, error: expenseError } = await supabase
      .from("project_expenses")
      .insert({
        org_id: orgId,
        project_id: lineProjectId,
        expense_date: jeDate,
        description,
        amount_cents: amountCents,
        tax_cents: 0,
        is_billable: false,
        status: "approved",
        approved_by_pm_at: nowIso,
        approved_by_pm_user_id: ctx.userId,
        vendor_name_text: isVendor ? refName(entity?.EntityRef) : null,
        payment_method: null,
        metadata: {
          imported_from_qbo: true,
          qbo_imported_at: nowIso,
          source: "journal_entry",
          qbo_je_id: qboId,
          qbo_je_line_id: String(line.Id),
        },
        qbo_id: qboId,
        qbo_transaction_type: "journal_entry",
        qbo_synced_at: nowIso,
        qbo_sync_status: "synced",
        qbo_vendor_id: isVendor ? refValue(entity?.EntityRef) : null,
        qbo_vendor_name: isVendor ? refName(entity?.EntityRef) : null,
        qbo_expense_account_id: refValue(accountRef),
        qbo_expense_account_name: refName(accountRef),
        qbo_class_id: refValue(classRef),
        qbo_class_name: refName(classRef),
      })
      .select("id")
      .single()

    if (expenseError || !expenseRow) throw new Error(expenseError?.message ?? "Failed to import journal entry line")

    await linkSyncRecord({
      supabase,
      orgId,
      connectionId,
      entityType: "project_expense",
      entityId: expenseRow.id,
      qboId,
      pushable: false,
      metadata: { source: "journal_entry", qbo_je_line_id: String(line.Id) },
    })
    await recordEvent({
      orgId,
      actorId: ctx.userId,
      eventType: "expense_imported_from_qbo",
      entityType: "project_expense",
      entityId: expenseRow.id,
      payload: { qbo_id: qboId, source: "journal_entry", amount_cents: amountCents, project_id: lineProjectId },
    })
    created += 1
  }

  await markEventsResolved(supabase, qboId)
  return { skipped: created === 0 }
}

/**
 * Import the selected QBO transactions into the given project, creating Arc records pre-linked as
 * synced. Each item is processed independently; a failure on one never aborts the rest.
 *
 * Items are processed in dependency order (invoices/bills before their payments) so that a payment
 * selected alongside its invoice in the same batch can resolve its local target.
 */
export async function importQboRecords({
  orgId,
  projectId,
  items,
}: {
  orgId?: string
  projectId: string
  items: { qboId: string; entityType: QboImportEntityType }[]
}): Promise<QboImportResult> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "bill.write", userId, orgId: resolvedOrgId, supabase, logDecision: true })
  await requireAuthorization({ permission: "invoice.write", userId, orgId: resolvedOrgId, supabase, logDecision: true })

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("id", projectId)
    .maybeSingle()
  if (!project?.id) throw new Error("Project not found")

  const connectionId = await getActiveConnectionId(supabase, resolvedOrgId)
  if (!connectionId) throw new Error("QuickBooks isn't connected for this organization.")

  const client = await QBOClient.forOrg(resolvedOrgId)
  if (!client) throw new Error("Couldn't connect to QuickBooks.")

  const ctx: ResolvedContext = { supabase, orgId: resolvedOrgId, userId }

  // Order so that documents are imported before the payments that reference them.
  const order: Record<QboImportEntityType, number> = {
    invoice: 0,
    bill: 0,
    expense: 0,
    journal_entry: 0,
    payment: 1,
    bill_payment: 1,
  }
  const ordered = [...items].sort((a, b) => order[a.entityType] - order[b.entityType])

  // Journal entries need the org's expense/COGS account ids to keep only cost lines; fetch once.
  const jeExpenseAccountIds = ordered.some((item) => item.entityType === "journal_entry")
    ? new Set((await client.listExpenseAccounts().catch(() => [] as { id: string }[])).map((account) => account.id))
    : new Set<string>()

  const result: QboImportResult = { imported: 0, skipped: 0, failed: 0, errors: [] }

  for (const item of ordered) {
    try {
      let outcome: { skipped: boolean }
      switch (item.entityType) {
        case "invoice":
          outcome = await importInvoice(ctx, client, connectionId, projectId, item.qboId)
          break
        case "expense":
          outcome = await importExpense(ctx, client, connectionId, projectId, item.qboId)
          break
        case "bill":
          outcome = await importBill(ctx, client, connectionId, projectId, item.qboId)
          break
        case "payment":
          outcome = await importPayment(ctx, client, connectionId, item.qboId)
          break
        case "bill_payment":
          outcome = await importBillPayment(ctx, client, connectionId, item.qboId)
          break
        case "journal_entry":
          outcome = await importJournalEntry(ctx, client, connectionId, projectId, item.qboId, jeExpenseAccountIds)
          break
        default:
          throw new Error(`Unsupported entity type: ${item.entityType}`)
      }
      if (outcome.skipped) result.skipped += 1
      else result.imported += 1
    } catch (error: any) {
      result.failed += 1
      result.errors.push({
        qboId: item.qboId,
        entityType: item.entityType,
        message: error?.message ?? "Import failed",
      })
      logQBO("warn", "qbo_import_item_failed", {
        orgId: resolvedOrgId,
        qboId: item.qboId,
        entityType: item.entityType,
        error: error?.message ?? String(error),
      })
    }
  }

  return result
}
