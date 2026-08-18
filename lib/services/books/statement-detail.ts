import "server-only"

import { z } from "zod"

import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import {
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
  orgId?: string
}) {
  const context = await requireStatementsAccess(input.orgId)
  const orgId = context.orgId
  const priorYear = (date: string) => {
    const [year, ...rest] = date.split("-")
    return [String(Number(year) - 1), ...rest].join("-")
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

  const [profitLoss, balanceSheet, trialBalance, cashFlow, cashBasis, priorProfitLoss, monthlyProfitLoss] = await Promise.all([
    buildProfitAndLoss(orgId, input.startDate, input.endDate),
    buildBalanceSheet(orgId, input.endDate),
    buildTrialBalance(orgId, input.endDate),
    buildCashFlowStatement(orgId, input.startDate, input.endDate),
    buildCashBasisStatement(orgId, input.startDate, input.endDate),
    comparisonRange ? buildProfitAndLoss(orgId, comparisonRange.start, comparisonRange.end) : Promise.resolve(null),
    Promise.all(monthRanges.map(async (range) => ({ ...range, profitLoss: await buildProfitAndLoss(orgId, range.startDate, range.endDate) }))),
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
    monthlyProfitLoss,
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
): LedgerSourceLink | null {
  if (!sourceType) return null
  const label = SOURCE_LABELS[sourceType] ?? sourceType.replace(/_/g, " ")
  const entityType = SOURCE_ENTITY_TYPES[sourceType]
  const template = entityType ? SEARCH_CONFIGS[entityType]?.hrefTemplate : undefined
  if (!template || !sourceId) return { type: sourceType, label, href: null }
  // Every project-scoped template needs a project id. Substituting an empty one
  // yields `/projects//...`, which 404s — better to render no link at all.
  if (template.includes("{project_id}") && !projectId) return { type: sourceType, label, href: null }
  const href = template
    .replace("{id}", sourceId)
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
      .select("id, lines:journal_lines!inner(debit_cents, credit_cents)")
      .eq("org_id", args.orgId)
      .eq("status", "posted")
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
  accountId: string
  startDate: string
  endDate: string
  projectId?: string | null
  orgId?: string
}) {
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
  const signed = (debitCents: number, creditCents: number) =>
    account.normal_balance === "debit" ? debitCents - creditCents : creditCents - debitCents

  const [{ openingDebit, openingCredit }, activity] = await Promise.all([
    loadOpeningBalanceCents({ orgId, accountId: input.accountId, startDate: input.startDate, projectId: input.projectId }),
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
            "lines:journal_lines!inner(id, account_id, project_id, company_id, debit_cents, credit_cents, description, line_no)",
        )
        .eq("org_id", orgId)
        .eq("status", "posted")
        .gte("entry_date", input.startDate)
        .lte("entry_date", input.endDate)
        .eq("lines.account_id", input.accountId)
        .order("entry_date", { ascending: true })
        .order("id", { ascending: true })
        // One past the cap, so truncation is detected rather than assumed.
        .range(0, ACTIVITY_ROW_CAP)
      if (input.projectId) query = query.eq("lines.project_id", input.projectId)
      const { data, error } = await query
      if (error) throw new Error(`Failed to load account activity: ${error.message}`)
      return z.array(activityEntrySchema).parse(data ?? [])
    })(),
  ])

  const truncated = activity.length > ACTIVITY_ROW_CAP
  const entries = truncated ? activity.slice(0, ACTIVITY_ROW_CAP) : activity

  // One entry can post to the same account more than once. Flatten to lines and
  // keep `line_no` order inside each entry so the register reads as it was written.
  const page = entries.flatMap((entry) =>
    [...entry.lines]
      .sort((left, right) => left.line_no - right.line_no)
      .map((line) => ({ entry, line })),
  )

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
      source: resolveSource(entry.source_type, entry.source_id, projectId),
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
