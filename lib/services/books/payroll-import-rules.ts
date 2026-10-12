import { z } from "zod"
import { booksDigest } from "./hash"
import { assertBalancedJournalDraft, buildPostingKey, type JournalEntryDraft, type JournalLineDraft } from "./types"

const cents = z.number().int().safe().nonnegative()
const accountCode = z.string().trim().min(1)
export const payrollAllocationSchema = z.object({
  id: z.string().uuid().toLowerCase(), project_id: z.string().uuid().toLowerCase().nullable(), cost_code_id: z.string().uuid().toLowerCase().nullable(),
  cost_account_code: accountCode, gross_cents: cents, employer_taxes_cents: cents, employer_benefits_cents: cents,
  labor_evidence_ids: z.array(z.string().uuid().toLowerCase()),
}).strict()
const employeeSchema = z.object({
  worker_id: z.string().uuid().toLowerCase(), employee_reference: z.string().trim().min(1).max(200),
  gross_cents: cents.positive(), net_cents: cents, employee_taxes_cents: cents, employee_deductions_cents: cents,
  employer_taxes_cents: cents, employer_benefits_cents: cents, allocations: z.array(payrollAllocationSchema).min(1),
}).strict()
/** Provider amounts, not tax calculations. A server must verify the source bytes
 * and capture original labor journals before using this accounting planner.
 */
export const payrollImportSchema = z.object({
  id: z.string().uuid().toLowerCase(), org_id: z.string().uuid().toLowerCase(), provider: z.string().trim().min(1).max(100), provider_run_id: z.string().trim().min(1).max(200),
  period_start: z.string().date(), period_end: z.string().date(), accrual_date: z.string().date(), pay_date: z.string().date(),
  source_checksum: z.string().regex(/^[a-f0-9]{64}$/), employees: z.array(employeeSchema).min(1),
  controls: z.object({ gross_cents: cents, net_cents: cents, employee_taxes_cents: cents, employee_deductions_cents: cents, employer_taxes_cents: cents, employer_benefits_cents: cents, funding_cents: cents }).strict(),
}).strict()
export const payrollLaborEvidenceSchema = z.array(z.object({
  id: z.string().uuid().toLowerCase(), org_id: z.string().uuid().toLowerCase(), worker_id: z.string().uuid().toLowerCase(), project_id: z.string().uuid().toLowerCase().nullable(),
  cost_code_id: z.string().uuid().toLowerCase().nullable(), account_code: accountCode, incurred_on: z.string().date(),
  fact_id: z.string().uuid().toLowerCase(), journal_id: z.string().uuid().toLowerCase(), source_revision: z.string().min(1),
  gross_cents: z.number().int().safe(), estimated_burden_cents: z.number().int().safe(), cost_cents: z.number().int().safe().refine(value => value !== 0), clearing_cents: z.number().int().safe(),
}).strict())
type AmountKey = "gross_cents" | "net_cents" | "employee_taxes_cents" | "employee_deductions_cents" | "employer_taxes_cents" | "employer_benefits_cents"
function safe(value: bigint) { const result = Number(value); if (!Number.isSafeInteger(result)) throw new Error("Payroll totals exceed safe integer cents"); return result }
function sum(values: number[]) { return safe(values.reduce((total,value) => total + BigInt(value),BigInt(0))) }
function unique(values: string[], label: string) { if (new Set(values).size !== values.length) throw new Error(`Duplicate payroll ${label}`) }
const compare = (a: string,b: string) => a < b ? -1 : a > b ? 1 : 0
/** Exact largest-remainder shares, with stable IDs as ties. Amount <= capacity
 * ensures no project receives more withholding than its remaining gross.
 */
function apportion(amount: number, capacities: { id: string; cents: number }[]) {
  const total = capacities.reduce((value,row) => value + BigInt(row.cents),BigInt(0))
  if (BigInt(amount) > total) throw new Error("Payroll deductions exceed gross capacity")
  if (!total) return capacities.map(() => 0)
  const rows = capacities.map((row,index) => ({ index, id: row.id, value: BigInt(amount)*BigInt(row.cents)/total, remainder: BigInt(amount)*BigInt(row.cents)%total }))
  let left = BigInt(amount) - rows.reduce((value,row) => value + row.value,BigInt(0))
  for (const row of [...rows].sort((a,b) => a.remainder === b.remainder ? compare(a.id,b.id) : a.remainder > b.remainder ? -1 : 1)) { if (!left) break; row.value++; left-- }
  return rows.map(row => safe(row.value))
}

export function reconcilePayrollImport(input: unknown, laborInput: unknown, accounts: { org_id: string; code: string; account_type: string; subtype: string; active: boolean }[]) {
  const parsed = payrollImportSchema.parse(input), evidence = payrollLaborEvidenceSchema.parse(laborInput)
  if (parsed.period_start > parsed.period_end || parsed.accrual_date < parsed.period_start || parsed.accrual_date > parsed.period_end) throw new Error("Payroll accrual date must be in its work period")
  unique(parsed.employees.map(row => row.worker_id),"worker")
  unique(parsed.employees.map(row => row.employee_reference),"employee reference")
  unique(parsed.employees.flatMap(row => row.allocations.map(allocation => allocation.id)),"allocation")
  unique(evidence.map(row => row.id),"labor evidence")
  unique(evidence.map(row => row.fact_id),"labor fact")
  unique(evidence.map(row => row.journal_id),"labor journal")
  const used = new Set<string>(), byId = new Map(evidence.map(row => [row.id,row]))
  const chart = new Map(accounts.filter(row => row.org_id === parsed.org_id && row.active).map(row => [row.code,row]))
  for (const code of ["2200","2230"]) if (chart.get(code)?.account_type !== "liability") throw new Error(`Payroll liability account ${code} is missing or invalid`)
  const run = { ...parsed, employees: parsed.employees.map(employee => ({ ...employee, allocations: employee.allocations.map(row => ({ ...row, labor_evidence_ids: [...row.labor_evidence_ids].sort(compare) })).sort((a,b) => compare(a.id,b.id)) })).sort((a,b) => compare(a.worker_id,b.worker_id)) }
  const amountKeys: AmountKey[] = ["gross_cents","net_cents","employee_taxes_cents","employee_deductions_cents","employer_taxes_cents","employer_benefits_cents"]
  const totals = Object.fromEntries(amountKeys.map(key => [key,sum(run.employees.map(row => row[key]))])) as Record<AmountKey,number>
  for (const key of amountKeys) if (totals[key] !== run.controls[key]) throw new Error(`Provider payroll control total differs: ${key}`)
  const fundingCents = sum([totals.net_cents,totals.employee_taxes_cents,totals.employee_deductions_cents,totals.employer_taxes_cents,totals.employer_benefits_cents])
  if (fundingCents !== run.controls.funding_cents) throw new Error("Provider payroll funding total differs")
  const lines: JournalLineDraft[] = [], variances: { workerId: string; allocationId: string; recognizedCents: number; estimatedBurdenCents: number; providerGrossCents: number; varianceCents: number; burdenVarianceCents: number; laborEvidenceIds: string[] }[] = []
  for (const employee of run.employees) {
    if (sum([employee.net_cents,employee.employee_taxes_cents,employee.employee_deductions_cents]) !== employee.gross_cents) throw new Error("Employee gross, net and deductions do not reconcile")
    for (const key of ["gross_cents","employer_taxes_cents","employer_benefits_cents"] as const) if (sum(employee.allocations.map(row => row[key])) !== employee[key]) throw new Error(`Payroll construction allocations differ: ${key}`)
    const taxShares = apportion(employee.employee_taxes_cents,employee.allocations.map(row => ({id:row.id,cents:row.gross_cents})))
    const deductionShares = apportion(employee.employee_deductions_cents,employee.allocations.map((row,index) => ({id:row.id,cents:row.gross_cents-taxShares[index]})))
    for (const [index,allocation] of employee.allocations.entries()) {
      const account = chart.get(allocation.cost_account_code)
      // The one liability a payroll allocation may hit: commission comp accrued at
      // settlement (Dr 6100 / Cr 2240) is paid by payroll, so its gross relieves
      // 2240 instead of being expensed twice. It carries no labor, no employer
      // burden and no variance to review.
      if (account?.account_type === "liability" && account.subtype === "accrued_commissions") {
        if (allocation.labor_evidence_ids.length || allocation.employer_taxes_cents || allocation.employer_benefits_cents) throw new Error("An accrued-commission payroll allocation carries only the commission gross")
        if (allocation.gross_cents) lines.push(
          { accountCode:allocation.cost_account_code,debitCents:allocation.gross_cents,creditCents:0,description:"Payroll accrued_commission_relief",dimensions:{ payroll_run_id:run.id, payroll_worker_id:employee.worker_id, payroll_allocation_id:allocation.id, payroll_component:"accrued_commission_relief" } },
          { accountCode:"2200",debitCents:0,creditCents:allocation.gross_cents,description:"Payroll accrued_commission_relief",dimensions:{ payroll_run_id:run.id, payroll_worker_id:employee.worker_id, payroll_allocation_id:allocation.id, payroll_component:"accrued_commission_relief" } },
        )
        for (const [amount,component] of [[taxShares[index],"employee_taxes"],[deductionShares[index],"employee_deductions"]] as const) if (amount) lines.push(
          { accountCode:"2200",debitCents:amount,creditCents:0,description:`Payroll ${component}`,dimensions:{ payroll_run_id:run.id, payroll_worker_id:employee.worker_id, payroll_allocation_id:allocation.id, payroll_component:component } },
          { accountCode:"2230",debitCents:0,creditCents:amount,description:`Payroll ${component}`,dimensions:{ payroll_run_id:run.id, payroll_worker_id:employee.worker_id, payroll_allocation_id:allocation.id, payroll_component:component } },
        )
        continue
      }
      if (!account || !(["cogs","expense"].includes(account.account_type) || (account.account_type === "asset" && account.subtype === "work_in_progress"))) throw new Error("Payroll allocation requires an active cost or construction-inventory account")
      if (account.account_type === "asset" && !allocation.project_id) throw new Error("Capitalized payroll requires a construction project")
      const original = allocation.labor_evidence_ids.map(id => {
        const row = byId.get(id)
        if (!row || used.has(id)) throw new Error("Payroll labor evidence is missing or reused")
        used.add(id)
        if ((row.gross_cents >= 0 && row.estimated_burden_cents < 0) || (row.gross_cents <= 0 && row.estimated_burden_cents > 0)) throw new Error("Payroll native wage and estimated-burden signs differ")
        if (row.org_id !== run.org_id || row.worker_id !== employee.worker_id || row.project_id !== allocation.project_id || row.cost_code_id !== allocation.cost_code_id || row.account_code !== allocation.cost_account_code || row.incurred_on < run.period_start || row.incurred_on > run.period_end || row.clearing_cents !== row.cost_cents || BigInt(row.cost_cents) !== BigInt(row.gross_cents)+BigInt(row.estimated_burden_cents)) throw new Error("Payroll labor evidence scope, period, classification or clearing differs")
        return row
      })
      const recognized = sum(original.map(row => row.gross_cents)), estimatedBurden = sum(original.map(row => row.estimated_burden_cents)), variance = safe(BigInt(allocation.gross_cents)-BigInt(recognized))
      const burdenVariance = safe(BigInt(allocation.employer_taxes_cents)+BigInt(allocation.employer_benefits_cents)-BigInt(estimatedBurden))
      variances.push({workerId:employee.worker_id,allocationId:allocation.id,recognizedCents:recognized,estimatedBurdenCents:estimatedBurden,providerGrossCents:allocation.gross_cents,varianceCents:variance,burdenVarianceCents:burdenVariance,laborEvidenceIds:allocation.labor_evidence_ids})
      const dimensions = { payroll_run_id:run.id, payroll_worker_id:employee.worker_id, payroll_allocation_id:allocation.id, ...(allocation.cost_code_id ? {cost_code_id:allocation.cost_code_id} : {}) }
      const pair = (debitCode: string,creditCode: string,amount: number,component: string) => {
        if (!amount) return
        const common = { ...(allocation.project_id ? {projectId:allocation.project_id} : {}), dimensions:{...dimensions,payroll_component:component}, description:`Payroll ${component}` }
        lines.push({ ...common,accountCode:debitCode,debitCents:Math.max(amount,0),creditCents:Math.max(-amount,0) },{ ...common,accountCode:creditCode,debitCents:Math.max(-amount,0),creditCents:Math.max(amount,0) })
      }
      pair(allocation.cost_account_code,"2200",variance,"gross_variance")
      pair("2200",allocation.cost_account_code,estimatedBurden,"estimated_burden_release")
      pair("2200","2230",taxShares[index],"employee_taxes")
      pair("2200","2230",deductionShares[index],"employee_deductions")
      pair(allocation.cost_account_code,"2230",allocation.employer_taxes_cents,"employer_taxes")
      pair(allocation.cost_account_code,"2230",allocation.employer_benefits_cents,"employer_benefits")
    }
  }
  if (used.size !== evidence.length) throw new Error("Payroll contains unassigned labor evidence")
  const recognizedGrossCents = sum(variances.map(row => row.recognizedCents)), estimatedBurdenCents = sum(variances.map(row => row.estimatedBurdenCents)), wageVarianceCents = sum(variances.map(row => row.varianceCents))
  const burdenVarianceCents = sum(variances.map(row => row.burdenVarianceCents)), costVarianceCents = safe(BigInt(wageVarianceCents)+BigInt(burdenVarianceCents))
  const draft: JournalEntryDraft | null = lines.length ? { entryDate:run.accrual_date,entryKind:"adjusting",memo:`Payroll reconciliation ${run.provider} ${run.provider_run_id}`,postingKey:buildPostingKey(`payroll_import:${run.id}`,{projectionVersion:1,sourceVersion:1}),projectionVersion:1,policyVersion:1,sourceType:"payroll_import",sourceId:run.id,lines } : null
  if (draft) assertBalancedJournalDraft(draft)
  return { run, totals, fundingCents, recognizedGrossCents, estimatedBurdenCents, wageVarianceCents, burdenVarianceCents, costVarianceCents, requiresVarianceReview:variances.some(row => row.varianceCents !== 0 || row.burdenVarianceCents !== 0), variances, draft,
    evidenceDigest:booksDigest({run,labor:evidence.sort((a,b) => compare(a.id,b.id))}) }
}
