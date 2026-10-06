import { z } from "zod"
import { payrollConstructionImpact } from "./payroll-construction-impact"
import { payrollLiabilityHistory } from "./payroll-liability-history"
import type { reconcilePayrollImport } from "./payroll-import-rules"

const rows = z.array(z.record(z.unknown()))
export const payrollWorkflowTablesSchema = z.object({
  job_cost_entries: rows, budget_lines: rows, budgets: rows, billable_costs: rows,
  journal_entries: rows, journal_lines: rows, gl_accounts: rows,
}).strict()
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

/** Same selection contract as books_payroll_workflow_sources. Keep complete
 * original rows, but only the construction/payment/account dependencies of this
 * run; a payroll draft must not duplicate an entire organization's snapshot.
 */
export function payrollWorkflowSources(run: ReturnType<typeof reconcilePayrollImport>["run"], input: Record<string, Record<string, unknown>[]>) {
  const tables = payrollWorkflowTablesSchema.parse(Object.fromEntries(Object.keys(payrollWorkflowTablesSchema.shape).map(name => [name, input[name]])))
  for (const [name, records] of Object.entries(tables)) {
    const ids = new Set<string>()
    for (const row of records) {
      if (row.org_id !== run.org_id) throw new Error(`Foreign payroll workflow ${name}`)
      const id = z.string().uuid().parse(row.id)
      if (ids.has(id)) throw new Error(`Duplicate payroll workflow ${name}`)
      ids.add(id)
    }
  }
  const requested = new Set(run.employees.flatMap(worker => worker.allocations.flatMap(allocation => allocation.labor_evidence_ids)))
  const jobs = tables.job_cost_entries.filter(row => requested.has(String(row.id)))
  const timeIds = new Set(jobs.map(row => row.source_id)), billableIds = new Set(jobs.map(row => row.billable_cost_id))
  const lineIds = new Set(jobs.map(row => row.budget_line_id)), budgetLines = tables.budget_lines.filter(row => lineIds.has(row.id))
  const budgetIds = new Set(budgetLines.map(row => row.budget_id))
  const codes = new Set(["2200", "2230", ...run.employees.flatMap(worker => worker.allocations.map(allocation => allocation.cost_account_code))])
  const liabilityAccounts = new Set(tables.gl_accounts.filter(row => ["2200", "2230"].includes(String(row.code))).map(row => row.id))
  const historyIds = new Set(tables.journal_lines.filter(row => {
    const dimensions = row.dimensions as Record<string, unknown> | undefined
    const classification = dimensions?.books_account_classification as Record<string, unknown> | undefined
    return liabilityAccounts.has(row.account_id) || ["2200", "2230"].includes(String(classification?.code))
  }).map(row => row.entry_id))
  const entries = tables.journal_entries.filter(row => historyIds.has(row.id) && ["posted", "reversed"].includes(String(row.status)) && row.source_type !== "labor_cost")
  const entryIds = new Set(entries.map(row => row.id)), lines = tables.journal_lines.filter(row => entryIds.has(row.entry_id))
  const accountIds = new Set(lines.map(row => row.account_id))
  const sources = {
    job_cost_entries: jobs, budget_lines: budgetLines, budgets: tables.budgets.filter(row => budgetIds.has(row.id)),
    billable_costs: tables.billable_costs.filter(row => (row.source_type === "time_entry" && timeIds.has(row.source_id)) || billableIds.has(row.id)),
    journal_entries: entries, journal_lines: lines, gl_accounts: tables.gl_accounts.filter(row => codes.has(String(row.code)) || accountIds.has(row.id)),
  }
  return Object.fromEntries(Object.entries(sources).map(([name, records]) => [name, [...records].sort((a, b) => compare(String(a.id), String(b.id)))])) as z.infer<typeof payrollWorkflowTablesSchema>
}

export function payrollWorkflowEvidence(result: ReturnType<typeof reconcilePayrollImport>, labor: unknown, tables: Record<string, Record<string, unknown>[]>) {
  const sourceTables = payrollWorkflowSources(result.run, tables)
  return { version: 1 as const, sourceTables,
    constructionImpact: payrollConstructionImpact(result, labor, sourceTables), liabilityHistory: payrollLiabilityHistory(result.run.org_id, sourceTables) }
}
