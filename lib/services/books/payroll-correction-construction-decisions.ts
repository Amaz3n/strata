import { z } from "zod"

const uuid = z.string().uuid().toLowerCase()
export const payrollCorrectionConstructionDecisionsSchema = z.array(z.object({
  workerId: uuid, allocationId: uuid, projectId: uuid, costCodeId: uuid.nullable(),
  accountId: uuid, component: z.enum(["gross_variance", "employer_taxes", "employer_benefits"]),
  budgetLineId: uuid.nullable(), gmpClassification: z.enum(["inside_gmp", "outside_gmp"]),
  billingTreatment: z.literal("preserve_time_and_materials_rates"),
  reason: z.string().trim().min(20).max(4000),
}).strict()).min(1)
type Row = Record<string, unknown>
const identity = (row: Row) => JSON.stringify([row.workerId,row.allocationId,row.projectId,row.costCodeId,row.accountId,row.component])

/** Choices affect cost placement, never provider amounts, native time or the
 * customer's recorded hours/rates. The monetary proposal supplies immutable
 * preparation, independent review and actual posting ownership. */
export function applyPayrollCorrectionConstructionDecisions<T extends Row & {blockers:string[]}>(
  costs: T[], input: unknown, tables: Record<string, Row[]>, orgId: string,
): T[] {
  const decisions = payrollCorrectionConstructionDecisionsSchema.parse(input)
  const needed = costs.filter(cost=>cost.blockers.includes("review_new_or_reallocated_budget_and_gmp"))
  const selected = new Map(decisions.map(decision=>[identity(decision),decision]))
  if(selected.size!==decisions.length||selected.size!==needed.length||needed.some(cost=>!selected.has(identity(cost)))) throw new Error("Construction decisions must cover each new or reallocated cost leg exactly once")
  return costs.map(cost=>{
    const decision=selected.get(identity(cost))
    if(!decision)return cost
    if(decision.budgetLineId!==null){
      const lines=(tables.budget_lines??[]).filter(row=>row.org_id===orgId&&row.id===decision.budgetLineId)
      const budgets=(tables.budgets??[]).filter(row=>row.org_id===orgId&&row.id===lines[0]?.budget_id)
      if(lines.length!==1||budgets.length!==1||budgets[0].project_id!==decision.projectId||lines[0].cost_code_id!==decision.costCodeId)throw new Error("Construction decision budget is outside the corrective project and cost code")
    }
    // Current commercial/closing blockers still apply. Selecting preservation
    // is not authority to convert cost-plus invoices into T&M invoices.
    return {...cost,budgetLineId:decision.budgetLineId,gmpClassification:decision.gmpClassification,
      blockers:cost.blockers.filter(blocker=>!["review_new_or_reallocated_budget_and_gmp","review_customer_billing_basis"].includes(blocker))}
  })
}
