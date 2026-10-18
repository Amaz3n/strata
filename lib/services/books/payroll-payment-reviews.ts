import "server-only"
import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "./access"
import { booksDigest } from "./hash"
import { payrollEvidenceFromRecord } from "./payroll-register-request"
import { currentPayrollImportEvidence } from "./payroll-imports"
import { canonicalPayrollPaymentReviewRequest, payrollPaymentReviewEvidence, parsePayrollPaymentReviewEvidence } from "./payroll-payment-review-rules"
import { taxAttachmentSnapshotSchema } from "./tax-attachment-rules"
import { verifyTaxAttachmentBytes } from "./tax-attachments"
import { payrollPostingPlan } from "./payroll-posting-plan"

const uuid = z.string().uuid().toLowerCase()
const substantive = z.string().trim().min(10).max(4000)
async function access() {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.adjust", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "payroll_import", resourceId: context.orgId, logDecision: true })
  return context
}
async function parent(orgId: string, id: string) {
  const { data, error } = await createServiceSupabaseClient().from("books_payroll_imports").select("*").eq("org_id", orgId).eq("id", id).single()
  if (error || !data || data.org_id !== orgId) throw new Error("Payroll import is unavailable in organization")
  const evidence = payrollEvidenceFromRecord(data)
  if (evidence.run.org_id !== orgId || evidence.run.id !== id) throw new Error("Payroll parent evidence identity differs")
  return { row: data, evidence }
}
async function fresh(orgId: string, saved: Awaited<ReturnType<typeof parent>>) {
  if (!["draft", "reviewed"].includes(saved.row.status) || saved.evidence.reconciliation.evidenceVersion !== 2) throw new Error("Payment attribution requires an active v2 payroll import")
  const stored = saved.evidence
  const current = await currentPayrollImportEvidence(orgId, { runId: stored.run.id, fileId: stored.source_proof.file_id, documentVersionId: stored.source_proof.document_version_id,
    mapping: stored.column_mapping, workers: stored.run.employees.map(worker => ({ employee_reference: worker.employee_reference, worker_id: worker.worker_id, allocations: worker.allocations })) })
  if ((["evidence_digest", "mapping_digest", "reconciliation_digest", "source_revision"] as const).some(key => current[key] !== stored[key])) throw new Error("Payroll source or construction evidence changed; withdraw and reprepare")
}
async function documents(orgId: string, request: ReturnType<typeof canonicalPayrollPaymentReviewRequest>) {
  const service = createServiceSupabaseClient(), ids = [...new Set(request.decisions.map(row => row.document_version_id))], result = []
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200)
    const { data, error } = await service.from("doc_versions").select("id,org_id,file_id,storage_path,file_name,mime_type,size_bytes,checksum").eq("org_id", orgId).in("id", batch)
    if (error || !data || data.length !== batch.length) throw new Error("Payroll supporting version is unavailable in organization")
    const fileIds = [...new Set(data.map(row => row.file_id))]
    const files = await service.from("files").select("id,org_id").eq("org_id", orgId).in("id", fileIds)
    if (files.error || !files.data || files.data.length !== fileIds.length) throw new Error("Payroll supporting file is unavailable in organization")
    for (const row of data) {
      if (row.org_id !== orgId || !batch.includes(row.id) || !files.data.some(file => file.id === row.file_id && file.org_id === orgId)) throw new Error("Payroll supporting version identity differs")
      const proof = taxAttachmentSnapshotSchema.parse({ version: 1, document_version_id: row.id, org_id: row.org_id, file_id: row.file_id, storage_path: row.storage_path, file_name: row.file_name, mime_type: row.mime_type, size_bytes: row.size_bytes, checksum: row.checksum })
      await verifyTaxAttachmentBytes(service, orgId, proof)
      result.push(proof)
    }
  }
  return result
}
async function savedReview(orgId: string, id: string) {
  const { data, error } = await createServiceSupabaseClient().from("books_payroll_payment_reviews").select("*").eq("org_id", orgId).eq("id", id).single()
  if (error || !data || data.org_id !== orgId) throw new Error("Payroll payment review is unavailable in organization")
  const saved = await parent(orgId, data.payroll_import_id)
  const proof = parsePayrollPaymentReviewEvidence(saved.evidence, data.request, data.evidence, data.evidence_digest)
  if (proof.request.id !== id) throw new Error("Payroll payment review identity differs")
  return { row: data, parent: saved, proof }
}

/** Rebuild signed line claims and verify every retained supporting version.
 * Preview does not reserve source capacity, approve attribution or post money. */
export async function previewPayrollPaymentReview(input: { request: unknown }) {
  const context = await access(), request = canonicalPayrollPaymentReviewRequest(input.request);
  const saved = await parent(context.orgId, request.payroll_import_id);
  await fresh(context.orgId, saved);
  return payrollPaymentReviewEvidence(saved.evidence, request, await documents(context.orgId, request));
}

/** Only intent comes from the caller. Source records and original bytes are verified here. */
export async function preparePayrollPaymentReview(input: { request: unknown; notes: string; idempotencyKey: string; expectedEvidenceDigest?: string }) {
  const context = await access(), request = canonicalPayrollPaymentReviewRequest(input.request), notes = substantive.parse(input.notes), key = z.string().trim().min(10).max(200).parse(input.idempotencyKey)
  const service = createServiceSupabaseClient()
  const existing = async () => {
    const { data, error } = await service.from("books_payroll_payment_reviews").select("*").eq("org_id", context.orgId).eq("idempotency_key", key).maybeSingle()
    if (error) throw new Error(`Failed to recover payroll payment review: ${error.message}`)
    return data
  }
  const recover = async (row: Record<string, unknown>) => {
    if (row.org_id !== context.orgId || row.prepared_by !== context.userId || row.preparation_notes !== notes || row.idempotency_key !== key || !["draft", "reviewed", "withdrawn"].includes(String(row.status)) || booksDigest(row.request) !== booksDigest(request)) throw new Error("Payroll payment retry key belongs to different intent or preparer")
    const saved = await parent(context.orgId, request.payroll_import_id)
    const proof = parsePayrollPaymentReviewEvidence(saved.evidence, row.request, row.evidence, z.string().parse(row.evidence_digest))
    if (row.id !== proof.request.id || row.payroll_import_id !== saved.evidence.run.id) throw new Error("Payroll payment retry identity differs")
    return proof.request.id
  }
  const expectedDigest = input.expectedEvidenceDigest === undefined ? undefined : z.string().regex(/^[a-f0-9]{64}$/).parse(input.expectedEvidenceDigest)
  const previous = await existing()
  if (previous) return recover(previous)
  try {
    const saved = await parent(context.orgId, request.payroll_import_id)
    await fresh(context.orgId, saved)
    const proof = payrollPaymentReviewEvidence(saved.evidence, request, await documents(context.orgId, request))
    if (expectedDigest && proof.evidenceDigest !== expectedDigest) throw new Error("Payroll payment evidence changed since preview; verify the current original lines and supporting versions again")
    const { data, error } = await service.rpc("prepare_books_payroll_payment_review", { p_org_id: context.orgId, p_actor_id: context.userId, p_request: proof.request, p_evidence: proof.evidence, p_digest: proof.evidenceDigest, p_notes: notes, p_key: key })
    if (error) throw new Error(`Failed to prepare payroll payment review: ${error.message}`)
    const id = uuid.parse(data)
    if (id !== request.id) throw new Error("Payroll payment preparation returned a different identity")
    return id
  } catch (error) {
    let row
    try { row = await existing() } catch { throw error }
    if (row) return recover(row)
    throw error
  }
}
export async function reviewPayrollPaymentReview(input: { id: string; notes: string }) {
  const context = await access(), id = uuid.parse(input.id), notes = substantive.parse(input.notes), saved = await savedReview(context.orgId, id)
  if (context.userId === saved.row.prepared_by || context.userId === saved.parent.row.prepared_by) throw new Error("Payroll payment attribution requires a separate reviewer")
  // A confirmed historical approval is a receipt, not a new transition. Recover
  // its exact reviewer/notes even after later source changes or withdrawal.
  if (["reviewed", "withdrawn"].includes(String(saved.row.status)) && saved.row.reviewed_by === context.userId && saved.row.review_notes === notes) return id
  await fresh(context.orgId, saved.parent)
  const verified = payrollPaymentReviewEvidence(saved.parent.evidence, saved.proof.request, await documents(context.orgId, saved.proof.request))
  if (verified.evidenceDigest !== saved.proof.evidenceDigest) throw new Error("Payroll payment supporting evidence changed")
  const { data, error } = await createServiceSupabaseClient().rpc("review_books_payroll_payment_review", { p_org_id: context.orgId, p_id: id, p_actor_id: context.userId, p_evidence: verified.evidence, p_digest: verified.evidenceDigest, p_notes: notes })
  if (error) throw new Error(`Failed to review payroll payment attribution: ${error.message}`)
  const reviewedId = uuid.parse(data)
  if (reviewedId !== id) throw new Error("Payroll payment review returned a different identity")
  return reviewedId
}
export async function withdrawPayrollPaymentReview(input: { id: string; reason: string }) {
  const context = await access(), id = uuid.parse(input.id)
  const { data, error } = await createServiceSupabaseClient().rpc("withdraw_books_payroll_payment_review", { p_org_id: context.orgId, p_id: id, p_actor_id: context.userId, p_reason: substantive.parse(input.reason) })
  if (error) throw new Error(`Failed to withdraw payroll payment attribution: ${error.message}`)
  const withdrawnId = uuid.parse(data)
  if (withdrawnId !== id) throw new Error("Payroll payment withdrawal returned a different identity")
  return withdrawnId
}

export async function previewReviewedPayrollPostingPlan(input: { id: string }) {
  const context = await access(), id = uuid.parse(input.id), saved = await parent(context.orgId, id)
  await fresh(context.orgId, saved)
  const { data, error } = await createServiceSupabaseClient().from("books_payroll_payment_reviews").select("*").eq("org_id", context.orgId).eq("payroll_import_id", id).eq("status", "reviewed").maybeSingle()
  if (error) throw new Error(`Failed to load reviewed payroll payment ownership: ${error.message}`)
  if (data) {
    if (data.org_id !== context.orgId || data.payroll_import_id !== id) throw new Error("Payroll payment ownership is outside this run")
    const proof = parsePayrollPaymentReviewEvidence(saved.evidence, data.request, data.evidence, data.evidence_digest)
    const current = payrollPaymentReviewEvidence(saved.evidence, proof.request, await documents(context.orgId, proof.request))
    if (current.evidenceDigest !== proof.evidenceDigest) throw new Error("Payroll payment supporting evidence changed")
  }
  const plan = payrollPostingPlan(saved.row, data ?? null)
  const verification = await createServiceSupabaseClient().rpc("verify_books_payroll_posting_plan", { p_org_id: context.orgId, p_parent_id: id, p_plan: plan })
  if (verification.error) throw new Error(`Failed independent payroll posting verification: ${verification.error.message}`)
  if (verification.data !== true) throw new Error("Independent payroll posting verification was not confirmed")
  return plan
}
