import "server-only"

import { z } from "zod"

import { requireBooksAuthorization as requireAuthorization } from "@/lib/services/books/access"
import type { StatementDimension } from "@/lib/services/books/statements"
import { loadClosedPeriodSnapshots } from "@/lib/services/books/closed-snapshots"
import { canReadWorkerPay, isWorkerPayLine, mergeWorkerPay, RESTRICTED_WORKER_PAY } from "@/lib/services/books/worker-pay-privacy"
import { requireOrgContext } from "@/lib/services/context"
import {
  ledgerForCompany,
  loadPostedLedger,
  buildBalanceSheet,
  buildCashBasisStatement,
  buildCashFlowStatement,
  buildProfitAndLoss,
  buildTrialBalance,
} from "@/lib/services/books/statements"
import { SEARCH_CONFIGS, type SearchEntityType } from "@/lib/services/search-config"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * The data layer behind the Books statements surface.
 *
 * Two things live here: the period statement set the surface renders, and the
 * drill-down behind any number on it — click a P&L line, see the entries that
 * made it, open the bill or invoice that caused them. That drill-down is also the
 * account register (click an account, get a running-balance transaction list):
 * the same query framed two ways, so it is written once.
 *
 * The drill-down is deliberately NOT built on `loadPostedLedger`. The statement
 * builders load every entry and line for the period and aggregate in memory,
 * which is fine when you are about to total all of it. A drill-down wants one
 * account, so it filters in Postgres and reads a fraction of the rows.
 */

const ACTIVITY_ROW_CAP = 500

const accountSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  account_type: z.enum(["asset", "liability", "equity", "income", "cogs", "expense"]),
  normal_balance: z.enum(["debit", "credit"]),
})

/**
 * The embedded shapes are parsed rather than trusted. The Supabase client cannot
 * infer a select string it did not see as a literal, so without this the rows
 * arrive untyped — and a cast would only hide that, not answer it.
 */
const activityLineSchema = z.object({
  id: z.string().uuid(),
  account_id: z.string().uuid(),
  project_id: z.string().uuid().nullable(),
  company_id: z.string().uuid().nullable(),
  debit_cents: z.number().int(),
  credit_cents: z.number().int(),
  description: z.string().nullable(),
  line_no: z.number().int(),
  dimensions: z.record(z.unknown()).nullable().optional(),
})

const activityEntrySchema = z.object({
  id: z.string().uuid(),
  entry_date: z.string(),
  entry_kind: z.string(),
  memo: z.string().nullable(),
  source_type: z.string().nullable(),
  source_id: z.string().nullable(),
  lines: z.array(activityLineSchema),
})

const openingEntrySchema = z.object({
  lines: z.array(z.object({ debit_cents: z.number().int(), credit_cents: z.number().int() })),
})

/**
 * Which record a posting rule was reading when it produced an entry.
 *
 * The keys are `sourceType` from `books/posting-rules.ts`; the values are search
 * entity types, so the href comes from `SEARCH_CONFIGS` — the same templates
 * global search and notifications deep-link with. A second hand-written copy of
 * these routes would drift the first time a route moved.
 *
 * Both retainage releases resolve to their underlying document: an AP release IS a
 * `vendor_bills` row and an AR release IS an `invoices` row. Entries with no
 * navigable source (labor, revenue recognition, year-end close, manual journals)
 * map to null and render as plain text rather than a dead link.
 */
const SOURCE_ENTITY_TYPES: Record<string, SearchEntityType> = {
  vendor_bill: "payable",
  retainage_release_payable: "payable",
  invoice: "invoice",
  retainage_release_receivable: "invoice",
  expense: "expense",
  bill_payment: "payment",
  invoice_payment: "payment",
}

const SOURCE_LABELS: Record<string, string> = {
  vendor_bill: "Vendor bill",
  bill_payment: "Vendor payment",
  invoice: "Invoice",
  invoice_payment: "Customer payment",
  expense: "Expense",
  payment_reversal: "Payment reversal",
  labor_cost: "Field labor",
  retainage_release_payable: "Retainage release",
  retainage_release_receivable: "Retainage release",
  revenue_recognition: "Revenue recognition",
  year_end_close: "Year-end close",
  opening_balance: "Opening balance",
}

async function requireStatementsAccess(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "books.read",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "books",
    resourceId: context.orgId,
    logDecision: true,
  })
  return context
}

/**
 * The statements saved when a period closed, when the request is exactly that
 * closed period. A closed month reads as it was closed: later work cannot post
 * into it, and the screen, CSV and PDF all serve the same frozen record.
 */
async function loadClosedPeriodStatements(orgId: string, startDate: string, endDate: string, legalEntityId: string | null) {
  const closed = await loadClosedPeriodSnapshots(orgId, { start: startDate, end: endDate })
  // A company's statements were saved only once the organization had more than one.
  if (!closed || !closed.has("trial_balance", legalEntityId)) return null
  return {
    periodId: closed.periodId,
    closedAt: closed.closedAt,
    profitLoss: closed.report<Awaited<ReturnType<typeof buildProfitAndLoss>>>("profit_loss", legalEntityId),
    balanceSheet: closed.report<Awaited<ReturnType<typeof buildBalanceSheet>>>("balance_sheet", legalEntityId),
    trialBalance: closed.report<Awaited<ReturnType<typeof buildTrialBalance>>>("trial_balance", legalEntityId),
    cashFlow: closed.report<Awaited<ReturnType<typeof buildCashFlowStatement>>>("cash_flow", legalEntityId),
  }
}

/**
 * Every statement for one period, plus the same period a year earlier.
 *
 * The comparison is loaded here rather than by a second round trip from the
 * client: a P&L number means little without something to read it against, and a
 * statement that arrives in two pieces flickers.
 */
export async function getStatementsForPeriod(input: {
  startDate: string
  endDate: string
  comparePriorYear?: boolean
  comparison?: "prior_year" | "prior_period" | "none"
  includeMonthly?: boolean
  /** One company's statements; omitted or null, all companies consolidated. */
  legalEntityId?: string | null
  orgId?: string
}) {
  const context = await requireStatementsAccess(input.orgId)
  const orgId = context.orgId
  const priorYear = (date: string) => {
    const [year, month, day] = date.split("-").map(Number)
    const lastDay = new Date(Date.UTC(year - 1, month, 0)).getUTCDate()
    return `${year - 1}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`
  }

  const comparison = input.comparison ?? (input.comparePriorYear === false ? "none" : "prior_year")
  const dayBefore = (date: string) => {
    const value = new Date(`${date}T00:00:00Z`)
    value.setUTCDate(value.getUTCDate() - 1)
    return value.toISOString().slice(0, 10)
  }
  const daysBetween = Math.round((new Date(`${input.endDate}T00:00:00Z`).getTime() - new Date(`${input.startDate}T00:00:00Z`).getTime()) / 86_400_000) + 1
  const priorPeriodEnd = dayBefore(input.startDate)
  const priorPeriodStartDate = new Date(`${priorPeriodEnd}T00:00:00Z`)
  priorPeriodStartDate.setUTCDate(priorPeriodStartDate.getUTCDate() - daysBetween + 1)
  const comparisonRange = comparison === "prior_year"
    ? { start: priorYear(input.startDate), end: priorYear(input.endDate), label: "Prior year" }
    : comparison === "prior_period"
      ? { start: priorPeriodStartDate.toISOString().slice(0, 10), end: priorPeriodEnd, label: "Prior period" }
      : null

  const monthRanges: Array<{ startDate: string; endDate: string; label: string }> = []
  if (input.includeMonthly) {
    const cursor = new Date(`${input.startDate.slice(0, 7)}-01T00:00:00Z`)
    while (monthRanges.length < 24) {
      const monthStart = cursor.toISOString().slice(0, 10)
      if (monthStart > input.endDate) break
      const endOfMonth = new Date(cursor)
      endOfMonth.setUTCMonth(endOfMonth.getUTCMonth() + 1)
      endOfMonth.setUTCDate(0)
      const monthEnd = endOfMonth.toISOString().slice(0, 10)
      monthRanges.push({
        startDate: monthStart < input.startDate ? input.startDate : monthStart,
        endDate: monthEnd > input.endDate ? input.endDate : monthEnd,
        label: cursor.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }),
      })
      cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    }
  }

  const legalEntityId = input.legalEntityId ?? null
  const [posted, closed] = await Promise.all([loadPostedLedger(orgId, input.endDate), loadClosedPeriodStatements(orgId, input.startDate, input.endDate, legalEntityId)])
  const snapshot = await ledgerForCompany(orgId, posted, legalEntityId)
  const [profitLoss, balanceSheet, trialBalance, cashFlow, cashBasis, priorProfitLoss, monthlyProfitLoss] = await Promise.all([
    closed?.profitLoss ?? buildProfitAndLoss(orgId, input.startDate, input.endDate, snapshot),
    closed?.balanceSheet ?? buildBalanceSheet(orgId, input.endDate, snapshot),
    closed?.trialBalance ?? buildTrialBalance(orgId, input.endDate, snapshot),
    closed?.cashFlow ?? buildCashFlowStatement(orgId, input.startDate, input.endDate, snapshot),
    buildCashBasisStatement(orgId, input.startDate, input.endDate, snapshot),
    comparisonRange ? buildProfitAndLoss(orgId, comparisonRange.start, comparisonRange.end, snapshot) : Promise.resolve(null),
    Promise.all(monthRanges.map(async (range) => ({ ...range, profitLoss: await buildProfitAndLoss(orgId, range.startDate, range.endDate, snapshot) }))),
  ])

  return {
    startDate: input.startDate,
    endDate: input.endDate,
    profitLoss,
    balanceSheet,
    trialBalance,
    cashFlow,
    cashBasis,
    priorProfitLoss,
    comparisonLabel: comparisonRange?.label ?? null,
    comparisonRange,
    monthlyProfitLoss,
    // Set when these are the statements saved at close rather than a live run.
    closedPeriod: closed ? { periodId: closed.periodId, closedAt: closed.closedAt } : null,
  }
}

export type StatementsForPeriod = Awaited<ReturnType<typeof getStatementsForPeriod>>

export type LedgerSourceLink = { type: string; label: string; href: string | null }

export type AccountActivityRow = {
  lineId: string
  entryId: string
  entryDate: string
  entryKind: string
  memo: string
  description: string | null
  debitCents: number
  creditCents: number
  /** Running balance in the account's normal direction, opening balance included. */
  balanceCents: number
  projectId: string | null
  projectName: string | null
  companyId: string | null
  companyName: string | null
  source: LedgerSourceLink | null
}

function resolveSource(
  sourceType: string | null,
  sourceId: string | null,
  projectId: string | null,
  dimensions?: Record<string, unknown> | null,
): LedgerSourceLink | null {
  if (!sourceType) return null
  const label = SOURCE_LABELS[sourceType] ?? sourceType.replace(/_/g, " ")
  // A payment opens the document it settled, on that document's own page.
  const settled = typeof dimensions?.invoice_id === "string" ? { type: "invoice" as const, id: dimensions.invoice_id }
    : typeof dimensions?.bill_id === "string" ? { type: "payable" as const, id: dimensions.bill_id } : null
  const isPayment = SOURCE_ENTITY_TYPES[sourceType] === "payment"
  const entityType = isPayment && settled ? settled.type : SOURCE_ENTITY_TYPES[sourceType]
  const targetId = isPayment && settled ? settled.id : sourceId
  const template = entityType ? SEARCH_CONFIGS[entityType]?.hrefTemplate : undefined
  if (!template || !targetId) return { type: sourceType, label, href: null }
  // Every project-scoped template needs a project id. Substituting an empty one
  // yields `/projects//...`, which 404s — better to render no link at all.
  if (template.includes("{project_id}") && !projectId) return { type: sourceType, label, href: null }
  const href = template
    .replace("{id}", targetId)
    .replace("{project_id}", projectId ?? "")
  return { type: sourceType, label, href }
}

/**
 * Activity before the window opens, in the account's normal direction.
 *
 * Selects two integer columns and nothing else: this walks the account's whole
 * history, and history is the one thing that only grows.
 */
async function loadOpeningBalanceCents(args: {
  orgId: string
  accountId: string
  startDate: string
  projectId?: string | null
}) {
  const service = createServiceSupabaseClient()
  let openingDebit = 0
  let openingCredit = 0
  for (let from = 0; ; from += 1000) {
    let query = service
      .from("journal_entries")
      .select("id, lines:journal_lines!journal_lines_entry_owner_fk!inner(debit_cents, credit_cents)")
      .eq("org_id", args.orgId)
      .in("status", ["posted", "reversed"])
      .lt("entry_date", args.startDate)
      .eq("lines.account_id", args.accountId)
      .order("id", { ascending: true })
      .range(from, from + 999)
    if (args.projectId) query = query.eq("lines.project_id", args.projectId)
    const { data, error } = await query
    if (error) throw new Error(`Failed to load the opening balance: ${error.message}`)
    const page = z.array(openingEntrySchema).parse(data ?? [])
    for (const row of page) {
      for (const line of row.lines) {
        openingDebit += line.debit_cents
        openingCredit += line.credit_cents
      }
    }
    if (page.length < 1000) break
  }
  return { openingDebit, openingCredit }
}

export async function getAccountActivity(input: {
  operatingOnly?: boolean
  unassignedOnly?: boolean
  accountId: string
  startDate: string
  endDate: string
  projectId?: string | null
  /** One slice of a sliced P&L: lines carrying this value, or none when null. */
  dimension?: { key: StatementDimension; value: string | null }
  orgId?: string
}) {
  if (input.dimension && !input.operatingOnly) throw new Error("Dimension activity is a statement-period view")
  const context = await requireStatementsAccess(input.orgId)
  const orgId = context.orgId
  const service = createServiceSupabaseClient()

  const { data: accountData, error: accountError } = await service
    .from("gl_accounts")
    .select("id, code, name, account_type, normal_balance")
    .eq("org_id", orgId)
    .eq("id", input.accountId)
    .maybeSingle()
  if (accountError) throw new Error(`Failed to load the account: ${accountError.message}`)
  if (!accountData) throw new Error("Account not found")
  const account = accountSchema.parse(accountData)
  if (input.operatingOnly) account.normal_balance = ["asset", "cogs", "expense"].includes(account.account_type) ? "debit" : "credit"
  const closingIds: string[] = []
  if (input.operatingOnly) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await service.from("journal_entries").select("id").eq("org_id", orgId).eq("entry_kind", "closing").lte("entry_date", input.endDate).order("id").range(from, from + 999)
      if (error) throw new Error("Could not resolve closing entries for this statement.")
      closingIds.push(...(data ?? []).map(row => String(row.id)))
      if ((data?.length ?? 0) < 1000) break
    }
  }
  const signed = (debitCents: number, creditCents: number) =>
    account.normal_balance === "debit" ? debitCents - creditCents : creditCents - debitCents

  const [{ openingDebit, openingCredit }, activity, workerPayVisible] = await Promise.all([
    input.operatingOnly ? Promise.resolve({ openingDebit: 0, openingCredit: 0 }) : loadOpeningBalanceCents({ orgId, accountId: input.accountId, startDate: input.startDate, projectId: input.projectId }),
    // Queried entry-first, not line-first. PostgREST orders a parent only by its
    // OWN columns, and `journal_lines` has no date — ordering by an embedded
    // `entry_date` is silently not the sort you asked for, which would make the
    // row cap slice an arbitrary 500 and the running balance meaningless. Entries
    // own `entry_date`, and `!inner` on the lines keeps only entries that touch
    // this account while the embedded array carries just the matching lines.
    (async () => {
      let query = service
        .from("journal_entries")
        .select(
          "id, entry_date, entry_kind, memo, source_type, source_id, " +
            "lines:journal_lines!journal_lines_entry_owner_fk!inner(id, account_id, project_id, company_id, debit_cents, credit_cents, description, line_no, dimensions)",
        )
        .eq("org_id", orgId)
        .in("status", ["posted", "reversed"])
        .gte("entry_date", input.startDate)
        .lte("entry_date", input.endDate)
        .eq("lines.account_id", input.accountId)
        .order("entry_date", { ascending: true })
        .order("id", { ascending: true })
        // One past the cap, so truncation is detected rather than assumed.
        .range(0, ACTIVITY_ROW_CAP)
      if (input.operatingOnly) {
        query = query.neq("entry_kind", "closing")
        if (closingIds.length) query = query.or(`reversal_of_entry_id.is.null,reversal_of_entry_id.not.in.(${closingIds.join(",")})`)
      }
      if (input.unassignedOnly) query = query.is("lines.project_id", null)
      else if (input.projectId) query = query.eq("lines.project_id", input.projectId)
      if (input.dimension) query = input.dimension.value === null
        ? query.is(`lines.dimensions->>${input.dimension.key}`, null)
        : query.eq(`lines.dimensions->>${input.dimension.key}`, input.dimension.value)
      const { data, error } = await query
      if (error) throw new Error(`Failed to load account activity: ${error.message}`)
      return z.array(activityEntrySchema).parse(data ?? [])
    })(),
    canReadWorkerPay(context),
  ])

  const truncated = activity.length > ACTIVITY_ROW_CAP
  const entries = truncated ? activity.slice(0, ACTIVITY_ROW_CAP) : activity

  // One entry can post to the same account more than once. Flatten to lines and
  // keep `line_no` order inside each entry so the register reads as it was written.
  const lines = entries.flatMap((entry) =>
    [...entry.lines]
      .sort((left, right) => left.line_no - right.line_no)
      .map((line) => ({ entry, line })),
  )
  const page = workerPayVisible ? lines : mergeWorkerPay(lines, {
    isWorkerPay: ({ line }) => isWorkerPayLine(line.dimensions),
    groupKey: ({ entry, line }) => `${entry.id}:${line.account_id}:${line.project_id ?? ""}`,
    merge: (into, { line }) => ({ ...into, line: { ...into.line, debit_cents: into.line.debit_cents + line.debit_cents, credit_cents: into.line.credit_cents + line.credit_cents } }),
    redact: ({ entry, line }) => ({ entry, line: { ...line, description: RESTRICTED_WORKER_PAY, dimensions: null } }),
  })

  const projectIds = Array.from(new Set(page.map(({ line }) => line.project_id).filter((id): id is string => Boolean(id))))
  const companyIds = Array.from(new Set(page.map(({ line }) => line.company_id).filter((id): id is string => Boolean(id))))
  const [projectNames, companyNames] = await Promise.all([
    (async () => {
      const names = new Map<string, string>()
      if (projectIds.length === 0) return names
      const { data } = await service.from("projects").select("id, name").eq("org_id", orgId).in("id", projectIds)
      for (const row of data ?? []) names.set(String(row.id), String(row.name))
      return names
    })(),
    (async () => {
      const names = new Map<string, string>()
      if (companyIds.length === 0) return names
      const { data } = await service.from("companies").select("id, name").eq("org_id", orgId).in("id", companyIds)
      for (const row of data ?? []) names.set(String(row.id), String(row.name))
      return names
    })(),
  ])

  const openingBalanceCents = signed(openingDebit, openingCredit)
  let running = openingBalanceCents
  const rows: AccountActivityRow[] = page.map(({ entry, line }) => {
    const { debit_cents: debitCents, credit_cents: creditCents } = line
    running += signed(debitCents, creditCents)
    const projectId = line.project_id
    const companyId = line.company_id
    return {
      lineId: line.id,
      entryId: entry.id,
      entryDate: entry.entry_date,
      entryKind: entry.entry_kind,
      memo: entry.memo ?? "",
      description: line.description,
      debitCents,
      creditCents,
      balanceCents: running,
      projectId,
      projectName: projectId ? projectNames.get(projectId) ?? null : null,
      companyId,
      companyName: companyId ? companyNames.get(companyId) ?? null : null,
      source: resolveSource(entry.source_type, entry.source_id, projectId, line.dimensions),
    }
  })

  return {
    account: {
      id: account.id,
      code: account.code,
      name: account.name,
      accountType: account.account_type,
      normalBalance: account.normal_balance,
    },
    startDate: input.startDate,
    endDate: input.endDate,
    projectId: input.projectId ?? null,
    openingBalanceCents,
    closingBalanceCents: running,
    periodDebitCents: rows.reduce((sum, row) => sum + row.debitCents, 0),
    periodCreditCents: rows.reduce((sum, row) => sum + row.creditCents, 0),
    rows,
    truncated,
    rowCap: ACTIVITY_ROW_CAP,
  }
}
