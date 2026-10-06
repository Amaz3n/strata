import { payrollCorrectionConstructionDecisionsSchema } from "./payroll-correction-construction-decisions"
import { payrollCorrectionBaselineSchema } from "./payroll-correction-lineage"
import { z } from "zod"
import { booksDigest } from "./hash"
import { payrollCorrectionPlan } from "./payroll-correction-plan"
import { payrollCorrectionRequestSchema } from "./payroll-correction-request"
import { parsePayrollCorrectionSource } from "./payroll-correction-source"
import { payrollLiabilityHistory } from "./payroll-liability-history"
const uuid=z.string().uuid().toLowerCase()
type Tables=Record<string,Record<string,unknown>[]>

export const correctionContextSchema=z.object({
 version:z.union([z.literal(1),z.literal(2),z.literal(3)]),constructionDecisions:payrollCorrectionConstructionDecisionsSchema.optional(),baseline:payrollCorrectionBaselineSchema.optional(),orgId:uuid,sourceId:uuid,sourceHash:z.string().regex(/^[a-f0-9]{64}$/),originalPostingId:uuid,originalPlanDigest:z.string().regex(/^[a-f0-9]{64}$/),request:payrollCorrectionRequestSchema,
 math:z.object({journalDraft:z.record(z.unknown()).nullable(),costDeltaCents:z.number().int().safe(),projectCostDeltaCents:z.number().int().safe(),overheadCostDeltaCents:z.number().int().safe(),liabilityDelta:z.record(z.number().int().safe()),cashDeltaCents:z.literal(0),customerAmountDeltaCents:z.literal(0),nativeLaborReconciledAgain:z.literal(false)}).strict(),
 projectCosts:z.array(z.record(z.unknown())),workers:z.array(z.record(z.unknown())),remainingBeforeAdditionalAttribution:z.record(z.number().int().safe()),additionalLiabilityJournalIds:z.array(uuid),
 context:z.object({project_financial_settings:z.array(z.record(z.unknown())).optional(),contracts:z.array(z.record(z.unknown())).optional(),closings:z.array(z.record(z.unknown())).optional(),projects:z.array(z.record(z.unknown())),cost_codes:z.array(z.record(z.unknown())),budget_lines:z.array(z.record(z.unknown())),budgets:z.array(z.record(z.unknown())),billable_costs:z.array(z.record(z.unknown())),gl_accounts:z.array(z.record(z.unknown())),accounting_periods:z.array(z.record(z.unknown())),liability_journals:z.array(z.record(z.unknown())),liability_lines:z.array(z.record(z.unknown()))}).strict(),contextHash:z.string().regex(/^[a-f0-9]{64}$/),blockers:z.array(z.string()),requiresConstructionReview:z.boolean(),preservedBillableCostIds:z.array(uuid),postingImplemented:z.literal(false),requiresCommitRevalidation:z.literal(true),locksHeldUntilTransactionEnd:z.literal(true),
}).strict()

export function parsePayrollCorrectionContext(input:unknown,tables:Tables,historical=false){
 const current=correctionContextSchema.parse(input)
 if((current.version===3)!==(current.constructionDecisions!==undefined))throw new Error("Correction construction decision version differs")
 if(current.version>=2&&[current.context.project_financial_settings,current.context.contracts,current.context.closings].some(rows=>!rows))throw new Error("Correction commercial context evidence is missing")
 if(current.version===1&&[current.context.project_financial_settings,current.context.contracts,current.context.closings].some(rows=>rows!==undefined))throw new Error("Legacy correction cannot hide commercial context evidence")
 if(historical){
  for(const rows of Object.values(current.context))if(rows&&(rows.some(row=>row.org_id!==current.orgId)||new Set(rows.map(row=>row.id)).size!==rows.length))throw new Error("Correction historical context scope or identity differs")
  const native=tables.journal_entries.filter(row=>row.source_type==="labor_cost"),nativeIds=new Set(native.map(row=>row.id))
  tables={...tables,...Object.fromEntries(Object.entries(current.context).filter(([name])=>!["liability_journals","liability_lines"].includes(name))),journal_entries:[...native,...current.context.liability_journals],journal_lines:[...tables.journal_lines.filter(row=>nativeIds.has(row.entry_id)),...current.context.liability_lines]}
 }
 const sources=(tables.books_payroll_correction_sources??[]).filter(row=>row.org_id===current.orgId&&row.id===current.sourceId)
 if(sources.length!==1)throw new Error("Correction context source is missing or ambiguous")
 const source=parsePayrollCorrectionSource(sources[0],tables)
 if((source.status!=="reviewed"&&(!historical||source.reviewed_by===null))||current.sourceHash!==source.evidence_hash||current.originalPostingId!==source.posting_id||booksDigest(current.request)!==booksDigest(source.request))throw new Error("Correction context source identity changed")
 const plan=payrollCorrectionPlan({request:source.request,correctedRun:source.run,tables,constructionDecisions:current.constructionDecisions,constructionPolicyVersion:current.version>=2?2:undefined,baselinePostingId:historical?(current.baseline?.previousPostingId??null):undefined})
 if(current.baseline&&booksDigest(current.baseline)!==booksDigest(plan.baseline))throw new Error("Correction monetary baseline changed")
 if(current.originalPlanDigest!==plan.originalPlanDigest)throw new Error("Correction context original posting changed")
 for(const key of Object.keys(current.math) as (keyof typeof current.math)[])if(booksDigest(current.math[key])!==booksDigest(plan[key]))throw new Error(`Correction context arithmetic differs: ${key}`)
 for(const key of ["projectCosts","workers","remainingBeforeAdditionalAttribution","blockers","requiresConstructionReview","preservedBillableCostIds"] as const)if(booksDigest(current[key])!==booksDigest(plan[key]))throw new Error(`Correction construction context changed: ${key}`)
 const compare=(a:Record<string,unknown>,b:Record<string,unknown>)=>String(a.id).localeCompare(String(b.id)),history=payrollLiabilityHistory(current.orgId,tables),journalIds=new Set(history.movements.map(row=>row.journal.id))
 const expected={...plan.constructionDependencies,gl_accounts:[...tables.gl_accounts].sort(compare),liability_journals:tables.journal_entries.filter(row=>journalIds.has(String(row.id))).sort(compare),liability_lines:tables.journal_lines.filter(row=>journalIds.has(String(row.entry_id))).sort(compare)}
 for(const key of Object.keys(current.context) as (keyof typeof current.context)[])if(booksDigest(current.context[key])!==booksDigest(expected[key]))throw new Error(`Correction dependencies changed: ${key}`)
 if(booksDigest(current.additionalLiabilityJournalIds)!==booksDigest(plan.additionalLiabilityMovements.map(row=>row.journal.id).sort()))throw new Error("Correction liability attribution changed")
 return current
}
