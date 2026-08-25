import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgContext } from "@/lib/services/context"
import { requireAnyPermission } from "@/lib/services/permissions"
import { requireAuthorization } from "@/lib/services/authorization"
import { getCompanyAccountingLinks } from "@/lib/services/companies"
import { getBooksModuleSettings } from "@/lib/services/books/module"
import { payableOutstandingCents } from "@/lib/financials/payables-rules"
import { PAYABLE_VENDOR_BILL_STATUSES } from "@/lib/financials/ledger-status"
import { getAgingBucket, type AgingBucket } from "@/lib/services/reports/aging"
import { todayIsoDateOnly } from "@/lib/services/reports/dates"
import { ACCOUNTING_PROVIDERS } from "@/lib/integrations/accounting/catalog"
import type { AccountingProviderKey } from "@/lib/integrations/accounting/provider"

/**
 * The vendor account: one party's full payable relationship with the org,
 * composed from the operational tables (bills, credits, payments, expenses).
 * Provider-agnostic by construction — accounting identity comes from
 * `accounting_counterparty_links`, and Arc Books state from `books_settings`.
 */

export type VendorLedgerEntryKind = "bill" | "vendor_credit" | "payment" | "expense"

export interface VendorLedgerEntry {
  /** Synthetic, unique across kinds: `${kind}:${source_id}`. */
  id: string
  kind: VendorLedgerEntryKind
  source_id: string
  /** The id used to open the entry's detail surface (payments open their bill). */
  target_id: string
  date: string | null
  due_date: string | null
  /** 0 unless the entry is an unpaid bill past its due date. */
  days_past_due: number
  reference: string | null
  memo: string | null
  /** Payment rail or method, for payment rows. */
  method: string | null
  project_id: string | null
  project_name: string | null
  status: string | null
  /**
   * Signed AP effect in cents: bills increase what is owed, credits and
   * payments decrease it. Expenses are informational spend (paid at capture)
   * and carry their cost here without touching the balance.
   */
  amount_cents: number
  /** Running AP balance after this entry, oldest → newest. Null for expenses. */
  balance_cents: number | null
  commitment_id: string | null
  commitment_title: string | null
  is_draft: boolean
  /** Attachment (scanned invoice, receipt) available for download, if any. */
  attachment_file_id: string | null
  /**
   * Why a row cannot be deleted, or null when it can be. Recorded payments and
   * a record the accounting provider owns are both hard blocks.
   */
  delete_blocked_reason: string | null
}

export interface VendorLedgerQuery {
  kinds?: VendorLedgerEntryKind[]
  statuses?: string[]
  projectId?: string
  /** Unpaid bills past their due date only. */
  overdueOnly?: boolean
  from?: string
  to?: string
  page?: number
  pageSize?: number
}

export interface VendorLedgerPagination {
  page: number
  pageSize: number
  total: number
  pageCount: number
}

/** Filter options derived from the whole ledger, not just the visible page. */
export interface VendorLedgerFacets {
  projects: { id: string; name: string }[]
  statuses: string[]
}

export type VendorAccountAging = Record<AgingBucket, number>

export interface VendorAccountSummary {
  company_id: string
  /** Owed now across approved/partial bills, net of retainage and credits applied. */
  open_cents: number
  /** The slice of open_cents past its due date. */
  overdue_cents: number
  retainage_held_cents: number
  /** Vendor credits not yet applied to a bill. */
  credit_open_cents: number
  paid_ytd_cents: number
  open_bill_count: number
  overdue_bill_count: number
  last_bill_date: string | null
  last_payment_date: string | null
  aging: VendorAccountAging
  /** False when the viewer lacks bill.read — every money field reads zero. */
  can_view_bills: boolean
}

export interface VendorAccountingIdentity {
  provider: string
  /** Human name from the provider catalog; falls back to the raw key. */
  provider_name: string
  external_name: string | null
  status: string | null
  last_synced_at: string | null
}

export interface VendorBooksContext {
  workspace_enabled: boolean
  ledger_authority: "external" | "arc"
}

export interface VendorAccountLedger {
  summary: VendorAccountSummary
  /** Newest first, already filtered and sliced to the requested page. */
  entries: VendorLedgerEntry[]
  pagination: VendorLedgerPagination
  facets: VendorLedgerFacets
  /** True when any source hit its fetch cap — totals may undercount. */
  truncated: boolean
  accounting: VendorAccountingIdentity | null
  books: VendorBooksContext | null
}

const LEDGER_SOURCE_LIMIT = 500
const DEFAULT_PAGE_SIZE = 50

const emptyAging = (): VendorAccountAging => ({
  current: 0,
  "1_30": 0,
  "31_60": 0,
  "61_90": 0,
  "90_plus": 0,
  paid: 0,
  no_due_date: 0,
})

const emptySummary = (companyId: string, canViewBills: boolean): VendorAccountSummary => ({
  company_id: companyId,
  open_cents: 0,
  overdue_cents: 0,
  retainage_held_cents: 0,
  credit_open_cents: 0,
  paid_ytd_cents: 0,
  open_bill_count: 0,
  overdue_bill_count: 0,
  last_bill_date: null,
  last_payment_date: null,
  aging: emptyAging(),
  can_view_bills: canViewBills,
})

function providerDisplayName(provider: string): string {
  const meta = ACCOUNTING_PROVIDERS[provider as AccountingProviderKey]
  return meta?.name ?? provider
}

async function loadAccountingIdentity(
  supabase: SupabaseClient,
  orgId: string,
  companyId: string,
): Promise<VendorAccountingIdentity | null> {
  const links = await getCompanyAccountingLinks(supabase, orgId, [companyId])
  const link = links.get(companyId)
  if (!link) return null
  return {
    provider: link.provider,
    provider_name: providerDisplayName(link.provider),
    external_name:
      link.external_name ?? ((link.metadata?.display_name as string | undefined) || null),
    status: link.status ?? null,
    last_synced_at: link.last_synced_at ?? null,
  }
}

async function loadBooksContext(orgId: string): Promise<VendorBooksContext | null> {
  try {
    const module_ = await getBooksModuleSettings({ orgId })
    if (!module_.settings) return null
    return {
      workspace_enabled: module_.settings.workspace_enabled,
      ledger_authority: module_.settings.ledger_authority,
    }
  } catch {
    // Books state is contextual chrome; the account page must not fail on it.
    return null
  }
}

const emptyPagination = (query?: VendorLedgerQuery): VendorLedgerPagination => ({
  page: 1,
  pageSize: query?.pageSize ?? DEFAULT_PAGE_SIZE,
  total: 0,
  pageCount: 1,
})

export async function getVendorAccountLedger(
  companyId: string,
  orgId?: string,
  query: VendorLedgerQuery = {},
): Promise<VendorAccountLedger> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read", "directory.read", "directory.write"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })

  // Money answers to bill.read; directory access alone yields an empty account.
  // Identity decoration is independent, so overlap it with authorization rather
  // than paying for another full network round before starting the ledger.
  const canViewBillsPromise = requireAuthorization({
    permission: "bill.read",
    userId,
    orgId: resolvedOrgId,
    supabase,
    resourceType: "directory",
    resourceId: "vendor_account_ledger",
  })
    .then(() => true)
    .catch(() => false)

  const [canViewBills, [accounting, books]] = await Promise.all([
    canViewBillsPromise,
    Promise.all([
      loadAccountingIdentity(supabase, resolvedOrgId, companyId),
      loadBooksContext(resolvedOrgId),
    ]),
  ])

  if (!canViewBills) {
    return {
      summary: emptySummary(companyId, false),
      entries: [],
      pagination: emptyPagination(query),
      facets: { projects: [], statuses: [] },
      truncated: false,
      accounting,
      books,
    }
  }

  const [billsResult, expensesResult] = await Promise.all([
    supabase
      .from("vendor_bills")
      .select(
        "id, project_id, bill_number, status, bill_date, due_date, total_cents, paid_cents, retainage_cents, commitment_id, metadata, created_at, file_id, project:projects(name), commitment:commitments(title)",
      )
      .eq("org_id", resolvedOrgId)
      .eq("company_id", companyId)
      .order("bill_date", { ascending: false, nullsFirst: false })
      .limit(LEDGER_SOURCE_LIMIT),
    supabase
      .from("project_expenses")
      .select(
        "id, project_id, expense_date, status, amount_cents, tax_cents, description, receipt_file_id, project:projects(name)",
      )
      .eq("org_id", resolvedOrgId)
      .eq("vendor_company_id", companyId)
      .order("expense_date", { ascending: false, nullsFirst: false })
      .limit(LEDGER_SOURCE_LIMIT),
  ])

  if (billsResult.error)
    throw new Error(`Failed to load vendor bills: ${billsResult.error.message}`)
  if (expensesResult.error)
    throw new Error(`Failed to load vendor expenses: ${expensesResult.error.message}`)

  const bills = billsResult.data ?? []
  const expenses = expensesResult.data ?? []

  const billIds = bills.map((bill) => bill.id)
  const [paymentsResult, ownershipResult] = billIds.length
    ? await Promise.all([
        supabase
          .from("payments")
          .select("id, bill_id, amount_cents, method, reference, received_at, status, created_at")
          .eq("org_id", resolvedOrgId)
          .in("bill_id", billIds)
          .not("status", "in", "(canceled,refunded,failed)")
          .order("received_at", { ascending: false, nullsFirst: false })
          .limit(LEDGER_SOURCE_LIMIT),
        supabase
          .from("accounting_sync_records")
          .select("entity_id")
          .eq("org_id", resolvedOrgId)
          .in("entity_type", ["bill", "vendor_credit"])
          .in("entity_id", billIds)
          .not("external_id", "is", null),
      ])
    : [{ data: [], error: null }, { data: [], error: null }]
  if (paymentsResult.error)
    throw new Error(`Failed to load vendor payments: ${paymentsResult.error.message}`)
  if (ownershipResult.error)
    throw new Error(`Failed to load accounting ownership: ${ownershipResult.error.message}`)
  const payments = paymentsResult.data ?? []
  const externallyOwnedBillIds = new Set((ownershipResult.data ?? []).map((row) => row.entity_id))

  const billById = new Map(bills.map((bill) => [bill.id, bill]))
  const projectName = (row: { project?: { name?: string } | { name?: string }[] | null }) => {
    const project = Array.isArray(row.project) ? row.project[0] : row.project
    return project?.name ?? null
  }

  const paymentCountByBillId = new Map<string, number>()
  for (const payment of payments) {
    paymentCountByBillId.set(payment.bill_id, (paymentCountByBillId.get(payment.bill_id) ?? 0) + 1)
  }

  const asOfDate = todayIsoDateOnly()
  const entries: VendorLedgerEntry[] = []

  for (const bill of bills) {
    const metadata = (bill.metadata ?? {}) as Record<string, unknown>
    const isCredit = metadata.source === "vendor_credit"
    const totalCents = Number(bill.total_cents ?? 0)
    const paidCents = Number(bill.paid_cents ?? 0)
    const commitment = Array.isArray(bill.commitment) ? bill.commitment[0] : bill.commitment
    const settled = bill.status === "paid" || totalCents - paidCents <= 0
    const { daysPastDue } = getAgingBucket({
      dueDate: bill.due_date,
      asOf: asOfDate,
      isPaid: settled,
    })
    entries.push({
      id: `${isCredit ? "vendor_credit" : "bill"}:${bill.id}`,
      kind: isCredit ? "vendor_credit" : "bill",
      source_id: bill.id,
      target_id: bill.id,
      date: bill.bill_date ?? bill.created_at?.slice(0, 10) ?? null,
      due_date: bill.due_date ?? null,
      days_past_due: daysPastDue,
      reference: bill.bill_number ?? null,
      // Payment memo is a metadata field on the bill, not a column.
      memo: typeof metadata.payment_memo === "string" ? metadata.payment_memo : null,
      method: null,
      project_id: bill.project_id ?? null,
      project_name: projectName(bill),
      status: bill.status ?? null,
      // Credits are stored as negative-total bills; keep the stored sign.
      amount_cents: totalCents,
      balance_cents: null,
      commitment_id: bill.commitment_id ?? null,
      commitment_title: commitment?.title ?? null,
      is_draft: metadata.creation_state === "draft",
      attachment_file_id: (bill.file_id as string | null) ?? null,
      delete_blocked_reason: (paymentCountByBillId.get(bill.id) ?? 0) > 0
        ? "it has recorded payments"
        : externallyOwnedBillIds.has(bill.id)
          ? "the accounting provider owns this record"
          : null,
    })
  }

  for (const payment of payments) {
    const bill = billById.get(payment.bill_id)
    entries.push({
      id: `payment:${payment.id}`,
      kind: "payment",
      source_id: payment.id,
      target_id: payment.bill_id,
      date: payment.received_at?.slice(0, 10) ?? payment.created_at?.slice(0, 10) ?? null,
      due_date: null,
      days_past_due: 0,
      reference: payment.reference ?? null,
      memo: bill?.bill_number ? `Applied to ${bill.bill_number}` : null,
      method: payment.method ?? null,
      project_id: bill?.project_id ?? null,
      project_name: bill ? projectName(bill) : null,
      status: payment.status ?? null,
      amount_cents: -Math.abs(Number(payment.amount_cents ?? 0)),
      balance_cents: null,
      commitment_id: bill?.commitment_id ?? null,
      commitment_title: null,
      is_draft: false,
      attachment_file_id: null,
      // A payment is reversed from its bill, never deleted from the register.
      delete_blocked_reason: "payments are reversed from the bill they paid",
    })
  }

  for (const expense of expenses) {
    entries.push({
      id: `expense:${expense.id}`,
      kind: "expense",
      source_id: expense.id,
      target_id: expense.id,
      date: expense.expense_date ?? null,
      due_date: null,
      days_past_due: 0,
      reference: expense.description ?? null,
      memo: null,
      method: null,
      project_id: expense.project_id ?? null,
      project_name: projectName(expense),
      status: expense.status ?? null,
      amount_cents: Number(expense.amount_cents ?? 0) + Number(expense.tax_cents ?? 0),
      balance_cents: null,
      commitment_id: null,
      commitment_title: null,
      is_draft: false,
      attachment_file_id: (expense.receipt_file_id as string | null) ?? null,
      delete_blocked_reason: null,
    })
  }

  // Running AP balance, oldest → newest. Drafts and expenses don't move it:
  // drafts aren't payable yet, expenses are settled at capture.
  entries.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.id.localeCompare(b.id))
  let running = 0
  for (const entry of entries) {
    if (entry.kind === "expense") continue
    if (entry.is_draft || entry.status === "rejected") {
      entry.balance_cents = running
      continue
    }
    running += entry.amount_cents
    entry.balance_cents = running
  }
  entries.reverse()

  // Summary + aging over open payables only.
  const summary = emptySummary(companyId, true)
  const asOf = todayIsoDateOnly()
  const yearStart = `${asOf.slice(0, 4)}-01-01`
  const payableStatuses: ReadonlySet<string> = new Set(PAYABLE_VENDOR_BILL_STATUSES)

  for (const bill of bills) {
    const metadata = (bill.metadata ?? {}) as Record<string, unknown>
    const isCredit = metadata.source === "vendor_credit"
    if (metadata.creation_state === "draft") continue
    const totalCents = Number(bill.total_cents ?? 0)
    const paidCents = Number(bill.paid_cents ?? 0)
    const retainageCents = Number(bill.retainage_cents ?? 0)

    if (isCredit) {
      // Open credit = the un-applied remainder of a negative-total bill.
      summary.credit_open_cents += Math.max(0, Math.abs(totalCents) - Math.abs(paidCents))
      continue
    }
    if (!payableStatuses.has(String(bill.status))) continue

    const outstanding = payableOutstandingCents({
      total_cents: totalCents,
      paid_cents: paidCents,
      retainage_cents: retainageCents,
    })
    summary.retainage_held_cents += retainageCents
    if (!summary.last_bill_date && bill.bill_date) summary.last_bill_date = bill.bill_date
    if (outstanding <= 0) continue

    summary.open_cents += outstanding
    summary.open_bill_count += 1
    const { bucket } = getAgingBucket({ dueDate: bill.due_date, asOf, isPaid: false })
    summary.aging[bucket] += outstanding
    if (bucket !== "current" && bucket !== "no_due_date" && bucket !== "paid") {
      summary.overdue_cents += outstanding
      summary.overdue_bill_count += 1
    }
  }

  for (const payment of payments) {
    const date = payment.received_at?.slice(0, 10) ?? null
    if (!date) continue
    if (!summary.last_payment_date) summary.last_payment_date = date
    if (date >= yearStart) summary.paid_ytd_cents += Math.abs(Number(payment.amount_cents ?? 0))
  }

  // Facets describe the whole ledger so the filter menu offers every real
  // option, not only the ones that survived the current filter.
  const projectsById = new Map<string, string>()
  const statusSet = new Set<string>()
  for (const entry of entries) {
    if (entry.project_id) projectsById.set(entry.project_id, entry.project_name ?? "Project")
    if (entry.status) statusSet.add(entry.status)
  }
  const facets: VendorLedgerFacets = {
    projects: Array.from(projectsById, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    statuses: Array.from(statusSet).sort(),
  }

  // Filtering happens after the running balance is computed, so a filtered view
  // still reports each row's true position in the account.
  const kinds = query.kinds && query.kinds.length > 0 ? new Set(query.kinds) : null
  const statuses = query.statuses && query.statuses.length > 0 ? new Set(query.statuses) : null
  const filtered = entries.filter((entry) => {
    if (kinds && !kinds.has(entry.kind)) return false
    if (statuses && (!entry.status || !statuses.has(entry.status))) return false
    if (query.projectId && entry.project_id !== query.projectId) return false
    if (query.from && (!entry.date || entry.date < query.from)) return false
    if (query.to && (!entry.date || entry.date > query.to)) return false
    if (query.overdueOnly && !(entry.kind === "bill" && entry.days_past_due > 0 && !entry.is_draft))
      return false
    return true
  })

  const pageSize = Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE)
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const page = Math.min(Math.max(1, query.page ?? 1), pageCount)
  const start = (page - 1) * pageSize

  return {
    summary,
    entries: filtered.slice(start, start + pageSize),
    pagination: { page, pageSize, total: filtered.length, pageCount },
    facets,
    truncated:
      bills.length >= LEDGER_SOURCE_LIMIT ||
      payments.length >= LEDGER_SOURCE_LIMIT ||
      expenses.length >= LEDGER_SOURCE_LIMIT,
    accounting,
    books,
  }
}
