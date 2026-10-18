import type { JournalEntryDraft } from "./types"
import { z } from "zod"
import { createHash } from "node:crypto"
import { booksDigest } from "./hash"
import { parsePayrollCorrectionProposalEvidence } from "./payroll-correction-proposal"
import { postgresPayrollJson,verifyPayrollPostingReceipt } from "./payroll-posting-receipt"

const uuid=z.string().uuid().toLowerCase(),digest=z.string().regex(/^[a-f0-9]{64}$/)
const resultFields={postingId:uuid,proposalId:uuid,sourceId:uuid,originalPostingId:uuid,planDigest:digest,journalId:uuid,factId:uuid,jobCosts:z.array(z.record(z.unknown())),billingPreserved:z.array(uuid)}
export const payrollCorrectionPostingSchema=z.object({
 id:uuid,org_id:uuid,proposal_id:uuid,source_id:uuid,posting_id:uuid,plan_digest:digest,posted_by:uuid,posted_at:z.string().datetime({offset:true}),posting_notes:z.string().trim().min(10).max(4000),idempotency_key:z.string().trim().min(10).max(200),
 previous_posting_id:uuid.nullable().optional().default(null),sequence:z.number().int().positive().safe().optional().default(1),
 result:z.discriminatedUnion("version",[z.object({version:z.literal(1),...resultFields}).strict(),z.object({version:z.literal(2),...resultFields,previousPostingId:uuid.nullable(),sequence:z.number().int().positive().safe()}).strict()]),
}).strict()

type Tables=Record<string,Record<string,unknown>[]>
const equal=(a:unknown,b:unknown)=>{if(booksDigest(a)!==booksDigest(b))throw new Error("Correction actual posting differs from reviewed evidence")}
const amount=(v:unknown)=>{const n=Number(z.union([z.number().int().safe(),z.string().regex(/^-?\d+$/)]).parse(v));if(!Number.isSafeInteger(n))throw new Error("Unsafe correction amount");return n}

/** Durable accounting ownership, including signed construction costs. Current
 * operational budgets or later settlements do not reinterpret prior approval. */
export function verifyPayrollCorrectionPosting(input:unknown,tables:Tables){
 const row=payrollCorrectionPostingSchema.parse(input),r=row.result
 const find=(table:string,id:string)=>{const rows=(tables[table]??[]).filter(v=>v.org_id===row.org_id&&v.id===id);if(rows.length!==1)throw new Error(`Missing or ambiguous correction ${table}`);return rows[0]}
 const {row:proposal,plan}=parsePayrollCorrectionProposalEvidence(find("books_payroll_correction_proposals",row.proposal_id),tables),source=find("books_payroll_correction_sources",row.source_id),root=verifyPayrollPostingReceipt(find("books_payroll_postings",row.posting_id),tables,{requireNativeOwnership:true})
 const draft=plan.math.journalDraft as JournalEntryDraft|null
 if(proposal.status!=="reviewed"||source.status!=="reviewed"||proposal.source_id!==row.source_id||proposal.posting_id!==root.id||proposal.plan_digest!==row.plan_digest||!draft||plan.blockers.length||plan.requiresConstructionReview)throw new Error("Correction posting lacks complete reviewed authority")
 if(r.version===1){if(row.sequence!==1||row.previous_posting_id!==null)throw new Error("Legacy correction receipt cannot hide sequential ancestry")}
 else{
  equal([r.previousPostingId,r.sequence,proposal.posted_receipt_id],[row.previous_posting_id,row.sequence,row.id])
  equal([plan.baseline?.previousPostingId??null,plan.baseline?.sequence??1],[row.previous_posting_id,row.sequence])
 }
 equal([r.postingId,r.proposalId,r.sourceId,r.originalPostingId,r.planDigest],[row.id,row.proposal_id,row.source_id,row.posting_id,row.plan_digest])
 const journal=find("journal_entries",r.journalId),fact=find("accounting_facts",r.factId)
 equal([journal.fact_id,journal.status,journal.source_type,journal.source_id,journal.entry_date,journal.entry_kind,journal.memo,journal.posting_key,amount(journal.policy_version),amount(journal.projection_version),journal.created_by,journal.posted_by,journal.reversal_of_entry_id??null],[r.factId,"posted","payroll_correction",row.source_id,draft.entryDate,draft.entryKind,draft.memo,draft.postingKey,draft.policyVersion,draft.projectionVersion,row.posted_by,row.posted_by,null])
 for(const value of [journal.posted_at,fact.occurred_at]){z.string().datetime({offset:true}).parse(value);equal(new Date(String(value)).getTime(),new Date(row.posted_at).getTime())}
 equal([fact.source_type,fact.source_id,amount(fact.source_version),fact.fact_kind,fact.accounting_date,fact.idempotency_key,amount(fact.policy_version),fact.created_by],["payroll_correction",row.source_id,1,"payroll_correction",draft.entryDate,draft.postingKey,draft.policyVersion,row.posted_by])
 equal(fact.payload,{payroll_correction_posting_id:row.id,proposal_id:row.proposal_id,plan_digest:row.plan_digest,source_hash:source.evidence_hash,original_posting_id:row.posting_id,draft})
 equal(fact.payload_hash,createHash("sha256").update(postgresPayrollJson(fact.payload)).digest("hex"))
 const expected=draft.lines.map((line,index)=>{
  const dimensions=line.dimensions;if(!dimensions)throw new Error("Correction journal line is missing frozen dimensions")
  const accounts=plan.context.gl_accounts.filter(a=>a.id===dimensions.books_correction_account_id);if(accounts.length!==1)throw new Error("Correction frozen account is ambiguous");const account=accounts[0];find("gl_accounts",String(account.id));equal(account.code,line.accountCode)
  return {line_no:index+1,account_id:account.id,project_id:line.projectId??null,company_id:null,description:line.description??null,debit_cents:line.debitCents,credit_cents:line.creditCents,dimensions:{...dimensions,payroll_correction_posting_id:row.id,payroll_correction_proposal_id:row.proposal_id,books_account_classification:{version:1,account_id:account.id,code:account.code,account_type:account.account_type,subtype:account.subtype}}}
 })
 equal((tables.journal_lines??[]).filter(l=>l.org_id===row.org_id&&l.entry_id===r.journalId).sort((a,b)=>amount(a.line_no)-amount(b.line_no)).map(l=>({line_no:amount(l.line_no),account_id:l.account_id,project_id:l.project_id??null,company_id:l.company_id??null,description:l.description??null,debit_cents:amount(l.debit_cents),credit_cents:amount(l.credit_cents),dimensions:l.dimensions})),expected)
 for(const [table,id] of [["journal_entries",r.journalId],["accounting_facts",r.factId]])equal((tables[table]??[]).filter(v=>v.org_id===row.org_id&&v.source_type==="payroll_correction"&&v.source_id===row.source_id).map(v=>v.id),[id])
 if(r.jobCosts.length!==plan.projectCosts.length)throw new Error("Correction cost inventory differs")
 const costIds=new Set<string>()
 for(const [index,cost] of plan.projectCosts.entries()){
  const link=r.jobCosts[index],id=uuid.parse(link.jobCostId);if(costIds.has(id))throw new Error("Duplicate corrective cost");costIds.add(id);equal(link,{...cost,jobCostId:id});const job=find("job_cost_entries",id)
  equal([job.source_type,job.source_id,job.status,job.project_id,job.cost_code_id??null,job.budget_line_id??null,job.gmp_classification,job.incurred_on,amount(job.cost_cents),job.is_billable,job.billable_cost_id??null,job.invoice_id??null],["payroll_correction",id,"posted",cost.projectId,cost.costCodeId,cost.budgetLineId,cost.gmpClassification,cost.incurredOn,cost.costCents,false,null,null])
  equal(job.metadata,{payroll_correction_posting_id:row.id,payroll_correction_proposal_id:row.proposal_id,payroll_correction_source_id:row.source_id,payroll_original_posting_id:row.posting_id,payroll_run_id:root.payroll_import_id,payroll_worker_id:cost.workerId,payroll_allocation_id:cost.allocationId,payroll_component:cost.component,cost_account_id:cost.accountId,cost_account_code:cost.accountCode,original_job_cost_ids:cost.sourceJobCostIds,billing_action:"preserve_time_and_materials_rates"})
 }
 equal((tables.job_cost_entries??[]).filter(v=>v.org_id===row.org_id&&v.source_type==="payroll_correction"&&(v.metadata as Record<string,unknown>)?.payroll_correction_posting_id===row.id).map(v=>v.id).sort(),[...costIds].sort())
 equal(r.billingPreserved,plan.preservedBillableCostIds)
 return row
}
