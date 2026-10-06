import { z } from "zod"
import { booksDigest } from "./hash"
import { payrollLaborEvidenceSchema, type reconcilePayrollImport } from "./payroll-import-rules"

type Reconciliation = ReturnType<typeof reconcilePayrollImport>
type Tables = Record<string, Record<string, unknown>[]>
type Component = "gross_variance" | "estimated_burden_release" | "employer_taxes" | "employer_benefits"
const uuid = z.string().uuid().toLowerCase()
const costSchema = z.object({
  id: uuid, org_id: uuid, project_id: uuid, cost_code_id: uuid.nullable(), source_type: z.literal("time_entry"), source_id: uuid,
  status: z.literal("posted"), cost_cents: z.number().int().safe(), incurred_on: z.string().date(),
  budget_line_id: uuid.nullable().optional(), gmp_classification: z.enum(["inside_gmp", "outside_gmp"]).nullable().optional(),
  billable_cost_id: uuid.nullable().optional(),
})
const billableSchema = z.object({
  id: uuid, org_id: uuid, project_id: uuid, cost_code_id: uuid.nullable(), source_type: z.literal("time_entry"), source_id: uuid,
  status: z.enum(["open", "locked", "billed", "excluded", "voided"]), is_billable: z.boolean(),
  cost_cents: z.number().int().safe(), markup_cents: z.number().int().safe(), billable_cents: z.number().int().safe(),
  markup_percent_resolved: z.union([z.number().finite(), z.string().regex(/^-?\d+(\.\d+)?$/)]),
  invoice_id: uuid.nullable().optional(), metadata: z.record(z.unknown()),
})
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
function exact(value: bigint) {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new Error("Payroll construction totals exceed safe integer cents")
  return result
}
function indexed(rows: Record<string, unknown>[], label: string) {
  const result = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const id = uuid.parse(row.id)
    if (result.has(id)) throw new Error(`Duplicate payroll construction ${label}`)
    result.set(id, row)
  }
  return result
}

/** Construction-side preview, never a posting authority. Original labor stays
 * intact; signed supplemental costs replace its wage/burden estimates. A future
 * posting transaction must independently freeze/validate these dependencies and
 * commit the GL, job costs and reviewed billing corrections together.
 */
export function payrollConstructionImpact(result: Reconciliation, laborInput: unknown, tables: Tables) {
  const labor = payrollLaborEvidenceSchema.parse(laborInput), byId = new Map(labor.map(row => [row.id, row]))
  const required = ["job_cost_entries", "budget_lines", "budgets", "billable_costs"]
  const unavailable = required.filter(name => !tables[name])
  for (const name of required) if (tables[name]?.some(row => row.org_id !== result.run.org_id)) throw new Error(`Foreign payroll construction evidence in ${name}`)
  const sourceCosts = indexed(tables.job_cost_entries ?? [], "job cost")
  const variances = new Map(result.variances.map(row => [row.allocationId, row]))
  const budgetsById = indexed(tables.budgets ?? [], "budget")
  const budgetLinesById = indexed(tables.budget_lines ?? [], "budget line")
  indexed(tables.billable_costs ?? [], "billable cost")
  const billablesByTime = new Map<string, Record<string, unknown>[]>()
  for (const row of tables.billable_costs ?? []) if (row.source_type === "time_entry") {
    const id = String(row.source_id), matches = billablesByTime.get(id) ?? []
    matches.push(row); billablesByTime.set(id, matches)
  }
  const allocations = result.run.employees.flatMap(employee => employee.allocations.map(allocation => {
    const variance = variances.get(allocation.id)
    if (!variance || variance.workerId !== employee.worker_id) throw new Error("Missing payroll construction reconciliation")
    const components: { component: Component; costCents: number }[] = [
      { component: "gross_variance", costCents: variance.varianceCents },
      { component: "estimated_burden_release", costCents: -variance.estimatedBurdenCents },
      { component: "employer_taxes", costCents: allocation.employer_taxes_cents },
      { component: "employer_benefits", costCents: allocation.employer_benefits_cents },
    ].filter(row => row.costCents !== 0) as { component: Component; costCents: number }[]
    const costDeltaCents = exact(components.reduce((total, row) => total + BigInt(row.costCents), BigInt(0)))
    const originalCostCents = exact(allocation.labor_evidence_ids.reduce((total, id) => {
      const original = byId.get(id)
      if (!original || original.project_id !== allocation.project_id || original.cost_code_id !== allocation.cost_code_id || original.worker_id !== employee.worker_id || original.org_id !== result.run.org_id) throw new Error("Payroll construction original labor differs")
      return total + BigInt(original.cost_cents)
    }, BigInt(0)))
    const actualCostCents = exact(BigInt(allocation.gross_cents) + BigInt(allocation.employer_taxes_cents) + BigInt(allocation.employer_benefits_cents))
    if (BigInt(originalCostCents) + BigInt(costDeltaCents) !== BigInt(actualCostCents)) throw new Error("Payroll project costs do not reconcile to actual payroll")
    const blockers: string[] = []
    const sources = allocation.labor_evidence_ids.map(id => {
      const source = costSchema.parse(sourceCosts.get(id)), original = byId.get(id)!
      if (source.org_id !== result.run.org_id || source.project_id !== allocation.project_id || source.cost_code_id !== allocation.cost_code_id || source.cost_cents !== original.cost_cents || source.incurred_on !== original.incurred_on) throw new Error("Payroll construction source differs from original labor")
      return source
    })
    let budgetLineId: string | null = null, gmpClassification: "inside_gmp" | "outside_gmp" | null = null
    if (allocation.project_id && components.length) {
      blockers.push(...unavailable.map(name => `missing_${name}`))
      if (sources.some(row => row.incurred_on > result.run.accrual_date)) blockers.push("payroll_accrual_precedes_native_cost")
      if (!sources.length) blockers.push("new_project_cost_requires_budget_and_gmp_allocation")
      else {
        const budgets = new Set(sources.map(row => row.budget_line_id)), gmp = new Set(sources.map(row => row.gmp_classification))
        if (budgets.size !== 1 || budgets.has(undefined)) blockers.push("review_budget_allocation")
        else budgetLineId = sources[0].budget_line_id ?? null
        if (gmp.size !== 1 || gmp.has(undefined) || gmp.has(null)) blockers.push("review_gmp_allocation")
        else gmpClassification = sources[0].gmp_classification!
        if (budgetLineId) {
          const line = budgetLinesById.get(budgetLineId), budget = budgetsById.get(String(line?.budget_id))
          if (!line || !budget || budget.project_id !== allocation.project_id || line.cost_code_id !== allocation.cost_code_id) blockers.push("review_budget_source_scope")
        }
      }
      if (components.some(row => row.costCents < -2147483648 || row.costCents > 2147483647)) blockers.push("job_cost_integer_capacity")
    }
    const billables = sources.flatMap(source => {
      const matches = billablesByTime.get(source.source_id) ?? []
      if (matches.length > 1) throw new Error("Ambiguous payroll original billing source")
      if (!matches.length) { if (source.billable_cost_id) blockers.push("missing_original_billable_cost"); return [] }
      const item = billableSchema.parse(matches[0])
      if (item.org_id !== result.run.org_id || item.project_id !== source.project_id || item.cost_code_id !== source.cost_code_id || source.billable_cost_id && source.billable_cost_id !== item.id) throw new Error("Payroll billing source differs from native job cost")
      if (BigInt(item.cost_cents) + BigInt(item.markup_cents) !== BigInt(item.billable_cents)) throw new Error("Payroll original billing amounts do not reconcile")
      return [item]
    }).sort((a, b) => compare(a.id, b.id))
    const methods = new Set(billables.map(row => row.metadata.billing_method))
    // Payroll costs do not change agreed hourly customer rates. Cost-plus cost
    // changes need markup/eligibility/GMP review; no guessed customer amount.
    const billingAction = !allocation.project_id ? "overhead_only" : !components.length ? "no_cost_components" :
      billables.length === sources.length && billables.length > 0 && methods.size === 1 && methods.has("time_and_materials_rate") ? "preserve_time_and_materials_rates" :
      billables.length === sources.length && billables.length > 0 && methods.size === 1 && methods.has("cost_plus_markup") ? "review_cost_plus_correction" : "review_billing_basis"
    return {
      allocationId: allocation.id, workerId: employee.worker_id, projectId: allocation.project_id, costCodeId: allocation.cost_code_id,
      accountCode: allocation.cost_account_code, incurredOn: result.run.accrual_date, originalCostCents, actualCostCents, costDeltaCents,
      budgetLineId, gmpClassification, components,
      jobCostCorrections: allocation.project_id ? components.map(row => ({ ...row, sourceType: "payroll_import" as const, sourceKey: `${result.run.id}:${allocation.id}:${row.component}` })) : [],
      sourceJobCosts: [...sources].sort((a, b) => compare(a.id, b.id)), sourceJobCostIds: sources.map(row => row.id).sort(compare), blockers: [...new Set(blockers)].sort(compare),
      billing: { action: billingAction, customerAmountDeltaCents: billingAction === "preserve_time_and_materials_rates" || billingAction === "overhead_only" || billingAction === "no_cost_components" ? 0 : null,
        originalSources: billables, originalBillableCostIds: billables.map(row => row.id), protectedBillableCostIds: billables.filter(row => ["locked", "billed"].includes(row.status) || row.invoice_id).map(row => row.id),
        requiresReview: billingAction === "review_cost_plus_correction" || billingAction === "review_billing_basis" },
    }
  }))
  // Compare every cost bucket against the proposed journal, including overhead
  // and capitalized WIP. Netting across projects could conceal misallocation.
  const expected = new Map<string, bigint>(), actual = new Map<string, bigint>()
  const key = (account: string, project: string | null, code: string | null) => JSON.stringify([account, project, code])
  for (const allocation of allocations) {
    const bucket = key(allocation.accountCode, allocation.projectId, allocation.costCodeId)
    expected.set(bucket, (expected.get(bucket) ?? BigInt(0)) + BigInt(allocation.costDeltaCents))
  }
  for (const line of result.draft?.lines ?? []) if (!["2200", "2230"].includes(line.accountCode)) {
    const bucket = key(line.accountCode, line.projectId ?? null, String(line.dimensions?.cost_code_id ?? "") || null)
    actual.set(bucket, (actual.get(bucket) ?? BigInt(0)) + BigInt(line.debitCents) - BigInt(line.creditCents))
  }
  for (const bucket of new Set([...expected.keys(), ...actual.keys()])) if ((expected.get(bucket) ?? BigInt(0)) !== (actual.get(bucket) ?? BigInt(0))) throw new Error("Payroll construction allocation differs from ledger cost bucket")
  const plan = { version: 1 as const, runId: result.run.id, allocations,
    projectCostDeltaCents: exact(allocations.filter(row => row.projectId).reduce((total, row) => total + BigInt(row.costDeltaCents), BigInt(0))),
    overheadCostDeltaCents: exact(allocations.filter(row => !row.projectId).reduce((total, row) => total + BigInt(row.costDeltaCents), BigInt(0))),
    requiresAllocationReview: allocations.some(row => row.blockers.length), requiresBillingReview: allocations.some(row => row.billing.requiresReview),
    previewOnly: true as const, postingImplemented: false as const }
  return { ...plan, digest: booksDigest(plan) }
}
