import "server-only"

import { z } from "zod"

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

  const lines: z.infer<typeof lineSchema>[] = []
  for (let offset = 0; offset < entries.length; offset += 200) {
    const ids = entries.slice(offset, offset + 200).map((entry) => entry.id)
    const { data, error } = await service
      .from("journal_lines")
      .select("id, entry_id, account_id, project_id, company_id, debit_cents, credit_cents, description")
      .eq("org_id", orgId)
      .in("entry_id", ids)
      .order("entry_id")
      .order("line_no")
    if (error) throw new Error(`Failed to load journal lines: ${error.message}`)
    lines.push(...z.array(lineSchema).parse(data ?? []))
  }

  const { data: accountsData, error: accountError } = await service
    .from("gl_accounts")
    .select("id, code, name, account_type, subtype, normal_balance, cash_flow_category")
    .eq("org_id", orgId)
    .order("code")
  if (accountError) throw new Error(`Failed to load chart of accounts: ${accountError.message}`)
  return { accounts: z.array(accountSchema).parse(accountsData ?? []), entries, lines }
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

export async function buildProfitAndLoss(orgId: string, startDate: string, endDate: string) {
  const ledger = await loadPostedLedger(orgId, endDate, startDate)
  const rows = accountRows(ledger).filter((row) => new Set(["income", "cogs", "expense"]).has(row.accountType))
  const revenueCents = rows.filter((row) => row.accountType === "income").reduce((sum, row) => sum + row.balanceCents, 0)
  const cogsCents = rows.filter((row) => row.accountType === "cogs").reduce((sum, row) => sum + row.balanceCents, 0)
  const expenseCents = rows.filter((row) => row.accountType === "expense").reduce((sum, row) => sum + row.balanceCents, 0)
  return {
    statement: "profit_loss" as const,
    startDate,
    endDate,
    rows,
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
    const counterpart = lines
      .filter((line) => accountById.get(line.account_id)?.cash_flow_category !== "cash")
      .sort((left, right) => (right.debit_cents + right.credit_cents) - (left.debit_cents + left.credit_cents))[0]
    const category = counterpart ? accountById.get(counterpart.account_id)?.cash_flow_category : null
    if (category === "investing" || category === "financing") categories[category] += cashMovement
    else categories.operating += cashMovement
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

