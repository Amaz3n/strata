import { z } from "zod"
import { payrollCsvMappingSchema, payrollWorkerMappingSchema } from "./payroll-register-csv"
import { booksDigest } from "./hash"
import { parsePayrollDraftEvidence } from "./payroll-draft-evidence"

export const payrollRegisterRequestSchema = z.object({
  runId: z.string().uuid().toLowerCase(), fileId: z.string().uuid().toLowerCase(), documentVersionId: z.string().uuid().toLowerCase(),
  mapping: payrollCsvMappingSchema, workers: payrollWorkerMappingSchema,
}).strict()
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
/** Request identity is independent of newly observed labor or source timestamps.
 * Sorting follows the planner's stable allocation/evidence identity rules.
 */
export function canonicalPayrollRegisterRequest(input: unknown) {
  const request = payrollRegisterRequestSchema.parse(input)
  const unique = (values: string[], label: string) => { if (new Set(values).size !== values.length) throw new Error(`Duplicate payroll request ${label}`) }
  unique(request.workers.map(worker => worker.worker_id), "worker")
  unique(request.workers.map(worker => worker.employee_reference), "employee reference")
  unique(request.workers.flatMap(worker => worker.allocations.map(allocation => allocation.id)), "allocation")
  return { ...request, workers: request.workers.map(worker => ({ ...worker, allocations: worker.allocations.map(allocation => ({ ...allocation, labor_evidence_ids: [...allocation.labor_evidence_ids].sort(compare) })).sort((a,b) => compare(a.id,b.id)) })).sort((a,b) => compare(a.worker_id,b.worker_id)) }
}

export const payrollEvidenceKeys = ["run", "reconciliation", "labor_evidence", "source_proof", "column_mapping", "evidence_digest", "mapping_digest", "reconciliation_digest", "source_revision"] as const
export function payrollEvidenceFromRecord(record: Record<string, unknown>) {
  return parsePayrollDraftEvidence(Object.fromEntries(payrollEvidenceKeys.map(key => [key, record[key]])))
}

/** Recover the original resource only after matching the original actor,
 * notes, source version and complete construction mapping. No new approval or
 * posting is implied, including when the saved draft is now withdrawn/stale.
 */
export function recoverPayrollPreparation(input: { row: unknown; orgId: string; actorId: string; notes: string; key: string; register: unknown }) {
  const request = canonicalPayrollRegisterRequest(input.register)
  const metadata = z.object({ id: z.string().uuid(), org_id: z.literal(input.orgId), prepared_by: z.literal(input.actorId),
    preparation_notes: z.literal(input.notes), idempotency_key: z.literal(input.key), status: z.enum(["draft", "reviewed", "withdrawn"]) }).safeParse(input.row)
  if (!metadata.success) throw new Error("Payroll retry key belongs to a different request or preparer")
  const evidence = payrollEvidenceFromRecord(z.record(z.unknown()).parse(input.row))
  const original = canonicalPayrollRegisterRequest({ runId: evidence.run.id, fileId: evidence.source_proof.file_id, documentVersionId: evidence.source_proof.document_version_id,
    mapping: evidence.column_mapping, workers: evidence.run.employees.map(employee => ({ employee_reference: employee.employee_reference, worker_id: employee.worker_id, allocations: employee.allocations })) })
  if (metadata.data.id !== evidence.run.id || evidence.run.org_id !== input.orgId || booksDigest(original) !== booksDigest(request)) throw new Error("Payroll retry key has a different register or construction mapping")
  return metadata.data.id
}
