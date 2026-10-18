import "server-only"
import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "./access"
import { payrollDraftEvidence } from "./payroll-draft-evidence"
import { canonicalPayrollRegisterRequest, payrollEvidenceFromRecord, recoverPayrollPreparation } from "./payroll-register-request"
import { payrollReconciliationFromSnapshot } from "./payroll-labor-snapshot"
import { previewPayrollRegisterFile } from "./payroll-register-source"
import { booksDigest } from "./hash"

async function access() {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.adjust", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "payroll_import", resourceId: context.orgId, logDecision: true })
  return context
}
export async function currentPayrollImportEvidence(orgId: string, input: unknown, legacyEvidence = false) {
  const verified = await previewPayrollRegisterFile(input)
  if (verified.run.org_id !== orgId) throw new Error("Payroll organization changed during preparation")
  const { data, error } = await createServiceSupabaseClient().rpc("capture_books_payroll_context", { p_org_id: orgId, p_run: verified.run })
  if (error) throw new Error(`Failed to capture payroll preparation context: ${error.message}`)
  const revision = z.object({ payrollSourceRevision: z.string().regex(/^[a-f0-9]{64}$/) }).parse(data).payrollSourceRevision
  const result = payrollReconciliationFromSnapshot(orgId, verified.run, data)
  const tables = z.object({tables:z.record(z.array(z.record(z.unknown())))}).parse(data).tables
  if (tables.books_payroll_labor_ownership) {
    const postings = tables.books_payroll_postings
    if (!postings || [...tables.books_payroll_labor_ownership, ...postings].some(row => row.org_id !== orgId)) throw new Error("Payroll native ownership evidence is unavailable")
    const laborIds = new Set(result.laborEvidence.map(row => row.id))
    for (const owner of tables.books_payroll_labor_ownership) if (laborIds.has(String(owner.job_cost_entry_id))) {
      const parents = postings.filter(row => row.id === owner.posting_id)
      if (parents.length !== 1 || parents[0].payroll_import_id !== verified.run.id) throw new Error("Native labor already belongs to another payroll register; use its correction workflow")
    }
  }
  return payrollDraftEvidence({ ...verified, ...result, providerSourceVerified: true }, revision, { requireWorkflow: !legacyEvidence, legacyEvidence })
}
/** No caller-defined accounting journal/evidence or claimed verified flag. */
export async function preparePayrollImport(input: { register: unknown; notes: string; idempotencyKey: string; expectedEvidenceDigest?: string }) {
  const context = await access(), notes = z.string().trim().min(10).max(4000).parse(input.notes), key = z.string().trim().min(10).max(200).parse(input.idempotencyKey)
  const register = canonicalPayrollRegisterRequest(input.register), service = createServiceSupabaseClient()
  const expectedDigest = input.expectedEvidenceDigest === undefined ? undefined : z.string().regex(/^[a-f0-9]{64}$/).parse(input.expectedEvidenceDigest)
  const existing = async () => {
    const { data, error } = await service.from("books_payroll_imports").select("*").eq("org_id", context.orgId).eq("idempotency_key", key).maybeSingle()
    if (error) throw new Error(`Failed to recover payroll preparation: ${error.message}`)
    return data
  }
  const recover = (row: unknown) => recoverPayrollPreparation({ row, register, orgId: context.orgId, actorId: context.userId, notes, key })
  const prior = await existing()
  if (prior) return recover(prior)
  try {
    const evidence = await currentPayrollImportEvidence(context.orgId, register)
    if (expectedDigest && booksDigest(evidence) !== expectedDigest) throw new Error("Payroll evidence changed since preview; reconcile and review the current amounts again")
    const { data, error } = await service.rpc("prepare_books_payroll_import", { p_org_id: context.orgId, p_actor_id: context.userId, p_evidence: evidence, p_notes: notes, p_idempotency_key: key })
    if (error) throw new Error(`Failed to prepare payroll import: ${error.message}`)
    const id = z.string().uuid().parse(data)
    if (id !== register.runId) throw new Error("Payroll preparation returned a different run identity")
    return id
  } catch (error) {
    // Another request may have committed while this one was reading sources,
    // or the transport may have lost its response after a successful commit.
    let saved
    try { saved = await existing() } catch { throw error }
    if (saved) return recover(saved)
    throw error
  }
}
export async function reviewPayrollImport(input: { id: string; notes: string }) {
  const context = await access(), id = z.string().uuid().parse(input.id), notes = z.string().trim().min(10).max(4000).parse(input.notes)
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("books_payroll_imports").select("*").eq("org_id", context.orgId).eq("id", id).single()
  if (error || !data || data.org_id !== context.orgId) throw new Error("Payroll import is unavailable in organization")
  const stored = payrollEvidenceFromRecord(data)
  if (data.prepared_by === context.userId) throw new Error("Payroll requires a separate reviewer")
  const current = await currentPayrollImportEvidence(context.orgId, { runId: stored.run.id, fileId: stored.source_proof.file_id, documentVersionId: stored.source_proof.document_version_id, mapping: stored.column_mapping,
    workers: stored.run.employees.map(employee => ({ employee_reference: employee.employee_reference, worker_id: employee.worker_id, allocations: employee.allocations })) }, stored.reconciliation.evidenceVersion !== 2)
  if ((["evidence_digest", "mapping_digest", "reconciliation_digest", "source_revision"] as const).some(key => current[key] !== stored[key])) throw new Error("Payroll source or workflow evidence changed; withdraw and prepare current evidence")
  const reviewed = await service.rpc("review_books_payroll_import", { p_org_id: context.orgId, p_id: id, p_actor_id: context.userId, p_evidence: current, p_notes: notes })
  if (reviewed.error) throw new Error(`Failed to review payroll import: ${reviewed.error.message}`)
  return z.string().uuid().parse(reviewed.data)
}
export async function withdrawPayrollImport(input: { id: string; reason: string }) {
  const context = await access()
  const { data, error } = await createServiceSupabaseClient().rpc("withdraw_books_payroll_import", { p_org_id: context.orgId, p_id: z.string().uuid().parse(input.id), p_actor_id: context.userId, p_reason: z.string().trim().min(10).max(4000).parse(input.reason) })
  if (error) throw new Error(`Failed to withdraw payroll import: ${error.message}`)
  return z.string().uuid().parse(data)
}
