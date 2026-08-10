import "server-only"

import { z } from "zod"

import { convertToCashBasis } from "@/lib/services/books/cash-basis-rules"
import { allocateCashMovement } from "@/lib/services/books/cash-flow-rules"
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const accountSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  account_type: z.enum(["asset", "liability", "equity", "income", "cogs", "expense"]),
  subtype: z.string(),
  normal_balance: z.enum(["debit", "credit"]),
  cash_flow_category: z.enum(["operating", "investing", "financing", "cash"]).nullable(),
})
const entrySchema = z.object({ id: z.string().uuid(), entry_date: z.string(), memo: z.string() })
const lineSchema = z.object({
  id: z.string().uuid(),
  entry_id: z.string().uuid(),
  account_id: z.string().uuid(),
  project_id: z.string().uuid().nullable(),
  company_id: z.string().uuid().nullable(),
  debit_cents: z.number().int(),
  credit_cents: z.number().int(),
  description: z.string().nullable(),
})

type LoadedLedger = {
  accounts: z.infer<typeof accountSchema>[]
  entries: z.infer<typeof entrySchema>[]
  lines: z.infer<typeof lineSchema>[]
}

async function loadPostedLedger(orgId: string, endDate: string, startDate?: string): Promise<LoadedLedger> {
  const service = createServiceSupabaseClient()
  const entries: z.infer<typeof entrySchema>[] = []
  for (let from = 0; ; from += 1000) {
    let query = service
      .from("journal_entries")
      .select("id, entry_date, memo")
      .eq("org_id", orgId)
      .eq("status", "posted")
      .lte("entry_date", endDate)
      .order("entry_date")
      .order("id")
      .range(from, from + 999)
    if (startDate) query = query.gte("entry_date", startDate)
    const { data, error } = await query
    if (error) throw new Error(`Failed to load journal entries: ${error.message}`)
    const page = z.array(entrySchema).parse(data ?? [])
    entries.push(...page)
    if (page.length < 1000) break
  }

  // Batching entry ids bounds the URL, but it does NOT bound the row count: 200
  // entries averaging more than five lines each blow past PostgREST's 1000-row
  // default, and the lines past it were silently dropped — which stops the trial
  // balance summing and makes every statement built on it quietly wrong. Each
  // batch is therefore paged to exhaustion, ordered by the unique
  // `(entry_id, line_no)` so a range cannot skip or repeat a line.
  const lines: z.infer<typeof lineSchema>[] = []
  for (let offset = 0; offset < entries.length; offset += 200) {
    const ids = entries.slice(offset, offset + 200).map((entry) => entry.id)
    for (let from = 0; ; from += 1000) {
      const { data, error } = await service
        .from("journal_lines")
        .select("id, entry_id, account_id, project_id, company_id, debit_cents, credit_cents, description")
        .eq("org_id", orgId)
        .in("entry_id", ids)
        .order("entry_id")
        .order("line_no")
        .range(from, from + 999)
      if (error) throw new Error(`Failed to load journal lines: ${error.message}`)
      const page = z.array(lineSchema).parse(data ?? [])
      lines.push(...page)
      if (page.length < 1000) break
    }
  }

  const { data: accountsData, error: accountError } = await service
    .from("gl_accounts")
    .select("id, code, name, account_type, subtype, normal_balance, cash_flow_category")
    .eq("org_id", orgId)
    .order("code")
  if (accountError) throw new Error(`Failed to load chart of accounts: ${accountError.message}`)
  return { accounts: z.array(accountSchema).parse(accountsData ?? []), entries, lines }
}

/** Lines carrying no project are real: org overhead is not job cost. */
export const UNASSIGNED_PROJECT_LABEL = "Unassigned"

async function loadProjectNames(orgId: string, projectIds: string[]) {
  const names = new Map<string, string>()
  const unique = Array.from(new Set(projectIds))
  const service = createServiceSupabaseClient()
  for (let from = 0; from < unique.length; from += 200) {
    const { data, error } = await service
      .from("projects")
      .select("id, name")
      .eq("org_id", orgId)
      .in("id", unique.slice(from, from + 200))
    if (error) throw new Error(`Failed to load project names: ${error.message}`)
    for (const row of data ?? []) names.set(String(row.id), String(row.name))
  }
  return names
}

export type StatementAccountRow = {
  accountId: string
  code: string
  name: string
  accountType: z.infer<typeof accountSchema>["account_type"]
  subtype: string
  debitCents: number
  creditCents: number
  balanceCents: number
  /** Present on the P&L only, where job-cost detail by project is the whole point. */
  projects?: StatementProjectAmount[]
}

export type StatementProjectAmount = {
  projectId: string | null
  projectName: string
  balanceCents: number
}

export type StatementProjectSummary = {
  projectId: string | null
  projectName: string
  revenueCents: number
  cogsCents: number
  grossProfitCents: number
  expenseCents: number
  netIncomeCents: number
}

function accountRows(ledger: LoadedLedger) {
  const totals = new Map<string, { debitCents: number; creditCents: number }>()
  for (const line of ledger.lines) {
    const current = totals.get(line.account_id) ?? { debitCents: 0, creditCents: 0 }
    current.debitCents += line.debit_cents
    current.creditCents += line.credit_cents
    totals.set(line.account_id, current)
  }
  return ledger.accounts.map<StatementAccountRow>((account) => {
    const total = totals.get(account.id) ?? { debitCents: 0, creditCents: 0 }
    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      accountType: account.account_type,
      subtype: account.subtype,
      debitCents: total.debitCents,
      creditCents: total.creditCents,
      balanceCents: account.normal_balance === "debit"
        ? total.debitCents - total.creditCents
        : total.creditCents - total.debitCents,
    }
  }).filter((row) => row.debitCents !== 0 || row.creditCents !== 0)
}

export async function buildTrialBalance(orgId: string, asOf: string) {
  const ledger = await loadPostedLedger(orgId, asOf)
  const rows = accountRows(ledger)
  return {
    statement: "trial_balance" as const,
    asOf,
    rows,
    totalDebitCents: rows.reduce((sum, row) => sum + row.debitCents, 0),
    totalCreditCents: rows.reduce((sum, row) => sum + row.creditCents, 0),
  }
}

const INCOME_STATEMENT_TYPES = new Set(["income", "cogs", "expense"])

/**
 * Profit and loss, with the project dimension the construction story depends on.
 *
 * `accountRows` aggregates by account and drops `project_id`, which is correct for
 * a trial balance and wrong for a P&L: "job-cost detail by project" is the thing a
 * generic ledger cannot do, and it survived only in the raw GL export. Journal
 * lines already carry `project_id`, so the breakdown is a second grouping over
 * rows that are already loaded — no extra ledger read.
 */
export async function buildProfitAndLoss(orgId: string, startDate: string, endDate: string) {
  const ledger = await loadPostedLedger(orgId, endDate, startDate)
  const rows = accountRows(ledger).filter((row) => INCOME_STATEMENT_TYPES.has(row.accountType))
  const accountById = new Map(ledger.accounts.map((account) => [account.id, account]))

  const totalsByAccountProject = new Map<string, Map<string, { debitCents: number; creditCents: number }>>()
  for (const line of ledger.lines) {
    const account = accountById.get(line.account_id)
    if (!account || !INCOME_STATEMENT_TYPES.has(account.account_type)) continue
    const byProject = totalsByAccountProject.get(line.account_id) ?? new Map()
    // "" is the unassigned bucket; a null project id is not a Map key that survives.
    const key = line.project_id ?? ""
    const current = byProject.get(key) ?? { debitCents: 0, creditCents: 0 }
    current.debitCents += line.debit_cents
    current.creditCents += line.credit_cents
    byProject.set(key, current)
    totalsByAccountProject.set(line.account_id, byProject)
  }

  const projectIds = Array.from(
    new Set(Array.from(totalsByAccountProject.values()).flatMap((byProject) => Array.from(byProject.keys()))),
  ).filter((key) => key !== "")
  const projectNames = await loadProjectNames(orgId, projectIds)
  const nameFor = (key: string) =>
    key === "" ? UNASSIGNED_PROJECT_LABEL : projectNames.get(key) ?? "Unknown project"

  const summaries = new Map<string, StatementProjectSummary>()
  const rowsWithProjects = rows.map((row) => {
    const account = accountById.get(row.accountId)
    const byProject = totalsByAccountProject.get(row.accountId) ?? new Map()
    const projects: StatementProjectAmount[] = Array.from(byProject.entries())
      .map(([key, total]) => {
        const balanceCents = account?.normal_balance === "credit"
          ? total.creditCents - total.debitCents
          : total.debitCents - total.creditCents
        const summary = summaries.get(key) ?? {
          projectId: key === "" ? null : key,
          projectName: nameFor(key),
          revenueCents: 0,
          cogsCents: 0,
          grossProfitCents: 0,
          expenseCents: 0,
          netIncomeCents: 0,
        }
        if (row.accountType === "income") summary.revenueCents += balanceCents
        else if (row.accountType === "cogs") summary.cogsCents += balanceCents
        else summary.expenseCents += balanceCents
        summaries.set(key, summary)
        return { projectId: key === "" ? null : key, projectName: nameFor(key), balanceCents }
      })
      .filter((project) => project.balanceCents !== 0)
      .sort((left, right) => right.balanceCents - left.balanceCents)
    return { ...row, projects }
  })

  const revenueCents = rows.filter((row) => row.accountType === "income").reduce((sum, row) => sum + row.balanceCents, 0)
  const cogsCents = rows.filter((row) => row.accountType === "cogs").reduce((sum, row) => sum + row.balanceCents, 0)
  const expenseCents = rows.filter((row) => row.accountType === "expense").reduce((sum, row) => sum + row.balanceCents, 0)

  const byProject = Array.from(summaries.values())
    .map((summary) => ({
      ...summary,
      grossProfitCents: summary.revenueCents - summary.cogsCents,
      netIncomeCents: summary.revenueCents - summary.cogsCents - summary.expenseCents,
    }))
    // Unassigned overhead sorts last: it is real, but it is not a job.
    .sort((left, right) =>
      left.projectId === null ? 1 : right.projectId === null ? -1 : right.netIncomeCents - left.netIncomeCents,
    )

  return {
    statement: "profit_loss" as const,
    startDate,
    endDate,
    rows: rowsWithProjects,
    byProject,
    revenueCents,
    cogsCents,
    grossProfitCents: revenueCents - cogsCents,
    expenseCents,
    netIncomeCents: revenueCents - cogsCents - expenseCents,
  }
}

export async function buildBalanceSheet(orgId: string, asOf: string) {
  const ledger = await loadPostedLedger(orgId, asOf)
  const rows = accountRows(ledger).filter((row) => new Set(["asset", "liability", "equity"]).has(row.accountType))
  const incomeRows = accountRows(ledger).filter((row) => new Set(["income", "cogs", "expense"]).has(row.accountType))
  const currentEarningsCents = incomeRows.reduce((sum, row) => {
    if (row.accountType === "income") return sum + row.balanceCents
    return sum - row.balanceCents
  }, 0)
  const assetCents = rows.filter((row) => row.accountType === "asset").reduce((sum, row) => sum + row.balanceCents, 0)
  const liabilityCents = rows.filter((row) => row.accountType === "liability").reduce((sum, row) => sum + row.balanceCents, 0)
  const equityCents = rows.filter((row) => row.accountType === "equity").reduce((sum, row) => sum + row.balanceCents, 0) + currentEarningsCents
  return {
    statement: "balance_sheet" as const,
    asOf,
    rows,
    currentEarningsCents,
    assetCents,
    liabilityCents,
    equityCents,
    differenceCents: assetCents - liabilityCents - equityCents,
  }
}

export async function buildCashFlowStatement(orgId: string, startDate: string, endDate: string) {
  const ledger = await loadPostedLedger(orgId, endDate, startDate)
  const accountById = new Map(ledger.accounts.map((account) => [account.id, account]))
  const linesByEntry = new Map<string, z.infer<typeof lineSchema>[]>()
  for (const line of ledger.lines) {
    const rows = linesByEntry.get(line.entry_id) ?? []
    rows.push(line)
    linesByEntry.set(line.entry_id, rows)
  }
  const categories = { operating: 0, investing: 0, financing: 0 }
  for (const lines of linesByEntry.values()) {
    const cashLines = lines.filter((line) => accountById.get(line.account_id)?.cash_flow_category === "cash")
    const cashMovement = cashLines.reduce((sum, line) => sum + line.debit_cents - line.credit_cents, 0)
    if (cashMovement === 0) continue
    const allocation = allocateCashMovement(
      cashMovement,
      lines
        .filter((line) => accountById.get(line.account_id)?.cash_flow_category !== "cash")
        .map((line) => ({
          weightCents: line.debit_cents + line.credit_cents,
          category: accountById.get(line.account_id)?.cash_flow_category ?? null,
        })),
    )
    categories.operating += allocation.operating
    categories.investing += allocation.investing
    categories.financing += allocation.financing
  }
  return {
    statement: "cash_flow" as const,
    startDate,
    endDate,
    operatingCents: categories.operating,
    investingCents: categories.investing,
    financingCents: categories.financing,
    netChangeInCashCents: categories.operating + categories.investing + categories.financing,
  }
}

/**
 * The same period, stated on a cash basis.
 *
 * Loads the period ledger once and reads both halves off it: the accrual income
 * statement, and the period movement in each account that stands between accrual
 * and cash. The conversion itself is pure — see `books/cash-basis-rules.ts` for
 * the derivation and its one stated simplification.
 *
 * The movements come from the period's own lines rather than from two trial
 * balances taken at either end. A journal line inside the window IS the change,
 * so this needs no second ledger read and cannot disagree with the accrual
 * figures it is presented beside.
 */
export async function buildCashBasisStatement(orgId: string, startDate: string, endDate: string) {
  const ledger = await loadPostedLedger(orgId, endDate, startDate)
  const accountById = new Map(ledger.accounts.map((account) => [account.id, account]))

  const movementByCode = new Map<string, number>()
  let accrualRevenueCents = 0
  let accrualCogsCents = 0
  let accrualExpenseCents = 0
  for (const line of ledger.lines) {
    const account = accountById.get(line.account_id)
    if (!account) continue
    const signed = account.normal_balance === "credit"
      ? line.credit_cents - line.debit_cents
      : line.debit_cents - line.credit_cents
    if (account.account_type === "income") accrualRevenueCents += signed
    else if (account.account_type === "cogs") accrualCogsCents += signed
    else if (account.account_type === "expense") accrualExpenseCents += signed
    else movementByCode.set(account.code, (movementByCode.get(account.code) ?? 0) + signed)
  }
  const movement = (code: string) => movementByCode.get(code) ?? 0

  const statement = convertToCashBasis({
    accrualRevenueCents,
    accrualCogsCents,
    accrualExpenseCents,
    movements: {
      accountsReceivableCents: movement(SYSTEM_ACCOUNT_CODES.accountsReceivable),
      retainageReceivableCents: movement(SYSTEM_ACCOUNT_CODES.retainageReceivable),
      contractLiabilityCents: movement(SYSTEM_ACCOUNT_CODES.contractLiability),
      customerDepositsCents: movement(SYSTEM_ACCOUNT_CODES.customerDeposits),
      accountsPayableCents: movement(SYSTEM_ACCOUNT_CODES.accountsPayable),
      retainagePayableCents: movement(SYSTEM_ACCOUNT_CODES.retainagePayable),
      payrollClearingCents: movement(SYSTEM_ACCOUNT_CODES.payrollClearing),
    },
  })

  return { statement: "cash_basis" as const, startDate, endDate, ...statement }
}

export async function buildGeneralLedger(orgId: string, startDate: string, endDate: string) {
  const ledger = await loadPostedLedger(orgId, endDate, startDate)
  const accountById = new Map(ledger.accounts.map((account) => [account.id, account]))
  const entryById = new Map(ledger.entries.map((entry) => [entry.id, entry]))
  return {
    statement: "general_ledger" as const,
    startDate,
    endDate,
    rows: ledger.lines.map((line) => ({
      ...line,
      account: accountById.get(line.account_id),
      entry: entryById.get(line.entry_id),
    })),
  }
}

