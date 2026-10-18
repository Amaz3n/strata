import { z } from "zod"
import { createHash } from "node:crypto"
import { booksDigest } from "./hash"
import { parsePayrollCorrectionContext } from "./payroll-correction-context"

const uuid=z.string().uuid().toLowerCase(),timestamp=z.string().datetime({offset:true}),notes=z.string().trim().min(10).max(4000)
export const payrollCorrectionProposalSchema=z.object({
 posted_receipt_id:uuid.nullable().optional().default(null),id:uuid,org_id:uuid,source_id:uuid,posting_id:uuid,status:z.enum(["draft","reviewed","withdrawn"]),plan:z.record(z.unknown()),plan_text:z.string(),context_text:z.string(),plan_digest:z.string().regex(/^[a-f0-9]{64}$/),
 prepared_by:uuid,prepared_at:timestamp,preparation_notes:notes,reviewed_by:uuid.nullable(),reviewed_at:timestamp.nullable(),review_notes:notes.nullable(),withdrawn_by:uuid.nullable(),withdrawn_at:timestamp.nullable(),withdrawal_reason:notes.nullable(),idempotency_key:z.string().trim().min(10).max(200),
}).strict()

/** Frozen proposal replay proves the original approval, not current readiness.
 * Keep canonical SQL text so numeric scales in budget evidence survive export. */
export function parsePayrollCorrectionProposalEvidence(input:unknown,tables:Record<string,Record<string,unknown>[]>){
 const row=payrollCorrectionProposalSchema.parse(input),hash=(text:string)=>createHash("sha256").update(text).digest("hex")
 if(hash(row.plan_text)!==row.plan_digest||booksDigest(JSON.parse(row.plan_text))!==booksDigest(row.plan)||hash(row.context_text)!==row.plan.contextHash||booksDigest(JSON.parse(row.context_text))!==booksDigest(row.plan.context))throw new Error("Correction proposal canonical text or hash differs")
 if(Object.hasOwn(row.plan,"locksHeldUntilTransactionEnd"))throw new Error("Correction proposal contains expired lock authority")
 const plan=parsePayrollCorrectionContext({...row.plan,locksHeldUntilTransactionEnd:true},tables,true)
 if(plan.orgId!==row.org_id||plan.sourceId!==row.source_id||plan.originalPostingId!==row.posting_id)throw new Error("Correction proposal source/root identity differs")
 const source=tables.books_payroll_correction_sources.find(value=>value.org_id===row.org_id&&value.id===row.source_id)!,posting=tables.books_payroll_postings.find(value=>value.org_id===row.org_id&&value.id===row.posting_id)!
 const original=tables.books_payroll_posting_proposals.find(value=>value.org_id===row.org_id&&value.id===posting.proposal_id)!,parent=tables.books_payroll_imports.find(value=>value.org_id===row.org_id&&value.id===posting.payroll_import_id)!,payment=tables.books_payroll_payment_reviews.find(value=>value.org_id===row.org_id&&value.id===original.payment_review_id)
 if(row.reviewed_by===null ? row.reviewed_at!==null||row.review_notes!==null||row.status==="reviewed" : row.reviewed_at===null||row.review_notes===null||row.status==="draft"||[row.prepared_by,source.prepared_by,parent.prepared_by,original.prepared_by,payment?.prepared_by].includes(row.reviewed_by)||plan.blockers.length>0||plan.requiresConstructionReview)throw new Error("Correction proposal lacks independent complete monetary review")
 if(row.status==="withdrawn" ? row.withdrawn_by===null||row.withdrawn_at===null||row.withdrawal_reason===null : row.withdrawn_by!==null||row.withdrawn_at!==null||row.withdrawal_reason!==null)throw new Error("Correction proposal withdrawal history differs")
 if(source.status==="withdrawn"&&row.status!=="withdrawn")throw new Error("Correction proposal retains authority after source withdrawal")
 if(row.posted_receipt_id!==null){
  const receipts=(tables.books_payroll_correction_postings??[]).filter(value=>value.org_id===row.org_id&&value.id===row.posted_receipt_id)
  if(row.status!=="reviewed"||receipts.length!==1||receipts[0].proposal_id!==row.id||receipts[0].source_id!==row.source_id||receipts[0].posting_id!==row.posting_id||receipts[0].plan_digest!==row.plan_digest)throw new Error("Correction proposal posted ownership differs")
 }
 return {row,plan}
}


export function parsePayrollCorrectionProposal(input:unknown,tables:Record<string,Record<string,unknown>[]>){
 return parsePayrollCorrectionProposalEvidence(input,tables).row
}
