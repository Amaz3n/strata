import { z } from "zod"
import { booksDigest } from "./hash"
import { payrollEvidenceFromRecord } from "./payroll-register-request"
import { reconcilePayrollImport } from "./payroll-import-rules"
import { payrollWorkflowEvidence, payrollWorkflowTablesSchema } from "./payroll-workflow-evidence"
import { parsePayrollPaymentReviewEvidence, type payrollPaymentComponentSchema } from "./payroll-payment-review-rules"
import { assertBalancedJournalDraft, buildPostingKey, type JournalEntryDraft, type JournalLineDraft } from "./types"

const uuid = z.string().uuid().toLowerCase()
const timestamp = z.string().datetime({ offset: true })
const reviewed = z.object({ id: uuid, org_id: uuid, status: z.literal("reviewed"), prepared_by: uuid, prepared_at: timestamp,
  preparation_notes: z.string().trim().min(10), reviewed_by: uuid, reviewed_at: timestamp, review_notes: z.string().trim().min(10),
  withdrawn_by: z.null(), withdrawn_at: z.null(), withdrawal_reason: z.null(),
}).passthrough()
function exact(value: bigint) {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error("Payroll posting totals exceed safe integer cents")
  return number
}
const total = (amounts: number[]) => exact(amounts.reduce((sum, value) => sum + BigInt(value), BigInt(0)))
type PaymentComponent = z.infer<typeof payrollPaymentComponentSchema>

/** Complete arithmetic proposal, not permission to post. Commit must recheck
 * source/document freshness, active claims, period locks and construction
 * allocation/billing decisions in the same transaction as all resulting writes.
 */
export function payrollPostingPlan(parentInput: unknown, paymentInput: unknown | null) {
  const parent = reviewed.parse(parentInput), original = payrollEvidenceFromRecord(parent)
  if (parent.id !== original.run.id || parent.org_id !== original.run.org_id || parent.reviewed_by === parent.prepared_by || original.reconciliation.evidenceVersion !== 2) throw new Error("Payroll posting requires independently reviewed v2 parent evidence")
  const accounts = z.array(z.object({ id: uuid, org_id: uuid, code: z.string(), account_type: z.string(), subtype: z.string(), active: z.boolean() })).parse(original.reconciliation.postingAccounts)
  const core = reconcilePayrollImport(original.run, original.labor_evidence, accounts)
  const sources = z.object({ sourceTables: payrollWorkflowTablesSchema }).parse(original.reconciliation.workflowEvidence).sourceTables
  const workflow = payrollWorkflowEvidence(core, original.labor_evidence, sources)
  let payment: ReturnType<typeof parsePayrollPaymentReviewEvidence> | null = null
  let paymentId: string | null = null
  if (paymentInput !== null) {
    const row = reviewed.extend({ payroll_import_id: uuid, evidence_digest: z.string().regex(/^[a-f0-9]{64}$/) }).parse(paymentInput)
    if (row.org_id !== parent.org_id || row.payroll_import_id !== parent.id || row.reviewed_by === row.prepared_by || row.reviewed_by === parent.prepared_by) throw new Error("Payroll payment attribution lacks separate reviewed ownership")
    payment = parsePayrollPaymentReviewEvidence(original, row.request, row.evidence, row.evidence_digest)
    if (payment.request.id !== row.id) throw new Error("Payroll payment attribution identity differs")
    paymentId = row.id
  } else if (workflow.liabilityHistory.movements.length) throw new Error("Payroll posting requires reviewed allocation or exclusion of every retained liability movement")
  const prior = new Map((payment?.evidence.allocation_components ?? []).map(row => [`${row.allocation_id}:${row.component}`, row.signed_cents]))
  const claim = (allocation: string, component: PaymentComponent) => prior.get(`${allocation}:${component}`) ?? 0
  const shares = new Map<string, number>()
  for (const line of core.draft?.lines ?? []) if (line.accountCode === "2230") {
    const key = `${line.dimensions?.payroll_allocation_id}:${line.dimensions?.payroll_component}`
    shares.set(key, (shares.get(key) ?? 0) + line.creditCents - line.debitCents)
  }
  const variances = new Map(core.variances.map(row => [row.allocationId, row]))
  const construction = new Map(workflow.constructionImpact.allocations.map(row => [row.allocationId, row]))
  const lines: JournalLineDraft[] = []
  const allocations = core.run.employees.flatMap(worker => worker.allocations.map(allocation => {
    const native = variances.get(allocation.id)!, operational = construction.get(allocation.id)!
    const tax = shares.get(`${allocation.id}:employee_taxes`) ?? 0, deduction = shares.get(`${allocation.id}:employee_deductions`) ?? 0
    const paidNet = claim(allocation.id, "net_pay_payment"), taxReclass = claim(allocation.id, "employee_taxes_reclassification"), deductionReclass = claim(allocation.id, "employee_deductions_reclassification")
    const priorGross = claim(allocation.id, "gross_wages_recognition"), priorTaxCost = claim(allocation.id, "employer_taxes_recognition"), priorBenefitCost = claim(allocation.id, "employer_benefits_recognition")
    const priorCost = total([priorGross, priorTaxCost, priorBenefitCost])
    const dimensions = { payroll_run_id: core.run.id, payroll_worker_id: worker.worker_id, payroll_allocation_id: allocation.id,
      ...(allocation.cost_code_id ? { cost_code_id: allocation.cost_code_id } : {}), ...(paymentId ? { payroll_payment_review_id: paymentId } : {}) }
    const components = [
      { component: "gross_variance", debit: allocation.cost_account_code, credit: "2200", amount: exact(BigInt(native.varianceCents) - BigInt(priorGross)) },
      { component: "estimated_burden_release", debit: "2200", credit: allocation.cost_account_code, amount: native.estimatedBurdenCents },
      { component: "employee_taxes", debit: "2200", credit: "2230", amount: tax - taxReclass },
      { component: "employee_deductions", debit: "2200", credit: "2230", amount: deduction - deductionReclass },
      { component: "employer_taxes", debit: allocation.cost_account_code, credit: "2230", amount: allocation.employer_taxes_cents - priorTaxCost },
      { component: "employer_benefits", debit: allocation.cost_account_code, credit: "2230", amount: allocation.employer_benefits_cents - priorBenefitCost },
    ]
    for (const component of components) {
      if (!component.amount) continue
      const common = { ...(allocation.project_id ? { projectId: allocation.project_id } : {}), dimensions: { ...dimensions, payroll_component: component.component }, description: `Payroll ${component.component}` }
      lines.push({ ...common, accountCode: component.debit, debitCents: Math.max(component.amount, 0), creditCents: Math.max(-component.amount, 0) },
        { ...common, accountCode: component.credit, debitCents: Math.max(-component.amount, 0), creditCents: Math.max(component.amount, 0) })
    }
    const outstanding = { netPayCents: allocation.gross_cents - tax - deduction - paidNet,
      employeeTaxesCents: tax - claim(allocation.id, "employee_taxes_payment"), employeeDeductionsCents: deduction - claim(allocation.id, "employee_deductions_payment"),
      employerTaxesCents: allocation.employer_taxes_cents - claim(allocation.id, "employer_taxes_payment"), employerBenefitsCents: allocation.employer_benefits_cents - claim(allocation.id, "employer_benefits_payment") }
    const nativeCost = total([native.recognizedCents, native.estimatedBurdenCents]), ledgerOriginal = total([nativeCost, priorCost])
    const ledgerDelta = total([components[0].amount, -components[1].amount, components[4].amount, components[5].amount])
    if (total([ledgerOriginal, ledgerDelta]) !== operational.actualCostCents || total([operational.originalCostCents, operational.costDeltaCents]) !== operational.actualCostCents || total([ledgerDelta, priorCost]) !== operational.costDeltaCents) throw new Error("Payroll original GL and construction cost bridge does not reconcile")
    const wagePrior = total([nativeCost, priorGross, -paidNet, -taxReclass, -deductionReclass])
    const wageDelta = total([components[0].amount, -components[1].amount, -components[2].amount, -components[3].amount])
    const deductionsPrior = total([taxReclass, deductionReclass, priorTaxCost, priorBenefitCost, -claim(allocation.id, "employee_taxes_payment"), -claim(allocation.id, "employee_deductions_payment"), -claim(allocation.id, "employer_taxes_payment"), -claim(allocation.id, "employer_benefits_payment")])
    const deductionsDelta = total([components[2].amount, components[3].amount, components[4].amount, components[5].amount])
    if (total([wagePrior, wageDelta]) !== outstanding.netPayCents || total([deductionsPrior, deductionsDelta]) !== total([outstanding.employeeTaxesCents, outstanding.employeeDeductionsCents, outstanding.employerTaxesCents, outstanding.employerBenefitsCents])) throw new Error("Payroll recorded and proposed liabilities do not reconcile to remaining provider obligations")
    return { workerId: worker.worker_id, allocationId: allocation.id, projectId: allocation.project_id, costCodeId: allocation.cost_code_id, accountCode: allocation.cost_account_code,
      originalLedgerCostCents: ledgerOriginal, priorNonNativeLedgerCostCents: priorCost, ledgerCostDeltaCents: ledgerDelta,
      originalOperationalCostCents: operational.originalCostCents, operationalCostDeltaCents: operational.costDeltaCents, actualCostCents: operational.actualCostCents,
      ledgerOperationalBridgeCents: priorCost, components: components.map(row => ({ component: row.component, signedCents: row.amount })), outstanding,
      liabilityBridge: { wages: { originalCents: wagePrior, deltaCents: wageDelta, remainingCents: outstanding.netPayCents }, deductions: { originalCents: deductionsPrior, deltaCents: deductionsDelta, remainingCents: total([outstanding.employeeTaxesCents, outstanding.employeeDeductionsCents, outstanding.employerTaxesCents, outstanding.employerBenefitsCents]) } },
      construction: operational }
  }))
  // Recognize the register at its accrual date, then offset duplicate original
  // recognition/reclassification no earlier than that original event. Netting
  // everything into the accrual journal would remove costs/liabilities before
  // a later original journal exists, distorting an intervening period close.
  const datedLines = new Map<string, JournalLineDraft[]>()
  if (core.draft) datedLines.set(core.run.accrual_date, core.draft.lines.map(line => ({ ...line, dimensions: { ...line.dimensions, ...(paymentId ? { payroll_payment_review_id: paymentId } : {}) } })))
  const allocationById = new Map(core.run.employees.flatMap(worker => worker.allocations.map(allocation => [allocation.id, allocation] as const)))
  const movements = new Map(workflow.liabilityHistory.movements.map(movement => [String(movement.journal.id), movement]))
  for (const decision of payment?.request.decisions ?? []) for (const sourceClaim of decision.claims) {
    const recognition = sourceClaim.component.endsWith("_recognition"), reclassification = sourceClaim.component.endsWith("_reclassification")
    if (!recognition && !reclassification) continue
    const originalDate = z.string().date().parse(movements.get(decision.journal_id)!.journal.entry_date)
    const date = originalDate > core.run.accrual_date ? originalDate : core.run.accrual_date
    const allocation = allocationById.get(sourceClaim.allocation_id)!
    const debit = reclassification || sourceClaim.component !== "gross_wages_recognition" ? "2230" : "2200"
    const credit = reclassification ? "2200" : allocation.cost_account_code
    const amount = sourceClaim.signed_cents, common = { ...(allocation.project_id ? { projectId: allocation.project_id } : {}),
      dimensions: { payroll_run_id: core.run.id, payroll_worker_id: sourceClaim.worker_id, payroll_allocation_id: allocation.id,
        ...(allocation.cost_code_id ? { cost_code_id: allocation.cost_code_id } : {}), payroll_payment_review_id: paymentId!, payroll_prior_claim_id: sourceClaim.id,
        payroll_original_journal_id: decision.journal_id, payroll_component: `prior_${sourceClaim.component}_offset` }, description: `Offset recorded payroll ${sourceClaim.component}` }
    const rows = datedLines.get(date) ?? []
    rows.push({ ...common, accountCode: debit, debitCents: Math.max(amount, 0), creditCents: Math.max(-amount, 0) },
      { ...common, accountCode: credit, debitCents: Math.max(-amount, 0), creditCents: Math.max(amount, 0) })
    datedLines.set(date, rows)
  }
  const journalDrafts: JournalEntryDraft[] = [...datedLines].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([entryDate, rows]) => ({ entryDate, entryKind: "adjusting",
    memo: `Reviewed payroll reconciliation ${core.run.provider} ${core.run.provider_run_id}`, postingKey: buildPostingKey(`payroll_import:${core.run.id}:${entryDate}`, { projectionVersion: 2, sourceVersion: 1 }),
    projectionVersion: 2, policyVersion: 1, sourceType: "payroll_import", sourceId: core.run.id, lines: rows }))
  for (const draft of journalDrafts) assertBalancedJournalDraft(draft)
  const costBuckets = new Map<string, bigint>()
  for (const line of lines) if (!["2200", "2230"].includes(line.accountCode)) {
    const key = `${line.dimensions?.payroll_allocation_id}:${line.accountCode}`
    costBuckets.set(key, (costBuckets.get(key) ?? BigInt(0)) + BigInt(line.debitCents) - BigInt(line.creditCents))
  }
  for (const allocation of allocations) if ((costBuckets.get(`${allocation.allocationId}:${allocation.accountCode}`) ?? BigInt(0)) !== BigInt(allocation.ledgerCostDeltaCents)) throw new Error("Payroll adjusted cost lines differ from construction bridge")
  const aggregate = (rows: JournalLineDraft[]) => {
    const buckets = new Map<string, bigint>()
    for (const row of rows) {
      const key = JSON.stringify([row.dimensions?.payroll_allocation_id, row.accountCode, row.projectId ?? null, row.dimensions?.cost_code_id ?? null])
      buckets.set(key, (buckets.get(key) ?? BigInt(0)) + BigInt(row.debitCents) - BigInt(row.creditCents))
    }
    return buckets
  }
  const expected = aggregate(lines), dated = aggregate(journalDrafts.flatMap(draft => draft.lines))
  for (const key of new Set([...expected.keys(), ...dated.keys()])) if ((expected.get(key) ?? BigInt(0)) !== (dated.get(key) ?? BigInt(0))) throw new Error("Payroll dated journals differ from adjusted allocation balances")
  const attributedLines = new Map(payment?.evidence.source_line_claims.map(row => [row.line_id, row.claimed_cents]) ?? [])
  const dispositions = new Map(payment?.request.decisions.map(row => [row.journal_id, row.disposition]) ?? [])
  const retainedLiabilityLines = workflow.liabilityHistory.movements.flatMap(movement => movement.lines.filter(line => ["2200", "2230"].includes(line.accountCode)).map(line => {
    const attributedCents = attributedLines.get(line.id) ?? 0
    return { lineId: line.id, journalId: String(movement.journal.id), accountCode: line.accountCode, recordedDebitCents: line.debit_cents, recordedCreditCents: line.credit_cents,
      attributedCents, unclaimedCents: total([line.debit_cents, line.credit_cents, -attributedCents]), disposition: dispositions.get(String(movement.journal.id))! }
  }))
  const plan = { version: 1 as const, runId: parent.id, orgId: parent.org_id, parentReconciliationDigest: original.reconciliation_digest, sourceRevision: original.source_revision,
    paymentReviewId: paymentId, paymentEvidenceDigest: payment?.evidenceDigest ?? null, allocations, journalDrafts, retainedLiabilityLines,
    ledgerCostDeltaCents: total(allocations.map(row => row.ledgerCostDeltaCents)), operationalCostDeltaCents: total(allocations.map(row => row.operationalCostDeltaCents)),
    priorNonNativeLedgerCostCents: total(allocations.map(row => row.priorNonNativeLedgerCostCents)),
    outstanding: { netPayCents: total(allocations.map(row => row.outstanding.netPayCents)), employeeTaxesCents: total(allocations.map(row => row.outstanding.employeeTaxesCents)), employeeDeductionsCents: total(allocations.map(row => row.outstanding.employeeDeductionsCents)), employerTaxesCents: total(allocations.map(row => row.outstanding.employerTaxesCents)), employerBenefitsCents: total(allocations.map(row => row.outstanding.employerBenefitsCents)) },
    requiresAllocationReview: workflow.constructionImpact.requiresAllocationReview, requiresBillingReview: workflow.constructionImpact.requiresBillingReview,
    runOwnedBalancesOnly: true as const, organizationBalancesProven: false as const,
    requiresCommitRevalidation: true as const, previewOnly: true as const, postingImplemented: false as const }
  return { ...plan, digest: booksDigest(plan) }
}
