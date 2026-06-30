import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { QBOClient } from "@/lib/integrations/accounting/qbo-api"
import {
  collectPaginatedRows,
  extractLinkedQboAmounts,
  extractLinkedQboIds,
  isUsableQboPaymentMapping,
  qboImportProviderPaymentId,
  qboPurchaseCreditCents,
  qboPurchaseIsCredit,
  qboVendorCreditCents,
} from "@/lib/integrations/accounting/qbo-import-rules"
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
// `client_deposit` is a virtual classification: it is derived from the income lines of a QBO
// JournalEntry (historical, pre-go-live client deposits booked straight to a Construction Income
// account, with no invoice behind them) and lands in Arc as a paid historical invoice + payment.
export type QboImportEntityType =
  | "invoice"
  | "expense"
  | "expense_credit"
  | "bill"
  | "vendor_credit"
  | "payment"
  | "bill_payment"
  | "journal_entry"
  | "client_deposit"

// QBO transaction entity name → Arc entity classification.
const QBO_ENTITY_BY_TYPE: Record<
  QboImportEntityType,
  "Invoice" | "Purchase" | "Bill" | "VendorCredit" | "Payment" | "BillPayment" | "JournalEntry"
> = {
  invoice: "Invoice",
  expense: "Purchase",
  // QBO models credit-card credits/refunds as Purchase records too (Credit=true, or negative
  // totals/lines in older payloads). Arc keeps them separate in the import UX and posts negative
  // actuals, while preserving the original Purchase mapping as inbound-only.
  expense_credit: "Purchase",
  bill: "Bill",
  // A vendor credit is the sign-flipped twin of a bill (Cr Expense / Dr A/P); it imports as a
  // vendor_bills row with negative amounts, reducing project cost.
  vendor_credit: "VendorCredit",
  payment: "Payment",
  bill_payment: "BillPayment",
  journal_entry: "JournalEntry",
  // Sourced from the same JournalEntry rows as `journal_entry` (income lines instead of cost lines).
  client_deposit: "JournalEntry",
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
  /**
   * For a bill payment that applied vendor credits: the QBO ids of those credits. Selecting the
   * payment auto-selects them too (same dependency UX as the linked bill) so the credit's cost
   * reduction lands alongside the payment that settled the bill.
   */
  appliedVendorCreditQboIds?: string[]
  dependencyStatus?: "already_in_arc" | "available_to_import" | "missing" | null
  dependencyMessage?: string | null
  possibleMatch?: string | null
  /**
   * The QBO customer/project this record is primarily associated with — header CustomerRef for
   * invoices/payments, the first cost line's customer for bills/expenses/journal entries. Used as
   * the display default.
   */
  qboCustomerId?: string | null
  qboCustomerName?: string | null
  /**
   * Arc project the record's header customer auto-maps to via its QBO customer link, or null when
   * unmapped. Drives the default destination for single-document types (invoices) in the import
   * workspace; multi-line types resolve their destination per line instead.
   */
  suggestedProjectId?: string | null
  /**
   * Every QBO customer/project this record touches (one per costed line for bills/expenses/JEs).
   * Drives the "filter import by QBO project" picker so a multi-project transaction surfaces under
   * each of its projects, not just the first line's.
   */
  qboCustomerIds?: { id: string; name: string | null }[]
  /**
   * Per-line breakdown for the multi-line types (bill / expense / journal_entry / client_deposit).
   * Drives the per-line "allocate to project" editor in the import sheet: each line shows its QBO
   * customer and a suggested Arc project (the existing customer→project link), and the user can
   * override where any line lands. Absent for single-document types (invoices, payments).
   */
  lines?: QboImportLine[]
  /**
   * Read-only allocation breakdown for payments / bill payments: how the payment is split across the
   * QBO invoices/bills it pays, and which Arc project each portion lands in. Payments aren't manually
   * re-allocated — the project is always the linked document's project — so this is purely for display.
   * `projectName` is null until the linked document has been imported into Arc.
   */
  linkedDocs?: QboImportLinkedDoc[]
  possibleMatchId?: string | null
  possibleMatchEntityType?: "invoice" | "project_expense" | "bill" | null
}

export type QboImportLinkedDoc = {
  qboId: string
  /** Invoice/bill number once imported, else the QBO id. */
  docLabel: string | null
  amountCents: number
  projectName: string | null
  /** True when the linked invoice/bill already exists in Arc (so its project is known). */
  inArc: boolean
}

/** One costed line of a multi-line importable record, for the per-line project allocation UI. */
export type QboImportLine = {
  /** QBO line id — the key used to send a per-line project override back to the import. */
  lineId: string
  description: string
  amountCents: number
  qboCustomerId: string | null
  qboCustomerName: string | null
  /** Arc project the line auto-maps to via its QBO customer link, or null when unmapped. */
  suggestedProjectId: string | null
}

export type QboImportListing = {
  connected: boolean
  records: QboImportRecord[]
  alreadyImportedCounts?: Partial<Record<QboImportEntityType, number>>
  /**
   * Per-entity-type fetch failures. A QBO query for one entity (e.g. VendorCredit) can 400/timeout
   * while the others succeed; rather than silently showing zero of that type, we surface which types
   * failed so the UI can warn the user instead of implying "nothing to import".
   */
  loadErrors?: { entityType: QboImportEntityType; message: string }[]
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

function expenseLineDetail(line: any): any | null {
  return line?.AccountBasedExpenseLineDetail ?? line?.ItemBasedExpenseLineDetail ?? null
}

/** The customer/project ref on the first expense line of a Bill/Purchase, if any (job-costing link). */
function firstLineCustomerRef(lines: any[] | undefined): { value?: string; name?: string } | null {
  for (const line of lines ?? []) {
    const ref = expenseLineDetail(line)?.CustomerRef
    if (ref?.value) return ref
  }
  return null
}

/** Distinct customer/project refs across every expense line of a Bill/Purchase (job-costing links). */
function allLineCustomerRefs(lines: any[] | undefined): { id: string; name: string | null }[] {
  const seen = new Map<string, string | null>()
  for (const line of lines ?? []) {
    const ref = expenseLineDetail(line)?.CustomerRef
    if (ref?.value && !seen.has(String(ref.value))) seen.set(String(ref.value), refName(ref))
  }
  return Array.from(seen, ([id, name]) => ({ id, name }))
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
  return extractLinkedQboIds(payment, "invoice")
}

/** Per-linked-document amounts for a payment, e.g. how much of a payment was applied to each invoice. */
function extractLinkedDocAmounts(payment: any, txnType: "invoice" | "bill"): { qboId: string; amountCents: number }[] {
  return extractLinkedQboAmounts(payment, txnType)
}

function extractLinkedBillQboIds(billPayment: any): string[] {
  return extractLinkedQboIds(billPayment, "bill")
}

/**
 * A bill payment that applied vendor credits carries each credit as its own line, e.g.
 *   { Amount: 114.29, LinkedTxn: [{ TxnId: "176", TxnType: "VendorCredit" }] }
 * The line Amount is the dollars of that credit consumed (QBO prorates across available credits).
 * `TotalAmt` on the bill payment is the cash *net* of these credits, so cash + applied credits =
 * the bill amount settled.
 */
function extractAppliedVendorCredits(billPayment: any): { qboId: string; amountCents: number }[] {
  return extractLinkedQboAmounts(billPayment, "vendorcredit")
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
    expense_credit: new Set(),
    bill: new Set(),
    vendor_credit: new Set(),
    payment: new Set(),
    bill_payment: new Set(),
    // Journal-entry and client-deposit imports dedupe at the line level (see listImportableQboRecords),
    // not by JE id, so these sets are intentionally left empty.
    journal_entry: new Set(),
    client_deposit: new Set(),
  }

  const [invoiceRows, expenseRows, billRows, syncRows, paymentRows] = await Promise.all([
    // Exclude client-deposit invoices: their qbo_id is the JournalEntry id (shared across lines) and
    // must not shadow a real Invoice that happens to share that numeric id.
    collectPaginatedRows(
      (from, to) =>
        supabase
          .from("invoices")
          .select("id, qbo_id, metadata")
          .eq("org_id", orgId)
          .not("qbo_id", "is", null)
          .order("id")
          .range(from, to),
      { label: "linked QBO invoices" },
    ),
    // Exclude JE-derived expenses: their qbo_id is the JournalEntry id (shared across lines) and must
    // not shadow a real Purchase that happens to share that numeric id.
    collectPaginatedRows(
      (from, to) =>
        supabase
          .from("project_expenses")
          .select("id, qbo_id, metadata")
          .eq("org_id", orgId)
          .not("qbo_id", "is", null)
          .or("qbo_transaction_type.is.null,qbo_transaction_type.neq.journal_entry")
          .order("id")
          .range(from, to),
      { label: "linked QBO expenses" },
    ),
    // Vendor credits also live in vendor_bills (negative rows, metadata.source = "vendor_credit").
    // Route them to the vendor_credit set, not bill — QBO ids aren't unique across entity types, so
    // a Bill and a VendorCredit can share a numeric id.
    collectPaginatedRows(
      (from, to) =>
        supabase
          .from("vendor_bills")
          .select("id, qbo_id, metadata")
          .eq("org_id", orgId)
          .not("qbo_id", "is", null)
          .order("id")
          .range(from, to),
      { label: "linked QBO bills" },
    ),
    collectPaginatedRows(
      (from, to) =>
        supabase
          .from("qbo_sync_records")
          .select("id, entity_type, entity_id, qbo_id, status, metadata")
          .eq("org_id", orgId)
          .in("entity_type", ["invoice", "project_expense", "bill", "vendor_credit", "payment", "bill_payment"])
          .order("id")
          .range(from, to),
      { label: "QBO sync mappings" },
    ),
    collectPaginatedRows(
      (from, to) =>
        supabase.from("payments").select("id").eq("org_id", orgId).order("id").range(from, to),
      { label: "payment ledger rows" },
    ),
  ])

  for (const row of invoiceRows) {
    if (!row.qbo_id) continue
    if ((row.metadata as { source?: string } | null)?.source === "client_deposit") continue
    linked.invoice.add(String(row.qbo_id))
  }
  for (const row of expenseRows) {
    if (!row.qbo_id) continue
    if (String((row.metadata as { source?: string } | null)?.source ?? "").startsWith("expense_credit")) {
      linked.expense_credit.add(String(row.qbo_id))
    } else {
      linked.expense.add(String(row.qbo_id))
    }
  }
  for (const row of billRows) {
    if (!row.qbo_id) continue
    if ((row.metadata as { qbo_import_complete?: boolean } | null)?.qbo_import_complete === false) continue
    if ((row.metadata as { source?: string } | null)?.source === "vendor_credit") linked.vendor_credit.add(String(row.qbo_id))
    else linked.bill.add(String(row.qbo_id))
  }
  const paymentIds = new Set(paymentRows.map((row) => String(row.id)))
  for (const row of syncRows) {
    const qboId = row.qbo_id ? String(row.qbo_id) : null
    if (!qboId) continue
    // Native financial rows above are the source of truth for documents. For payments, accept a
    // mapping only when it points at a real Arc ledger row. This deliberately ignores old webhook
    // placeholder mappings whose random entity_id never existed in `payments`.
    if (!isUsableQboPaymentMapping(row, paymentIds)) continue
    switch (row.entity_type) {
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

/** A QBO customer/project option for the import filter. QBO models projects as sub-customers. */
export type QboImportCustomerOption = {
  id: string
  /** Display label — the full hierarchy path ("Parent:Project") when QBO exposes one, else the name. */
  name: string
  /** True for QBO Projects (sub-customers with IsProject set); false for top-level customers. */
  isProject: boolean
}

export type QboImportCustomerListing = {
  connected: boolean
  customers: QboImportCustomerOption[]
}

/**
 * Every active QBO customer and project, for the import sheet's project filter. Sourced from the live
 * QBO customer list (paged in full) rather than inferred from the fetched transactions, so projects
 * with no un-imported transactions in the window — or whose transactions fall outside it — still
 * appear in the dropdown.
 */
export async function listQboCustomersForImport({
  orgId,
}: { orgId?: string } = {}): Promise<QboImportCustomerListing> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "bill.read", userId, orgId: resolvedOrgId, supabase, logDecision: true })

  const client = await QBOClient.forOrg(resolvedOrgId)
  if (!client) return { connected: false, customers: [] }

  try {
    const customers = await client.listAllCustomers()
    return {
      connected: true,
      customers: customers.map((customer) => ({
        id: customer.id,
        name: customer.fullyQualifiedName ?? customer.name,
        isProject: customer.isProject === true,
      })),
    }
  } catch (error: any) {
    logQBO("warn", "qbo_import_customers_failed", {
      orgId: resolvedOrgId,
      error: error?.message ?? String(error),
    })
    return { connected: true, customers: [] }
  }
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

  // `client_deposit` is derived from the same JournalEntry rows as `journal_entry`; fetch that QBO
  // entity once and emit both record kinds from it instead of querying JournalEntry twice.
  const fetchTypes = Array.from(
    new Set(wanted.map((type) => (type === "client_deposit" ? "journal_entry" : type === "expense_credit" ? "expense" : type))),
  ) as QboImportEntityType[]

  const loadErrors: { entityType: QboImportEntityType; message: string }[] = []
  const [linked, ...results] = await Promise.all([
    collectLinkedQboIds(supabase, resolvedOrgId),
    ...fetchTypes.map((type) =>
      client
        .listTransactionsForImport(QBO_ENTITY_BY_TYPE[type], { sinceDate })
        .then((rows) => ({ type, rows }))
        .catch((error) => {
          const message = error?.message ?? String(error)
          logQBO("warn", "qbo_import_list_failed", {
            orgId: resolvedOrgId,
            entity: QBO_ENTITY_BY_TYPE[type],
            error: message,
          })
          // Surface the failure instead of silently showing zero of this type. `journal_entry` is the
          // fetched entity behind both journal_entry and client_deposit records, so attribute it to
          // every wanted type it backs.
          for (const wantedType of wanted) {
            const fetchType = wantedType === "client_deposit" ? "journal_entry" : wantedType === "expense_credit" ? "expense" : wantedType
            if (fetchType === type) loadErrors.push({ entityType: wantedType, message })
          }
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

  // Client-deposit support needs the org's Income account ids (to keep only the income/revenue lines
  // of a JE) and the set of deposit lines already imported (line-level dedup against the historical
  // invoices a prior import created).
  let incomeAccountIds = new Set<string>()
  const importedDepositLines = new Set<string>()
  if (wanted.includes("client_deposit")) {
    const [incomeAccounts, depositRows] = await Promise.all([
      client.listIncomeAccounts().catch(() => [] as { id: string }[]),
      supabase
        .from("invoices")
        .select("qbo_id, metadata")
        .eq("org_id", resolvedOrgId)
        .eq("metadata->>source", "client_deposit"),
    ])
    incomeAccountIds = new Set(incomeAccounts.map((account) => account.id))
    for (const row of depositRows.data ?? []) {
      const lineId = (row.metadata as { qbo_je_line_id?: string } | null)?.qbo_je_line_id
      if (row.qbo_id && lineId != null) importedDepositLines.add(`${row.qbo_id}:${lineId}`)
    }
  }

  // The multi-line types (bill / expense / journal_entry / client_deposit) expose a per-line project
  // allocation editor, which needs each line's suggested Arc project — the project already linked to
  // the line's QBO customer. Build that customer→project map once.
  const projectByCustomerForList = new Map<string, string>()
  const wantsLineAllocation = (
    ["bill", "vendor_credit", "expense", "expense_credit", "journal_entry", "client_deposit"] as QboImportEntityType[]
  ).some((t) => wanted.includes(t))
  if (wantsLineAllocation) {
    const { data: projectRows } = await supabase
      .from("projects")
      .select("id, qbo_customer_id")
      .eq("org_id", resolvedOrgId)
      .not("qbo_customer_id", "is", null)
    for (const projectRow of projectRows ?? []) {
      if (projectRow.qbo_customer_id) projectByCustomerForList.set(String(projectRow.qbo_customer_id), projectRow.id)
    }
  }
  const suggestProjectForCustomer = (customerId: string | null) =>
    (customerId && projectByCustomerForList.get(customerId)) || null

  // Build the per-line allocation breakdown attached to multi-line records.
  const expenseLineToImportLine = (line: any): QboImportLine => {
    const detail = expenseLineDetail(line)
    const customerRef = detail?.CustomerRef ?? null
    const customerId = refValue(customerRef)
    const accountRef = line.AccountBasedExpenseLineDetail?.AccountRef ?? line.ItemBasedExpenseLineDetail?.ItemRef ?? null
    return {
      lineId: String(line.Id),
      description: String(line.Description ?? refName(accountRef) ?? "Imported QuickBooks line"),
      amountCents: toCents(line.Amount),
      qboCustomerId: customerId,
      qboCustomerName: refName(customerRef),
      suggestedProjectId: suggestProjectForCustomer(customerId),
    }
  }
  const jeLineToImportLine = (line: any, creditPositive: boolean): QboImportLine => {
    const ref = jeLineCustomerRef(line)
    const customerId = refValue(ref)
    const isCredit = String(line.JournalEntryLineDetail?.PostingType ?? "").toLowerCase() === "credit"
    const factor = isCredit === creditPositive ? 1 : -1
    const accountRef = line.JournalEntryLineDetail?.AccountRef
    return {
      lineId: String(line.Id),
      description: String(line.Description ?? refName(accountRef) ?? "Journal entry line"),
      amountCents: toCents(line.Amount) * factor,
      qboCustomerId: customerId,
      qboCustomerName: refName(ref),
      suggestedProjectId: suggestProjectForCustomer(customerId),
    }
  }

  const records: QboImportRecord[] = []
  const alreadyImportedCounts: Partial<Record<QboImportEntityType, number>> = {}
  const billCustomersByQboId = new Map<string, { id: string; name: string | null }[]>()
  for (const result of results) {
    if (result.type !== "bill") continue
    for (const bill of result.rows) {
      if (bill?.Id) billCustomersByQboId.set(String(bill.Id), allLineCustomerRefs(bill.Line))
    }
  }

  for (const { type, rows } of results) {
    for (const row of rows) {
      const qboId = row?.Id ? String(row.Id) : null
      if (!qboId) continue
      if (type !== "expense" && linked[type].has(qboId)) {
        alreadyImportedCounts[type] = (alreadyImportedCounts[type] ?? 0) + 1
        continue
      }

      if (type === "journal_entry") {
        const customerIdsForLines = (lines: any[]) => {
          const seen = new Map<string, string | null>()
          for (const line of lines) {
            const ref = jeLineCustomerRef(line)
            if (ref?.value && !seen.has(String(ref.value))) seen.set(String(ref.value), refName(ref))
          }
          return Array.from(seen, ([id, name]) => ({ id, name }))
        }

        // Cost side → `journal_entry`. Only debit/credit lines hitting an expense/COGS account are
        // real project costs; the balancing cash/AP/equity lines are skipped. Credits to an expense
        // account reverse cost.
        if (wanted.includes("journal_entry")) {
          const costLines = ((row.Line ?? []) as any[]).filter(
            (line) =>
              line?.DetailType === "JournalEntryLineDetail" &&
              jeExpenseAccountIds.has(refValue(line.JournalEntryLineDetail?.AccountRef) ?? ""),
          )
          const remaining = costLines.filter((line) => !importedJeLines.has(`${qboId}:${line.Id}`))
          if (remaining.length > 0) {
            const amountCents = remaining.reduce((sum, line) => {
              const isCredit = String(line.JournalEntryLineDetail?.PostingType ?? "").toLowerCase() === "credit"
              return sum + toCents(line.Amount) * (isCredit ? -1 : 1)
            }, 0)
            records.push({
              qboId,
              entityType: "journal_entry",
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
              qboCustomerIds: customerIdsForLines(remaining),
              lines: remaining.map((line) => jeLineToImportLine(line, false)),
            })
          }
        }

        // Income side → `client_deposit`. Credit lines hitting an Income account are client revenue
        // (historical deposits). These land in Arc as paid historical invoices + payments.
        if (wanted.includes("client_deposit")) {
          const incomeLines = ((row.Line ?? []) as any[]).filter(
            (line) =>
              line?.DetailType === "JournalEntryLineDetail" &&
              incomeAccountIds.has(refValue(line.JournalEntryLineDetail?.AccountRef) ?? ""),
          )
          const remaining = incomeLines.filter((line) => !importedDepositLines.has(`${qboId}:${line.Id}`))
          if (remaining.length > 0) {
            // A deposit credits income, so a credit is positive revenue; a debit (refund/reversal) nets down.
            const amountCents = remaining.reduce((sum, line) => {
              const isCredit = String(line.JournalEntryLineDetail?.PostingType ?? "").toLowerCase() === "credit"
              return sum + toCents(line.Amount) * (isCredit ? 1 : -1)
            }, 0)
            records.push({
              qboId,
              entityType: "client_deposit",
              docNumber: row.DocNumber ? String(row.DocNumber) : null,
              counterparty: refName(jeLineCustomerRef(remaining[0])) ?? (row.PrivateNote ? String(row.PrivateNote) : "Client deposit"),
              date: normalizeDate(row.TxnDate),
              amountCents,
              balanceCents: null,
              hasLinks: false,
              qboCustomerId: refValue(jeLineCustomerRef(remaining[0])),
              qboCustomerName: refName(jeLineCustomerRef(remaining[0])),
              qboCustomerIds: customerIdsForLines(remaining),
              lines: remaining.map((line) => jeLineToImportLine(line, true)),
            })
          }
        }
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
          suggestedProjectId: suggestProjectForCustomer(refValue(row.CustomerRef)),
        })
      } else if (type === "expense") {
        const isCredit = qboPurchaseIsCredit(row)
        const entityType: QboImportEntityType = isCredit ? "expense_credit" : "expense"
        if (!wanted.includes(entityType)) continue
        if (linked[entityType].has(qboId)) {
          alreadyImportedCounts[entityType] = (alreadyImportedCounts[entityType] ?? 0) + 1
          continue
        }
        const vendor = refName(row.EntityRef) ?? refName(row.AccountRef)
        const lineCustomer = firstLineCustomerRef(row.Line)
        const lines = ((row.Line ?? []) as any[])
          .filter((line) => line?.AccountBasedExpenseLineDetail || line?.ItemBasedExpenseLineDetail)
          .map((line) => {
            const mapped = expenseLineToImportLine(line)
            return isCredit ? { ...mapped, amountCents: qboPurchaseCreditCents(line.Amount) } : mapped
          })
        records.push({
          qboId,
          entityType,
          docNumber: row.DocNumber ? String(row.DocNumber) : (row.PaymentType ? String(row.PaymentType) : null),
          counterparty: vendor,
          date: normalizeDate(row.TxnDate),
          amountCents: isCredit ? qboPurchaseCreditCents(row.TotalAmt) : toCents(row.TotalAmt),
          balanceCents: null,
          hasLinks: false,
          qboCustomerId: refValue(lineCustomer),
          qboCustomerName: refName(lineCustomer),
          qboCustomerIds: allLineCustomerRefs(row.Line),
          lines,
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
          qboCustomerIds: allLineCustomerRefs(row.Line),
          lines: ((row.Line ?? []) as any[])
            .filter((line) => expenseLineDetail(line))
            .map(expenseLineToImportLine),
        })
      } else if (type === "vendor_credit") {
        // Same shape as a bill, but it reduces cost — surface negative amounts so the row reads as a
        // credit. The negation is display-only here; the importer derives signs from the QBO payload.
        const lineCustomer = firstLineCustomerRef(row.Line)
        const negativeLines = ((row.Line ?? []) as any[])
          .filter((line) => line?.AccountBasedExpenseLineDetail || line?.ItemBasedExpenseLineDetail)
          .map((line) => {
            const mapped = expenseLineToImportLine(line)
            return { ...mapped, amountCents: qboVendorCreditCents(line.Amount) }
          })
        records.push({
          qboId,
          entityType: type,
          docNumber: row.DocNumber ? String(row.DocNumber) : null,
          counterparty: refName(row.VendorRef),
          date: normalizeDate(row.TxnDate),
          amountCents: qboVendorCreditCents(row.TotalAmt),
          balanceCents: null,
          hasLinks: false,
          qboCustomerId: refValue(lineCustomer),
          qboCustomerName: refName(lineCustomer),
          qboCustomerIds: allLineCustomerRefs(row.Line),
          lines: negativeLines,
        })
      } else if (type === "payment") {
        const linkedQboIds = extractLinkedInvoiceQboIds(row)
        const docAmounts = extractLinkedDocAmounts(row, "invoice")
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
          // Project/doc labels are filled in the resolve pass below; amounts come straight from QBO.
          linkedDocs: docAmounts.map((doc) => ({
            qboId: doc.qboId,
            docLabel: null,
            amountCents: doc.amountCents,
            projectName: null,
            inArc: false,
          })),
        })
      } else if (type === "bill_payment") {
        const linkedQboIds = extractLinkedBillQboIds(row)
        const docAmounts = extractLinkedDocAmounts(row, "bill")
        const appliedVendorCreditQboIds = extractAppliedVendorCredits(row).map((c) => c.qboId)
        const linkedCustomers = new Map<string, string | null>()
        for (const linkedId of linkedQboIds) {
          for (const customer of billCustomersByQboId.get(linkedId) ?? []) {
            if (!linkedCustomers.has(customer.id)) linkedCustomers.set(customer.id, customer.name)
          }
        }
        const qboCustomerIds = Array.from(linkedCustomers, ([id, name]) => ({ id, name }))
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
          appliedVendorCreditQboIds: appliedVendorCreditQboIds.length > 0 ? appliedVendorCreditQboIds : undefined,
          qboCustomerId: qboCustomerIds[0]?.id ?? null,
          qboCustomerName: qboCustomerIds[0]?.name ?? null,
          qboCustomerIds,
          linkedDocs: docAmounts.map((doc) => ({
            qboId: doc.qboId,
            docLabel: null,
            amountCents: doc.amountCents,
            projectName: null,
            inArc: false,
          })),
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
      expense_credit: new Set(),
      bill: new Set(),
      vendor_credit: new Set(),
      payment: new Set(),
      bill_payment: new Set(),
      journal_entry: new Set(),
      client_deposit: new Set(),
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

    const missingAny = linkedIds.some((id) => !linked[parentType].has(id) && !qboIdsByType[parentType].has(id))
    const allAlreadyLinked = linkedIds.every((id) => linked[parentType].has(id))

    if (missingAny) {
      record.dependencyStatus = "missing"
      record.dependencyMessage = parentType === "invoice"
        ? "Import all linked invoices first."
        : "Import all linked bills first."
    } else if (allAlreadyLinked) {
      record.dependencyStatus = "already_in_arc"
      record.dependencyMessage = parentType === "invoice"
        ? (linkedIds.length > 1 ? "Linked invoices are already in Arc." : "Linked invoice is already in Arc.")
        : (linkedIds.length > 1 ? "Linked bills are already in Arc." : "Linked bill is already in Arc.")
    } else {
      record.dependencyStatus = "available_to_import"
      record.dependencyMessage = parentType === "invoice"
        ? (linkedIds.length > 1 ? "Linked invoices are available in this list." : "Linked invoice is available in this list.")
        : (linkedIds.length > 1 ? "Linked bills are available in this list." : "Linked bill is available in this list.")
    }
  }

  const [invoiceCandidates, expenseCandidates, billCandidates] = await Promise.all([
    records.some((record) => record.entityType === "invoice")
      ? supabase
          .from("invoices")
          .select("id, invoice_number, title, total_cents, issue_date")
          .eq("org_id", resolvedOrgId)
          .is("qbo_id", null)
          .limit(500)
      : Promise.resolve({ data: [] as any[] }),
    records.some((record) => record.entityType === "expense")
      ? supabase
          .from("project_expenses")
          .select("id, description, vendor_name_text, amount_cents, expense_date")
          .eq("org_id", resolvedOrgId)
          .is("qbo_id", null)
          .limit(500)
      : Promise.resolve({ data: [] as any[] }),
    records.some((record) => record.entityType === "bill")
      ? supabase
          .from("vendor_bills")
          .select("id, bill_number, total_cents, bill_date")
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
      if (match) {
        record.possibleMatch = match.invoice_number ? `Invoice #${match.invoice_number}` : match.title ?? "Existing invoice"
        record.possibleMatchId = match.id
        record.possibleMatchEntityType = "invoice"
      }
    } else if (record.entityType === "expense") {
      const match = (expenseCandidates.data ?? []).find((expense: any) =>
        Number(expense.amount_cents ?? 0) === record.amountCents &&
        normalizeDate(expense.expense_date) === record.date &&
        (!record.counterparty || !expense.vendor_name_text || String(expense.vendor_name_text).toLowerCase() === record.counterparty.toLowerCase()),
      )
      if (match) {
        record.possibleMatch = match.description ?? match.vendor_name_text ?? "Existing expense"
        record.possibleMatchId = match.id
        record.possibleMatchEntityType = "project_expense"
      }
    } else if (record.entityType === "bill") {
      const match = (billCandidates.data ?? []).find((bill: any) =>
        (record.docNumber && bill.bill_number === record.docNumber) ||
        (Number(bill.total_cents ?? 0) === record.amountCents && normalizeDate(bill.bill_date) === record.date),
      )
      if (match) {
        record.possibleMatch = match.bill_number ? `Bill #${match.bill_number}` : "Existing bill"
        record.possibleMatchId = match.id
        record.possibleMatchEntityType = "bill"
      }
    }
  }

  // Resolve the read-only payment breakdown: map each linked invoice/bill QBO id to its Arc doc
  // number and project, so a payment shows where each portion of it lands.
  const linkedInvoiceQboIds = new Set<string>()
  const linkedBillQboIds = new Set<string>()
  for (const record of records) {
    if (!record.linkedDocs) continue
    const target = record.linkedEntityType === "invoice" ? linkedInvoiceQboIds : linkedBillQboIds
    for (const doc of record.linkedDocs) target.add(doc.qboId)
  }

  if (linkedInvoiceQboIds.size > 0 || linkedBillQboIds.size > 0) {
    const [linkedInvoiceRows, linkedBillRows] = await Promise.all([
      linkedInvoiceQboIds.size > 0
        ? supabase
            .from("invoices")
            .select("qbo_id, invoice_number, project_id")
            .eq("org_id", resolvedOrgId)
            .in("qbo_id", Array.from(linkedInvoiceQboIds))
        : Promise.resolve({ data: [] as any[] }),
      linkedBillQboIds.size > 0
        ? supabase
            .from("vendor_bills")
            .select("qbo_id, bill_number, project_id")
            .eq("org_id", resolvedOrgId)
            .in("qbo_id", Array.from(linkedBillQboIds))
        : Promise.resolve({ data: [] as any[] }),
    ])

    const invoiceByQboId = new Map(
      (linkedInvoiceRows.data ?? []).map((row: any) => [String(row.qbo_id), row]),
    )
    const billByQboId = new Map((linkedBillRows.data ?? []).map((row: any) => [String(row.qbo_id), row]))

    const projectIds = Array.from(
      new Set(
        [...(linkedInvoiceRows.data ?? []), ...(linkedBillRows.data ?? [])]
          .map((row: any) => row.project_id)
          .filter((id): id is string => Boolean(id)),
      ),
    )
    const projectNameById = new Map<string, string>()
    if (projectIds.length > 0) {
      const { data: projectRows } = await supabase
        .from("projects")
        .select("id, name, qbo_customer_id, qbo_customer_name")
        .eq("org_id", resolvedOrgId)
        .in("id", projectIds)
      for (const projectRow of projectRows ?? []) projectNameById.set(projectRow.id, projectRow.name)

      const projectById = new Map((projectRows ?? []).map((projectRow) => [projectRow.id, projectRow]))
      for (const record of records) {
        if (record.entityType !== "bill_payment" || !record.linkedDocs) continue
        const customers = new Map((record.qboCustomerIds ?? []).map((customer) => [customer.id, customer.name]))
        for (const doc of record.linkedDocs) {
          const billRow = billByQboId.get(doc.qboId)
          const projectRow = billRow?.project_id ? projectById.get(billRow.project_id) : null
          if (projectRow?.qbo_customer_id) {
            customers.set(String(projectRow.qbo_customer_id), projectRow.qbo_customer_name ?? projectRow.name)
          }
        }
        record.qboCustomerIds = Array.from(customers, ([id, name]) => ({ id, name }))
        record.qboCustomerId = record.qboCustomerIds[0]?.id ?? null
        record.qboCustomerName = record.qboCustomerIds[0]?.name ?? null
      }
    }

    for (const record of records) {
      if (!record.linkedDocs) continue
      const lookup = record.linkedEntityType === "invoice" ? invoiceByQboId : billByQboId
      for (const doc of record.linkedDocs) {
        const docRow = lookup.get(doc.qboId)
        if (!docRow) continue
        doc.inArc = true
        doc.docLabel =
          record.linkedEntityType === "invoice"
            ? (docRow.invoice_number ? `Invoice #${docRow.invoice_number}` : "Invoice")
            : (docRow.bill_number ? `Bill #${docRow.bill_number}` : "Bill")
        doc.projectName = docRow.project_id ? projectNameById.get(docRow.project_id) ?? null : null
      }
    }
  }

  records.sort(
    (a, b) =>
      (b.date ?? "").localeCompare(a.date ?? "") ||
      a.entityType.localeCompare(b.entityType) ||
      a.qboId.localeCompare(b.qboId),
  )
  return {
    connected: true,
    records,
    alreadyImportedCounts,
    loadErrors: loadErrors.length > 0 ? loadErrors : undefined,
  }
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
  const { error } = await params.supabase.from("qbo_sync_records").upsert(
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
  if (error) throw new Error(`Failed to save QuickBooks import mapping: ${error.message}`)
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

/**
 * Resolve which Arc project a costed line lands in, honoring (in order): an explicit per-line user
 * allocation, the line's QBO customer→project link, then the import target project. When the user
 * explicitly allocates a previously-unmapped customer, persist that customer→project link so every
 * future import auto-maps it — but never clobber a project that is already linked to a customer, and
 * never re-map a customer that already resolves elsewhere.
 */
async function resolveLineProject(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  lineId: string
  qboCustomerId: string | null
  qboCustomerName: string | null
  allocations: Record<string, string> | undefined
  projectByCustomer: Map<string, string>
  fallbackProjectId: string
}): Promise<string> {
  const { qboCustomerId, projectByCustomer } = params
  const override = params.allocations?.[params.lineId]
  if (override) {
    if (qboCustomerId && !projectByCustomer.has(qboCustomerId)) {
      await params.supabase
        .from("projects")
        .update({ qbo_customer_id: qboCustomerId, qbo_customer_name: params.qboCustomerName ?? null })
        .eq("org_id", params.orgId)
        .eq("id", override)
        .is("qbo_customer_id", null)
      projectByCustomer.set(qboCustomerId, override)
    }
    return override
  }
  return (qboCustomerId && projectByCustomer.get(qboCustomerId)) || params.fallbackProjectId
}

// Imported bills/expenses are inserted directly with status='approved', bypassing the
// in-app approval flow (propagateApprovalToLedger) that normally posts job-cost actuals.
// Without these entries the Margin KPI, budget pages, and reports treat the project as
// having zero cost. Post the actuals here, mirroring lib/services/job-cost-actuals.ts and
// the backfill migration. is_billable is left false (the actuals total is what matters for
// margin); we deliberately do NOT create billable_costs for historical imports. Idempotent
// via the job_cost_entries_source_unique index.
async function postJobCostActualsForImportedExpense(ctx: ResolvedContext, expenseId: string) {
  const { supabase, orgId } = ctx
  const { data: e } = await supabase
    .from("project_expenses")
    .select("id, project_id, cost_code_id, expense_date, amount_cents, tax_cents, created_at, metadata")
    .eq("org_id", orgId)
    .eq("id", expenseId)
    .maybeSingle()
  if (!e?.project_id) return
  const metadata = (e.metadata as { source?: string } | null) ?? {}
  const isExpenseCredit = String(metadata.source ?? "").startsWith("expense_credit")
  const costCents = Math.round(Number(e.amount_cents ?? 0) + Number(e.tax_cents ?? 0)) * (isExpenseCredit ? -1 : 1)

  await supabase.from("job_cost_entries").upsert(
    {
      org_id: orgId,
      project_id: e.project_id,
      cost_code_id: e.cost_code_id ?? null,
      source_type: "project_expense",
      source_id: e.id,
      incurred_on: e.expense_date ?? String(e.created_at).slice(0, 10),
      cost_cents: costCents,
      status: "posted",
      is_billable: false,
      metadata: {
        source_label: isExpenseCredit ? "project_expense_credit" : "project_expense",
        imported_from_qbo: true,
        ...(isExpenseCredit ? { source: "expense_credit" } : {}),
      },
    },
    { onConflict: "org_id,source_type,source_id" },
  )
}

async function postJobCostActualsForImportedBill(ctx: ResolvedContext, billId: string) {
  const { supabase, orgId } = ctx
  const { data: bill } = await supabase
    .from("vendor_bills")
    .select("id, project_id, bill_date, created_at")
    .eq("org_id", orgId)
    .eq("id", billId)
    .maybeSingle()
  if (!bill) return

  const { data: lines } = await supabase
    .from("bill_lines")
    .select("id, project_id, cost_code_id, unit_cost_cents, quantity")
    .eq("org_id", orgId)
    .eq("bill_id", billId)

  const incurredOn = bill.bill_date ?? String(bill.created_at).slice(0, 10)
  const rows = (lines ?? [])
    .map((l: any) => ({
      org_id: orgId,
      project_id: l.project_id ?? bill.project_id,
      cost_code_id: l.cost_code_id ?? null,
      source_type: "vendor_bill_line" as const,
      source_id: l.id,
      incurred_on: incurredOn,
      cost_cents: Math.round(Number(l.unit_cost_cents ?? 0) * Number(l.quantity ?? 1)),
      status: "posted" as const,
      is_billable: false,
      metadata: { source_label: "vendor_bill_line", bill_id: bill.id, imported_from_qbo: true },
    }))
    .filter((r) => r.project_id)
  if (rows.length === 0) return

  await supabase.from("job_cost_entries").upsert(rows, { onConflict: "org_id,source_type,source_id" })
}

async function deletePartialImportedBill(ctx: ResolvedContext, billId: string) {
  const { supabase, orgId } = ctx
  const { data: lines } = await supabase
    .from("bill_lines")
    .select("id")
    .eq("org_id", orgId)
    .eq("bill_id", billId)
  const lineIds = (lines ?? []).map((line) => line.id)
  if (lineIds.length > 0) {
    await supabase
      .from("job_cost_entries")
      .delete()
      .eq("org_id", orgId)
      .eq("source_type", "vendor_bill_line")
      .in("source_id", lineIds)
  }
  await supabase.from("vendor_bills").delete().eq("org_id", orgId).eq("id", billId)
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

async function importExpense(
  ctx: ResolvedContext,
  client: QBOClient,
  connectionId: string,
  projectId: string,
  qboId: string,
  allocations?: Record<string, string>,
) {
  const { supabase, orgId } = ctx

  const { data: existing } = await supabase
    .from("project_expenses")
    .select("id")
    .eq("org_id", orgId)
    .eq("qbo_id", qboId)
    .limit(1)
    .maybeSingle()
  if (existing?.id) return { skipped: true as const }

  const qbo = await client.getPurchaseById(qboId)
  if (!qbo) throw new Error("Expense not found in QuickBooks")
  if (qboPurchaseIsCredit(qbo)) {
    return importExpenseCredit(ctx, client, connectionId, projectId, qboId, allocations)
  }

  const totalCents = toCents(qbo.TotalAmt)
  const expenseDate = normalizeDate(qbo.TxnDate) ?? new Date().toISOString().split("T")[0]
  const vendorRef = qbo.EntityRef ?? qbo.VendorRef
  const nowIso = new Date().toISOString()

  // Account- or item-based expense lines may each carry a CustomerRef = the QBO job/project the cost
  // was coded to. A purchase split across multiple customers in QBO must fan out to the matching Arc
  // projects (job-costing), exactly like a multi-customer bill or journal entry.
  const expenseLines = ((qbo.Line ?? []) as any[]).filter(
    (line) => line?.AccountBasedExpenseLineDetail || line?.ItemBasedExpenseLineDetail,
  )
  const lineCustomerRef = (line: any) =>
    line?.AccountBasedExpenseLineDetail?.CustomerRef ?? line?.ItemBasedExpenseLineDetail?.CustomerRef ?? null
  const lineAccountRef = (line: any) =>
    line?.AccountBasedExpenseLineDetail?.AccountRef ?? line?.ItemBasedExpenseLineDetail?.ItemRef ?? null
  const lineClassRef = (line: any) =>
    line?.AccountBasedExpenseLineDetail?.ClassRef ?? line?.ItemBasedExpenseLineDetail?.ClassRef ?? null

  // Resolve each line's customer to an Arc project; lines without a (mappable) customer fall back to
  // the project the user is importing into.
  const customerIds = Array.from(
    new Set(
      expenseLines
        .map((line) => refValue(lineCustomerRef(line)))
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
  // Resolve every line's target project once (honoring per-line allocations and persisting any new
  // customer→project links the user chose), keyed by line id for the split/non-split paths below.
  const projectByLineId = new Map<string, string>()
  for (const line of expenseLines) {
    const customerRef = lineCustomerRef(line)
    projectByLineId.set(
      String(line.Id),
      await resolveLineProject({
        supabase,
        orgId,
        lineId: String(line.Id),
        qboCustomerId: refValue(customerRef),
        qboCustomerName: refName(customerRef),
        allocations,
        projectByCustomer,
        fallbackProjectId: projectId,
      }),
    )
  }
  const lineProjectFor = (line: any) => projectByLineId.get(String(line.Id)) ?? projectId
  const distinctProjects = new Set(expenseLines.map(lineProjectFor))

  // Single-project purchases (the common case) stay one pushable expense for the full amount, so the
  // existing two-way sync keeps working. Only fan out — as inbound-only shadow rows, like JE lines —
  // when the purchase genuinely spans more than one Arc project.
  const shouldSplit = expenseLines.length > 1 && distinctProjects.size > 1

  if (!shouldSplit) {
    // Honor the line-level job coding when every line shares one project (even if that's not the
    // project the user is importing from); fall back to the import target otherwise.
    const targetProjectId = distinctProjects.size === 1 ? [...distinctProjects][0] : projectId
    const firstLine = (qbo.Line ?? []).find((line: any) => line?.Description) ?? (qbo.Line ?? [])[0]
    const accountRef = lineAccountRef(expenseLines[0]) ?? null
    const classRef = lineClassRef(expenseLines[0]) ?? null
    const description = String(firstLine?.Description ?? qbo.PrivateNote ?? refName(accountRef) ?? "Imported QuickBooks expense")

    const { data: expenseRow, error: expenseError } = await supabase
      .from("project_expenses")
      .insert({
        org_id: orgId,
        project_id: targetProjectId,
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

    await postJobCostActualsForImportedExpense(ctx, expenseRow.id)
    await linkSyncRecord({ supabase, orgId, connectionId, entityType: "project_expense", entityId: expenseRow.id, qboId })
    await markEventsResolved(supabase, qboId)
    await recordEvent({
      orgId,
      actorId: ctx.userId,
      eventType: "expense_imported_from_qbo",
      entityType: "project_expense",
      entityId: expenseRow.id,
      payload: { qbo_id: qboId, amount_cents: totalCents, project_id: targetProjectId },
    })

    return { skipped: false as const, entityId: expenseRow.id }
  }

  // Split path: one expense per QBO line, each on its mapped project. These are inbound-only shadow
  // rows (pushable: false) — pushing several Arc expenses back onto the single source Purchase would
  // corrupt it — and carry the line id for idempotent re-import, mirroring journal-entry lines.
  let created = 0
  let firstEntityId: string | null = null
  for (const line of expenseLines) {
    const lineProjectId = lineProjectFor(line)
    const amountCents = Math.max(toCents(line.Amount), 0)
    const accountRef = lineAccountRef(line)
    const classRef = lineClassRef(line)
    const description = String(line.Description ?? qbo.PrivateNote ?? refName(accountRef) ?? "Imported QuickBooks expense")

    const { data: expenseRow, error: expenseError } = await supabase
      .from("project_expenses")
      .insert({
        org_id: orgId,
        project_id: lineProjectId,
        expense_date: expenseDate,
        description,
        amount_cents: amountCents,
        tax_cents: 0,
        is_billable: false,
        status: "approved",
        approved_by_pm_at: nowIso,
        approved_by_pm_user_id: ctx.userId,
        vendor_name_text: refName(vendorRef),
        payment_method: mapQboPaymentMethod(qbo.PaymentType),
        metadata: {
          imported_from_qbo: true,
          qbo_imported_at: nowIso,
          source: "purchase_split",
          qbo_purchase_id: qboId,
          qbo_purchase_line_id: String(line.Id),
        },
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
    firstEntityId ??= expenseRow.id

    await postJobCostActualsForImportedExpense(ctx, expenseRow.id)
    await linkSyncRecord({
      supabase,
      orgId,
      connectionId,
      entityType: "project_expense",
      entityId: expenseRow.id,
      qboId,
      pushable: false,
      metadata: { source: "purchase_split", qbo_purchase_line_id: String(line.Id) },
    })
    await recordEvent({
      orgId,
      actorId: ctx.userId,
      eventType: "expense_imported_from_qbo",
      entityType: "project_expense",
      entityId: expenseRow.id,
      payload: { qbo_id: qboId, source: "purchase_split", amount_cents: amountCents, project_id: lineProjectId },
    })
    created += 1
  }

  await markEventsResolved(supabase, qboId)
  return { skipped: created === 0, entityId: firstEntityId ?? undefined }
}

async function importExpenseCredit(
  ctx: ResolvedContext,
  client: QBOClient,
  connectionId: string,
  projectId: string,
  qboId: string,
  allocations?: Record<string, string>,
) {
  const { supabase, orgId } = ctx

  const { data: existing } = await supabase
    .from("project_expenses")
    .select("id")
    .eq("org_id", orgId)
    .eq("qbo_id", qboId)
    .limit(1)
    .maybeSingle()
  if (existing?.id) return { skipped: true as const }

  const qbo = await client.getPurchaseById(qboId)
  if (!qbo) throw new Error("Expense credit not found in QuickBooks")
  if (!qboPurchaseIsCredit(qbo)) throw new Error("QuickBooks purchase is not an expense credit")

  const totalCents = Math.abs(toCents(qbo.TotalAmt))
  const expenseDate = normalizeDate(qbo.TxnDate) ?? new Date().toISOString().split("T")[0]
  const vendorRef = qbo.EntityRef ?? qbo.VendorRef
  const nowIso = new Date().toISOString()

  const expenseLines = ((qbo.Line ?? []) as any[]).filter(
    (line) => line?.AccountBasedExpenseLineDetail || line?.ItemBasedExpenseLineDetail,
  )
  const lineCustomerRef = (line: any) =>
    line?.AccountBasedExpenseLineDetail?.CustomerRef ?? line?.ItemBasedExpenseLineDetail?.CustomerRef ?? null
  const lineAccountRef = (line: any) =>
    line?.AccountBasedExpenseLineDetail?.AccountRef ?? line?.ItemBasedExpenseLineDetail?.ItemRef ?? null
  const lineClassRef = (line: any) =>
    line?.AccountBasedExpenseLineDetail?.ClassRef ?? line?.ItemBasedExpenseLineDetail?.ClassRef ?? null

  const customerIds = Array.from(
    new Set(
      expenseLines
        .map((line) => refValue(lineCustomerRef(line)))
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

  const projectByLineId = new Map<string, string>()
  for (const line of expenseLines) {
    const customerRef = lineCustomerRef(line)
    projectByLineId.set(
      String(line.Id),
      await resolveLineProject({
        supabase,
        orgId,
        lineId: String(line.Id),
        qboCustomerId: refValue(customerRef),
        qboCustomerName: refName(customerRef),
        allocations,
        projectByCustomer,
        fallbackProjectId: projectId,
      }),
    )
  }
  const lineProjectFor = (line: any) => projectByLineId.get(String(line.Id)) ?? projectId
  const distinctProjects = new Set(expenseLines.map(lineProjectFor))
  const shouldSplit = expenseLines.length > 1 && distinctProjects.size > 1

  const baseMetadata = {
    source: "expense_credit",
    imported_from_qbo: true,
    qbo_imported_at: nowIso,
    qbo_purchase_credit: true,
    qbo_credit_total_cents: -totalCents,
  }

  if (!shouldSplit) {
    const targetProjectId = distinctProjects.size === 1 ? [...distinctProjects][0] : projectId
    const firstLine = (qbo.Line ?? []).find((line: any) => line?.Description) ?? (qbo.Line ?? [])[0]
    const accountRef = lineAccountRef(expenseLines[0]) ?? null
    const classRef = lineClassRef(expenseLines[0]) ?? null
    const description = String(firstLine?.Description ?? qbo.PrivateNote ?? refName(accountRef) ?? "Imported QuickBooks expense credit")

    const { data: expenseRow, error: expenseError } = await supabase
      .from("project_expenses")
      .insert({
        org_id: orgId,
        project_id: targetProjectId,
        expense_date: expenseDate,
        description,
        amount_cents: totalCents,
        tax_cents: 0,
        is_billable: false,
        status: "approved",
        approved_by_pm_at: nowIso,
        approved_by_pm_user_id: ctx.userId,
        vendor_name_text: refName(vendorRef),
        payment_method: mapQboPaymentMethod(qbo.PaymentType),
        metadata: baseMetadata,
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

    if (expenseError || !expenseRow) throw new Error(expenseError?.message ?? "Failed to create expense credit")

    await postJobCostActualsForImportedExpense(ctx, expenseRow.id)
    await linkSyncRecord({
      supabase,
      orgId,
      connectionId,
      entityType: "project_expense",
      entityId: expenseRow.id,
      qboId,
      pushable: false,
      metadata: { source: "expense_credit" },
    })
    await markEventsResolved(supabase, qboId)
    await recordEvent({
      orgId,
      actorId: ctx.userId,
      eventType: "expense_credit_imported_from_qbo",
      entityType: "project_expense",
      entityId: expenseRow.id,
      payload: { qbo_id: qboId, amount_cents: -totalCents, project_id: targetProjectId },
    })

    return { skipped: false as const, entityId: expenseRow.id }
  }

  let created = 0
  let firstEntityId: string | null = null
  for (const line of expenseLines) {
    const lineProjectId = lineProjectFor(line)
    const amountCents = Math.abs(toCents(line.Amount))
    const accountRef = lineAccountRef(line)
    const classRef = lineClassRef(line)
    const description = String(line.Description ?? qbo.PrivateNote ?? refName(accountRef) ?? "Imported QuickBooks expense credit")

    const { data: expenseRow, error: expenseError } = await supabase
      .from("project_expenses")
      .insert({
        org_id: orgId,
        project_id: lineProjectId,
        expense_date: expenseDate,
        description,
        amount_cents: amountCents,
        tax_cents: 0,
        is_billable: false,
        status: "approved",
        approved_by_pm_at: nowIso,
        approved_by_pm_user_id: ctx.userId,
        vendor_name_text: refName(vendorRef),
        payment_method: mapQboPaymentMethod(qbo.PaymentType),
        metadata: {
          ...baseMetadata,
          source: "expense_credit_split",
          qbo_purchase_id: qboId,
          qbo_purchase_line_id: String(line.Id),
          qbo_credit_line_cents: -amountCents,
        },
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

    if (expenseError || !expenseRow) throw new Error(expenseError?.message ?? "Failed to create expense credit")
    firstEntityId ??= expenseRow.id

    await postJobCostActualsForImportedExpense(ctx, expenseRow.id)
    await linkSyncRecord({
      supabase,
      orgId,
      connectionId,
      entityType: "project_expense",
      entityId: expenseRow.id,
      qboId,
      pushable: false,
      metadata: { source: "expense_credit_split", qbo_purchase_line_id: String(line.Id) },
    })
    await recordEvent({
      orgId,
      actorId: ctx.userId,
      eventType: "expense_credit_imported_from_qbo",
      entityType: "project_expense",
      entityId: expenseRow.id,
      payload: { qbo_id: qboId, source: "expense_credit_split", amount_cents: -amountCents, project_id: lineProjectId },
    })
    created += 1
  }

  await markEventsResolved(supabase, qboId)
  return { skipped: created === 0, entityId: firstEntityId ?? undefined }
}

async function importBill(
  ctx: ResolvedContext,
  client: QBOClient,
  connectionId: string,
  projectId: string,
  qboId: string,
  allocations?: Record<string, string>,
) {
  const { supabase, orgId } = ctx

  const { data: existing } = await supabase
    .from("vendor_bills")
    .select("id, metadata")
    .eq("org_id", orgId)
    .eq("qbo_id", qboId)
    .maybeSingle()
  if (existing?.id) {
    if ((existing.metadata as { qbo_import_complete?: boolean } | null)?.qbo_import_complete !== false) {
      return { skipped: true as const }
    }
    await deletePartialImportedBill(ctx, existing.id)
  }

  const qbo = await client.getBillById(qboId)
  if (!qbo) throw new Error("Bill not found in QuickBooks")

  const totalCents = toCents(qbo.TotalAmt)
  const balanceCents = qbo.Balance != null ? toCents(qbo.Balance) : totalCents
  const paidCents = Math.max(totalCents - balanceCents, 0)
  const billDate = normalizeDate(qbo.TxnDate)
  const dueDate = normalizeDate(qbo.DueDate)
  const vendorRef = qbo.VendorRef
  const accountLine = (qbo.Line ?? []).find((line: any) => expenseLineDetail(line))
  const accountDetail = expenseLineDetail(accountLine)
  const accountRef = accountDetail?.AccountRef ?? accountDetail?.ItemRef
  const classRef = accountDetail?.ClassRef
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
      metadata: { imported_from_qbo: true, qbo_imported_at: nowIso, qbo_import_complete: false },
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
  const expenseLines = (qbo.Line ?? []).filter((line: any) => expenseLineDetail(line))
  if (expenseLines.length > 0) {
    const customerIds = Array.from(
      new Set(
        expenseLines
          .map((line: any) => refValue(expenseLineDetail(line)?.CustomerRef))
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

    const lineRows = []
    for (const [index, line] of expenseLines.entries()) {
      const detail = expenseLineDetail(line)
      const customerRef = detail?.CustomerRef ?? null
      const lineProjectId = await resolveLineProject({
        supabase,
        orgId,
        lineId: String(line.Id),
        qboCustomerId: refValue(customerRef),
        qboCustomerName: refName(customerRef),
        allocations,
        projectByCustomer,
        fallbackProjectId: projectId,
      })
      lineRows.push({
        org_id: orgId,
        bill_id: billRow.id,
        project_id: lineProjectId,
        cost_code_id: null,
        description: String(line.Description ?? refName(detail?.AccountRef ?? detail?.ItemRef) ?? "Imported QuickBooks line"),
        quantity: 1,
        unit: "LS",
        unit_cost_cents: toCents(line.Amount),
        sort_order: index,
        metadata: {
          source: "qbo_import",
          qbo_expense_account_id: refValue(detail?.AccountRef),
          qbo_expense_account_name: refName(detail?.AccountRef ?? detail?.ItemRef),
          qbo_class_id: refValue(detail?.ClassRef),
          qbo_class_name: refName(detail?.ClassRef),
        },
      })
    }

    const { error: linesError } = await supabase.from("bill_lines").insert(lineRows)
    if (linesError) {
      await supabase.from("vendor_bills").delete().eq("org_id", orgId).eq("id", billRow.id)
      throw new Error(`Failed to create bill lines: ${linesError.message}`)
    }
  }

  await postJobCostActualsForImportedBill(ctx, billRow.id)
  await linkSyncRecord({ supabase, orgId, connectionId, entityType: "bill", entityId: billRow.id, qboId })
  const { error: completeBillError } = await supabase
    .from("vendor_bills")
    .update({ metadata: { imported_from_qbo: true, qbo_imported_at: nowIso, qbo_import_complete: true } })
    .eq("org_id", orgId)
    .eq("id", billRow.id)
  if (completeBillError) throw new Error(`Failed to finalize imported bill: ${completeBillError.message}`)
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

/**
 * Import a QBO vendor credit as a *negative* vendor bill. A VendorCredit posts Cr Expense / Dr A/P,
 * so it reduces project cost by its full amount — mirrored here as a vendor_bills row with negative
 * total + negative lines (tagged metadata.source = "vendor_credit"). It is inbound-only
 * (`pushable: false`): the source of truth is the QBO VendorCredit, never reconstructed outbound.
 * Per-line CustomerRef → Arc project allocation works exactly as for bills. We deliberately do not
 * track how much of the credit has been applied — Arc shows the full credit, QBO owns the running
 * unapplied balance.
 */
async function importVendorCredit(
  ctx: ResolvedContext,
  client: QBOClient,
  connectionId: string,
  projectId: string,
  qboId: string,
  allocations?: Record<string, string>,
) {
  const { supabase, orgId } = ctx

  const { data: existing } = await supabase
    .from("vendor_bills")
    .select("id, metadata")
    .eq("org_id", orgId)
    .eq("qbo_id", qboId)
    .eq("metadata->>source", "vendor_credit")
    .maybeSingle()
  if (existing?.id) {
    if ((existing.metadata as { qbo_import_complete?: boolean } | null)?.qbo_import_complete !== false) {
      return { skipped: true as const }
    }
    await deletePartialImportedBill(ctx, existing.id)
  }

  const qbo = await client.getVendorCreditById(qboId)
  if (!qbo) throw new Error("Vendor credit not found in QuickBooks")

  const totalCents = qboVendorCreditCents(qbo.TotalAmt)
  const txnDate = normalizeDate(qbo.TxnDate)
  const vendorRef = qbo.VendorRef
  const accountLine = (qbo.Line ?? []).find((line: any) => expenseLineDetail(line))
  const accountDetail = expenseLineDetail(accountLine)
  const accountRef = accountDetail?.AccountRef ?? accountDetail?.ItemRef
  const classRef = accountDetail?.ClassRef
  const nowIso = new Date().toISOString()

  const { data: creditRow, error: creditError } = await supabase
    .from("vendor_bills")
    .insert({
      org_id: orgId,
      project_id: projectId,
      bill_number: qbo.DocNumber ? String(qbo.DocNumber) : null,
      // A credit has no payment lifecycle of its own; it stands as an approved negative payable.
      status: "approved",
      bill_date: txnDate,
      due_date: null,
      total_cents: totalCents,
      paid_cents: 0,
      currency: "usd",
      approved_at: nowIso,
      approved_by: ctx.userId,
      metadata: {
        source: "vendor_credit",
        imported_from_qbo: true,
        qbo_imported_at: nowIso,
        qbo_import_complete: false,
      },
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

  if (creditError || !creditRow) throw new Error(creditError?.message ?? "Failed to create vendor credit")

  const creditLines = (qbo.Line ?? []).filter((line: any) => expenseLineDetail(line))
  if (creditLines.length > 0) {
    const customerIds = Array.from(
      new Set(
        creditLines
          .map((line: any) => refValue(expenseLineDetail(line)?.CustomerRef))
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

    const lineRows = []
    for (const [index, line] of creditLines.entries()) {
      const detail = expenseLineDetail(line)
      const customerRef = detail?.CustomerRef ?? null
      const lineProjectId = await resolveLineProject({
        supabase,
        orgId,
        lineId: String(line.Id),
        qboCustomerId: refValue(customerRef),
        qboCustomerName: refName(customerRef),
        allocations,
        projectByCustomer,
        fallbackProjectId: projectId,
      })
      lineRows.push({
        org_id: orgId,
        bill_id: creditRow.id,
        project_id: lineProjectId,
        cost_code_id: null,
        description: String(
          line.Description ?? refName(detail?.AccountRef ?? detail?.ItemRef) ?? "Imported QuickBooks vendor credit line",
        ),
        quantity: 1,
        unit: "LS",
        // Negative so the credit reduces the project's job cost.
        unit_cost_cents: qboVendorCreditCents(line.Amount),
        sort_order: index,
        metadata: {
          source: "vendor_credit",
          qbo_expense_account_id: refValue(detail?.AccountRef),
          qbo_expense_account_name: refName(detail?.AccountRef ?? detail?.ItemRef),
          qbo_class_id: refValue(detail?.ClassRef),
          qbo_class_name: refName(detail?.ClassRef),
        },
      })
    }

    const { error: linesError } = await supabase.from("bill_lines").insert(lineRows)
    if (linesError) {
      await supabase.from("vendor_bills").delete().eq("org_id", orgId).eq("id", creditRow.id)
      throw new Error(`Failed to create vendor credit lines: ${linesError.message}`)
    }
  }

  await postJobCostActualsForImportedBill(ctx, creditRow.id)
  await linkSyncRecord({
    supabase,
    orgId,
    connectionId,
    entityType: "vendor_credit",
    entityId: creditRow.id,
    qboId,
    pushable: false,
  })
  const { error: completeCreditError } = await supabase
    .from("vendor_bills")
    .update({
      metadata: {
        source: "vendor_credit",
        imported_from_qbo: true,
        qbo_imported_at: nowIso,
        qbo_import_complete: true,
      },
    })
    .eq("org_id", orgId)
    .eq("id", creditRow.id)
  if (completeCreditError) {
    throw new Error(`Failed to finalize imported vendor credit: ${completeCreditError.message}`)
  }
  await markEventsResolved(supabase, qboId)
  await recordEvent({
    orgId,
    actorId: ctx.userId,
    eventType: "vendor_credit_imported_from_qbo",
    entityType: "vendor_bill",
    entityId: creditRow.id,
    payload: { qbo_id: qboId, total_cents: totalCents, project_id: projectId },
  })

  return { skipped: false as const, entityId: creditRow.id }
}

async function upsertPaymentAllocation({
  supabase,
  orgId,
  paymentId,
  invoiceId,
  projectId,
  amountCents,
  metadata,
}: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  paymentId: string
  invoiceId: string
  projectId?: string | null
  amountCents: number
  metadata: Record<string, any>
}) {
  const { data: existing, error: existingError } = await supabase
    .from("payment_allocations")
    .select("id")
    .eq("org_id", orgId)
    .eq("payment_id", paymentId)
    .eq("invoice_id", invoiceId)
    .maybeSingle()

  if (existingError) {
    throw new Error(`Failed to check payment allocation: ${existingError.message}`)
  }

  if (existing?.id) {
    const { error } = await supabase
      .from("payment_allocations")
      .update({
        project_id: projectId ?? null,
        amount_cents: amountCents,
        metadata,
      })
      .eq("org_id", orgId)
      .eq("id", existing.id)
    if (error) throw new Error(`Failed to update payment allocation: ${error.message}`)
    return existing.id as string
  }

  const { data, error } = await supabase
    .from("payment_allocations")
    .insert({
      org_id: orgId,
      project_id: projectId ?? null,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: amountCents,
      metadata,
    })
    .select("id")
    .single()

  if (error || !data) throw new Error(error?.message ?? "Failed to create payment allocation")
  return data.id as string
}

async function importPayment(ctx: ResolvedContext, client: QBOClient, connectionId: string, qboId: string) {
  const { supabase, orgId } = ctx

  const qbo = await client.getPaymentById(qboId)
  if (!qbo) throw new Error("Payment not found in QuickBooks")

  const linkedInvoiceQboIds = extractLinkedInvoiceQboIds(qbo)
  if (linkedInvoiceQboIds.length === 0) {
    throw new Error("This payment isn't linked to an invoice in QuickBooks.")
  }

  // Fetch all linked invoices
  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, project_id, qbo_id")
    .eq("org_id", orgId)
    .in("qbo_id", linkedInvoiceQboIds)

  if (!invoices || invoices.length === 0) {
    throw new Error("Import all linked invoices first, then import this payment.")
  }

  const invoiceByQboId = new Map(invoices.map((inv) => [inv.qbo_id, inv]))

  const receivedAt = normalizeDate(qbo.TxnDate)
  const nowIso = new Date().toISOString()
  let created = 0
  let firstEntityId: string | null = null

  const paymentApplications = extractLinkedDocAmounts(qbo, "invoice").filter((application) => application.amountCents > 0)
  const isAllocatedPayment = paymentApplications.length > 1

  if (isAllocatedPayment) {
    const { data: legacySplitRows } = await supabase
      .from("payments")
      .select("id, invoice_id")
      .eq("org_id", orgId)
      .eq("provider", "qbo")
      .like("provider_payment_id", `qbo_payment_${qboId}_%`)

    if ((legacySplitRows ?? []).length > 0) {
      firstEntityId = legacySplitRows?.[0]?.id ?? null
      for (const row of legacySplitRows ?? []) {
        await linkSyncRecord({
          supabase,
          orgId,
          connectionId,
          entityType: "payment",
          entityId: row.id,
          qboId,
          pushable: false,
          metadata: { source: "legacy_payment_split" },
        })
        if (row.invoice_id) {
          await recalcInvoiceBalanceAndStatus({ supabase, orgId, invoiceId: row.invoice_id })
        }
      }
      await markEventsResolved(supabase, qboId)
      return { skipped: true as const, entityId: firstEntityId ?? undefined }
    }
  }

  if (isAllocatedPayment) {
    const totalCents = paymentApplications.reduce((sum, application) => sum + application.amountCents, 0)
    const firstInvoice = invoiceByQboId.get(paymentApplications[0]?.qboId)
    const providerPaymentId = qboImportProviderPaymentId({
      kind: "payment",
      qboId,
      split: false,
      lineId: "payment",
    })

    const { data: existingPayment } = await supabase
      .from("payments")
      .select("id")
      .eq("org_id", orgId)
      .eq("provider", "qbo")
      .eq("provider_payment_id", providerPaymentId)
      .maybeSingle()

    let paymentId = existingPayment?.id as string | undefined
    if (!paymentId) {
      const { data: paymentRow, error: paymentError } = await supabase
        .from("payments")
        .insert({
          org_id: orgId,
          project_id: firstInvoice?.project_id ?? null,
          invoice_id: null,
          amount_cents: totalCents,
          gross_cents: totalCents,
          net_cents: totalCents,
          currency: "usd",
          method: "other",
          provider: "qbo",
          provider_payment_id: providerPaymentId,
          status: "succeeded",
          received_at: receivedAt ? new Date(receivedAt).toISOString() : nowIso,
          metadata: {
            imported_from_qbo: true,
            qbo_id: qboId,
            qbo_imported_at: nowIso,
            source: "payment_allocation",
            allocation_count: paymentApplications.length,
          },
        })
        .select("id")
        .single()

      if (paymentError || !paymentRow) throw new Error(paymentError?.message ?? "Failed to record payment")
      paymentId = paymentRow.id
      created += 1
    }
    if (!paymentId) throw new Error("Failed to resolve imported payment")

    firstEntityId = paymentId

    await linkSyncRecord({
      supabase,
      orgId,
      connectionId,
      entityType: "payment",
      entityId: paymentId,
      qboId,
      pushable: false,
      metadata: { source: "payment_allocation", allocation_count: paymentApplications.length },
    })

    for (const application of paymentApplications) {
      const invoice = invoiceByQboId.get(application.qboId)
      if (!invoice) {
        throw new Error(`Linked invoice ${application.qboId} not found in Arc. Import all linked invoices first.`)
      }
      await upsertPaymentAllocation({
        supabase,
        orgId,
        paymentId,
        invoiceId: invoice.id,
        projectId: invoice.project_id,
        amountCents: application.amountCents,
        metadata: {
          imported_from_qbo: true,
          qbo_id: qboId,
          qbo_invoice_id: application.qboId,
          qbo_imported_at: nowIso,
        },
      })
      await recalcInvoiceBalanceAndStatus({ supabase, orgId, invoiceId: invoice.id })
    }

    await recordEvent({
      orgId,
      actorId: ctx.userId,
      eventType: "payment_imported_from_qbo",
      entityType: "payment",
      entityId: paymentId,
      payload: {
        qbo_id: qboId,
        amount_cents: totalCents,
        source: "payment_allocation",
        allocation_count: paymentApplications.length,
      },
    })

    await markEventsResolved(supabase, qboId)
    return { skipped: created === 0, entityId: firstEntityId ?? undefined }
  }

  for (const application of paymentApplications) {
    const invoice = invoiceByQboId.get(application.qboId)
    if (!invoice) {
      throw new Error(`Linked invoice ${application.qboId} not found in Arc. Import all linked invoices first.`)
    }

    const amountCents = application.amountCents
    if (amountCents <= 0) continue
    const providerPaymentId = qboImportProviderPaymentId({
      kind: "payment",
      qboId,
      split: false,
      lineId: "payment",
    })

    const { data: existingPayment } = await supabase
      .from("payments")
      .select("id")
      .eq("org_id", orgId)
      .eq("provider", "qbo")
      .eq("provider_payment_id", providerPaymentId)
      .maybeSingle()
    if (existingPayment?.id) {
      firstEntityId ??= existingPayment.id
      await linkSyncRecord({
        supabase,
        orgId,
        connectionId,
        entityType: "payment",
        entityId: existingPayment.id,
        qboId,
        pushable: true,
      })
      await recalcInvoiceBalanceAndStatus({ supabase, orgId, invoiceId: invoice.id })
      continue
    }

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
        provider_payment_id: providerPaymentId,
        status: "succeeded",
        received_at: receivedAt ? new Date(receivedAt).toISOString() : nowIso,
        metadata: {
          imported_from_qbo: true,
          qbo_id: qboId,
          qbo_imported_at: nowIso,
        },
      })
      .select("id")
      .single()

    if (paymentError || !paymentRow) throw new Error(paymentError?.message ?? "Failed to record payment")

    firstEntityId ??= paymentRow.id

    await linkSyncRecord({
      supabase,
      orgId,
      connectionId,
      entityType: "payment",
      entityId: paymentRow.id,
      qboId,
      pushable: true,
    })
    await recalcInvoiceBalanceAndStatus({ supabase, orgId, invoiceId: invoice.id })
    await recordEvent({
      orgId,
      actorId: ctx.userId,
      eventType: "payment_imported_from_qbo",
      entityType: "payment",
      entityId: paymentRow.id,
      payload: {
        qbo_id: qboId,
        amount_cents: amountCents,
        invoice_id: invoice.id,
      },
    })

    created += 1
  }

  await markEventsResolved(supabase, qboId)

  return { skipped: created === 0, entityId: firstEntityId ?? undefined }
}

async function importBillPayment(ctx: ResolvedContext, client: QBOClient, connectionId: string, qboId: string) {
  const { supabase, orgId } = ctx

  const qbo = await client.getBillPaymentById(qboId)
  if (!qbo) throw new Error("Bill payment not found in QuickBooks")

  const linkedBillQboIds = extractLinkedBillQboIds(qbo)
  if (linkedBillQboIds.length === 0) {
    throw new Error("This bill payment isn't linked to a bill in QuickBooks.")
  }

  const { data: bills } = await supabase
    .from("vendor_bills")
    .select("id, project_id, total_cents, paid_cents, qbo_id")
    .eq("org_id", orgId)
    .in("qbo_id", linkedBillQboIds)

  if (!bills || bills.length === 0) {
    throw new Error("Import all linked bills first, then import this bill payment.")
  }

  const billByQboId = new Map(bills.map((b) => [b.qbo_id, b]))

  const receivedAt = normalizeDate(qbo.TxnDate)
  const nowIso = new Date().toISOString()
  let insertedAny = false
  let firstEntityId: string | null = null

  // A bill payment might apply to multiple bills. Create payment records for each.
  const paymentLines = (qbo.Line ?? []).filter((line: any) =>
    line?.LinkedTxn?.some((txn: any) => String(txn?.TxnType ?? "").toLowerCase() === "bill"),
  )
  const shouldSplit = paymentLines.length > 1
  let remainingCreditCents = extractAppliedVendorCredits(qbo).reduce((sum, c) => sum + c.amountCents, 0)

  for (const line of paymentLines) {
    const linkedTxn = line.LinkedTxn.find((txn: any) => String(txn?.TxnType ?? "").toLowerCase() === "bill")
    if (!linkedTxn?.TxnId) continue

    const bill = billByQboId.get(String(linkedTxn.TxnId))
    if (!bill) {
      throw new Error(`Linked bill ${linkedTxn.TxnId} not found in Arc. Import all linked bills first.`)
    }

    const lineTotalCents = toCents(line.Amount)
    if (lineTotalCents <= 0) continue

    // Distribute any applied vendor credits across the lines until exhausted.
    const creditForThisLine = Math.min(lineTotalCents, remainingCreditCents)
    const cashForThisLine = lineTotalCents - creditForThisLine
    remainingCreditCents -= creditForThisLine

    const paymentsToInsert = []
    if (cashForThisLine > 0) {
      paymentsToInsert.push({
        amount_cents: cashForThisLine,
        gross_cents: cashForThisLine,
        net_cents: cashForThisLine,
        provider_payment_id: qboImportProviderPaymentId({
          kind: "billpayment",
          qboId,
          split: shouldSplit,
          lineId: String(line.Id || linkedTxn.TxnId),
        }),
        metadata: {
          imported_from_qbo: true,
          qbo_id: qboId,
          qbo_imported_at: nowIso,
          ...(shouldSplit ? { source: "payment_split", qbo_payment_line_id: String(line.Id || linkedTxn.TxnId) } : {}),
        },
      })
    }
    if (creditForThisLine > 0) {
      paymentsToInsert.push({
        amount_cents: creditForThisLine,
        gross_cents: creditForThisLine,
        net_cents: creditForThisLine,
        provider_payment_id: qboImportProviderPaymentId({
          kind: "billpayment",
          qboId,
          split: shouldSplit,
          lineId: String(line.Id || linkedTxn.TxnId),
          vendorCredit: true,
        }),
        metadata: {
          imported_from_qbo: true,
          qbo_id: qboId,
          qbo_imported_at: nowIso,
          vendor_credit_applied: true,
          ...(shouldSplit ? { source: "payment_split", qbo_payment_line_id: `${line.Id || linkedTxn.TxnId}_vc` } : {}),
        },
      })
    }

    for (const p of paymentsToInsert) {
      const { data: existingPayment } = await supabase
        .from("payments")
        .select("id")
        .eq("org_id", orgId)
        .eq("provider", "qbo")
        .eq("provider_payment_id", p.provider_payment_id)
        .maybeSingle()
      if (existingPayment?.id) {
        firstEntityId ??= existingPayment.id
        await linkSyncRecord({
          supabase,
          orgId,
          connectionId,
          entityType: "bill_payment",
          entityId: existingPayment.id,
          qboId,
          pushable: !shouldSplit,
          metadata: shouldSplit ? { source: "payment_split", qbo_payment_line_id: p.metadata.qbo_payment_line_id } : undefined,
        })
        continue
      }

      const { data: paymentRow, error: paymentError } = await supabase
        .from("payments")
        .insert({
          org_id: orgId,
          project_id: bill.project_id,
          bill_id: bill.id,
          currency: "usd",
          method: "other",
          provider: "qbo",
          status: "succeeded",
          received_at: receivedAt ? new Date(receivedAt).toISOString() : nowIso,
          ...p,
        })
        .select("id")
        .single()

      if (paymentError || !paymentRow) throw new Error(paymentError?.message ?? "Failed to record bill payment")

      insertedAny = true
      firstEntityId ??= paymentRow.id

      await linkSyncRecord({
        supabase,
        orgId,
        connectionId,
        entityType: "bill_payment",
        entityId: paymentRow.id,
        qboId,
        pushable: !shouldSplit,
        metadata: shouldSplit ? { source: "payment_split", qbo_payment_line_id: p.metadata.qbo_payment_line_id } : undefined,
      })
      await recordEvent({
        orgId,
        actorId: ctx.userId,
        eventType: "bill_payment_imported_from_qbo",
        entityType: "payment",
        entityId: paymentRow.id,
        payload: {
          qbo_id: qboId,
          amount_cents: p.amount_cents,
          bill_id: bill.id,
          vendor_credit_applied:
            "vendor_credit_applied" in p.metadata ? p.metadata.vendor_credit_applied : false,
          ...(shouldSplit ? { source: "payment_split" } : {}),
        },
      })
    }

    // Derive paid_cents from the payment ledger (the source of truth) rather than blindly adding
    const { data: ledgerRows } = await supabase
      .from("payments")
      .select("amount_cents")
      .eq("org_id", orgId)
      .eq("bill_id", bill.id)
      .eq("status", "succeeded")
    const ledgerPaid = (ledgerRows ?? []).reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0)
    const nextPaid = bill.total_cents != null ? Math.min(ledgerPaid, Number(bill.total_cents)) : ledgerPaid
    const fullyPaid = bill.total_cents != null && nextPaid >= Number(bill.total_cents)
    await supabase
      .from("vendor_bills")
      .update({
        paid_cents: nextPaid,
        ...(fullyPaid ? { status: "paid", paid_at: nowIso } : {}),
      })
      .eq("org_id", orgId)
      .eq("id", bill.id)

  }

  await markEventsResolved(supabase, qboId)

  return { skipped: !insertedAny, entityId: firstEntityId ?? undefined }
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
  allocations?: Record<string, string>,
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
    const lineProjectId = await resolveLineProject({
      supabase,
      orgId,
      lineId: String(line.Id),
      qboCustomerId: customerId,
      qboCustomerName: isCustomer ? refName(entity?.EntityRef) : null,
      allocations,
      projectByCustomer,
      fallbackProjectId: projectId,
    })
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

    await postJobCostActualsForImportedExpense(ctx, expenseRow.id)
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
 * Import the income lines of a QBO JournalEntry as historical client deposits. Each income line that
 * credits a Construction Income (or other Income) account is reconstructed in Arc's own grammar as a
 * paid historical invoice + payment on the line's mapped project — the only representation that shows
 * up correctly in receivables, collected revenue, and the payments ledger. These are inbound-only
 * shadow records (pushable: false): the source of truth stays the original JournalEntry in QBO, so
 * the two-way sync must never push them back.
 */
async function importClientDeposit(
  ctx: ResolvedContext,
  client: QBOClient,
  connectionId: string,
  projectId: string,
  qboId: string,
  incomeAccountIds: Set<string>,
  allocations?: Record<string, string>,
) {
  const { supabase, orgId } = ctx

  const qbo = await client.getJournalEntryById(qboId)
  if (!qbo) throw new Error("Journal entry not found in QuickBooks")

  const incomeLines = ((qbo.Line ?? []) as any[]).filter(
    (line) =>
      line?.DetailType === "JournalEntryLineDetail" &&
      incomeAccountIds.has(refValue(line.JournalEntryLineDetail?.AccountRef) ?? ""),
  )
  if (incomeLines.length === 0) return { skipped: true as const }

  // Line-level idempotency: skip income lines already turned into a historical invoice.
  const { data: existingRows } = await supabase
    .from("invoices")
    .select("metadata")
    .eq("org_id", orgId)
    .eq("qbo_id", qboId)
    .eq("metadata->>source", "client_deposit")
  const importedLineIds = new Set<string>()
  for (const row of existingRows ?? []) {
    const lineId = (row.metadata as { qbo_je_line_id?: string } | null)?.qbo_je_line_id
    if (lineId != null) importedLineIds.add(String(lineId))
  }
  const pending = incomeLines.filter((line) => !importedLineIds.has(String(line.Id)))
  if (pending.length === 0) return { skipped: true as const }

  // Resolve each income line's QBO customer (job) to an Arc project; lines without a mappable
  // customer fall back to the project the user is importing into.
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
  const depositDate = normalizeDate(qbo.TxnDate) ?? nowIso.split("T")[0]
  let created = 0
  let firstEntityId: string | null = null

  for (const line of pending) {
    const detail = line.JournalEntryLineDetail
    const isCredit = String(detail?.PostingType ?? "").toLowerCase() === "credit"
    const amountCents = toCents(line.Amount) * (isCredit ? 1 : -1)
    // A non-positive line (a debit/reversal with no offsetting credit) isn't a deposit; skip it.
    if (amountCents <= 0) continue

    const entity = detail?.Entity
    const isCustomer = String(entity?.Type ?? "").toLowerCase() === "customer"
    const customerId = isCustomer ? refValue(entity?.EntityRef) : null
    const lineProjectId = await resolveLineProject({
      supabase,
      orgId,
      lineId: String(line.Id),
      qboCustomerId: customerId,
      qboCustomerName: isCustomer ? refName(entity?.EntityRef) : null,
      allocations,
      projectByCustomer,
      fallbackProjectId: projectId,
    })
    const description = String(line.Description ?? qbo.PrivateNote ?? "Historical client deposit")

    const { data: invoiceRow, error: invoiceError } = await supabase
      .from("invoices")
      .insert({
        org_id: orgId,
        project_id: lineProjectId,
        invoice_number: `HIST-${qboId}-${line.Id}`,
        title: "Historical client deposit",
        status: "paid",
        issue_date: depositDate,
        due_date: depositDate,
        subtotal_cents: amountCents,
        tax_cents: 0,
        total_cents: amountCents,
        balance_due_cents: 0,
        currency: "usd",
        client_visible: false,
        notes: description,
        metadata: {
          imported_from_qbo: true,
          qbo_imported_at: nowIso,
          historical: true,
          source: "client_deposit",
          qbo_je_id: qboId,
          qbo_je_line_id: String(line.Id),
        },
        qbo_id: qboId,
        qbo_synced_at: nowIso,
        qbo_sync_status: "synced",
      })
      .select("id")
      .single()

    if (invoiceError || !invoiceRow) throw new Error(invoiceError?.message ?? "Failed to create historical deposit invoice")
    firstEntityId ??= invoiceRow.id

    const { error: lineError } = await supabase.from("invoice_lines").insert({
      org_id: orgId,
      invoice_id: invoiceRow.id,
      cost_code_id: null,
      description,
      quantity: 1,
      unit: "ea",
      unit_price_cents: amountCents,
      metadata: { taxable: false, source: "client_deposit" },
    })
    if (lineError) {
      await supabase.from("invoices").delete().eq("org_id", orgId).eq("id", invoiceRow.id)
      throw new Error(`Failed to create historical deposit line: ${lineError.message}`)
    }

    const { data: paymentRow, error: paymentError } = await supabase
      .from("payments")
      .insert({
        org_id: orgId,
        project_id: lineProjectId,
        invoice_id: invoiceRow.id,
        amount_cents: amountCents,
        gross_cents: amountCents,
        net_cents: amountCents,
        currency: "usd",
        method: "other",
        provider: "qbo",
        provider_payment_id: `qbo_deposit_${qboId}_${line.Id}`,
        status: "succeeded",
        received_at: new Date(depositDate).toISOString(),
        metadata: {
          imported_from_qbo: true,
          historical: true,
          source: "client_deposit",
          qbo_je_id: qboId,
          qbo_je_line_id: String(line.Id),
        },
      })
      .select("id")
      .single()

    if (paymentError || !paymentRow) throw new Error(paymentError?.message ?? "Failed to record historical deposit payment")

    await linkSyncRecord({
      supabase,
      orgId,
      connectionId,
      entityType: "invoice",
      entityId: invoiceRow.id,
      qboId,
      pushable: false,
      metadata: { source: "client_deposit", qbo_je_line_id: String(line.Id) },
    })
    await linkSyncRecord({
      supabase,
      orgId,
      connectionId,
      entityType: "payment",
      entityId: paymentRow.id,
      qboId,
      pushable: false,
      metadata: { source: "client_deposit", qbo_je_line_id: String(line.Id) },
    })
    await recalcInvoiceBalanceAndStatus({ supabase, orgId, invoiceId: invoiceRow.id })
    await recordEvent({
      orgId,
      actorId: ctx.userId,
      eventType: "client_deposit_imported_from_qbo",
      entityType: "invoice",
      entityId: invoiceRow.id,
      payload: { qbo_id: qboId, source: "client_deposit", amount_cents: amountCents, project_id: lineProjectId },
    })
    created += 1
  }

  await markEventsResolved(supabase, qboId)
  return { skipped: created === 0, entityId: firstEntityId ?? undefined }
}

export async function linkExistingQboImportRecord({
  orgId,
  qboId,
  entityType,
  existingEntityId,
}: {
  orgId?: string
  qboId: string
  entityType: "invoice" | "expense" | "bill"
  existingEntityId: string
}): Promise<{ linked: true }> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: entityType === "invoice" ? "invoice.write" : "bill.write",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
  })

  const connectionId = await getActiveConnectionId(supabase, resolvedOrgId)
  if (!connectionId) throw new Error("QuickBooks isn't connected for this organization.")

  const nowIso = new Date().toISOString()
  if (entityType === "invoice") {
    const { data, error } = await supabase
      .from("invoices")
      .update({ qbo_id: qboId, qbo_synced_at: nowIso, qbo_sync_status: "synced" })
      .eq("org_id", resolvedOrgId)
      .eq("id", existingEntityId)
      .is("qbo_id", null)
      .select("id")
      .maybeSingle()
    if (error || !data?.id) throw new Error(error?.message ?? "Invoice is already linked or no longer exists.")
    await linkSyncRecord({ supabase, orgId: resolvedOrgId, connectionId, entityType: "invoice", entityId: data.id, qboId })
    await markEventsResolved(supabase, qboId)
    await recordEvent({
      orgId: resolvedOrgId,
      actorId: userId,
      eventType: "qbo_import_linked_existing",
      entityType: "invoice",
      entityId: data.id,
      payload: { qbo_id: qboId },
    })
    return { linked: true }
  }

  if (entityType === "expense") {
    const { data, error } = await supabase
      .from("project_expenses")
      .update({ qbo_id: qboId, qbo_transaction_type: "purchase", qbo_synced_at: nowIso, qbo_sync_status: "synced" })
      .eq("org_id", resolvedOrgId)
      .eq("id", existingEntityId)
      .is("qbo_id", null)
      .select("id")
      .maybeSingle()
    if (error || !data?.id) throw new Error(error?.message ?? "Expense is already linked or no longer exists.")
    await linkSyncRecord({ supabase, orgId: resolvedOrgId, connectionId, entityType: "project_expense", entityId: data.id, qboId })
    await markEventsResolved(supabase, qboId)
    await recordEvent({
      orgId: resolvedOrgId,
      actorId: userId,
      eventType: "qbo_import_linked_existing",
      entityType: "project_expense",
      entityId: data.id,
      payload: { qbo_id: qboId },
    })
    return { linked: true }
  }

  const { data, error } = await supabase
    .from("vendor_bills")
    .update({ qbo_id: qboId, qbo_synced_at: nowIso, qbo_sync_status: "synced" })
    .eq("org_id", resolvedOrgId)
    .eq("id", existingEntityId)
    .is("qbo_id", null)
    .select("id")
    .maybeSingle()
  if (error || !data?.id) throw new Error(error?.message ?? "Bill is already linked or no longer exists.")
  await linkSyncRecord({ supabase, orgId: resolvedOrgId, connectionId, entityType: "bill", entityId: data.id, qboId })
  await markEventsResolved(supabase, qboId)
  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "qbo_import_linked_existing",
    entityType: "vendor_bill",
    entityId: data.id,
    payload: { qbo_id: qboId },
  })
  return { linked: true }
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
  items,
}: {
  orgId?: string
  items: { qboId: string; entityType: QboImportEntityType; projectId?: string; allocations?: Record<string, string> }[]
}): Promise<QboImportResult> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "bill.write", userId, orgId: resolvedOrgId, supabase, logDecision: true })
  await requireAuthorization({ permission: "invoice.write", userId, orgId: resolvedOrgId, supabase, logDecision: true })

  // Each record carries its own destination project (org-wide import). Validate every distinct
  // destination belongs to the org in one query. Payments derive their project from the linked
  // document, so they may omit projectId.
  const projectIds = Array.from(
    new Set(items.map((item) => item.projectId).filter((id): id is string => Boolean(id))),
  )
  if (projectIds.length > 0) {
    const { data: validProjects } = await supabase
      .from("projects")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .in("id", projectIds)
    const validIds = new Set((validProjects ?? []).map((row) => row.id))
    if (projectIds.some((id) => !validIds.has(id))) throw new Error("Project not found")
  }

  const connectionId = await getActiveConnectionId(supabase, resolvedOrgId)
  if (!connectionId) throw new Error("QuickBooks isn't connected for this organization.")

  const client = await QBOClient.forOrg(resolvedOrgId)
  if (!client) throw new Error("Couldn't connect to QuickBooks.")

  const ctx: ResolvedContext = { supabase, orgId: resolvedOrgId, userId }

  // Order so that documents are imported before the payments that reference them. Client deposits are
  // self-contained (they create their own invoice + payment), so their order is immaterial.
  const order: Record<QboImportEntityType, number> = {
    invoice: 0,
    bill: 0,
    vendor_credit: 0,
    expense: 0,
    expense_credit: 0,
    journal_entry: 0,
    client_deposit: 0,
    payment: 1,
    bill_payment: 1,
  }
  const ordered = [...items].sort((a, b) => order[a.entityType] - order[b.entityType])

  // Journal entries need the org's expense/COGS account ids to keep only cost lines; fetch once.
  const jeExpenseAccountIds = ordered.some((item) => item.entityType === "journal_entry")
    ? new Set((await client.listExpenseAccounts().catch(() => [] as { id: string }[])).map((account) => account.id))
    : new Set<string>()

  // Client deposits need the org's Income account ids to keep only the income lines; fetch once.
  const incomeAccountIds = ordered.some((item) => item.entityType === "client_deposit")
    ? new Set((await client.listIncomeAccounts().catch(() => [] as { id: string }[])).map((account) => account.id))
    : new Set<string>()

  const result: QboImportResult = { imported: 0, skipped: 0, failed: 0, errors: [] }

  for (const item of ordered) {
    try {
      // Project-bound types must name a destination; payments resolve theirs from the linked doc.
      const isPayment = item.entityType === "payment" || item.entityType === "bill_payment"
      if (!isPayment && !item.projectId) throw new Error("No destination project selected")
      const dest = item.projectId as string
      let outcome: { skipped: boolean }
      switch (item.entityType) {
        case "invoice":
          outcome = await importInvoice(ctx, client, connectionId, dest, item.qboId)
          break
        case "expense":
          outcome = await importExpense(ctx, client, connectionId, dest, item.qboId, item.allocations)
          break
        case "expense_credit":
          outcome = await importExpenseCredit(ctx, client, connectionId, dest, item.qboId, item.allocations)
          break
        case "bill":
          outcome = await importBill(ctx, client, connectionId, dest, item.qboId, item.allocations)
          break
        case "vendor_credit":
          outcome = await importVendorCredit(ctx, client, connectionId, dest, item.qboId, item.allocations)
          break
        case "payment":
          outcome = await importPayment(ctx, client, connectionId, item.qboId)
          break
        case "bill_payment":
          outcome = await importBillPayment(ctx, client, connectionId, item.qboId)
          break
        case "journal_entry":
          outcome = await importJournalEntry(ctx, client, connectionId, dest, item.qboId, jeExpenseAccountIds, item.allocations)
          break
        case "client_deposit":
          outcome = await importClientDeposit(ctx, client, connectionId, dest, item.qboId, incomeAccountIds, item.allocations)
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
