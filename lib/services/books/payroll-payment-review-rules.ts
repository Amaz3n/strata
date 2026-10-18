import { z } from "zod"
import { booksDigest } from "./hash"
import { parsePayrollDraftEvidence } from "./payroll-draft-evidence"
import { reconcilePayrollImport } from "./payroll-import-rules"
import { payrollWorkflowEvidence, payrollWorkflowTablesSchema } from "./payroll-workflow-evidence"
import { taxAttachmentSnapshotSchema } from "./tax-attachment-rules"

const uuid = z.string().uuid().toLowerCase()
import { payrollPaymentComponents } from "./payroll-payment-fields"
export const payrollPaymentComponentSchema = z.enum(payrollPaymentComponents)
export const payrollPaymentClaimSchema = z.object({
  id: uuid, worker_id: uuid, allocation_id: uuid, component: payrollPaymentComponentSchema,
  liability_line_id: uuid, counterpart_line_id: uuid, signed_cents: z.number().int().safe().refine(value => value !== 0),
}).strict()
export const payrollPaymentDecisionsSchema = z.array(z.object({
  journal_id: uuid, disposition: z.enum(["allocated", "unrelated"]), explanation: z.string().trim().min(10).max(4000),
  document_version_id: uuid, claims: z.array(payrollPaymentClaimSchema),
}).strict()).min(1)
export const payrollPaymentReviewRequestSchema = z.object({ id: uuid, payroll_import_id: uuid, decisions: payrollPaymentDecisionsSchema }).strict()
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
function unique(values: string[], label: string) { if (new Set(values).size !== values.length) throw new Error(`Duplicate payroll payment ${label}`) }
function exact(value: bigint) { const result = Number(value); if (!Number.isSafeInteger(result)) throw new Error("Payroll payment claims exceed safe integer cents"); return result }
export function canonicalPayrollPaymentReviewRequest(input: unknown) {
  const request = payrollPaymentReviewRequestSchema.parse(input)
  unique(request.decisions.map(row => row.journal_id), "journal decision")
  unique(request.decisions.flatMap(row => row.claims.map(claim => claim.id)), "claim identity")
  return { ...request, decisions: request.decisions.map(row => ({ ...row, claims: [...row.claims].sort((a, b) => compare(a.id, b.id)) })).sort((a, b) => compare(a.journal_id, b.journal_id)) }
}

/** Signed claims consume real source-line capacity, not an organization balance.
 * Positive means the normal event; negative means its refund/reversal. This
 * produces attribution evidence only, never a settlement or posting journal.
 */
export function payrollPaymentReviewEvidence(parentInput: unknown, requestInput: unknown, documentsInput: unknown) {
  const parent = parsePayrollDraftEvidence(parentInput), request = canonicalPayrollPaymentReviewRequest(requestInput)
  if (parent.reconciliation.evidenceVersion !== 2 || request.payroll_import_id !== parent.run.id) throw new Error("Payment attribution requires this run's complete v2 payroll evidence")
  const documents = z.array(taxAttachmentSnapshotSchema.refine(row => row.document_version_id !== null && row.size_bytes > 0, "Payment evidence requires a retained nonempty document version")).min(1).parse(documentsInput)
  unique(documents.map(row => row.document_version_id!), "supporting version")
  if (documents.some(row => row.org_id !== parent.run.org_id)) throw new Error("Payroll payment supporting document is outside organization")
  const wantedDocuments = new Set(request.decisions.map(row => row.document_version_id))
  if (documents.length !== wantedDocuments.size || documents.some(row => !wantedDocuments.has(row.document_version_id!))) throw new Error("Payroll payment decisions require exact supporting document inventory")
  const accountSchema = z.object({ org_id: uuid, code: z.string(), account_type: z.string(), subtype: z.string(), active: z.boolean() })
  const accounts = z.array(accountSchema).parse(parent.reconciliation.postingAccounts)
  const plan = reconcilePayrollImport(parent.run, parent.labor_evidence, accounts)
  const stored = z.object({ sourceTables: payrollWorkflowTablesSchema }).parse(parent.reconciliation.workflowEvidence)
  const workflow = payrollWorkflowEvidence(plan, parent.labor_evidence, stored.sourceTables)
  const history = new Map(workflow.liabilityHistory.movements.map(row => [String(row.journal.id), row]))
  if (request.decisions.length !== history.size || request.decisions.some(row => !history.has(row.journal_id))) throw new Error("Review every retained payroll liability movement exactly once")
  const chart = new Map(stored.sourceTables.gl_accounts.map(row => [String(row.id), row]))
  const allocations = new Map(plan.run.employees.flatMap(worker => worker.allocations.map(allocation => [allocation.id, { worker, allocation }] as const)))
  const withholding = new Map<string, number>()
  for (const line of plan.draft?.lines ?? []) {
    if (line.accountCode !== "2230") continue
    const key = `${line.dimensions?.payroll_allocation_id}:${line.dimensions?.payroll_component}`
    withholding.set(key, (withholding.get(key) ?? 0) + line.creditCents - line.debitCents)
  }
  const lineClaims = new Map<string, { line_id: string; journal_id: string; available_cents: number; claimed_cents: bigint }>()
  const totals = new Map<string, { worker_id: string; allocation_id: string; component: z.infer<typeof payrollPaymentComponentSchema>; signed_cents: bigint; limit_cents: number }>()
  for (const decision of request.decisions) {
    if (decision.disposition === "unrelated" ? decision.claims.length !== 0 : decision.claims.length === 0) throw new Error("Allocated decisions need claims; unrelated decisions cannot claim payroll money")
    if (decision.claims.length && decision.document_version_id === parent.source_proof.document_version_id) throw new Error("Intended payroll register alone cannot prove a recorded payment or prior recognition")
    const movement = history.get(decision.journal_id)!, lines = new Map(movement.lines.map(row => [row.id, row]))
    for (const claim of decision.claims) {
      const scope = allocations.get(claim.allocation_id)
      if (!scope || scope.worker.worker_id !== claim.worker_id) throw new Error("Payroll payment claim worker/allocation differs from this run")
      const liability = lines.get(claim.liability_line_id), counterpart = lines.get(claim.counterpart_line_id)
      if (!liability || !counterpart || liability.id === counterpart.id) throw new Error("Payroll claim requires two distinct original journal lines in its decision")
      const reclass = claim.component.endsWith("_reclassification"), recognition = claim.component.endsWith("_recognition")
      const wageLiability = claim.component === "net_pay_payment" || claim.component === "gross_wages_recognition" || reclass
      const normalLiabilitySign = recognition ? 1 : -1
      const code = wageLiability ? "2200" : "2230"
      const direction = Math.sign(claim.signed_cents), amount = Math.abs(claim.signed_cents)
      if (liability.accountCode !== code || Math.sign(liability.credit_cents - liability.debit_cents) !== normalLiabilitySign * direction || Math.sign(counterpart.credit_cents - counterpart.debit_cents) !== -normalLiabilitySign * direction) throw new Error("Payroll claim liability account or original debit/credit direction differs")
      const classification = counterpart.dimensions.books_account_classification as Record<string, unknown> | undefined
      const current = chart.get(counterpart.account_id), type = classification?.account_type ?? current?.account_type, subtype = classification?.subtype ?? current?.subtype
      if (reclass ? counterpart.accountCode !== "2230" : recognition ? counterpart.accountCode !== scope.allocation.cost_account_code : type !== "asset" || subtype !== "cash") throw new Error("Payroll claim requires the matching original cost, deductions or cash counterpart")
      for (const line of [liability, counterpart]) if (line.project_id != null && line.project_id !== scope.allocation.project_id) throw new Error("Payroll claim original journal project differs from allocation")
      for (const line of [liability, counterpart]) {
        for (const [field, expected] of [["payroll_run_id", parent.run.id], ["payroll_worker_id", claim.worker_id], ["labor_worker_id", claim.worker_id], ["payroll_allocation_id", claim.allocation_id]]) {
          if (line.dimensions[field] != null && line.dimensions[field] !== expected) throw new Error("Payroll claim contradicts original run/worker/allocation ownership")
        }
      }
      if (recognition && ((counterpart.project_id ?? null) !== scope.allocation.project_id || (counterpart.dimensions.cost_code_id ?? null) !== scope.allocation.cost_code_id)) throw new Error("Prior wage/burden recognition requires exact construction cost dimensions")
      const taxes = withholding.get(`${claim.allocation_id}:employee_taxes`) ?? 0, deductions = withholding.get(`${claim.allocation_id}:employee_deductions`) ?? 0
      const limit = claim.component === "gross_wages_recognition" ? scope.allocation.gross_cents : claim.component === "net_pay_payment" ? scope.allocation.gross_cents - taxes - deductions :
        claim.component.startsWith("employee_taxes_") ? taxes : claim.component.startsWith("employee_deductions_") ? deductions : claim.component.startsWith("employer_taxes_") ? scope.allocation.employer_taxes_cents : scope.allocation.employer_benefits_cents
      const key = `${claim.allocation_id}:${claim.component}`, total = totals.get(key) ?? { worker_id: claim.worker_id, allocation_id: claim.allocation_id, component: claim.component, signed_cents: BigInt(0), limit_cents: limit }
      total.signed_cents += BigInt(claim.signed_cents); totals.set(key, total)
      for (const line of [liability, counterpart]) {
        const available = line.debit_cents + line.credit_cents, used = lineClaims.get(line.id) ?? { line_id: line.id, journal_id: decision.journal_id, available_cents: available, claimed_cents: BigInt(0) }
        used.claimed_cents += BigInt(amount)
        if (used.claimed_cents > BigInt(available)) throw new Error("Payroll claims exceed original journal-line capacity")
        lineClaims.set(line.id, used)
      }
    }
  }
  const components = [...totals.values()].map(row => {
    if (row.signed_cents < BigInt(0) || row.signed_cents > BigInt(row.limit_cents)) throw new Error("Payroll prior payments/recognition exceed the provider allocation or have an unpaired refund")
    return { ...row, signed_cents: exact(row.signed_cents) }
  }).sort((a, b) => compare(`${a.allocation_id}:${a.component}`, `${b.allocation_id}:${b.component}`))
  const evidence = { version: 1 as const, org_id: parent.run.org_id, payroll_import_id: parent.run.id, payroll_reconciliation_digest: parent.reconciliation_digest,
    decisions: request.decisions, supporting_documents: [...documents].sort((a, b) => compare(a.document_version_id!, b.document_version_id!)),
    allocation_components: components, source_line_claims: [...lineClaims.values()].map(row => ({ ...row, claimed_cents: exact(row.claimed_cents) })).sort((a, b) => compare(a.line_id, b.line_id)),
    attributionOnly: true as const, postingImplemented: false as const }
  return { evidence, evidenceDigest: booksDigest(evidence), request }
}

export function parsePayrollPaymentReviewEvidence(parent: unknown, request: unknown, evidenceInput: unknown, digest: string) {
  const evidence = z.record(z.unknown()).parse(evidenceInput)
  if (booksDigest(evidence) !== digest) throw new Error("Payroll payment review digest failed integrity verification")
  const rebuilt = payrollPaymentReviewEvidence(parent, request, evidence.supporting_documents)
  if (rebuilt.evidenceDigest !== digest) throw new Error("Payroll payment review differs from original payment lines, provider controls or request")
  return rebuilt
}
