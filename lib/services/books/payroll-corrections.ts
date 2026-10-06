import "server-only"
import { payrollCorrectionPlan, payrollCorrectionRequestSchema } from "./payroll-correction-plan"
import { readVerifiedPayrollRegisterFile } from "./payroll-register-source"
import { booksDigest } from "./hash"
import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "./access"
import { canonicalPayrollRegisterRequest } from "./payroll-register-request"
import { payrollCorrectionSourceEvidence,parsePayrollCorrectionSource,correctionSourceRegister } from "./payroll-correction-source"
import { parsePayrollCorrectionContext } from "./payroll-correction-context"
import { payrollCorrectionConstructionDecisionsSchema } from "./payroll-correction-construction-decisions"

const uuid=z.string().uuid().toLowerCase(),notes=z.string().trim().min(10).max(4000)
async function correctionAccess(){const context=await requireOrgContext();await requireBooksAuthorization({permission:"books.adjust",userId:context.userId,orgId:context.orgId,supabase:context.supabase,resourceType:"payroll_import",resourceId:context.orgId,logDecision:true});return context}
async function sourceSnapshot(orgId:string){const service=createServiceSupabaseClient(),result=await service.rpc("capture_books_export_snapshot",{p_org_id:orgId});if(result.error)throw new Error(`Correction snapshot failed: ${result.error.message}`);const snapshot=z.object({orgId:z.literal(orgId),tables:z.record(z.array(z.record(z.unknown())))}).parse(result.data);return snapshot.tables}

/** Reuse whole-org books.adjust authorization, one MVCC capture and original
 * version byte verification. Callers provide mappings, never corrected money. */
export async function previewPayrollCorrection(input:{request:unknown;register:unknown}) {
  const source=await readVerifiedPayrollRegisterFile(input.register)
  const request=payrollCorrectionRequestSchema.parse(input.request)
  if(request.id!==source.run.id)throw new Error("Payroll correction/register identity differs")
  const plan=payrollCorrectionPlan({request,correctedRun:source.run,tables:source.snapshot.tables})
  const {digest:planDigest,...proposal}=plan
  const codes=new Set(["2200","2230",...source.run.employees.flatMap(worker=>worker.allocations.map(row=>row.cost_account_code))])
  const accountSnapshot=source.snapshot.tables.gl_accounts.filter(row=>codes.has(String(row.code))).map(row=>({id:row.id,org_id:row.org_id,code:row.code,account_type:row.account_type,subtype:row.subtype,active:row.active})).sort((a,b)=>String(a.id).localeCompare(String(b.id)))
  const evidence={...proposal,planDigest,sourceProof:source.sourceProof,columnMapping:source.columnMapping,sourceMappingDigest:source.sourceMappingDigest,accountSnapshot,providerSourceVerified:true as const}
  return {...evidence,digest:booksDigest(evidence)}
}

/** Durable source review confers no GL or job-cost posting authority. */
export async function preparePayrollCorrectionSource(input:{request:unknown;register:unknown;notes:string;idempotencyKey:string}){
 const context=await correctionAccess(),request=payrollCorrectionRequestSchema.parse(input.request),register=canonicalPayrollRegisterRequest(input.register),text=notes.parse(input.notes),key=z.string().trim().min(10).max(200).parse(input.idempotencyKey),service=createServiceSupabaseClient()
 const existing=async()=>{const result=await service.from("books_payroll_correction_sources").select("*").eq("org_id",context.orgId).eq("idempotency_key",key).maybeSingle();if(result.error)throw new Error(`Correction recovery failed: ${result.error.message}`);return result.data}
 const recover=async(value:unknown)=>{const row=parsePayrollCorrectionSource(value,await sourceSnapshot(context.orgId));if(row.org_id!==context.orgId||row.prepared_by!==context.userId||row.preparation_notes!==text||row.idempotency_key!==key||booksDigest(row.request)!==booksDigest(request)||booksDigest(correctionSourceRegister(row))!==booksDigest(register))throw new Error("Correction retry key belongs to different intent or preparer");return row.id}
 const prior=await existing();if(prior)return recover(prior)
 try{
  const preview=await previewPayrollCorrection({request,register});if(preview.orgId!==context.orgId)throw new Error("Correction source organization changed")
  const evidence=payrollCorrectionSourceEvidence(preview),result=await service.rpc("prepare_books_payroll_correction_source",{p_org_id:context.orgId,p_actor_id:context.userId,p_evidence:evidence,p_notes:text,p_key:key})
  if(result.error)throw new Error(`Correction preparation failed: ${result.error.message}`)
  const saved=await existing();if(!saved||uuid.parse(result.data)!==request.id)throw new Error("Correction preparation lacks matching durable source")
  return recover(saved)
 }catch(error){let saved;try{saved=await existing()}catch{throw error}if(saved)return recover(saved);throw error}
}
export async function reviewPayrollCorrectionSource(input:{id:string;notes:string}){
 const context=await correctionAccess(),id=uuid.parse(input.id),service=createServiceSupabaseClient(),result=await service.from("books_payroll_correction_sources").select("*").eq("org_id",context.orgId).eq("id",id).single()
 if(result.error||!result.data||result.data.org_id!==context.orgId)throw new Error("Correction source is unavailable in organization")
 const row=parsePayrollCorrectionSource(result.data,await sourceSnapshot(context.orgId));if(row.status!=="draft"||row.prepared_by===context.userId)throw new Error("Correction source requires independent reviewer and awaiting-review state")
 const preview=await previewPayrollCorrection({request:row.request,register:correctionSourceRegister(row)}),evidence=payrollCorrectionSourceEvidence(preview)
 if(booksDigest(evidence)!==booksDigest({request:row.request,run:row.run,source_proof:row.source_proof,column_mapping:row.column_mapping,account_snapshot:row.account_snapshot,source_mapping_digest:row.source_mapping_digest}))throw new Error("Correction source or account bindings changed; withdraw and reprepare")
 const reviewed=await service.rpc("review_books_payroll_correction_source",{p_org_id:context.orgId,p_id:id,p_actor_id:context.userId,p_evidence:evidence,p_notes:notes.parse(input.notes)})
 if(reviewed.error)throw new Error(`Correction source review failed: ${reviewed.error.message}`);if(uuid.parse(reviewed.data)!==id)throw new Error("Correction source review returned different identity");return id
}
export async function withdrawPayrollCorrectionSource(input:{id:string;reason:string}){
 const context=await correctionAccess(),id=uuid.parse(input.id),result=await createServiceSupabaseClient().rpc("withdraw_books_payroll_correction_source",{p_org_id:context.orgId,p_id:id,p_actor_id:context.userId,p_reason:notes.parse(input.reason)})
 if(result.error)throw new Error(`Correction source withdrawal failed: ${result.error.message}`);if(uuid.parse(result.data)!==id)throw new Error("Correction source withdrawal returned different identity");return id
}

/** Current construction/liability preflight. RPC locks have expired when this
 * returns. An independent posting review and atomic commit are still required. */
export async function getPayrollCorrectionContext(input:{id:string;constructionDecisions?:unknown}){
 const access=await correctionAccess(),id=uuid.parse(input.id),service=createServiceSupabaseClient()
 const result=input.constructionDecisions===undefined?await service.rpc("lock_books_payroll_correction_context",{p_org_id:access.orgId,p_source_id:id}):await service.rpc("lock_books_payroll_correction_decisions",{p_org_id:access.orgId,p_source_id:id,p_decisions:payrollCorrectionConstructionDecisionsSchema.parse(input.constructionDecisions)})
 if(result.error)throw new Error(`Correction context failed: ${result.error.message}`)
 if(result.data?.orgId!==access.orgId||result.data?.sourceId!==id)throw new Error("Correction context source identity changed")
 const current=parsePayrollCorrectionContext(result.data,await sourceSnapshot(access.orgId))
 const {locksHeldUntilTransactionEnd:_locks,...preflight}=current;void _locks
 return {...preflight,preflightOnly:true as const}
}
