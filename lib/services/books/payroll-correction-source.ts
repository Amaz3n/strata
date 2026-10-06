import { z } from "zod"
import { createHash } from "node:crypto"
import { booksDigest } from "./hash"
import { payrollCorrectionRequestSchema } from "./payroll-correction-request"
import { payrollImportSchema, reconcilePayrollImport } from "./payroll-import-rules"
import { payrollCsvMappingSchema, payrollRunFromCsv } from "./payroll-register-csv"
import { canonicalPayrollRegisterRequest } from "./payroll-register-request"
import { postgresPayrollJson, verifyPayrollPostingReceipt } from "./payroll-posting-receipt"
import { taxAttachmentSnapshotSchema } from "./tax-attachment-rules"

const uuid=z.string().uuid().toLowerCase(),timestamp=z.string().datetime({offset:true}),notes=z.string().trim().min(10).max(4000)
const accountsSchema=z.array(z.object({id:uuid,org_id:uuid,code:z.string(),account_type:z.string(),subtype:z.string(),active:z.literal(true)}).strict())
export const payrollCorrectionSourceSchema=z.object({
 id:uuid,org_id:uuid,posting_id:uuid,revision:z.number().int().positive(),status:z.enum(["draft","reviewed","withdrawn"]),
 request:payrollCorrectionRequestSchema,run:payrollImportSchema,source_proof:taxAttachmentSnapshotSchema,column_mapping:payrollCsvMappingSchema,account_snapshot:accountsSchema,source_mapping_digest:z.string().regex(/^[a-f0-9]{64}$/),evidence_hash:z.string().regex(/^[a-f0-9]{64}$/),
 prepared_by:uuid,prepared_at:timestamp,preparation_notes:notes,reviewed_by:uuid.nullable(),reviewed_at:timestamp.nullable(),review_notes:notes.nullable(),withdrawn_by:uuid.nullable(),withdrawn_at:timestamp.nullable(),withdrawal_reason:notes.nullable(),idempotency_key:z.string().trim().min(10).max(200),
}).strict()
export function payrollCorrectionSourceEvidence(preview:{request:unknown;correctedRun:unknown;sourceProof:unknown;columnMapping:unknown;sourceMappingDigest:unknown;accountSnapshot:unknown}){
 return {request:payrollCorrectionRequestSchema.parse(preview.request),run:payrollImportSchema.parse(preview.correctedRun),source_proof:taxAttachmentSnapshotSchema.parse(preview.sourceProof),column_mapping:payrollCsvMappingSchema.parse(preview.columnMapping),account_snapshot:accountsSchema.parse(preview.accountSnapshot),source_mapping_digest:z.string().regex(/^[a-f0-9]{64}$/).parse(preview.sourceMappingDigest)}
}
export function correctionSourceRegister(row:z.infer<typeof payrollCorrectionSourceSchema>){
 return canonicalPayrollRegisterRequest({runId:row.id,fileId:row.source_proof.file_id,documentVersionId:row.source_proof.document_version_id,mapping:row.column_mapping,workers:row.run.employees.map(worker=>({worker_id:worker.worker_id,employee_reference:worker.employee_reference,allocations:worker.allocations}))})
}
export function parsePayrollCorrectionSource(input:unknown,tables:Record<string,Record<string,unknown>[]>) {
 const row=payrollCorrectionSourceSchema.parse(input),proof=row.source_proof
 if(row.id!==row.run.id||row.org_id!==row.run.org_id||row.request.id!==row.id||row.request.postingId!==row.posting_id||proof.org_id!==row.org_id||!proof.document_version_id||proof.checksum!==row.run.source_checksum)throw new Error("Correction source scope/identity differs")
 const posting=verifyPayrollPostingReceipt((tables.books_payroll_postings??[]).find(value=>value.org_id===row.org_id&&value.id===row.posting_id),tables,{requireNativeOwnership:true})
 const parent=(tables.books_payroll_imports??[]).find(value=>value.org_id===row.org_id&&value.id===posting.payroll_import_id)!
 const proposal=(tables.books_payroll_posting_proposals??[]).find(value=>value.org_id===row.org_id&&value.id===posting.proposal_id)!
 const payment=(tables.books_payroll_payment_reviews??[]).find(value=>value.org_id===row.org_id&&value.id===proposal.payment_review_id)
 const original=payrollImportSchema.parse(parent.run)
 const native=z.array(z.object({id:uuid,worker_id:uuid}).passthrough()).parse(parent.labor_evidence),seen=new Set<string>()
 for(const worker of row.run.employees)for(const allocation of worker.allocations){
  for(const [table,id] of [["projects",allocation.project_id],["cost_codes",allocation.cost_code_id]])if(id&&!(tables[table!]??[]).some(value=>value.id===id&&value.org_id===row.org_id))throw new Error("Correction archived construction scope differs")
  for(const id of allocation.labor_evidence_ids){if(seen.has(id)||!native.some(value=>value.id===id&&value.worker_id===worker.worker_id))throw new Error("Correction archived native mapping differs");seen.add(id)}
 }
 for(const key of ["provider","provider_run_id","period_start","period_end","accrual_date"] as const)if(row.run[key]!==original[key])throw new Error("Replacement correction original provider/period differs")
 if(row.id===original.id||row.request.accountingDate<[original.accrual_date,...posting.result.journals.map(journal=>journal.entryDate)].sort().at(-1)!)throw new Error("Correction identity or accounting date differs")
 const mapped=correctionSourceRegister(row)
 if(row.account_snapshot.some(account=>account.org_id!==row.org_id)||new Set(row.account_snapshot.map(account=>account.code)).size!==row.account_snapshot.length)throw new Error("Correction original account bindings differ")
 const rebuilt=reconcilePayrollImport({...row.run,employees:row.run.employees.map(worker=>({...worker,allocations:worker.allocations.map(allocation=>({...allocation,labor_evidence_ids:[]}))}))},[],row.account_snapshot)
 if(rebuilt.run.source_checksum!==proof.checksum)throw new Error("Correction source checksum differs")
 const mappingDigest=booksDigest({source:proof,columns:row.column_mapping,workers:mapped.workers})
 if(row.source_mapping_digest!==mappingDigest)throw new Error("Correction worker/column mapping digest differs")
 const evidence={request:row.request,run:row.run,source_proof:row.source_proof,column_mapping:row.column_mapping,account_snapshot:row.account_snapshot,source_mapping_digest:row.source_mapping_digest}
 if(row.evidence_hash!==createHash("sha256").update(postgresPayrollJson(evidence)).digest("hex"))throw new Error("Correction immutable source hash differs")
 if(row.reviewed_by===null ? row.reviewed_at!==null||row.review_notes!==null||row.status==="reviewed" : row.status==="draft"||row.reviewed_at===null||row.review_notes===null||[row.prepared_by,parent.prepared_by,proposal.prepared_by,payment?.prepared_by].includes(row.reviewed_by))throw new Error("Correction source lacks independent complete review")
 if(row.status==="withdrawn" ? row.withdrawn_by===null||row.withdrawn_at===null||row.withdrawal_reason===null : row.withdrawn_by!==null||row.withdrawn_at!==null||row.withdrawal_reason!==null)throw new Error("Correction source withdrawal evidence differs")
 return row
}
export function verifyPayrollCorrectionSourceBytes(input:unknown,tables:Record<string,Record<string,unknown>[]>,encoded:string){
 const row=parsePayrollCorrectionSource(input,tables),proof=row.source_proof
 if(!proof.size_bytes||proof.size_bytes>16*1024*1024||encoded.length>Math.ceil(proof.size_bytes/3)*4)throw new Error("Correction archived source exceeds supported size")
 const bytes=Buffer.from(encoded,"base64")
 if(bytes.toString("base64")!==encoded||bytes.length!==proof.size_bytes||createHash("sha256").update(bytes).digest("hex")!==proof.checksum)throw new Error("Correction retained provider bytes differ")
 const source=payrollRunFromCsv({text:new TextDecoder("utf-8",{fatal:true}).decode(bytes),checksum:proof.checksum,orgId:row.org_id,runId:row.id,mapping:row.column_mapping,workers:correctionSourceRegister(row).workers})
 const canonical=(run:z.infer<typeof payrollImportSchema>)=>({...run,employees:[...run.employees].map(worker=>({...worker,allocations:[...worker.allocations].map(allocation=>({...allocation,labor_evidence_ids:[...allocation.labor_evidence_ids].sort()})).sort((a,b)=>a.id.localeCompare(b.id))})).sort((a,b)=>a.worker_id.localeCompare(b.worker_id))})
 if(booksDigest(canonical(source))!==booksDigest(canonical(row.run)))throw new Error("Correction financial register differs from retained provider bytes")
 return row
}
