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

// ---- Contract-level WIP (B04.1) -------------------------------------------
// A second (and third) contract on the job, each with its own cost code on its
// own schedule of values. Contract A is the fixed-price contract from contractJob.
function addContract(kit, job, { title, type, cents, effective = "2026-07-01", code, codeName }) {
  const { q } = kit
  const contractId = randomUUID(), costCodeId = randomUUID()
  kit.sql(`begin;
insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,retainage_percent,effective_date)
  values(${q(contractId)},${q(job.orgId)},${q(job.projectId)},${q(title)},'active',${cents},'usd',${q(type)},0,${q(effective)});
insert into public.cost_codes(id,org_id,code,name) values(${q(costCodeId)},${q(job.orgId)},${q(code)},${q(codeName)});
commit;`)
  sovLine(kit, job, contractId, costCodeId, code)
  return { contractId, costCodeId }
}
function sovLine(kit, job, contractId, costCodeId, label) {
  const { q } = kit
  kit.sql(`insert into public.prime_sov_lines(org_id,project_id,contract_id,line_number,description,scheduled_value_cents,cost_code_id)
    values(${q(job.orgId)},${q(job.projectId)},${q(contractId)},(select coalesce(max(line_number),0)+1 from public.prime_sov_lines where contract_id=${q(contractId)}),${q(label)},0,${q(costCodeId)});`)
}
async function billCode(kit, job, period, cents, label, costCodeId) {
  const { createProjectVendorBill, approveVendorBillsAtomic } = app("vendor-bills")
  const created = await kit.as(job.owner, () => createProjectVendorBill({ projectId: job.projectId, input: {
    company_id: job.vendorId, bill_number: label, bill_date: `${period}-10`, due_date: `${period}-25`, total_cents: cents,
    actual_lines: [{ cost_code_id: costCodeId, description: label, amount_cents: cents, project_id: job.projectId }],
  } }))
  await kit.as(job.owner, () => approveVendorBillsAtomic([{ id: created.id }]))
  await kit.drainOutbox(job.orgId)
}
function invoiceFor(kit, job, period, cents, label, contractId) {
  const { q } = kit
  kit.sql(`select public.create_invoice_atomic(${q(job.orgId)},jsonb_build_object('project_id',${q(job.projectId)},'invoice_number',${q(label)},
  'title','Progress billing','issue_date',${q(`${period}-20`)},'due_date',${q(`${period}-28`)},'client_visible',true,'approval_status','approved',
  'product_posture','residential','subtotal_cents',${cents},'tax_cents',0,'total_cents',${cents},'balance_due_cents',${cents},'token',${q(randomUUID())},
  'metadata',${contractId ? `jsonb_build_object('source_contract_id',${q(contractId)})` : "'{}'::jsonb"}),
  jsonb_build_array(jsonb_build_object('description','Work completed','quantity',1,'unit_price_cents',${cents},'amount_cents',${cents})));`)
  return kit.rows(`select id from public.invoices where org_id=${q(job.orgId)} and invoice_number=${q(label)}`)[0].id
}
const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
function prepareContract(kit, job, period, contractId, contractCents, eacCents) {
  return kit.as(job.owner, () => app("books/wip-review").prepareWipSnapshot({ periodId: job.periods[period].periodId, projectId: job.projectId, contractId, originalContractCents: contractCents, approvedChangeOrdersCents: 0, eacCents, note: "Contract value and estimate per this contract's own schedule." }))
}
async function reviewAll(kit, job, period) {
  const { getWipReviewWorkspace, reviewWipSnapshots } = app("books/wip-review")
  const { periodId } = job.periods[period]
  const workspace = await kit.as(job.reviewer, () => getWipReviewWorkspace(periodId))
  await kit.as(job.reviewer, () => reviewWipSnapshots({ periodId, snapshots: workspace.snapshots, note: "Independent review of each contract's WIP position." }))
  return workspace
}
// Net credit on an account per contract dimension ('' = no contract).
function byContract(kit, job, code) {
  const { q } = kit
  return Object.fromEntries(kit.rows(`select coalesce(l.dimensions->>'contract_id','') contract, sum(l.credit_cents - l.debit_cents)::bigint cents from public.journal_lines l
    join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id
    where l.org_id=${q(job.orgId)} and a.code=${q(code)} and e.status in ('posted','reversed') group by 1`).map((row) => [row.contract, Number(row.cents)]))
}
const sorted = (entries) => Object.fromEntries(entries.sort(([x], [y]) => x.localeCompare(y)))
const named = (map, names) => sorted(Object.entries(map).filter(([, cents]) => cents !== 0).map(([id, cents]) => [names[id] ?? (id || "none"), cents]))

// Two contracts on one job, a fixed-price contract and a time-and-materials one
// in a loss: each earns from its own costs and estimate, carries its own loss
// reserve, and together they are the project and the ledger.
async function secondContractSeparatelyOwned(kit, expected, check) {
  const input = expected.inputs
  const job = await contractJob(kit, { name: "WIP-01 two contracts", contractCents: input.a.contractCents, retainagePercent: 0, periods: [input.period] })
  sovLine(kit, job, job.contractId, job.costCodeId, "Framing")
  const b = addContract(kit, job, { title: "Site work (T&M)", type: "time_materials", cents: input.b.contractCents, code: "31-000", codeName: "Earthwork" })
  const names = { [job.contractId]: "A", [b.contractId]: "B" }
  await billCode(kit, job, input.period, input.a.costCents, "TWO-A", job.costCodeId)
  await billCode(kit, job, input.period, input.b.costCents, "TWO-B", b.costCodeId)
  invoiceFor(kit, job, input.period, input.a.billedCents, "TWO-IA", job.contractId)
  invoiceFor(kit, job, input.period, input.b.billedCents, "TWO-IB", b.contractId)
  await project(kit, job)
  const projectScope = await refusal(() => kit.as(job.owner, () => app("books/wip-review").prepareWipSnapshot({ periodId: job.periods[input.period].periodId, projectId: job.projectId, originalContractCents: input.a.contractCents + input.b.contractCents, approvedChangeOrdersCents: 0, eacCents: input.a.eacCents + input.b.eacCents, note: "One position for the whole job, netting both contracts." })))
  await prepareContract(kit, job, input.period, job.contractId, input.a.contractCents, input.a.eacCents)
  await prepareContract(kit, job, input.period, b.contractId, input.b.contractCents, input.b.eacCents)
  const workspace = await reviewAll(kit, job, input.period)
  await close(kit, job, input.period)
  const net = kit.postedNet(job.orgId)
  const live = await kit.as(job.owner, () => app("reports/wip-over-under").getProjectWipOverUnderReport({ projectId: job.projectId }))
  const report = await kit.as(job.owner, () => app("reports/wip-over-under").getProjectWipOverUnderReport({ projectId: job.projectId, asOf: job.periods[input.period].periodEnd }))
  check.equal("each contract earns, reserves and reports on its own; together they are the project and the ledger", expected.expected, {
    projectScopeRefused: projectScope,
    reviewedPositions: workspace.snapshots.map((row) => names[row.contractId] ?? "project").sort(),
    revenueByContract: named(byContract(kit, job, "4000"), names),
    lossReserveByContract: named(byContract(kit, job, "2360"), names),
    ledger: { revenue: -(net["4000"] ?? 0), jobCost: net["5000"] ?? 0, lossProvision: net["5060"] ?? 0, contractLiabilities: net["2350"] ?? 0 },
    reportRows: report.rows.map((row) => ({ contract: names[row.contract_id] ?? "project", earned: row.earned_revenue_cents, billed: row.billed_to_date_cents, overUnder: row.over_under_billing_cents })).sort((x, y) => x.contract.localeCompare(y.contract)),
    reportEarnedEqualsLedger: report.totals.earned_revenue_cents === -(net["4000"] ?? 0),
    liveContractValue: live.rows[0].revised_contract_cents,
  })
  return { orgId: job.orgId, projectId: job.projectId, contracts: names }
}

// A cost code on two contracts' schedules belongs to neither until a reviewed
// split says how it is shared, and an invoice that names no contract belongs to
// none: both block only the contracts they touch, and the cure clears them. A
// split is append-only, and a new one after review sends the job back to review.
async function sharedCostAllocation(kit, expected, check) {
  const input = expected.inputs
  const job = await contractJob(kit, { name: "WIP-01 shared cost", contractCents: input.a.contractCents, retainagePercent: 0, periods: [input.period] })
  sovLine(kit, job, job.contractId, job.costCodeId, "Framing")
  const b = addContract(kit, job, { title: "Site work", type: "fixed", cents: input.b.contractCents, code: "31-000", codeName: "Earthwork" })
  const c = addContract(kit, job, { title: "Landscaping", type: "fixed", cents: input.c.contractCents, code: "32-900", codeName: "Planting" })
  const shared = randomUUID()
  kit.sql(`insert into public.cost_codes(id,org_id,code,name) values(${kit.q(shared)},${kit.q(job.orgId)},'01-500','General conditions');`)
  sovLine(kit, job, job.contractId, shared, "General conditions")
  sovLine(kit, job, b.contractId, shared, "General conditions")
  const names = { [job.contractId]: "A", [b.contractId]: "B", [c.contractId]: "C" }
  await billCode(kit, job, input.period, input.a.costCents, "SH-A", job.costCodeId)
  await billCode(kit, job, input.period, input.b.costCents, "SH-B", b.costCodeId)
  await billCode(kit, job, input.period, input.c.costCents, "SH-C", c.costCodeId)
  await billCode(kit, job, input.period, input.sharedCents, "SH-GC", shared)
  invoiceFor(kit, job, input.period, input.a.billedCents, "SH-IA", job.contractId)
  const unassigned = invoiceFor(kit, job, input.period, input.unassignedBilledCents, "SH-IU", null)
  await project(kit, job)
  const prepare = (contract, which) => refusal(() => prepareContract(kit, job, input.period, contract, input[which].contractCents, input[which].eacCents))
  const beforeCure = { A: await prepare(job.contractId, "a"), B: await prepare(b.contractId, "b"), C: await prepare(c.contractId, "c") }
  const { recordWipCostAllocation } = app("books/wip-review")
  const split = (shares, note) => kit.as(job.owner, () => recordWipCostAllocation({ periodId: job.periods[input.period].periodId, projectId: job.projectId, costCodeId: shared, shares, note }))
  const badSplit = await refusal(() => split([{ contractId: job.contractId, basisPoints: 6000 }, { contractId: b.contractId, basisPoints: 3000 }], "Shares that do not add up to the whole."))
  const first = await split(input.firstSplit.map((share) => ({ contractId: share.contract === "A" ? job.contractId : b.contractId, basisPoints: share.basisPoints })), "General conditions follow each contract's share of the schedule.")
  const assignedTwice = await refusal(async () => {
    await kit.as(job.owner, () => app("invoices").assignInvoiceContract({ invoiceId: unassigned, contractId: b.contractId }))
    await kit.as(job.owner, () => app("invoices").assignInvoiceContract({ invoiceId: unassigned, contractId: job.contractId }))
  })
  for (const [contract, which] of [[job.contractId, "a"], [b.contractId, "b"], [c.contractId, "c"]]) await prepareContract(kit, job, input.period, contract, input[which].contractCents, input[which].eacCents)
  await reviewAll(kit, job, input.period)
  const immutable = await refusal(async () => kit.sql(`update public.books_wip_cost_allocations set note='rewritten after review' where id=${kit.q(first.allocationId)};`))
  await split(input.secondSplit.map((share) => ({ contractId: share.contract === "A" ? job.contractId : b.contractId, basisPoints: share.basisPoints })), "Revised: general conditions split evenly per the owner meeting.")
  const closeAfterNewSplit = await refusal(() => close(kit, job, input.period))
  for (const [contract, which] of [[job.contractId, "a"], [b.contractId, "b"], [c.contractId, "c"]]) await prepareContract(kit, job, input.period, contract, input[which].contractCents, input[which].eacCents)
  await reviewAll(kit, job, input.period)
  await close(kit, job, input.period)
  const costByContract = sorted(kit.rows(`select contract_id, cost_to_date_cents from public.poc_snapshots where org_id=${kit.q(job.orgId)} and contract_id is not null
    and id in (select (e->>'snapshotId')::uuid from public.books_close_items c, jsonb_array_elements(c.support_review->'snapshots') e where c.org_id=${kit.q(job.orgId)} and c.code='poc_snapshots')`).map((row) => [names[row.contract_id], Number(row.cost_to_date_cents)]))
  check.equal("unowned costs and billings block only the contracts they touch until a reviewed split or assignment owns them", expected.expected, {
    beforeCure, badSplit, assignedTwice, immutable: /immutable|cannot|not allowed|reject/i.test(immutable) ? "refused" : immutable,
    closeAfterNewSplit: /WIP and POC reviewed/.test(closeAfterNewSplit) ? "refused: WIP review out of date" : closeAfterNewSplit,
    costByContract, costConserved: Object.values(costByContract).reduce((sum, cents) => sum + cents, 0) === input.a.costCents + input.b.costCents + input.c.costCents + input.sharedCents,
    revenueByContract: named(byContract(kit, job, "4000"), names),
  })
  return { orgId: job.orgId, projectId: job.projectId, contracts: names }
}

// The close, its WIP review and recognition read one population. A contract
// that comes into force after review changes it, so close refuses until each
// contract is reviewed; a job that earned revenue before its second contract
// cannot split that revenue silently.
async function populationsAgree(kit, expected, check) {
  const input = expected.inputs
  const job = await contractJob(kit, { name: "WIP-01 populations", contractCents: input.a.contractCents, retainagePercent: 0, periods: input.periods })
  sovLine(kit, job, job.contractId, job.costCodeId, "Framing")
  const [july, august] = input.periods
  await billCode(kit, job, july, input.a.julyCostCents, "POP-A1", job.costCodeId)
  await project(kit, job)
  await prepareAndReview(kit, job, july, { contractCents: input.a.contractCents, eacCents: input.a.eacCents })
  // A second contract signed effective mid-July, after July's review.
  const b = addContract(kit, job, { title: "Owner extras", type: "fixed", cents: input.b.contractCents, effective: input.b.effective, code: "09-900", codeName: "Finishes" })
  const names = { [job.contractId]: "A", [b.contractId]: "B" }
  const checklist = async (period) => (await kit.as(job.owner, () => app("books/period-close").runBooksCloseChecklist(job.periods[period].periodId))).checks.find((row) => row.code === "poc_snapshots")
  const afterNewContract = await checklist(july)
  const julyClose = await refusal(() => close(kit, job, july))
  await billCode(kit, job, july, input.b.julyCostCents, "POP-B1", b.costCodeId)
  await project(kit, job)
  await prepareContract(kit, job, july, job.contractId, input.a.contractCents, input.a.eacCents)
  await prepareContract(kit, job, july, b.contractId, input.b.contractCents, input.b.eacCents)
  await reviewAll(kit, job, july)
  await close(kit, job, july)
  const julyRevenue = named(byContract(kit, job, "4000"), names)
  const reviewedJuly = kit.rows(`select e->>'contractId' contract from public.books_close_items c, jsonb_array_elements(c.support_review->'snapshots') e
    where c.org_id=${kit.q(job.orgId)} and c.period_id=${kit.q(job.periods[july].periodId)} and c.code='poc_snapshots'`).map((row) => names[row.contract] ?? "project").sort()
  // A second job that recognized revenue as a single-contract project, then
  // gained a contract: that revenue belongs to no contract.
  const legacy = await contractJob(kit, { name: "WIP-01 legacy revenue", contractCents: input.a.contractCents, retainagePercent: 0, periods: input.periods })
  sovLine(kit, legacy, legacy.contractId, legacy.costCodeId, "Framing")
  await billCode(kit, legacy, july, input.a.julyCostCents, "LEG-A1", legacy.costCodeId)
  await project(kit, legacy)
  await prepareAndReview(kit, legacy, july, { contractCents: input.a.contractCents, eacCents: input.a.eacCents })
  await close(kit, legacy, july)
  const extra = addContract(kit, legacy, { title: "Owner extras", type: "fixed", cents: input.b.contractCents, effective: input.legacyEffective, code: "09-900", codeName: "Finishes" })
  await billCode(kit, legacy, august, input.b.julyCostCents, "LEG-B1", extra.costCodeId)
  await project(kit, legacy)
  await prepareContract(kit, legacy, august, legacy.contractId, input.a.contractCents, input.a.eacCents)
  await prepareContract(kit, legacy, august, extra.contractId, input.b.contractCents, input.b.eacCents)
  await reviewAll(kit, legacy, august)
  const legacyClose = await refusal(() => close(kit, legacy, august))
  check.equal("the close checklist, the WIP review and recognition cover the same projects and contracts", expected.expected, {
    afterNewContract: { status: afterNewContract.status, missing: afterNewContract.evidence.missing_scopes.map((row) => names[row.contractId] ?? "project").sort() },
    julyCloseBeforeReview: /WIP and POC reviewed/.test(julyClose) ? "refused: WIP review out of date" : julyClose,
    reviewedJuly, julyRevenue,
    projectScopedRecognition: Number(kit.rows(`select count(*)::int n from public.journal_lines l join public.journal_entries e on e.id=l.entry_id where e.org_id=${kit.q(job.orgId)} and e.source_type='revenue_recognition' and l.dimensions->>'contract_id' is null`)[0].n),
    legacyClose: legacyClose.replace(/^Close blocked: /, ""),
  })
  return { orgId: job.orgId, projectId: job.projectId, legacyOrgId: legacy.orgId }
}

// ---- Period evidence and estimates (B04.2) ---------------------------------
function entriesOf(kit, job, sourceType) {
  return Number(kit.rows(`select count(*)::int n from public.journal_entries where org_id=${kit.q(job.orgId)} and source_type=${kit.q(sourceType)} and status in ('posted','reversed')`)[0].n)
}
function revenueThrough(kit, job, codes) {
  const { q } = kit
  return Object.fromEntries(codes.map((code) => [code, Number(kit.rows(`select coalesce(sum(l.credit_cents - l.debit_cents),0)::bigint n from public.journal_lines l
    join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id
    where l.org_id=${q(job.orgId)} and a.code=${q(code)} and e.status in ('posted','reversed')`)[0].n)]))
}

// Preparing, reviewing and closing again change nothing; a reopened month
// recloses without recognizing twice; a billing that lands after review needs a
// fresh review; and a July position prepared in August never sees August's cost.
async function periodEvidenceControls(kit, expected, check) {
  const input = expected.inputs
  const job = await contractJob(kit, { name: "WIP-01 period evidence", contractCents: input.contractCents, retainagePercent: 0, periods: ["2026-07", "2026-08"] })
  const { prepareWipSnapshot } = app("books/wip-review")
  const periodClose = app("books/period-close")
  const july = job.periods["2026-07"].periodId
  await bill(kit, job, "2026-07", input.julyCostCents, "EV-B1")
  // An August cost is already recorded when July's WIP is prepared.
  await bill(kit, job, "2026-08", input.augustCostCents, "EV-B2")
  invoice(kit, job, "2026-07", input.julyBilledCents, 0, "EV-I1")
  await project(kit, job)
  const prepare = () => kit.as(job.owner, () => prepareWipSnapshot({ periodId: july, projectId: job.projectId, originalContractCents: input.contractCents, approvedChangeOrdersCents: 0, eacCents: input.eacCents, note: "Contract and estimate per the reviewed WIP-01 fixture." }))
  const first = await prepare(), second = await prepare()
  const julyCost = Number(kit.rows(`select cost_to_date_cents n from public.poc_snapshots where id=${kit.q(first.snapshotId)}`)[0].n)
  await reviewAll(kit, job, "2026-07")
  await reviewAll(kit, job, "2026-07")
  await close(kit, job, "2026-07")
  const afterClose = { entries: entriesOf(kit, job, "revenue_recognition"), revenue: revenueThrough(kit, job, ["4000"])["4000"] }
  await kit.as(job.owner, () => periodClose.reopenAccountingPeriod({ periodId: july, reason: "Reopened to confirm the close is repeatable." }))
  await close(kit, job, "2026-07")
  const afterReclose = { entries: entriesOf(kit, job, "revenue_recognition"), revenue: revenueThrough(kit, job, ["4000"])["4000"] }
  await kit.as(job.owner, () => periodClose.reopenAccountingPeriod({ periodId: july, reason: "A July billing was found after the WIP review." }))
  invoice(kit, job, "2026-07", input.lateBilledCents, 0, "EV-I2")
  await project(kit, job)
  const staleReview = await refusal(() => close(kit, job, "2026-07"))
  const revised = await prepare()
  await reviewAll(kit, job, "2026-07")
  await close(kit, job, "2026-07")
  const billed = Number(kit.rows(`select billed_cents n from public.poc_snapshots where id=${kit.q(revised.snapshotId)}`)[0].n)
  check.equal("repeated preparation, review and close are idempotent; late evidence needs a fresh review; the past is not today", expected.expected, {
    samePreparation: first.snapshotId === second.snapshotId, julyCost, afterClose, afterReclose,
    staleReview: /WIP and POC reviewed/.test(staleReview) ? "refused: WIP review out of date" : staleReview,
    newSnapshotAfterLateBilling: revised.snapshotId !== first.snapshotId,
    afterLateBilling: { billed, entries: entriesOf(kit, job, "revenue_recognition"), revenue: revenueThrough(kit, job, ["4000"])["4000"] },
  })
  return { orgId: job.orgId, projectId: job.projectId }
}

// A higher estimate earns less to date, so the next close reverses revenue; a
// later split of the same earned revenue across income accounts moves revenue
// between them with no change to the total or to contract liabilities.
async function estimateReductionAndReclassification(kit, expected, check) {
  const input = expected.inputs
  const job = await contractJob(kit, { name: "WIP-01 estimate reduction", contractCents: input.contractCents, retainagePercent: 0, periods: ["2026-07", "2026-08", "2026-09"],
    accounts: [{ code: "4050", name: "Change order revenue", accountType: "income", subtype: "construction_revenue", normalBalance: "credit" }] })
  const { prepareWipSnapshot, allocateWipRevenue, getWipReviewWorkspace } = app("books/wip-review")
  await bill(kit, job, "2026-07", input.costCents, "RED-B1")
  await project(kit, job)
  const steps = {}
  for (const [period, eac] of [["2026-07", input.julyEacCents], ["2026-08", input.augustEacCents], ["2026-09", input.augustEacCents]]) {
    const { periodId } = job.periods[period]
    const prepared = await kit.as(job.owner, () => prepareWipSnapshot({ periodId, projectId: job.projectId, originalContractCents: input.contractCents, approvedChangeOrdersCents: 0, eacCents: eac, note: "Contract and estimate per the reviewed WIP-01 fixture." }))
    if (period === "2026-09") {
      const workspace = await kit.as(job.owner, () => getWipReviewWorkspace(periodId))
      const account = (code) => workspace.incomeAccounts.find((row) => row.code === code).id
      await kit.as(job.owner, () => allocateWipRevenue({ periodId, snapshotId: prepared.snapshotId, allocations: input.septemberSplit.map((row) => ({ account_id: account(row.code), contract_cents: row.contractCents })), note: "Change-order work is reported as its own revenue line." }))
    }
    await reviewAll(kit, job, period)
    await close(kit, job, period)
    const { periodStart, periodEnd } = job.periods[period]
    steps[period] = Number(kit.rows(`select coalesce(sum(l.credit_cents - l.debit_cents),0)::bigint n from public.journal_lines l join public.journal_entries e on e.id=l.entry_id
      join public.gl_accounts a on a.id=l.account_id where l.org_id=${kit.q(job.orgId)} and a.account_type='income' and e.source_type='revenue_recognition' and e.entry_date between ${kit.q(periodStart)} and ${kit.q(periodEnd)}`)[0].n)
  }
  const net = kit.postedNet(job.orgId)
  check.equal("an estimate increase reverses earned revenue; a reclassification moves it between accounts and nets to zero", expected.expected, {
    recognizedByPeriod: steps, revenueByAccount: revenueThrough(kit, job, ["4000", "4050"]), contractLiabilitiesDebit: net["2350"] ?? 0,
  })
  return { orgId: job.orgId, projectId: job.projectId }
}

// A finished job reconciles: all of its contract earned, its cost, billings that
// equal what it earned, the retainage still owed, and it stays in each close's
// WIP population until it has nothing left to report.
async function completedJobFinalReconciliation(kit, expected, check) {
  const input = expected.inputs
  const job = await contractJob(kit, { name: "WIP-01 final reconciliation", contractCents: input.contractCents, retainagePercent: input.retainagePercent, periods: ["2026-07", "2026-08"] })
  await bill(kit, job, "2026-07", input.costCents, "FIN-B1")
  invoice(kit, job, "2026-07", input.contractCents, input.retainageCents, "FIN-I1")
  await project(kit, job)
  await prepareAndReview(kit, job, "2026-07", { contractCents: input.contractCents, eacCents: input.costCents })
  await close(kit, job, "2026-07")
  await kit.as(job.owner, () => app("projects").updateProject({ projectId: job.projectId, input: { status: "completed" } }))
  await prepareAndReview(kit, job, "2026-08", { contractCents: input.contractCents, eacCents: input.costCents, carryForward: true })
  await close(kit, job, "2026-08")
  const reviewedAugust = kit.rows(`select e->>'projectId' project from public.books_close_items c, jsonb_array_elements(c.support_review->'snapshots') e
    where c.org_id=${kit.q(job.orgId)} and c.period_id=${kit.q(job.periods["2026-08"].periodId)} and c.code='poc_snapshots'`).map((row) => row.project === job.projectId ? "this job" : row.project)
  const net = kit.postedNet(job.orgId)
  check.equal("a completed job's final revenue, cost and retainage reconcile and it stays in the close population", expected.expected, {
    reviewedAugust, revenue: -(net["4000"] ?? 0), jobCost: net["5000"] ?? 0, grossProfit: -(net["4000"] ?? 0) - (net["5000"] ?? 0),
    contractLiabilities: net["2350"] ?? 0, receivable: net["1100"] ?? 0, retainageReceivable: net["1110"] ?? 0,
    augustRecognition: recognizedIn(kit, job, "2026-08"),
  })
  return { orgId: job.orgId, projectId: job.projectId }
}

// ---- Presentation and review (B04.3) ----------------------------------------
// An over-billed contract and an under-billed contract on one job are a
// liability and an asset, presented apart; the WIP schedule ties to the balance
// sheet, revenue and the loss reserve; the period's saved schedule is the one
// the report shows; and the approval says who, when and why, and what changed.
async function contractPositionsPresented(kit, expected, check) {
  const input = expected.inputs
  const period = "2026-07"
  const job = await contractJob(kit, { name: "WIP-01 presentation", contractCents: input.a.contractCents, retainagePercent: 0, periods: [period] })
  sovLine(kit, job, job.contractId, job.costCodeId, "Framing")
  const b = addContract(kit, job, { title: "Site work", type: "fixed", cents: input.b.contractCents, code: "31-000", codeName: "Earthwork" })
  const names = { [job.contractId]: "A", [b.contractId]: "B" }
  await billCode(kit, job, period, input.a.costCents, "PR-A", job.costCodeId)
  await billCode(kit, job, period, input.b.costCents, "PR-B", b.costCodeId)
  invoiceFor(kit, job, period, input.a.billedCents, "PR-IA", job.contractId)
  invoiceFor(kit, job, period, input.b.billedCents, "PR-IB", b.contractId)
  await project(kit, job)
  const { getWipReviewWorkspace } = app("books/wip-review")
  const { periodId } = job.periods[period]
  const prepareBoth = async () => {
    await prepareContract(kit, job, period, job.contractId, input.a.contractCents, input.a.eacCents)
    await prepareContract(kit, job, period, b.contractId, input.b.contractCents, input.b.eacCents)
  }
  await prepareBoth()
  await reviewAll(kit, job, period)
  const approved = (await kit.as(job.owner, () => getWipReviewWorkspace(periodId))).lastReview
  // A cost lands on A after approval: the approval stays on record, marked stale for A.
  await billCode(kit, job, period, input.a.lateCostCents, "PR-A2", job.costCodeId)
  await project(kit, job)
  const stale = (await kit.as(job.owner, () => getWipReviewWorkspace(periodId))).lastReview
  await prepareBoth()
  await reviewAll(kit, job, period)
  await close(kit, job, period)
  const asOf = job.periods[period].periodEnd
  const balanceSheet = await kit.service(() => app("books/statements").buildBalanceSheet(job.orgId, asOf))
  const report = await kit.as(job.owner, () => app("reports/wip-over-under").getProjectWipOverUnderReport({ projectId: job.projectId, asOf }))
  const saved = kit.rows(`select content from public.financial_statement_snapshots where org_id=${kit.q(job.orgId)} and period_id=${kit.q(periodId)} and statement_type='wip'`)[0].content
  const net = kit.postedNet(job.orgId)
  const row = (r) => ({ contract: names[r.contract_id] ?? "project", earned: r.earned_revenue_cents, billed: r.billed_to_date_cents, overBilled: r.over_billed_cents, underBilled: r.under_billed_cents, lossReserve: r.loss_reserve_cents })
  const byContract = (rows) => rows.map(row).sort((x, y) => x.contract.localeCompare(y.contract))
  const presented = (code) => balanceSheet.rows.find((r) => r.code === code)?.balanceCents ?? 0
  check.equal("contract positions are presented apart and the WIP schedule ties to the statements and journals", expected.expected, {
    balanceSheet: { contractAssets: presented("1150"), contractLiabilities: presented("2350"), unallocatedProjects: balanceSheet.unallocatedContractProjectIds.length,
      positions: balanceSheet.contractPositions.filter((p) => p.projectId === job.projectId).map((p) => ({ contract: names[p.contractId] ?? "project", asset: p.assetCents, liability: p.liabilityCents })).sort((x, y) => x.contract.localeCompare(y.contract)) },
    schedule: byContract(report.rows),
    ties: {
      underBilledIsContractAssets: report.totals.under_billed_cents === presented("1150"),
      overBilledIsContractLiabilities: report.totals.over_billed_cents === presented("2350"),
      earnedIsRevenue: report.totals.earned_revenue_cents === -(net["4000"] ?? 0),
      lossReserveIsJournal: report.totals.loss_reserve_cents === -(net["2360"] ?? 0),
    },
    savedScheduleMatchesReport: JSON.stringify(byContract(saved.rows.filter((r) => r.project_id === job.projectId))) === JSON.stringify(byContract(report.rows)),
    approval: { reviewerNamed: Boolean(approved?.reviewer), note: approved?.note, current: approved?.current },
    afterLateCost: { current: stale?.current, changed: (stale?.changed ?? []).map((scope) => names[scope.contractId] ?? "project") },
  })
  return { orgId: job.orgId, projectId: job.projectId, contracts: names }
}

module.exports = {
  id: "WIP-01",
  subcases: {
    "policy-worked-example": policyWorkedExample,
    "revised-and-reverted-eac": revisedAndRevertedEac,
    "completed-job-carryforward": completedJobCarryforward,
    "late-bill-after-review-blocks-close": lateBillAfterReview,
    "second-contract-separately-owned": secondContractSeparatelyOwned,
    "shared-cost-allocation": sharedCostAllocation,
    "wip-recognition-close-populations-agree": populationsAgree,
    "period-evidence-controls": periodEvidenceControls,
    "estimate-reduction-and-reclassification": estimateReductionAndReclassification,
    "completed-job-final-reconciliation": completedJobFinalReconciliation,
    "contract-positions-presented": contractPositionsPresented,
  },
}

module.exports.helpers = { bill, invoice, prepareAndReview, addContract, sovLine, billCode, invoiceFor }
