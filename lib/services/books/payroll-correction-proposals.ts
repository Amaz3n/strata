import "server-only"
import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "./access"
import { payrollCorrectionLineage } from "./payroll-correction-lineage"
import { verifyPayrollCorrectionPosting } from "./payroll-correction-posting"
import { booksDigest } from "./hash"
import { parsePayrollCorrectionProposal } from "./payroll-correction-proposal"
import { parsePayrollCorrectionSource,correctionSourceRegister,payrollCorrectionSourceEvidence } from "./payroll-correction-source"
import { getPayrollCorrectionContext,previewPayrollCorrection } from "./payroll-corrections"
import { payrollCorrectionConstructionDecisionsSchema } from "./payroll-correction-construction-decisions"

const uuid=z.string().uuid().toLowerCase(),notes=z.string().trim().min(10).max(4000)
async function access(){const c=await requireOrgContext();await requireBooksAuthorization({permission:"books.adjust",userId:c.userId,orgId:c.orgId,supabase:c.supabase,resourceType:"payroll_import",resourceId:c.orgId,logDecision:true});return c}
async function snapshot(orgId:string){const result=await createServiceSupabaseClient().rpc("capture_books_export_snapshot",{p_org_id:orgId});if(result.error)throw new Error(`Correction proposal snapshot failed: ${result.error.message}`);return z.object({orgId:z.literal(orgId),tables:z.record(z.array(z.record(z.unknown())))}).parse(result.data).tables}
async function verifiedSource(orgId:string,id:string){
 const tables=await snapshot(orgId),source=parsePayrollCorrectionSource(tables.books_payroll_correction_sources.find(row=>row.org_id===orgId&&row.id===id),tables)
 if(source.status!=="reviewed")throw new Error("Correction monetary proposal requires reviewed source")
 const head=payrollCorrectionLineage(tables,orgId,source.posting_id).postings.at(-1)
 if(head)verifyPayrollCorrectionPosting(head,tables)
 const preview=await previewPayrollCorrection({request:source.request,register:correctionSourceRegister(source)}),evidence=payrollCorrectionSourceEvidence(preview)
 if(booksDigest(evidence)!==booksDigest({request:source.request,run:source.run,source_proof:source.source_proof,column_mapping:source.column_mapping,source_mapping_digest:source.source_mapping_digest,account_snapshot:source.account_snapshot}))throw new Error("Correction source bytes or account bindings changed")
 return source
}
const persistedPlan=(context:Awaited<ReturnType<typeof getPayrollCorrectionContext>>)=>{const {preflightOnly:_preflight,...plan}=context;void _preflight;return plan}

export async function preparePayrollCorrectionProposal(input:{id:string;sourceId:string;notes:string;idempotencyKey:string;constructionDecisions?:unknown}){
 const c=await access(),id=uuid.parse(input.id),sourceId=uuid.parse(input.sourceId),text=notes.parse(input.notes),key=z.string().trim().min(10).max(200).parse(input.idempotencyKey),service=createServiceSupabaseClient()
 const existing=async()=>{const r=await service.from("books_payroll_correction_proposals").select("*").eq("org_id",c.orgId).eq("idempotency_key",key).maybeSingle();if(r.error)throw new Error(`Correction proposal recovery failed: ${r.error.message}`);return r.data}
 const constructionDecisions=input.constructionDecisions===undefined?undefined:payrollCorrectionConstructionDecisionsSchema.parse(input.constructionDecisions)
 const recover=async(value:unknown)=>{const row=parsePayrollCorrectionProposal(value,await snapshot(c.orgId));if(row.org_id!==c.orgId||row.id!==id||row.source_id!==sourceId||row.prepared_by!==c.userId||row.preparation_notes!==text||row.idempotency_key!==key||booksDigest(row.plan.constructionDecisions??null)!==booksDigest(constructionDecisions??null))throw new Error("Correction proposal retry belongs to different intent");return row.id}
 const previous=await existing();if(previous)return recover(previous)
 try{
  await verifiedSource(c.orgId,sourceId)
  const plan=persistedPlan(await getPayrollCorrectionContext({id:sourceId,constructionDecisions})),result=await service.rpc("prepare_books_payroll_correction_proposal",{p_org_id:c.orgId,p_id:id,p_source_id:sourceId,p_actor_id:c.userId,p_plan:plan,p_notes:text,p_key:key})
  if(result.error)throw new Error(`Correction proposal preparation failed: ${result.error.message}`)
  const row=await existing();if(!row||uuid.parse(result.data)!==id)throw new Error("Correction proposal lacks confirmed matching history")
  return recover(row)
 }catch(error){let row;try{row=await existing()}catch{throw error}if(row)return recover(row);throw error}
}

export async function reviewPayrollCorrectionProposal(input:{id:string;notes:string}){
 const c=await access(),id=uuid.parse(input.id),text=notes.parse(input.notes),service=createServiceSupabaseClient()
 const read=async()=>{const r=await service.from("books_payroll_correction_proposals").select("*").eq("org_id",c.orgId).eq("id",id).single();if(r.error||!r.data||r.data.org_id!==c.orgId||r.data.id!==id)throw new Error("Correction proposal is unavailable in organization");return parsePayrollCorrectionProposal(r.data,await snapshot(c.orgId))}
 const row=await read()
 // A confirmed earlier review is history, not fresh posting readiness.
 if(row.status==="reviewed"&&row.reviewed_by===c.userId&&row.review_notes===text)return row.id
 if(row.status!=="draft"||row.prepared_by===c.userId)throw new Error("Correction monetary review requires separate reviewer and awaiting-review draft")
 await verifiedSource(c.orgId,row.source_id)
 const current=persistedPlan(await getPayrollCorrectionContext({id:row.source_id}))
 if(booksDigest(current)!==booksDigest(row.plan))throw new Error("Correction evidence changed; withdraw and prepare again")
 try{
  const result=await service.rpc("review_books_payroll_correction_proposal",{p_org_id:c.orgId,p_id:id,p_actor_id:c.userId,p_digest:row.plan_digest,p_notes:text})
  if(result.error)throw new Error(`Correction monetary review failed: ${result.error.message}`)
  if(uuid.parse(result.data)!==id)throw new Error("Correction review returned different identity")
  const saved=await read();if(saved.status!=="reviewed"||saved.reviewed_by!==c.userId||saved.review_notes!==text||saved.plan_digest!==row.plan_digest)throw new Error("Correction review lacks confirmed history");return saved.id
 }catch(error){let saved;try{saved=await read()}catch{throw error}if(saved.status==="reviewed"&&saved.reviewed_by===c.userId&&saved.review_notes===text&&saved.plan_digest===row.plan_digest)return saved.id;throw error}
}

export async function withdrawPayrollCorrectionProposal(input:{id:string;reason:string}){
 const c=await access(),id=uuid.parse(input.id),text=notes.parse(input.reason),service=createServiceSupabaseClient()
 const confirm=async()=>{const result=await service.from("books_payroll_correction_proposals").select("*").eq("org_id",c.orgId).eq("id",id).single();if(result.error||!result.data)throw new Error("Correction withdrawal lacks confirmed history");const row=parsePayrollCorrectionProposal(result.data,await snapshot(c.orgId));if(row.org_id!==c.orgId||row.id!==id||row.status!=="withdrawn"||row.withdrawn_by!==c.userId||row.withdrawal_reason!==text)throw new Error("Correction withdrawal history differs from intent");return row.id}
 try{
  const result=await service.rpc("withdraw_books_payroll_correction_proposal",{p_org_id:c.orgId,p_id:id,p_actor_id:c.userId,p_reason:text})
  if(result.error)throw new Error(`Correction proposal withdrawal failed: ${result.error.message}`);if(uuid.parse(result.data)!==id)throw new Error("Correction proposal withdrawal returned different identity");return await confirm()
 }catch(error){try{return await confirm()}catch{throw error}}
}


export async function postPayrollCorrectionProposal(input:{id:string;proposalId:string;planDigest:string;notes:string;idempotencyKey:string}){
 const c=await access(),id=uuid.parse(input.id),proposalId=uuid.parse(input.proposalId),digest=z.string().regex(/^[a-f0-9]{64}$/).parse(input.planDigest),text=notes.parse(input.notes),key=z.string().trim().min(10).max(200).parse(input.idempotencyKey),service=createServiceSupabaseClient()
 const existing=async()=>{const result=await service.from("books_payroll_correction_postings").select("*").eq("org_id",c.orgId).eq("idempotency_key",key).maybeSingle();if(result.error)throw new Error(`Correction posting recovery failed: ${result.error.message}`);return result.data}
 const recover=async(value:unknown)=>{const row=verifyPayrollCorrectionPosting(value,await snapshot(c.orgId));if(row.org_id!==c.orgId||row.id!==id||row.proposal_id!==proposalId||row.plan_digest!==digest||row.posted_by!==c.userId||row.posting_notes!==text||row.idempotency_key!==key)throw new Error("Correction posting retry belongs to different intent");return row.result}
 const previous=await existing();if(previous)return recover(previous)
 try{
  const tables=await snapshot(c.orgId),proposal=parsePayrollCorrectionProposal(tables.books_payroll_correction_proposals.find(row=>row.org_id===c.orgId&&row.id===proposalId),tables)
  if(proposal.status!=="reviewed"||proposal.plan_digest!==digest)throw new Error("Correction posting requires exact independently reviewed proposal")
  await verifiedSource(c.orgId,proposal.source_id)
  // The RPC repeats all current source/calendar/construction checks under its
  // transaction fences. This earlier service read never grants commit authority.
  const result=await service.rpc("post_books_payroll_correction_proposal",{p_org_id:c.orgId,p_id:id,p_proposal_id:proposalId,p_actor_id:c.userId,p_digest:digest,p_notes:text,p_key:key})
  if(result.error)throw new Error(`Correction atomic posting failed: ${result.error.message}`)
  const saved=await existing();if(!saved)throw new Error("Correction posting lacks confirmed durable ownership")
  const confirmed=await recover(saved);if(booksDigest(result.data)!==booksDigest(confirmed))throw new Error("Correction posting response differs from durable receipt");return confirmed
 }catch(error){let saved;try{saved=await existing()}catch{throw error}if(saved)return recover(saved);throw error}
}
