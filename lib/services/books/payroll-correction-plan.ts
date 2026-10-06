import { applyPayrollCorrectionConstructionDecisions, payrollCorrectionConstructionDecisionsSchema } from "./payroll-correction-construction-decisions"
import { payrollCorrectionLineage } from "./payroll-correction-lineage"
import { payrollCorrectionConstructionPolicy } from "./payroll-correction-construction-policy"
import { verifyPayrollCorrectionPosting } from "./payroll-correction-posting"
import { payrollCorrectionRequestSchema } from "./payroll-correction-request"
import { z } from "zod"
import { booksDigest } from "./hash"
import { payrollEvidenceFromRecord } from "./payroll-register-request"
import { payrollImportSchema, reconcilePayrollImport } from "./payroll-import-rules"
import { verifyPayrollPostingReceipt } from "./payroll-posting-receipt"
import { payrollPostingPlan } from "./payroll-posting-plan"
import { payrollLiabilityHistory } from "./payroll-liability-history"
import { assertBalancedJournalDraft, buildPostingKey, type JournalEntryDraft, type JournalLineDraft } from "./types"

const uuid = z.string().uuid().toLowerCase()
export { payrollCorrectionRequestSchema } from "./payroll-correction-request"
type Tables = Record<string,Record<string,unknown>[]>
const exact = (value:bigint) => {const number=Number(value);if(!Number.isSafeInteger(number))throw new Error("Payroll correction exceeds safe integer cents");return number}
const sum = (values:number[]) => exact(values.reduce((total,value)=>total+BigInt(value),BigInt(0)))
const compare = (a:string,b:string) => a<b?-1:a>b?1:0
const accountSchema = z.object({id:uuid,org_id:uuid,code:z.string(),account_type:z.string(),subtype:z.string(),active:z.boolean()}).passthrough()
const withoutLabor = (run:z.infer<typeof payrollImportSchema>) => ({...run,employees:run.employees.map(worker=>({...worker,allocations:worker.allocations.map(allocation=>({...allocation,labor_evidence_ids:[]}))}))})

/** Full replacement register preview. It adjusts provider amounts already
 * recognized by the proven posting, never the original native labor again.
 * Persistence, independent review and atomic money writes remain separate. */
export function payrollCorrectionPlan(input:{request:unknown;correctedRun:unknown;tables:Tables;baselinePostingId?:string|null;constructionPolicyVersion?:2;constructionDecisions?:unknown}) {
  if(input.constructionDecisions!==undefined&&input.constructionPolicyVersion!==2)throw new Error("Construction decisions require current commercial controls")
  const request=payrollCorrectionRequestSchema.parse(input.request), corrected=payrollImportSchema.parse(input.correctedRun)
  const find=(table:string,id:string)=>{const rows=(input.tables[table]??[]).filter(row=>row.id===id&&row.org_id===corrected.org_id);if(rows.length!==1)throw new Error(`Missing/ambiguous payroll correction ${table}`);return rows[0]}
  const posting=verifyPayrollPostingReceipt(find("books_payroll_postings",request.postingId),input.tables,{requireNativeOwnership:true})
  const parent=find("books_payroll_imports",posting.payroll_import_id), original=payrollEvidenceFromRecord(parent)
  const proposal=find("books_payroll_posting_proposals",posting.proposal_id)
  const payment=proposal.payment_review_id==null?null:find("books_payroll_payment_reviews",String(proposal.payment_review_id))
  const originalPlan=payrollPostingPlan(parent,payment)
  if(corrected.id!==request.id || corrected.id===original.run.id || corrected.org_id!==posting.org_id)throw new Error("Payroll correction identity differs from original posting")
  for(const key of ["provider","provider_run_id","period_start","period_end","accrual_date"] as const)if(corrected[key]!==original.run[key])throw new Error(`Replacement payroll ${key} differs; use an explicitly reviewed separate run or period reclassification`)
  for(const worker of corrected.employees)for(const allocation of worker.allocations){
    if(allocation.project_id)find("projects",allocation.project_id)
    if(allocation.cost_code_id)find("cost_codes",allocation.cost_code_id)
  }
  const lineage=payrollCorrectionLineage(input.tables,posting.org_id,posting.id,input.baselinePostingId)
  const prior=lineage.postings.at(-1)
  if(prior)verifyPayrollCorrectionPosting(prior,input.tables)
  const baselineSource=prior?find("books_payroll_correction_sources",prior.source_id):null
  const baselineRun=baselineSource?payrollImportSchema.parse(baselineSource.run):original.run
  const baselineAccounts=z.array(accountSchema).parse(baselineSource?.account_snapshot??original.reconciliation.postingAccounts)
  const latestDate=[original.run.accrual_date,...originalPlan.journalDrafts.map(draft=>draft.entryDate),...lineage.postings.map(row=>String(find("journal_entries",row.result.journalId).entry_date))].sort().at(-1)!
  if(request.accountingDate<latestDate)throw new Error("Payroll correction cannot precede original dated recognition")
  const native=new Map(original.labor_evidence.map(row=>[row.id,row])), used=new Set<string>()
  for(const worker of corrected.employees)for(const allocation of worker.allocations)for(const id of allocation.labor_evidence_ids){
    if(used.has(id)||native.get(id)?.worker_id!==worker.worker_id)throw new Error("Payroll correction cannot consume duplicate, foreign or another worker's native labor")
    used.add(id)
  }
  const oldAccounts=baselineAccounts
  const accounts=z.array(accountSchema).parse(input.tables.gl_accounts)
  if(accounts.some(account=>account.org_id!==posting.org_id)||new Set(accounts.map(account=>account.code)).size!==accounts.length)throw new Error("Payroll correction chart scope or code is ambiguous")
  const before=reconcilePayrollImport(withoutLabor({...baselineRun,id:original.run.id}),[],oldAccounts), after=reconcilePayrollImport(withoutLabor(corrected),[],accounts)
  const correctedMappings=new Map(corrected.employees.flatMap(worker=>worker.allocations.map(allocation=>[allocation.id,[...allocation.labor_evidence_ids].sort(compare)] as const)))
  const correctedRun={...after.run,employees:after.run.employees.map(worker=>({...worker,allocations:worker.allocations.map(allocation=>({...allocation,labor_evidence_ids:correctedMappings.get(allocation.id)!}))}))}
  const buckets=new Map<string,{line:JournalLineDraft;amount:bigint;accountId:string}>()
  for(const [result,chart,sign] of [[before,oldAccounts,BigInt(-1)],[after,accounts,BigInt(1)]] as const)for(const line of result.draft?.lines??[]){
    const account=chart.find(account=>account.code===line.accountCode)!
    const key=JSON.stringify([line.dimensions?.payroll_worker_id,line.dimensions?.payroll_allocation_id,line.projectId??null,line.dimensions?.cost_code_id??null,account.id,line.dimensions?.payroll_component])
    const prior=buckets.get(key)??{line,amount:BigInt(0),accountId:account.id}
    prior.amount+=sign*(BigInt(line.debitCents)-BigInt(line.creditCents));buckets.set(key,prior)
  }
  const lines=[...buckets].sort(([a],[b])=>compare(a,b)).filter(([,bucket])=>bucket.amount!==BigInt(0)).map(([,bucket])=>{
    const amount=exact(bucket.amount)
    const dimensions:NonNullable<JournalLineDraft["dimensions"]>={...bucket.line.dimensions,payroll_run_id:original.run.id,payroll_correction_id:request.id,payroll_original_posting_id:posting.id,books_correction_account_id:bucket.accountId}
    return {...bucket.line,debitCents:Math.max(amount,0),creditCents:Math.max(-amount,0),description:`Payroll correction ${bucket.line.dimensions?.payroll_component}`,
      dimensions}
  })
  const journalDraft:JournalEntryDraft|null=lines.length?{entryDate:request.accountingDate,entryKind:"adjusting",memo:`Correct payroll ${corrected.provider} ${corrected.provider_run_id}: ${request.reason}`,postingKey:buildPostingKey(`payroll_correction:${request.id}`,{projectionVersion:1,sourceVersion:1}),projectionVersion:1,policyVersion:1,sourceType:"payroll_correction",sourceId:request.id,lines}:null
  if(journalDraft)assertBalancedJournalDraft(journalDraft)
  const oldAllocations=new Map(originalPlan.allocations.map(row=>[row.allocationId,row]))
  let projectCosts=lines.filter(line=>line.projectId&&!["2200","2230"].includes(line.accountCode)).map(line=>{
    const originalAllocation=oldAllocations.get(String(line.dimensions.payroll_allocation_id))
    const matching=originalAllocation&&originalAllocation.workerId===line.dimensions.payroll_worker_id&&originalAllocation.projectId===line.projectId&&originalAllocation.costCodeId===(line.dimensions.cost_code_id??null)&&originalAllocation.accountCode===line.accountCode
    const priorPlacement=[...lineage.postings].reverse().flatMap(row=>{
      const proposal=find("books_payroll_correction_proposals",String(row.proposal_id))
      return (proposal.plan as {projectCosts:Record<string,unknown>[]}).projectCosts
    }).find(cost=>cost.workerId===line.dimensions.payroll_worker_id&&cost.allocationId===line.dimensions.payroll_allocation_id&&cost.projectId===line.projectId&&cost.costCodeId===(line.dimensions.cost_code_id??null)&&cost.accountId===line.dimensions.books_correction_account_id)
    const construction=priorPlacement?{budgetLineId:priorPlacement.budgetLineId as string|null,gmpClassification:priorPlacement.gmpClassification as string|null,sourceJobCostIds:priorPlacement.sourceJobCostIds as string[],billing:{action:"preserve_time_and_materials_rates",originalBillableCostIds:priorPlacement.preservedBillableCostIds as string[]}}:matching?originalAllocation!.construction:null
    const blockers:string[]=[]
    if(!construction)blockers.push("review_new_or_reallocated_budget_and_gmp")
    if(construction?.billing.action!=="preserve_time_and_materials_rates")blockers.push("review_customer_billing_basis")
    if(construction?.budgetLineId){
      const budgetLines=(input.tables.budget_lines??[]).filter(row=>row.org_id===posting.org_id&&row.id===construction.budgetLineId)
      const budgets=(input.tables.budgets??[]).filter(row=>row.org_id===posting.org_id&&row.id===budgetLines[0]?.budget_id)
      if(budgetLines.length!==1||budgets.length!==1||budgets[0].project_id!==line.projectId||budgetLines[0].cost_code_id!==(line.dimensions.cost_code_id??null))blockers.push("review_changed_budget_scope")
    }
    for(const billableId of construction?.billing.originalBillableCostIds??[]){
      const rows=(input.tables.billable_costs??[]).filter(row=>row.org_id===posting.org_id&&row.id===billableId)
      const metadata=rows[0]?.metadata as Record<string,unknown>|undefined
      if(rows.length!==1||rows[0].project_id!==line.projectId||rows[0].cost_code_id!==(line.dimensions.cost_code_id??null)||metadata?.billing_method!=="time_and_materials_rate")blockers.push("review_changed_customer_billing_basis")
    }
    const costCents=exact(BigInt(line.debitCents)-BigInt(line.creditCents))
    if(costCents< -2147483648||costCents>2147483647)blockers.push("job_cost_integer_capacity")
    if(input.constructionPolicyVersion===2)blockers.push(...payrollCorrectionConstructionPolicy(input.tables,posting.org_id,line.projectId!))
    return {workerId:String(line.dimensions.payroll_worker_id),allocationId:String(line.dimensions.payroll_allocation_id),projectId:line.projectId!,costCodeId:line.dimensions.cost_code_id??null,accountCode:line.accountCode,accountId:String(line.dimensions.books_correction_account_id),component:String(line.dimensions.payroll_component),costCents,incurredOn:request.accountingDate,budgetLineId:construction?.budgetLineId??null,gmpClassification:construction?.gmpClassification??null,sourceJobCostIds:construction?.sourceJobCostIds??[],preservedBillableCostIds:construction?.billing.originalBillableCostIds??[],blockers}
  })
  const constructionDecisions=input.constructionDecisions===undefined?undefined:payrollCorrectionConstructionDecisionsSchema.parse(input.constructionDecisions)
  if(constructionDecisions)projectCosts=applyPayrollCorrectionConstructionDecisions(projectCosts,constructionDecisions,input.tables,posting.org_id)
  const liabilityDelta={netPayCents:sum([after.totals.net_cents,-before.totals.net_cents]),employeeTaxesCents:sum([after.totals.employee_taxes_cents,-before.totals.employee_taxes_cents]),employeeDeductionsCents:sum([after.totals.employee_deductions_cents,-before.totals.employee_deductions_cents]),employerTaxesCents:sum([after.totals.employer_taxes_cents,-before.totals.employer_taxes_cents]),employerBenefitsCents:sum([after.totals.employer_benefits_cents,-before.totals.employer_benefits_cents])}
  const amountKeys={netPayCents:"net_cents",employeeTaxesCents:"employee_taxes_cents",employeeDeductionsCents:"employee_deductions_cents",employerTaxesCents:"employer_taxes_cents",employerBenefitsCents:"employer_benefits_cents"} as const
  const remaining=Object.fromEntries(Object.entries(amountKeys).map(([key,field])=>[key,sum([originalPlan.outstanding[key as keyof typeof liabilityDelta],after.totals[field],-original.run.controls[field]])])) as typeof liabilityDelta
  const workers=[...new Set([...original.run.employees,...baselineRun.employees,...corrected.employees].map(worker=>worker.worker_id))].sort(compare).map(workerId=>{
    const old=baselineRun.employees.find(worker=>worker.worker_id===workerId), rootWorker=original.run.employees.find(worker=>worker.worker_id===workerId), next=corrected.employees.find(worker=>worker.worker_id===workerId)
    const delta=Object.fromEntries(Object.entries(amountKeys).map(([key,field])=>[key,sum([next?.[field]??0,-(old?.[field]??0)])])) as typeof liabilityDelta
    const unpaid=Object.fromEntries(Object.keys(amountKeys).map(key=>[key,sum([...originalPlan.allocations.filter(row=>row.workerId===workerId).map(row=>row.outstanding[key as keyof typeof liabilityDelta]),next?.[amountKeys[key as keyof typeof amountKeys]]??0,-(rootWorker?.[amountKeys[key as keyof typeof amountKeys]]??0)])])) as typeof liabilityDelta
    return {workerId,liabilityDelta:delta,remainingBeforeAdditionalAttribution:unpaid}
  })
  const history=payrollLiabilityHistory(posting.org_id,input.tables)
  const retained=new Set([...posting.result.journals.map(row=>row.journalId),...lineage.postings.map(row=>row.result.journalId),...(original.reconciliation.workflowEvidence as {sourceTables:{journal_entries:{id:string}[]}}).sourceTables.journal_entries.map(row=>row.id)])
  const additionalMovements=history.movements.filter(row=>!retained.has(String(row.journal.id)))
  const blockers:string[]=[]
  if(additionalMovements.length)blockers.push("review_additional_liability_attribution")
  if(workers.some(worker=>Object.values(worker.remainingBeforeAdditionalAttribution).some(value=>value<0)))blockers.push("review_employee_or_provider_overpayment_recovery")
  if(liabilityDelta.employeeTaxesCents||liabilityDelta.employerTaxesCents)blockers.push("review_provider_tax_correction_evidence")
  if(!lines.length)blockers.push("no_accounting_change")
  const dates=(input.tables.accounting_periods??[]).filter(row=>row.org_id===posting.org_id&&String(row.period_start)<=request.accountingDate&&String(row.period_end)>=request.accountingDate)
  if(dates.length!==1||!["open","reopened"].includes(String(dates[0].status)))blockers.push("correction_date_requires_one_open_period")
  for(const accountId of new Set(lines.map(line=>String(line.dimensions.books_correction_account_id)))){
    const current=accounts.find(account=>account.id===accountId)
    const frozen=oldAccounts.find(account=>account.id===accountId)
    if(!current||!current.active||frozen&&(current.code!==frozen.code||current.account_type!==frozen.account_type||current.subtype!==frozen.subtype))blockers.push("review_original_account_classification")
  }
  const projectCostDeltaCents=sum(projectCosts.map(row=>row.costCents)),costDeltaCents=sum([after.totals.gross_cents,after.totals.employer_taxes_cents,after.totals.employer_benefits_cents,-before.totals.gross_cents,-before.totals.employer_taxes_cents,-before.totals.employer_benefits_cents])
  const ledgerCost=sum(lines.filter(line=>!["2200","2230"].includes(line.accountCode)).map(line=>line.debitCents-line.creditCents))
  const wages=sum(lines.filter(line=>line.accountCode==="2200").map(line=>line.creditCents-line.debitCents)),deductions=sum(lines.filter(line=>line.accountCode==="2230").map(line=>line.creditCents-line.debitCents))
  if(ledgerCost!==costDeltaCents||wages!==liabilityDelta.netPayCents||deductions!==sum([liabilityDelta.employeeTaxesCents,liabilityDelta.employeeDeductionsCents,liabilityDelta.employerTaxesCents,liabilityDelta.employerBenefitsCents]))throw new Error("Payroll correction cost/liability bridge does not reconcile")
  const postedPlacements=lineage.postings.flatMap(row=>(find("books_payroll_correction_proposals",String(row.proposal_id)).plan as {projectCosts:Record<string,unknown>[]}).projectCosts)
  const projectIds=new Set([...originalPlan.allocations.map(row=>row.projectId),...baselineRun.employees.flatMap(worker=>worker.allocations.map(row=>row.project_id)),...corrected.employees.flatMap(worker=>worker.allocations.map(row=>row.project_id))].filter(Boolean))
  const codeIds=new Set([...originalPlan.allocations.map(row=>row.costCodeId),...baselineRun.employees.flatMap(worker=>worker.allocations.map(row=>row.cost_code_id)),...corrected.employees.flatMap(worker=>worker.allocations.map(row=>row.cost_code_id))].filter(Boolean))
  const budgetIds=new Set([...originalPlan.allocations.map(row=>row.construction.budgetLineId),...postedPlacements.map(row=>row.budgetLineId),...(constructionDecisions??[]).map(row=>row.budgetLineId)].filter(Boolean)),billableIds=new Set([...originalPlan.allocations.flatMap(row=>row.construction.billing.originalBillableCostIds),...postedPlacements.flatMap(row=>row.preservedBillableCostIds as string[])])
  const select=(name:string,predicate:(row:Record<string,unknown>)=>boolean)=>(input.tables[name]??[]).filter(row=>row.org_id===posting.org_id&&predicate(row)).sort((a,b)=>compare(String(a.id),String(b.id)))
  const constructionDependencies={...(input.constructionPolicyVersion===2?{project_financial_settings:select("project_financial_settings",row=>projectIds.has(String(row.project_id))),contracts:select("contracts",row=>projectIds.has(String(row.project_id))),closings:select("closings",row=>projectIds.has(String(row.project_id)))}:{}),projects:select("projects",row=>projectIds.has(String(row.id))),cost_codes:select("cost_codes",row=>codeIds.has(String(row.id))),budget_lines:select("budget_lines",row=>budgetIds.has(String(row.id))),budgets:select("budgets",row=>projectIds.has(String(row.project_id))),billable_costs:select("billable_costs",row=>billableIds.has(String(row.id))),accounting_periods:[...dates].sort((a,b)=>compare(String(a.id),String(b.id))),gl_accounts:accounts.filter(account=>lines.some(line=>line.dimensions.books_correction_account_id===account.id)).sort((a,b)=>compare(a.id,b.id))}
  const plan={...(constructionDecisions?{constructionDecisions}:{}),version:1 as const,request,baseline:lineage.baseline,orgId:posting.org_id,originalPostingId:posting.id,originalPayrollImportId:parent.id,originalPlanDigest:posting.plan_digest,correctedRun,originalRunDigest:booksDigest(original.run),journalDraft,projectCosts,costDeltaCents,projectCostDeltaCents,overheadCostDeltaCents:sum([costDeltaCents,-projectCostDeltaCents]),liabilityDelta,workers,remainingBeforeAdditionalAttribution:remaining,additionalLiabilityMovements:additionalMovements,liabilityHistoryDigest:history.digest,constructionDependencies,blockers:[...new Set(blockers)].sort(compare),requiresConstructionReview:projectCosts.some(row=>row.blockers.length),preservedBillableCostIds:[...billableIds].sort(compare),cashDeltaCents:0 as const,customerAmountDeltaCents:0 as const,nativeLaborReconciledAgain:false as const,previewOnly:true as const,postingImplemented:false as const,requiresCommitRevalidation:true as const}
  return {...plan,digest:booksDigest(plan)}
}
