import "server-only"
import { randomUUID } from "node:crypto"

import { z } from "zod"
import { collectBooksRows } from "@/lib/services/books/paging"

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
const entrySchema = z.object({
  id: z.string().uuid(), entry_date: z.string(), memo: z.string(),
  entry_kind: z.string(), source_type: z.string().nullable(),
  reversal_of_entry_id: z.string().uuid().nullable(),
})
const lineSchema = z.object({
  id: z.string().uuid(),
  entry_id: z.string().uuid(),
  account_id: z.string().uuid(),
  project_id: z.string().uuid().nullable(),
  company_id: z.string().uuid().nullable(),
  debit_cents: z.number().int(),
  credit_cents: z.number().int(),
  description: z.string().nullable(),
  dimensions: z.record(z.unknown()).optional(),
  legal_entity_id: z.string().uuid().optional(),
})

export type LoadedLedger = {
  accounts: z.infer<typeof accountSchema>[]
  entries: z.infer<typeof entrySchema>[]
  lines: z.infer<typeof lineSchema>[]
}

export async function loadPostedLedger(orgId: string, endDate: string, startDate?: string): Promise<LoadedLedger> {
  const service = createServiceSupabaseClient()
  const entries: z.infer<typeof entrySchema>[] = []
  for (let from = 0; ; from += 1000) {
    let query = service
      .from("journal_entries")
      .select("id, entry_date, memo, entry_kind, source_type, reversal_of_entry_id")
      .eq("org_id", orgId)
      .in("status", ["posted", "reversed"])
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
        .select("id, entry_id, account_id, project_id, company_id, debit_cents, credit_cents, description, dimensions, legal_entity_id")
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

  const accountsData = await collectBooksRows((from, to) => service.from("gl_accounts")
    .select("id, code, name, account_type, subtype, normal_balance, cash_flow_category")
    .eq("org_id", orgId).order("code").order("id").range(from, to))
  return { accounts: z.array(accountSchema).parse(accountsData), entries, lines }

}

/**
 * The ledger as of a date, summed in the database: one line per account, project,
 * contract and warranty-reserve flag under a single synthetic entry dated `asOf`.
 *
 * As-of statements (trial balance, balance sheet) and the close tie-outs need
 * only these totals, and loading every entry and line since the company began
 * made each review grow with the whole history. Anything that needs real
 * entries — dates inside a window, closing entries, memos — loads the ledger.
 */
export async function loadLedgerBalances(orgId: string, asOf: string): Promise<LoadedLedger> {
  const service = createServiceSupabaseClient()
  const [balances, accountsData] = await Promise.all([
    service.rpc("books_ledger_balances", { p_org_id: orgId, p_as_of: asOf }),
    collectBooksRows((from, to) => service.from("gl_accounts")
      .select("id, code, name, account_type, subtype, normal_balance, cash_flow_category")
      .eq("org_id", orgId).order("code").order("id").range(from, to)),
  ])
  if (balances.error) throw new Error(`Failed to load ledger balances: ${balances.error.message}`)
  const rows = z.array(z.object({
    account_id: z.string().uuid(), project_id: z.string().uuid().nullable(), contract_id: z.string().nullable(),
    warranty_reserve_adjustment: z.boolean(), legal_entity_id: z.string().uuid(), intercompany: z.boolean(), debit_cents: z.coerce.number().int(), credit_cents: z.coerce.number().int(),
  })).parse(balances.data ?? [])
  const entryId = randomUUID()
  return {
    accounts: z.array(accountSchema).parse(accountsData),
    entries: [{ id: entryId, entry_date: asOf, memo: "Ledger balances", entry_kind: "operational", source_type: null, reversal_of_entry_id: null }],
    lines: rows.map((row) => ({
      id: randomUUID(), entry_id: entryId, account_id: row.account_id, project_id: row.project_id, company_id: null,
      debit_cents: row.debit_cents, credit_cents: row.credit_cents, description: null, legal_entity_id: row.legal_entity_id,
      dimensions: { ...(row.contract_id ? { contract_id: row.contract_id } : {}), ...(row.warranty_reserve_adjustment ? { warranty_reserve_adjustment: true } : {}), ...(row.intercompany ? { intercompany: true } : {}) },
    })),
  }
}

/** One company's books. Each balances on its own because posting adds the due-from / due-to legs. */
export function forLegalEntity(ledger: LoadedLedger, legalEntityId: string): LoadedLedger {
  return { ...ledger, lines: ledger.lines.filter((line) => line.legal_entity_id === legalEntityId) }
}

/**
 * What consolidation removes beyond the tagged lines, computed from the
 * intercompany sales register and never posted: the profit a seller made on a
 * lot sold to an affiliate's home stays out of that home's inventory (moving with
 * it from construction to completed homes) until the home sells to an outside
 * buyer, when it comes out of cost of sales instead.
 */
export async function loadConsolidationEliminations(orgId: string): Promise<Pick<LoadedLedger, "entries" | "lines">> {
  const service = createServiceSupabaseClient()
  const [sales, accounts] = await Promise.all([
    collectBooksRows((from, to) => service.from("books_intercompany_sales").select("id, buyer_project_id, sale_date, price_cents, cost_cents").eq("org_id", orgId).order("id").range(from, to)),
    service.from("gl_accounts").select("id, code").eq("org_id", orgId).in("code", ["1160", "1170", "5000"]),
  ])
  if (accounts.error) throw new Error(`Failed to load elimination accounts: ${accounts.error.message}`)
  if (!sales.length) return { entries: [], lines: [] }
  const account = (code: string) => {
    const id = accounts.data?.find((row) => row.code === code)?.id
    if (!id) throw new Error(`Account ${code} is missing for consolidation`)
    return String(id)
  }
  const { data: settings, error } = await service.from("project_financial_settings").select("project_id, books_inventory_completed_on, books_inventory_sold_on")
    .eq("org_id", orgId).in("project_id", [...new Set(sales.map((sale) => String(sale.buyer_project_id)))])
  if (error) throw new Error(`Failed to load home stages for consolidation: ${error.message}`)
  const stage = new Map((settings ?? []).map((row) => [String(row.project_id), row]))
  const entries: LoadedLedger["entries"] = [], lines: LoadedLedger["lines"] = []
  const post = (date: string, projectId: string, debitCode: string | null, creditCode: string, cents: number) => {
    const id = randomUUID()
    entries.push({ id, entry_date: date, memo: "Eliminate intercompany profit", entry_kind: "adjusting", source_type: "consolidation_elimination", reversal_of_entry_id: null })
    const side = (code: string, debit: boolean) => ({ id: randomUUID(), entry_id: id, account_id: account(code), project_id: projectId, company_id: null, description: null,
      debit_cents: debit === cents > 0 ? Math.abs(cents) : 0, credit_cents: debit === cents > 0 ? 0 : Math.abs(cents), dimensions: { intercompany_elimination: true } })
    if (debitCode) lines.push(side(debitCode, true))
    lines.push(side(creditCode, false))
  }
  for (const sale of sales) {
    const profit = Number(sale.price_cents) - Number(sale.cost_cents)
    if (profit === 0) continue
    const projectId = String(sale.buyer_project_id), home = stage.get(projectId)
    const completedOn = home?.books_inventory_completed_on ? String(home.books_inventory_completed_on) : null
    const soldOn = home?.books_inventory_sold_on ? String(home.books_inventory_sold_on) : null
    // Balanced by the seller's revenue, cost and the due-from / due-to legs it replaces.
    post(String(sale.sale_date), projectId, null, "1160", profit)
    if (completedOn) post(completedOn, projectId, "1160", "1170", profit)
    if (soldOn) post(soldOn, projectId, completedOn ? "1170" : "1160", "5000", profit)
  }
  return { entries, lines }
}

/**
 * All companies consolidated: what they owe each other (the due-from / due-to
 * legs) and what one sold another (tagged intercompany_eliminate) come out, and
 * the computed eliminations go in. The legs always post as a balanced pair, and
 * a sale's tagged lines with its legs balance its elimination.
 */
export function consolidated(ledger: LoadedLedger, eliminations: Pick<LoadedLedger, "entries" | "lines">): LoadedLedger {
  return {
    accounts: ledger.accounts,
    entries: [...ledger.entries, ...eliminations.entries],
    lines: [...ledger.lines.filter((line) => line.dimensions?.intercompany !== true && line.dimensions?.intercompany_eliminate !== true), ...eliminations.lines],
  }
}

/** One company's ledger, or (null) the consolidated one. */
export async function ledgerForCompany(orgId: string, ledger: LoadedLedger, legalEntityId: string | null) {
  return legalEntityId ? forLegalEntity(ledger, legalEntityId) : consolidated(ledger, await loadConsolidationEliminations(orgId))
}

/** Closing and its reversing entry transfer earnings; neither is operating activity. */
function ledgerWindow(ledger: LoadedLedger, endDate: string, startDate?: string, operating = false): LoadedLedger {
  const closingIds = new Set(ledger.entries.filter((entry) => entry.entry_kind === "closing").map((entry) => entry.id))
  const entries = ledger.entries.filter((entry) => entry.entry_date <= endDate
    && (!startDate || entry.entry_date >= startDate)
    && (!operating || (!closingIds.has(entry.id) && !closingIds.has(entry.reversal_of_entry_id ?? ""))))
  const ids = new Set(entries.map((entry) => entry.id))
  const byId = new Map(ledger.entries.map((entry) => [entry.id, entry]))
  const classifiedEntries = entries.map((entry) => ({ ...entry, source_type: entry.source_type ?? byId.get(entry.reversal_of_entry_id ?? "")?.source_type ?? null }))
  return { accounts: ledger.accounts, entries: classifiedEntries, lines: ledger.lines.filter((line) => ids.has(line.entry_id)) }
}

/** Financial statement signs follow the category, including contra accounts. */
function statementRows(ledger: LoadedLedger) {
  return accountRows(ledger).map((row) => ({
    ...row,
    balanceCents: ["asset", "cogs", "expense"].includes(row.accountType)
      ? row.debitCents - row.creditCents : row.creditCents - row.debitCents,
  }))
}

/** The posting dimensions a P&L can be sliced by (see docs/books-dimensions.md). */
export const STATEMENT_DIMENSIONS = ["division_id", "community_id", "lot_id", "contract_id", "cost_code_id", "cost_type", "organization_id"] as const;
export type StatementDimension = (typeof STATEMENT_DIMENSIONS)[number];

/** Lines carrying no project are real: org overhead is not job cost. */
export const UNASSIGNED_PROJECT_LABEL = "Unassigned"

async function loadProjectNames(orgId: string, projectIds: string[]) {
  const names = new Map<string, string>()
  const unique = Array.from(new Set(projectIds))
  if (unique.length === 0) return names
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

export async function buildTrialBalance(orgId: string, asOf: string, snapshot?: LoadedLedger) {
  const ledger = ledgerWindow(snapshot ?? await loadLedgerBalances(orgId, asOf), asOf)
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
export async function buildProfitAndLoss(orgId: string, startDate: string, endDate: string, snapshot?: LoadedLedger) {
  const ledger = ledgerWindow(snapshot ?? await loadPostedLedger(orgId, endDate), endDate, startDate, true)
  const rows = statementRows(ledger).filter((row) => INCOME_STATEMENT_TYPES.has(row.accountType))
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
        const balanceCents = account?.account_type === "income"
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

  type DimensionGroup = { key: string; label: string; revenueCents: number; cogsCents: number; expenseCents: number; netIncomeCents: number;
    /** The group's amount per account, in statement sign, so each slice drills to its lines. */
    accounts: Array<{ accountId: string; code: string; name: string; accountType: string; balanceCents: number }> };
  const byDimension: Record<string, DimensionGroup[]> = {};
  for (const dimension of STATEMENT_DIMENSIONS) {
    const groups = new Map<string, DimensionGroup>();
    const accounts = new Map(ledger.accounts.map(account => [account.id, account]));
    for (const line of ledger.lines) {
      const account = accounts.get(line.account_id);
      if (!account || !["income", "cogs", "expense"].includes(account.account_type)) continue;
      // "" is the unassigned bucket: a line without this classification is shown,
      // never dropped, and cannot merge with a real value that reads "Unassigned".
      const key = typeof line.dimensions?.[dimension] === "string" ? String(line.dimensions[dimension]) : "";
      const labelKey = dimension.replace(/_id$/, "_name");
      const label = key === "" ? UNASSIGNED_PROJECT_LABEL : typeof line.dimensions?.[labelKey] === "string" ? String(line.dimensions[labelKey]) : key;
      const group = groups.get(key) ?? { key, label, revenueCents: 0, cogsCents: 0, expenseCents: 0, netIncomeCents: 0, accounts: [] };
      const signed = account.account_type === "income" ? line.credit_cents - line.debit_cents : line.debit_cents - line.credit_cents;
      if (account.account_type === "income") group.revenueCents += signed;
      else if (account.account_type === "cogs") group.cogsCents += signed;
      else group.expenseCents += signed;
      const byAccount = group.accounts.find((row) => row.accountId === account.id);
      if (byAccount) byAccount.balanceCents += signed;
      else group.accounts.push({ accountId: account.id, code: account.code, name: account.name, accountType: account.account_type, balanceCents: signed });
      group.netIncomeCents = group.revenueCents - group.cogsCents - group.expenseCents;
      groups.set(key, group);
    }
    byDimension[dimension] = [...groups.values()].sort((left, right) => Number(left.key === "") - Number(right.key === ""));
  }
  // Cost codes and contracts carry no name on the line; a slice reads by its code
  // and name or its contract title, never by a record id.
  const idsOf = (dimension: StatementDimension) => byDimension[dimension].map((group) => group.key).filter((key) => /^[0-9a-f-]{36}$/i.test(key));
  const service = idsOf("cost_code_id").length || idsOf("contract_id").length ? createServiceSupabaseClient() : null;
  const [costCodes, contracts] = await Promise.all([
    service && idsOf("cost_code_id").length ? service.from("cost_codes").select("id, code, name").eq("org_id", orgId).in("id", idsOf("cost_code_id")) : Promise.resolve({ data: [], error: null }),
    service && idsOf("contract_id").length ? service.from("contracts").select("id, title").eq("org_id", orgId).in("id", idsOf("contract_id")) : Promise.resolve({ data: [], error: null }),
  ]);
  if (costCodes.error || contracts.error) throw new Error(`Failed to name statement slices: ${(costCodes.error ?? contracts.error)?.message}`);
  const names = new Map<string, string>([
    ...(costCodes.data ?? []).map((row): [string, string] => [String(row.id), `${row.code} ${row.name}`]),
    ...(contracts.data ?? []).map((row): [string, string] => [String(row.id), String(row.title)]),
  ]);
  for (const dimension of ["cost_code_id", "contract_id"] as const)
    for (const group of byDimension[dimension]) group.label = names.get(group.key) ?? group.label;

  return {
    statement: "profit_loss" as const,
    startDate,
    endDate,
    rows: rowsWithProjects,
    byDimension,
    byProject,
    revenueCents,
    cogsCents,
    grossProfitCents: revenueCents - cogsCents,
    expenseCents,
    netIncomeCents: revenueCents - cogsCents - expenseCents,
  }
}

export async function buildBalanceSheet(orgId: string, asOf: string, snapshot?: LoadedLedger) {
  const ledger = ledgerWindow(snapshot ?? await loadLedgerBalances(orgId, asOf), asOf)
  const rows = statementRows(ledger).filter((row) => new Set(["asset", "liability", "equity"]).has(row.accountType))
  // The control ledger stays intact. Presentation nets each contract/project's
  // asset and liability, then sums debit positions separately from credit positions.
  const contractAccounts = new Set(ledger.accounts.filter((account) => new Set<string>([SYSTEM_ACCOUNT_CODES.contractAsset, SYSTEM_ACCOUNT_CODES.contractLiability]).has(account.code)).map((account) => account.id))
  const contractNet = new Map<string, number>()
  const contractProjects = new Map<string, string | null>()
  const unallocatedContractProjects = new Set(ledger.lines.filter(line => contractAccounts.has(line.account_id) && typeof line.dimensions?.contract_id !== "string").map(line => line.project_id))
  for (const line of ledger.lines) {
    if (!contractAccounts.has(line.account_id)) continue
    const contractKey = !unallocatedContractProjects.has(line.project_id) && typeof line.dimensions?.contract_id === "string" ? `contract:${line.dimensions.contract_id}` : `project:${line.project_id ?? "unassigned"}`
    contractProjects.set(contractKey, line.project_id)
    contractNet.set(contractKey, (contractNet.get(contractKey) ?? 0) + line.debit_cents - line.credit_cents)
  }
  const contractAssetCents = [...contractNet.values()].reduce((sum, net) => sum + Math.max(net, 0), 0)
  const contractLiabilityCents = [...contractNet.values()].reduce((sum, net) => sum + Math.max(-net, 0), 0)
  for (const [code, balanceCents] of [[SYSTEM_ACCOUNT_CODES.contractAsset, contractAssetCents], [SYSTEM_ACCOUNT_CODES.contractLiability, contractLiabilityCents]] as const) {
    const account = ledger.accounts.find((item) => item.code === code)
    if (!account) { if (balanceCents !== 0) throw new Error(`Missing contract presentation account ${code}`); continue }
    const existing = rows.find((row) => row.accountId === account.id)
    if (existing) existing.balanceCents = balanceCents
    else if (balanceCents !== 0) rows.push({ accountId: account.id, code, name: account.name, accountType: account.account_type, subtype: account.subtype, debitCents: 0, creditCents: 0, balanceCents })
  }
  const incomeRows = statementRows(ledger).filter((row) => new Set(["income", "cogs", "expense"]).has(row.accountType))
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
    unallocatedContractProjectIds: [...unallocatedContractProjects],
    contractPositions: [...contractNet].map(([key, netCents]) => ({ projectId: contractProjects.get(key) ?? null, contractId: key.startsWith("contract:") ? key.slice(9) : null, assetCents: Math.max(netCents, 0), liabilityCents: Math.max(-netCents, 0) })),
    assetCents,
    liabilityCents,
    equityCents,
    differenceCents: assetCents - liabilityCents - equityCents,
  }
}

function cashEntryAllocations(ledger: LoadedLedger) {
  const accountById = new Map(ledger.accounts.map((account) => [account.id, account]))
  const entryById = new Map(ledger.entries.map((entry) => [entry.id, entry]))
  const linesByEntry = new Map<string, z.infer<typeof lineSchema>[]>()
  for (const line of ledger.lines) {
    const rows = linesByEntry.get(line.entry_id) ?? []
    rows.push(line)
    linesByEntry.set(line.entry_id, rows)
  }
  return [...linesByEntry].map(([entryId, lines]) => {
    const sourceType = entryById.get(entryId)?.source_type
    const cashMovement = lines.filter((line) => accountById.get(line.account_id)?.cash_flow_category === "cash")
      .reduce((sum, line) => sum + line.debit_cents - line.credit_cents, 0)
    const counterparts = lines.filter((line) => accountById.get(line.account_id)?.cash_flow_category !== "cash")
    const allocation = allocateCashMovement(cashMovement, counterparts.map((line) => ({
      weightCents: line.debit_cents + line.credit_cents, cashOffsetCents: line.credit_cents - line.debit_cents,
      category: accountById.get(line.account_id)?.cash_flow_category ?? null,
    })), sourceType)
    const customer = sourceType?.startsWith("invoice") || sourceType?.startsWith("customer_deposit") || counterparts.some((line) => {
      const account = accountById.get(line.account_id)
      return account && new Set<string>([SYSTEM_ACCOUNT_CODES.accountsReceivable, SYSTEM_ACCOUNT_CODES.retainageReceivable, SYSTEM_ACCOUNT_CODES.contractLiability]).has(account.code)
    })
    const vendor = ["expense", "bill_payment", "ap_fee_charge", "labor_cost"].includes(sourceType ?? "")
    const receipt = customer || (!vendor && allocation.operating > 0)
    return { ...allocation, receipts: receipt ? allocation.operating : 0, payments: receipt ? 0 : -allocation.operating }
  })
}

export async function buildCashFlowStatement(orgId: string, startDate: string, endDate: string, snapshot?: LoadedLedger) {
  const ledger = ledgerWindow(snapshot ?? await loadPostedLedger(orgId, endDate), endDate, startDate)
  const categories = cashEntryAllocations(ledger).reduce((sum, entry) => ({ operating: sum.operating + entry.operating, investing: sum.investing + entry.investing, financing: sum.financing + entry.financing }), { operating: 0, investing: 0, financing: 0 })
  return { statement: "cash_flow" as const, startDate, endDate, operatingCents: categories.operating,
    investingCents: categories.investing, financingCents: categories.financing,
    netChangeInCashCents: categories.operating + categories.investing + categories.financing }
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
export async function buildCashBasisStatement(orgId: string, startDate: string, endDate: string, snapshot?: LoadedLedger) {
  const ledger = ledgerWindow(snapshot ?? await loadPostedLedger(orgId, endDate), endDate, startDate, true)
  const accountById = new Map(ledger.accounts.map((account) => [account.id, account]))

  const movementByCode = new Map<string, number>()
  let accrualRevenueCents = 0
  let accrualCogsCents = 0
  let accrualExpenseCents = 0
  for (const line of ledger.lines) {
    const account = accountById.get(line.account_id)
    if (!account) continue
    const signed = ["income", "liability", "equity"].includes(account.account_type)
      ? line.credit_cents - line.debit_cents
      : line.debit_cents - line.credit_cents
    if (account.account_type === "income") accrualRevenueCents += signed
    else if (account.account_type === "cogs") accrualCogsCents += signed
    else if (account.account_type === "expense") accrualExpenseCents += signed
    else movementByCode.set(account.code, (movementByCode.get(account.code) ?? 0) + signed)
  }
  const movement = (code: string) => movementByCode.get(code) ?? 0

  const cash = cashEntryAllocations(ledger)
  const statement = convertToCashBasis({
    actualCash: { receiptsCents: cash.reduce((sum, row) => sum + row.receipts, 0), paidCents: cash.reduce((sum, row) => sum + row.payments, 0) },
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

export async function buildGeneralLedger(orgId: string, startDate: string, endDate: string, snapshot?: LoadedLedger) {
  const ledger = ledgerWindow(snapshot ?? await loadPostedLedger(orgId, endDate), endDate, startDate)
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
