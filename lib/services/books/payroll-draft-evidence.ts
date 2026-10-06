import { z } from "zod"
import { booksDigest } from "./hash"
import { payrollImportSchema, payrollLaborEvidenceSchema, reconcilePayrollImport } from "./payroll-import-rules"
import { payrollCsvMappingSchema } from "./payroll-register-csv"
import { taxAttachmentSnapshotSchema } from "./tax-attachment-rules"
import type { previewPayrollRegisterFile } from "./payroll-register-source"
import { payrollWorkflowEvidence, payrollWorkflowTablesSchema } from "./payroll-workflow-evidence"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const payrollDraftEvidenceSchema = z.object({
  run: payrollImportSchema, reconciliation: z.record(z.unknown()), labor_evidence: payrollLaborEvidenceSchema,
  source_proof: taxAttachmentSnapshotSchema, column_mapping: payrollCsvMappingSchema,
  evidence_digest: digest, mapping_digest: digest, reconciliation_digest: digest, source_revision: digest,
}).strict()
export function parsePayrollDraftEvidence(input: unknown) {
  const evidence = payrollDraftEvidenceSchema.parse(input)
  if (booksDigest(evidence.reconciliation) !== evidence.reconciliation_digest) throw new Error("Payroll draft reconciliation digest failed integrity verification")
  const { run, source_proof: source, column_mapping: columns } = evidence
  if (source.org_id !== run.org_id || source.checksum !== run.source_checksum || !source.document_version_id) throw new Error("Payroll draft source identity differs")
  const labor = [...evidence.labor_evidence].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  if (booksDigest({ run, labor }) !== evidence.evidence_digest) throw new Error("Payroll draft labor/run digest failed integrity verification")
  const workers = run.employees.map(worker => ({ worker_id: worker.worker_id, employee_reference: worker.employee_reference, allocations: worker.allocations }))
  if (booksDigest({ source, columns, workers }) !== evidence.mapping_digest) throw new Error("Payroll draft source/mapping digest failed integrity verification")
  const accounts = z.array(z.object({ id: z.string().uuid(), org_id: z.literal(run.org_id), code: z.string(), account_type: z.string(), subtype: z.string(), active: z.boolean() }).strict()).parse(evidence.reconciliation.postingAccounts)
  const rebuilt = reconcilePayrollImport(run, evidence.labor_evidence, accounts)
  let workflow: ReturnType<typeof payrollWorkflowEvidence> | undefined
  if (evidence.reconciliation.evidenceVersion !== undefined || evidence.reconciliation.workflowEvidence !== undefined) {
    if (evidence.reconciliation.evidenceVersion !== 2) throw new Error("Unsupported payroll workflow evidence version")
    const stored = z.object({ version: z.literal(1), sourceTables: payrollWorkflowTablesSchema, constructionImpact: z.record(z.unknown()), liabilityHistory: z.record(z.unknown()) }).strict().parse(evidence.reconciliation.workflowEvidence)
    workflow = payrollWorkflowEvidence(rebuilt, evidence.labor_evidence, stored.sourceTables)
    if (booksDigest(workflow) !== booksDigest(stored)) throw new Error("Payroll workflow evidence differs from original construction and liability sources")
  }
  if (booksDigest(accountingPlan(rebuilt, accounts, workflow)) !== evidence.reconciliation_digest) throw new Error("Payroll draft accounting plan differs from original run and labor")
  return evidence
}
function accountingPlan(result: ReturnType<typeof reconcilePayrollImport>, postingAccounts: { id: string; org_id: string; code: string; account_type: string; subtype: string; active: boolean }[], workflowEvidence?: ReturnType<typeof payrollWorkflowEvidence>) {
  return { totals: result.totals, fundingCents: result.fundingCents, recognizedGrossCents: result.recognizedGrossCents,
    estimatedBurdenCents: result.estimatedBurdenCents, wageVarianceCents: result.wageVarianceCents, burdenVarianceCents: result.burdenVarianceCents,
    costVarianceCents: result.costVarianceCents, requiresVarianceReview: result.requiresVarianceReview, variances: result.variances, draft: result.draft, postingAccounts,
    ...(workflowEvidence ? { evidenceVersion: 2, workflowEvidence } : {}) }
}
export function payrollDraftEvidence(result: Awaited<ReturnType<typeof previewPayrollRegisterFile>>, sourceRevision: string, options?: { requireWorkflow?: boolean; legacyEvidence?: boolean }) {
  if (options?.requireWorkflow && !result.workflowEvidence) throw new Error("Payroll preparation requires complete construction and liability source populations")
  const evidence = { run: result.run, labor_evidence: result.laborEvidence,
    source_proof: result.sourceProof, column_mapping: result.columnMapping, evidence_digest: result.evidenceDigest,
    mapping_digest: result.sourceMappingDigest, source_revision: sourceRevision,
    reconciliation: accountingPlan(result, result.postingAccounts, options?.legacyEvidence ? undefined : result.workflowEvidence ?? undefined) }
  return parsePayrollDraftEvidence({ ...evidence, reconciliation_digest: booksDigest(evidence.reconciliation) })
}
