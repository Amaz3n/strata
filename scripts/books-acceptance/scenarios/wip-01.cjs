// WIP-01 — cost-to-cost percentage of completion, driven through the product's
// own services: bill services and the outbox queue, invoice RPC, the real
// projector, greenfield launch, period/WIP review and close.
const { randomUUID } = require("node:crypto")

const { app, contractJob, project } = require("./shared.cjs")

async function bill(kit, job, period, cents, label) {
  const { createProjectVendorBill, approveVendorBillsAtomic } = app("vendor-bills")
  const created = await kit.as(job.owner, () => createProjectVendorBill({ projectId: job.projectId, input: {
    company_id: job.vendorId, bill_number: label, bill_date: `${period}-10`, due_date: `${period}-25`, total_cents: cents,
    actual_lines: [{ cost_code_id: job.costCodeId, description: "Framing", amount_cents: cents, project_id: job.projectId }],
  } }))
  await kit.as(job.owner, () => approveVendorBillsAtomic([{ id: created.id }]))
  await kit.drainOutbox(job.orgId)
}

// Invoice totals are NET: the hold is a negative retainage line (lib/services/retainage.ts).
function invoice(kit, job, period, grossCents, retainageCents, label) {
  const { q } = kit
  const net = grossCents - retainageCents
  const lines = [`jsonb_build_object('description','Work completed','quantity',1,'unit_price_cents',${grossCents},'amount_cents',${grossCents})`]
  if (retainageCents) lines.push(`jsonb_build_object('description','Retainage held','quantity',1,'unit','retainage','unit_price_cents',${-retainageCents},'amount_cents',${-retainageCents})`)
  kit.sql(`select public.create_invoice_atomic(${q(job.orgId)},jsonb_build_object('project_id',${q(job.projectId)},'invoice_number',${q(label)},
  'title','Progress billing','issue_date',${q(`${period}-20`)},'due_date',${q(`${period}-28`)},'client_visible',true,'approval_status','approved',
  'product_posture','residential','subtotal_cents',${net},'tax_cents',0,'total_cents',${net},'balance_due_cents',${net},'token',${q(randomUUID())},
  'metadata',jsonb_build_object('retainage_amount_cents',${retainageCents},'source_contract_id',${q(job.contractId)})),
  jsonb_build_array(${lines.join(",")}));`)
}

async function prepareAndReview(kit, job, period, { contractCents, eacCents, carryForward = false }) {
  const { prepareWipSnapshot, carryForwardWipSnapshot, getWipReviewWorkspace, reviewWipSnapshots } = app("books/wip-review")
  const { periodId } = job.periods[period]
  if (carryForward) await kit.as(job.owner, () => carryForwardWipSnapshot({ periodId, projectId: job.projectId, note: "No activity: carry the reviewed position forward." }))
  else await kit.as(job.owner, () => prepareWipSnapshot({ periodId, projectId: job.projectId, originalContractCents: contractCents, approvedChangeOrdersCents: 0, eacCents, note: "Contract and estimate per the reviewed WIP-01 fixture." }))
  const workspace = await kit.as(job.reviewer, () => getWipReviewWorkspace(periodId))
  await kit.as(job.reviewer, () => reviewWipSnapshots({ periodId, snapshots: workspace.snapshots, note: "Independent review of the WIP-01 position." }))
}

async function close(kit, job, period) {
  const { closeAccountingPeriod } = app("books/period-close")
  await kit.as(job.owner, () => closeAccountingPeriod(job.periods[period].periodId))
}

function recognizedIn(kit, job, period) {
  const { periodStart, periodEnd } = job.periods[period]
  const { q } = kit
  return Number(kit.rows(`select coalesce(sum(l.credit_cents - l.debit_cents),0)::bigint cents from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
    join public.gl_accounts a on a.id=l.account_id where l.org_id=${q(job.orgId)} and a.code='4000' and e.status in ('posted','reversed') and e.entry_date between ${q(periodStart)} and ${q(periodEnd)}`)[0].cents)
}

async function policyWorkedExample(kit, expected, check) {
  const input = expected.inputs
  const job = await contractJob(kit, { name: "WIP-01 worked example", contractCents: input.contractCents, retainagePercent: input.retainagePercent, periods: input.months.map((m) => m.period) })
  for (const [index, month] of input.months.entries()) {
    await bill(kit, job, month.period, month.billCents, `WIP-B${index + 1}`)
    invoice(kit, job, month.period, month.invoiceGrossCents, month.invoiceRetainageCents, `WIP-I${index + 1}`)
    await project(kit, job)
    await prepareAndReview(kit, job, month.period, { contractCents: input.contractCents, eacCents: input.estimatedTotalCostCents })
    await close(kit, job, month.period)
    check.equal(`${month.period} ledger matches the policy entry set`, expected.expectedNetDebitCentsByAccount[index === 0 ? "afterJuly" : "afterAugust"], kit.postedNet(job.orgId))
    check.equal(`${month.period} recognition delta`, expected.expectedRecognitionCents[month.period], recognizedIn(kit, job, month.period))
  }
  const net = kit.postedNet(job.orgId)
  check.equal("gross profit after August", expected.expectedGrossProfitCentsAfterAugust, -(net["4000"] ?? 0) - (net["5000"] ?? 0))
  return { orgId: job.orgId, projectId: job.projectId }
}

async function revisedAndRevertedEac(kit, expected, check) {
  const input = expected.inputs
  const job = await contractJob(kit, { name: "WIP-01 EAC revision", contractCents: input.contractCents, retainagePercent: input.retainagePercent, periods: input.months.map((m) => m.period) })
  for (const [index, month] of input.months.entries()) {
    if (month.billCents) await bill(kit, job, month.period, month.billCents, `EAC-B${index + 1}`)
    await project(kit, job)
    await prepareAndReview(kit, job, month.period, { contractCents: input.contractCents, eacCents: month.eacCents })
    await close(kit, job, month.period)
    check.equal(`${month.period} recognition delta after EAC ${month.eacCents}`, expected.expectedRecognitionCents[month.period], recognizedIn(kit, job, month.period))
  }
  return { orgId: job.orgId, projectId: job.projectId }
}

async function completedJobCarryforward(kit, expected, check) {
  const input = expected.inputs
  const job = await contractJob(kit, { name: "WIP-01 completed job", contractCents: input.contractCents, retainagePercent: input.retainagePercent, periods: input.months.map((m) => m.period) })
  for (const [index, month] of input.months.entries()) {
    if (month.billCents) await bill(kit, job, month.period, month.billCents, `DONE-B${index + 1}`)
    await project(kit, job)
    // The builder marks the job complete once its final cost is in; only a
    // completed job may carry its final estimate forward.
    if (month.carryForward) await kit.as(job.owner, () => app("projects").updateProject({ projectId: job.projectId, input: { status: "completed" } }))
    await prepareAndReview(kit, job, month.period, { contractCents: input.contractCents, eacCents: month.eacCents, carryForward: month.carryForward })
    await close(kit, job, month.period)
    check.equal(`${month.period} recognition`, expected.expectedRecognitionCents[month.period], recognizedIn(kit, job, month.period))
  }
  return { orgId: job.orgId, projectId: job.projectId }
}

async function lateBillAfterReview(kit, expected, check) {
  const input = expected.inputs
  const job = await contractJob(kit, { name: "WIP-01 late bill", contractCents: input.contractCents, retainagePercent: input.retainagePercent, periods: [input.period] })
  await bill(kit, job, input.period, input.billCents, "LATE-B1")
  await project(kit, job)
  await prepareAndReview(kit, job, input.period, { contractCents: input.contractCents, eacCents: input.eacCents })
  await bill(kit, job, input.period, input.lateBillCents, "LATE-B2")
  await project(kit, job)
  let blocked = false
  try {
    await close(kit, job, input.period)
  } catch {
    blocked = true
  }
  check.equal("close refuses after a cost lands behind the WIP review", expected.expectedCloseBlockedAfterLateBill, blocked)
  check.equal("nothing recognized by the refused close", 0, recognizedIn(kit, job, input.period))
  await prepareAndReview(kit, job, input.period, { contractCents: input.contractCents, eacCents: input.eacCents })
  await close(kit, job, input.period)
  check.equal(`${input.period} recognition after re-review`, expected.expectedRecognitionCents[input.period], recognizedIn(kit, job, input.period))
  return { orgId: job.orgId, projectId: job.projectId }
}

module.exports = {
  id: "WIP-01",
  subcases: {
    "policy-worked-example": policyWorkedExample,
    "revised-and-reverted-eac": revisedAndRevertedEac,
    "completed-job-carryforward": completedJobCarryforward,
    "late-bill-after-review-blocks-close": lateBillAfterReview,
  },
}

module.exports.helpers = { bill, invoice, prepareAndReview }
