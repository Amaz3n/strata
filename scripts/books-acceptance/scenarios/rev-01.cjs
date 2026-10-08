// REV-01 — how each job earns revenue is an explicit, dated record (B11.1):
// every kind of work has a stated policy, a later change of billing settings
// cannot reach back, an approved change applies only from its date, superseded
// contracts stay reconstructible, and conflicting contracts are settled by
// reviewed per-contract policy.
const { randomUUID } = require("node:crypto")
const { app, greenfieldOrg, project } = require("./shared.cjs")
const { prepareAndReview } = require("./wip-01.cjs").helpers

// One job with its billing settings and contracts, inserted as data.
function job(kit, org, { name, billingModel = null, contracts = [] }) {
  const { q } = kit
  const projectId = randomUUID()
  const rows = contracts.map((contract) => ({ id: randomUUID(), status: "active", effective: "2026-01-01", ...contract }))
  kit.sql(`begin;
insert into public.projects(id,org_id,name,property_type,created_by) values(${q(projectId)},${q(org.orgId)},${q(name)},'residential',${q(org.owner.userId)});
insert into public.project_financial_settings(org_id,project_id${billingModel ? ",billing_model" : ""}) values(${q(org.orgId)},${q(projectId)}${billingModel ? `,${q(billingModel)}` : ""}) on conflict do nothing;
${rows.map((row) => `insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,retainage_percent,effective_date)
  values(${q(row.id)},${q(org.orgId)},${q(projectId)},${q(row.title ?? row.type)},${q(row.status)},100000000,'usd',${q(row.type)},0,${q(row.effective)});`).join("\n")}
commit;`)
  return { projectId, contractIds: rows.map((row) => row.id) }
}

function invoiceOn(kit, org, { projectId, number, cents, date, contractId }) {
  const { q } = kit
  kit.sql(`select public.create_invoice_atomic(${q(org.orgId)},jsonb_build_object(${projectId ? `'project_id',${q(projectId)},` : ""}'invoice_number',${q(number)},
  'title','Billing','issue_date',${q(date)},'due_date',${q(date)},'client_visible',true,'approval_status','approved',
  'product_posture','residential','subtotal_cents',${cents},'tax_cents',0,'total_cents',${cents},'balance_due_cents',${cents},'token',${q(randomUUID())},
  'metadata',${contractId ? `jsonb_build_object('source_contract_id',${q(contractId)})` : "'{}'::jsonb"}),
  jsonb_build_array(jsonb_build_object('description','Work','quantity',1,'unit_price_cents',${cents},'amount_cents',${cents})));`)
  return kit.rows(`select id from public.invoices where org_id=${q(org.orgId)} and invoice_number=${q(number)}`)[0].id
}

// Where an invoice's credit landed: deferred (2350) or earned (income).
function postedAs(kit, org, invoiceId) {
  const rows = kit.rows(`select a.code, a.account_type, sum(l.credit_cents - l.debit_cents)::bigint n from public.journal_lines l
    join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id
    where l.org_id=${kit.q(org.orgId)} and e.source_id=${kit.q(invoiceId)} and e.status='posted' group by 1,2`)
  if (rows.some((row) => row.code === "2350" && Number(row.n) > 0)) return "deferred until earned"
  if (rows.some((row) => row.account_type === "income" && Number(row.n) > 0)) return "earned when invoiced"
  return "not posted"
}
const entryCount = (kit, org) => Number(kit.rows(`select count(*)::int n from public.journal_entries where org_id=${kit.q(org.orgId)}`)[0].n)
const failureFor = (kit, org, sourceId) => kit.rows(`select details->>'error' message from public.accounting_reconciliation_items where org_id=${kit.q(org.orgId)} and entity_id=${kit.q(sourceId)} and category='projection_failed' and status='open' order by created_at desc limit 1`)[0]?.message ?? null
const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const register = async (kit, org) => (await kit.as(org.owner, () => app("books/revenue-policies").getRevenuePolicyRegister())).rows
const propose = (kit, org, input) => kit.as(org.owner, () => app("books/revenue-policies").proposeRevenuePolicy(input))
const approve = (kit, org, policyId, who = org.reviewer) => kit.as(who, () => app("books/revenue-policies").reviewRevenuePolicy({ policyId, approve: true }))

// Each kind of work has a stated policy once it posts; a standalone service
// invoice earns when invoiced.
async function explicitPolicyByKind(kit, expected, check) {
  const org = await greenfieldOrg(kit, { name: "REV-01 policy by kind", periods: ["2026-07"] })
  const kinds = {
    "Fixed price": job(kit, org, { name: "Fixed price", billingModel: "fixed_price", contracts: [{ type: "fixed" }] }),
    "Time and materials": job(kit, org, { name: "Time and materials", billingModel: "time_and_materials", contracts: [{ type: "time_materials" }] }),
    "Cost plus percentage": job(kit, org, { name: "Cost plus percentage", billingModel: "cost_plus_percent", contracts: [{ type: "cost_plus" }] }),
    "Cost plus fixed fee": job(kit, org, { name: "Cost plus fixed fee", billingModel: "cost_plus_fixed_fee", contracts: [{ type: "cost_plus" }] }),
    "Cost plus GMP": job(kit, org, { name: "Cost plus GMP", billingModel: "cost_plus_gmp", contracts: [{ type: "cost_plus" }] }),
    "Home closing": job(kit, org, { name: "Home closing", contracts: [{ type: "purchase_agreement" }] }),
  }
  const invoices = Object.fromEntries(Object.entries(kinds).map(([kind, row], index) => [kind, invoiceOn(kit, org, { projectId: row.projectId, number: `KIND-${index + 1}`, cents: 1000000, date: "2026-07-15" })]))
  invoices["Standalone service"] = invoiceOn(kit, org, { projectId: null, number: "SERVICE-1", cents: 50000, date: "2026-07-15" })
  await project(kit, org)
  const rows = await register(kit, org)
  check.equal("every kind of work posts under a stated policy, recorded and labeled as not yet reviewed", expected.expected, {
    policies: Object.fromEntries(Object.keys(kinds).map((kind) => {
      const row = rows.find((item) => item.projectName === kind)
      return [kind, { method: row.inForce?.method ?? null, billingMethod: row.inForce?.billingMethod ?? null, source: row.inForce?.source ?? null }]
    })),
    postings: Object.fromEntries(Object.entries(invoices).map(([kind, id]) => [kind, postedAs(kit, org, id)])),
  })
  return { orgId: org.orgId }
}

// Changing the billing settings later cannot rewrite how a job earned: the
// recorded policy decides, and the register says the settings now disagree.
async function settingsChangeCannotRewrite(kit, expected, check) {
  const org = await greenfieldOrg(kit, { name: "REV-01 settings change", periods: ["2026-07", "2026-08"] })
  const row = job(kit, org, { name: "Custom home", contracts: [{ type: "fixed" }] })
  const july = invoiceOn(kit, org, { projectId: row.projectId, number: "SC-1", cents: 1000000, date: "2026-07-15" })
  await project(kit, org)
  const before = entryCount(kit, org)
  // Someone re-types the contract as a purchase agreement.
  kit.sql(`update public.contracts set contract_type='purchase_agreement' where id=${kit.q(row.contractIds[0])};`)
  await project(kit, org)
  const august = invoiceOn(kit, org, { projectId: row.projectId, number: "SC-2", cents: 1000000, date: "2026-08-15" })
  await project(kit, org)
  const listed = (await register(kit, org)).find((item) => item.projectId === row.projectId)
  check.equal("the recorded policy governs; the settings change is flagged, not applied", expected.expected, {
    julyInvoice: postedAs(kit, org, july), augustInvoice: postedAs(kit, org, august),
    entriesAddedByReprojection: entryCount(kit, org) - before - 1,
    register: { method: listed.inForce.method, source: listed.inForce.source, drift: listed.drift, settingsSay: listed.settingsSay.method },
  })
  return { orgId: org.orgId }
}

// A change of method is proposed, approved by someone else, and applies only
// from its date; a closed month cannot be changed under its saved results.
async function approvedChangeFromItsDate(kit, expected, check) {
  const input = expected.inputs
  const org = await greenfieldOrg(kit, { name: "REV-01 approved change", periods: ["2026-07", "2026-08"] })
  const row = job(kit, org, { name: "Model home", contracts: [{ type: "fixed" }] })
  const july = invoiceOn(kit, org, { projectId: row.projectId, number: "AC-1", cents: 1000000, date: "2026-07-15" })
  await project(kit, org)
  await prepareAndReview(kit, { ...org, projectId: row.projectId }, "2026-07", { contractCents: 100000000, eacCents: 80000000 })
  await kit.as(org.owner, () => app("books/period-close").closeAccountingPeriod(org.periods["2026-07"].periodId))
  const intoClosedMonth = await refusal(() => propose(kit, org, { projectId: row.projectId, contractId: null, method: "closing", billingMethod: "purchase_agreement", effectiveFrom: "2026-07-20", rationale: "The home is now held for sale under a purchase agreement." }))
  const { policyId } = await propose(kit, org, { projectId: row.projectId, contractId: null, method: "closing", billingMethod: "purchase_agreement", effectiveFrom: input.effectiveFrom, rationale: "The home is now held for sale under a purchase agreement." })
  const selfApproval = await refusal(() => approve(kit, org, policyId, org.owner))
  await approve(kit, org, policyId)
  const august = invoiceOn(kit, org, { projectId: row.projectId, number: "AC-2", cents: 1000000, date: "2026-08-15" })
  await project(kit, org)
  const rewrite = await refusal(async () => kit.sql(`update public.books_revenue_policies set method='percentage_of_completion' where id=${kit.q(policyId)};`))
  const policyOnFact = kit.rows(`select payload->>'revenue_policy_id' id from public.accounting_facts where org_id=${kit.q(org.orgId)} and source_id=${kit.q(august)} order by created_at desc limit 1`)[0]?.id
  const listed = (await register(kit, org)).find((item) => item.projectId === row.projectId)
  check.equal("an approved change applies from its date only, approved by someone else, and is kept as written", expected.expected, {
    intoClosedMonth, selfApproval, julyInvoice: postedAs(kit, org, july), augustInvoice: postedAs(kit, org, august),
    augustNamesPolicy: policyOnFact === policyId, rewrite: /cannot change|recorded/.test(rewrite) ? "refused" : rewrite,
    register: { method: listed.inForce.method, source: listed.inForce.source, effectiveFrom: listed.inForce.effectiveFrom, history: listed.history.map((item) => item.status) },
  })
  return { orgId: org.orgId }
}

// A job whose contract was later superseded still resolves from its recorded
// policy; one with no record and only superseded evidence is a finding until a
// policy is attributed and approved.
async function supersededReconstructible(kit, expected, check) {
  const org = await greenfieldOrg(kit, { name: "REV-01 superseded", periods: ["2026-07"] })
  const recorded = job(kit, org, { name: "Recorded sale", contracts: [{ type: "purchase_agreement" }] })
  const recordedInvoice = invoiceOn(kit, org, { projectId: recorded.projectId, number: "SU-1", cents: 1000000, date: "2026-07-15" })
  await project(kit, org)
  const legacy = job(kit, org, { name: "Legacy sale", contracts: [{ type: "purchase_agreement", status: "superseded" }, { type: "purchase_agreement", effective: "2026-10-01", title: "Replacement" }] })
  const legacyInvoice = invoiceOn(kit, org, { projectId: legacy.projectId, number: "SU-2", cents: 1000000, date: "2026-07-15" })
  // The recorded job's contract is superseded by a replacement not yet in force.
  kit.sql(`update public.contracts set status='superseded' where id=${kit.q(recorded.contractIds[0])};
insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,retainage_percent,effective_date)
  values(${kit.q(randomUUID())},${kit.q(org.orgId)},${kit.q(recorded.projectId)},'Replacement','active',100000000,'usd','purchase_agreement',0,'2026-10-01');`)
  const before = entryCount(kit, org)
  const projected = await project(kit, org)
  await kit.service(() => app("books/reconciliation").recordProjectionFailures([{ orgId: org.orgId, ...projected }], { full: true }))
  const legacyBefore = { posted: postedAs(kit, org, legacyInvoice), finding: failureFor(kit, org, legacyInvoice) }
  const { policyId } = await propose(kit, org, { projectId: legacy.projectId, contractId: null, method: "closing", billingMethod: "purchase_agreement", effectiveFrom: "1900-01-01", rationale: "Sold under a purchase agreement since the job began; the original agreement was superseded." })
  await approve(kit, org, policyId)
  await project(kit, org)
  check.equal("superseded contracts stay reconstructible, and unknown legacy policy has an attribution path", expected.expected, {
    recordedJob: { posted: postedAs(kit, org, recordedInvoice), entriesAdded: entryCount(kit, org) - before - (postedAs(kit, org, legacyInvoice) === "not posted" ? 0 : 1) },
    legacyBefore: { posted: legacyBefore.posted, finding: legacyBefore.finding ? /Historical revenue-policy evidence/.test(legacyBefore.finding) : false },
    legacyAfter: postedAs(kit, org, legacyInvoice),
  })
  return { orgId: org.orgId }
}

// Two contracts on one job that earn differently are refused until each has an
// approved policy; then each invoice earns under its contract's policy and only
// the over-time contract has WIP.
async function mixedContractsReviewed(kit, expected, check) {
  const org = await greenfieldOrg(kit, { name: "REV-01 mixed contracts", periods: ["2026-07"] })
  const row = job(kit, org, { name: "Build and sell", contracts: [{ type: "fixed", title: "Construction" }, { type: "purchase_agreement", title: "Lot sale" }] })
  const [build, sale] = row.contractIds
  const buildInvoice = invoiceOn(kit, org, { projectId: row.projectId, number: "MX-1", cents: 1000000, date: "2026-07-15", contractId: build })
  const saleInvoice = invoiceOn(kit, org, { projectId: row.projectId, number: "MX-2", cents: 500000, date: "2026-07-20", contractId: sale })
  const projected = await project(kit, org)
  await kit.service(() => app("books/reconciliation").recordProjectionFailures([{ orgId: org.orgId, ...projected }], { full: true }))
  const beforeReview = { build: postedAs(kit, org, buildInvoice), finding: failureFor(kit, org, buildInvoice) }
  for (const [contractId, method, billingMethod] of [[build, "percentage_of_completion", "fixed_price"], [sale, "closing", "purchase_agreement"]]) {
    const { policyId } = await propose(kit, org, { projectId: row.projectId, contractId, method, billingMethod, effectiveFrom: "1900-01-01", rationale: "Construction earns over time; the lot sale earns at closing." })
    await approve(kit, org, policyId)
  }
  await project(kit, org)
  const scopes = await kit.service(() => app("books/wip-project-scope").loadWipScopesForPeriod(org.orgId, "2026-07-31"))
  check.equal("contracts that earn differently are refused until reviewed, then each earns under its own policy", expected.expected, {
    beforeReview: { build: beforeReview.build, refusedWithCure: Boolean(beforeReview.finding && /earn revenue differently/.test(beforeReview.finding)) },
    afterReview: { build: postedAs(kit, org, buildInvoice), sale: postedAs(kit, org, saleInvoice) },
    wipScopes: scopes.filter((scope) => scope.projectId === row.projectId).map((scope) => scope.contractId === build ? "Construction" : scope.contractId === sale ? "Lot sale" : "project"),
  })
  return { orgId: org.orgId }
}

// ---- Cost-driven billing (B11.2) --------------------------------------------
// A cost-plus job with a vendor, a cost code and a contract carrying its markup.
function costJob(kit, org, { name, billingModel, markupPercent, gmpCents = null, ownerPct = 0, builderPct = 0 }) {
  const { q } = kit
  const ids = { projectId: randomUUID(), contractId: randomUUID(), vendorId: randomUUID(), costCodeId: randomUUID() }
  kit.sql(`begin;
insert into public.projects(id,org_id,name,property_type,created_by) values(${q(ids.projectId)},${q(org.orgId)},${q(name)},'residential',${q(org.owner.userId)});
insert into public.project_financial_settings(org_id,project_id) values(${q(org.orgId)},${q(ids.projectId)}) on conflict do nothing;
update public.project_financial_settings set billing_model=${q(billingModel)} where org_id=${q(org.orgId)} and project_id=${q(ids.projectId)};
insert into public.companies(id,org_id,name) values(${q(ids.vendorId)},${q(org.orgId)},${q(`${name} framer`)});
insert into public.cost_codes(id,org_id,code,name) values(${q(ids.costCodeId)},${q(org.orgId)},${q(`06-${ids.costCodeId.slice(0, 4)}`)},'Rough carpentry');
insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,retainage_percent,effective_date,markup_percent,gmp_cents,savings_split_owner_pct,savings_split_builder_pct)
  values(${q(ids.contractId)},${q(org.orgId)},${q(ids.projectId)},'Cost-plus agreement','active',0,'usd','cost_plus',0,'2026-01-01',${markupPercent},${gmpCents === null ? "null" : gmpCents},${ownerPct},${builderPct});
commit;`)
  return ids
}
async function billableBill(kit, org, job, { number, date, cents }) {
  const { createProjectVendorBill, approveVendorBillsAtomic } = app("vendor-bills")
  const bill = await kit.as(org.owner, () => createProjectVendorBill({ projectId: job.projectId, input: {
    company_id: job.vendorId, bill_number: number, bill_date: date, due_date: date, total_cents: cents,
    actual_lines: [{ cost_code_id: job.costCodeId, description: number, amount_cents: cents, project_id: job.projectId, billable_to_customer: true }] } }))
  await kit.as(org.owner, () => approveVendorBillsAtomic([{ id: bill.id }]))
  await kit.drainOutbox(org.orgId)
  return bill.id
}
async function billCosts(kit, org, job, { from, to, issueOn = null, overrideGmpCap = false }) {
  const result = await kit.as(org.owner, () => app("cost-plus").generateInvoiceFromCosts({ projectId: job.projectId, dateRange: { from, to }, overrideGmpCap, idempotencyKey: randomUUID() }))
  if (issueOn) kit.sql(`update public.invoices set issue_date = ${kit.q(issueOn)}, due_date = ${kit.q(issueOn)} where id = ${kit.q(result.invoiceId)} and status = 'draft';`)
  await kit.as(org.owner, () => app("invoices").issueInvoice({ invoiceId: result.invoiceId, recipients: ["client@acceptance.example.test"] }))
  await kit.drainOutbox(org.orgId)
  return result
}
const costRows = (kit, org, job) => kit.rows(`select source_type, status, cost_cents::int, markup_cents::int, billable_cents::int, correction_of is not null as credit, billing_decision, credited_at is not null as credited
  from public.billable_costs where org_id=${kit.q(org.orgId)} and project_id=${kit.q(job.projectId)} order by created_at, id`)

// A cost-plus job earns what it bills, once: the invoice built from costs is
// deferred billing (2350), and percentage of completion against the expected
// total billable earns it, so revenue equals what was billed when the job is done.
async function costPlusEarnsOnce(kit, expected, check) {
  const input = expected.inputs
  const org = await greenfieldOrg(kit, { name: "REV-01 cost plus", periods: ["2026-09"] })
  const job = costJob(kit, org, { name: "Cost-plus remodel", billingModel: "cost_plus_percent", markupPercent: input.markupPercent })
  await billableBill(kit, org, job, { number: "CP-1", date: "2026-09-10", cents: input.vendorCents })
  // A manual billable adjustment (it could not be saved before: it wrote a computed column).
  const adjustment = await refusal(() => kit.as(org.owner, () => app("cost-plus").createManualBillableAdjustment({ projectId: job.projectId, costCodeId: job.costCodeId, occurredOn: "2026-09-20", description: "Permit expediting", reason: "Owner-requested expediting", amountCents: input.adjustmentCents })))
  const invoice = await billCosts(kit, org, job, { from: "2026-09-01", to: "2026-09-30", issueOn: "2026-09-30" })
  await project(kit, org)
  const billed = Number(kit.rows(`select total_cents n from public.invoices where id=${kit.q(invoice.invoiceId)}`)[0].n)
  await prepareAndReview(kit, { ...org, projectId: job.projectId }, "2026-09", { contractCents: billed, eacCents: input.vendorCents })
  await kit.as(org.owner, () => app("books/period-close").closeAccountingPeriod(org.periods["2026-09"].periodId))
  const net = kit.postedNet(org.orgId)
  check.equal("a cost-plus job's billing is deferred and earned once, equal to what was billed", expected.expected, {
    adjustmentSaved: adjustment === "allowed", invoicePosting: postedAs(kit, org, invoice.invoiceId), billed,
    revenue: -(net["4000"] ?? 0), contractLiabilities: net["2350"] ?? 0, jobCost: net["5000"] ?? 0,
  })
  return { orgId: org.orgId, projectId: job.projectId }
}

// A cost already billed is never rewritten. Changing its bill credits it once on
// the next invoice (or the company absorbs it, on record), the corrected cost bills
// again, billed rows cannot be edited, and a voided invoice cannot leave a credit
// orphaned.
async function billedCostCorrections(kit, expected, check) {
  const input = expected.inputs
  const org = await greenfieldOrg(kit, { name: "REV-01 billed corrections", periods: ["2026-10"] })
  const job = costJob(kit, org, { name: "Cost-plus addition", billingModel: "cost_plus_percent", markupPercent: input.markupPercent })
  const { updateVendorBillStatus } = app("vendor-bills")
  const billA = await billableBill(kit, org, job, { number: "BC-A", date: "2026-10-01", cents: input.billACents })
  const billB = await billableBill(kit, org, job, { number: "BC-B", date: "2026-10-02", cents: input.billBCents })
  const first = await billCosts(kit, org, job, { from: "2026-10-01", to: "2026-10-07" })
  // A is returned to pending twice and corrected; B is returned and stays pending.
  await kit.as(org.owner, () => updateVendorBillStatus({ billId: billA, input: { status: "pending" } }))
  await kit.as(org.owner, () => updateVendorBillStatus({ billId: billA, input: { status: "approved" } }))
  await kit.drainOutbox(org.orgId)
  await kit.as(org.owner, () => updateVendorBillStatus({ billId: billA, input: { status: "pending" } }))
  // Corrected: the same total split into two lines.
  await kit.as(org.owner, () => updateVendorBillStatus({ billId: billA, input: { status: "approved", actual_lines: input.correctedALines.map((cents, index) => ({ cost_code_id: job.costCodeId, description: `BC-A corrected ${index + 1}`, amount_cents: cents, project_id: job.projectId, billable_to_customer: true })) } }))
  await kit.drainOutbox(org.orgId)
  await billableBill(kit, org, job, { number: "BC-C", date: "2026-10-03", cents: input.billCCents })
  await kit.as(org.owner, () => updateVendorBillStatus({ billId: billB, input: { status: "pending" } }))
  const creditB = kit.rows(`select id from public.billable_costs where org_id=${kit.q(org.orgId)} and project_id=${kit.q(job.projectId)} and correction_of in (select id from public.billable_costs where metadata->>'bill_id'=${kit.q(billB)}) and status <> 'voided'`)[0].id
  const absorbed = await kit.as(org.owner, () => app("cost-plus").decideBillingCorrection({ billableCostId: creditB, decision: "absorb", note: "The owner agreed to keep the original price for this work." }))
  // Credits are dated when recorded (UTC), so the second billing runs through today.
  const second = await billCosts(kit, org, job, { from: "2026-10-01", to: [new Date().toISOString().slice(0, 10), "2026-10-07"].sort().at(-1) })
  const billedRow = kit.rows(`select id from public.billable_costs where org_id=${kit.q(org.orgId)} and status='billed' and correction_of is null limit 1`)[0].id
  const edit = await refusal(async () => kit.sql(`update public.billable_costs set cost_cents = cost_cents + 1 where id=${kit.q(billedRow)};`))
  const remove = await refusal(async () => kit.sql(`delete from public.billable_costs where id=${kit.q(billedRow)};`))
  const voidFirst = await refusal(() => kit.as(org.owner, () => app("invoices").voidInvoice({ invoiceId: first.invoiceId })))
  check.equal("billed costs are credited once with an explicit decision, rebill when corrected, and never change", expected.expected, {
    firstInvoice: first.totalBillableCents, secondInvoice: second.totalBillableCents,
    credits: costRows(kit, org, job).filter((row) => row.credit && row.status !== "voided").map((row) => ({ billable: row.billable_cents, status: row.status, decision: row.billing_decision })),
    absorbedDecision: absorbed.decision,
    edit: /cannot change/.test(edit) ? "refused" : edit, remove: /cannot be deleted/.test(remove) ? "refused" : remove,
    voidFirstInvoice: voidFirst,
  })
  return { orgId: org.orgId, projectId: job.projectId }
}

// Billing past the guaranteed maximum is refused unless someone overrides it on
// record; an approved change order raising the GMP lifts the cap. At completion
// the savings are the GMP less everything billed within it: settled once, only
// after every cost inside the GMP is billed, with only the builder's share billed.
async function gmpCapAndSettlement(kit, expected, check) {
  const input = expected.inputs
  const { q } = kit
  const org = await greenfieldOrg(kit, { name: "REV-01 GMP", periods: ["2026-10"] })
  const job = costJob(kit, org, { name: "GMP clinic", billingModel: "cost_plus_gmp", markupPercent: input.markupPercent, gmpCents: input.gmpCents, ownerPct: 50, builderPct: 50 })
  await billableBill(kit, org, job, { number: "GMP-1", date: "2026-10-01", cents: input.firstCents })
  const first = await billCosts(kit, org, job, { from: "2026-10-01", to: "2026-10-07" })
  await billableBill(kit, org, job, { number: "GMP-2", date: "2026-10-02", cents: input.secondCents })
  const overCap = await refusal(() => billCosts(kit, org, job, { from: "2026-10-01", to: "2026-10-07" }))
  const overridden = await billCosts(kit, org, job, { from: "2026-10-01", to: "2026-10-07", overrideGmpCap: true })
  const overrideEvents = Number(kit.rows(`select count(*)::int n from public.events where org_id=${q(org.orgId)} and event_type='gmp_cap_overridden'`)[0].n)
  // An approved change order raises the GMP; the next cost bills without an override.
  const changeOrderId = randomUUID()
  kit.sql(`begin;
insert into public.change_orders(id,org_id,project_id,title,status,lifecycle,total_cents) values(${q(changeOrderId)},${q(org.orgId)},${q(job.projectId)},'Added exam room','approved','approved',${input.changeOrderGmpCents});
insert into public.change_order_lines(org_id,change_order_id,description,gmp_classification,gmp_impact,gmp_delta_cents) values(${q(org.orgId)},${q(changeOrderId)},'Added exam room','inside_gmp','increase_gmp',${input.changeOrderGmpCents});
commit;`)
  await billableBill(kit, org, job, { number: "GMP-3", date: "2026-10-03", cents: input.thirdCents })
  const afterChangeOrder = await refusal(() => billCosts(kit, org, job, { from: "2026-10-01", to: "2026-10-07" }))
  const revisedGmp = (await kit.as(org.owner, () => app("gmp-control").getProjectGmpControlSummary(job.projectId))).revised_gmp_cents
  // A smaller job finishes under its GMP and settles; two requests race.
  const small = costJob(kit, org, { name: "GMP fit-out", billingModel: "cost_plus_gmp", markupPercent: input.markupPercent, gmpCents: input.gmpCents, ownerPct: 50, builderPct: 50 })
  await billableBill(kit, org, small, { number: "FIT-1", date: "2026-10-01", cents: input.smallCents })
  await billCosts(kit, org, small, { from: "2026-10-01", to: "2026-10-07" })
  await billableBill(kit, org, small, { number: "FIT-2", date: "2026-10-02", cents: input.smallLateCents })
  kit.sql(`update public.projects set status='completed' where id=${q(small.projectId)};`)
  const settle = () => refusal(() => kit.as(org.owner, () => app("gmp-control").settleGmpSavings(small.projectId)))
  const withUnbilled = await settle()
  await billCosts(kit, org, small, { from: "2026-10-01", to: "2026-10-07" })
  const outcomes = (await Promise.all([settle(), settle()])).map((outcome) => outcome === "allowed" ? "settled" : /already/.test(outcome) ? "refused: already settling or settled" : outcome).sort()
  const builderInvoices = kit.rows(`select total_cents::int n from public.invoices where org_id=${q(org.orgId)} and project_id=${q(small.projectId)} and title='Builder GMP savings share'`).map((row) => row.n)
  const settlement = kit.rows(`select snapshot->'gmp_savings_settlement' s from public.contracts where id=${q(small.contractId)}`)[0].s
  check.equal("the GMP cap holds unless overridden or raised by change order, and savings settle once on what was billed", expected.expected, {
    firstInvoice: first.totalBillableCents, overCap: /exceed the revised GMP/.test(overCap) ? "refused" : overCap,
    overriddenInvoice: overridden.totalBillableCents, overrideEvents, revisedGmp, afterChangeOrder,
    settleWithUnbilledCost: withUnbilled, settlement: outcomes, builderInvoices,
    recorded: { billed: settlement.billed_inside_gmp_cents, savings: settlement.savings_cents, owner: settlement.owner_savings_cents, builder: settlement.builder_savings_cents },
  })
  return { orgId: org.orgId }
}


// ---- B11.4: shared construction cost reaches jobs through a reviewed allocation ----
const glOf = (kit, org, code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0].id
const allocations = () => app("books/cost-allocations")
// Per job: the cents on its cost account lines (5000 or inventory) and its job-cost rows.
function jobCost(kit, org, projectId) {
  const ledger = kit.rows(`select coalesce(sum(l.debit_cents-l.credit_cents),0)::bigint n from public.journal_lines l join public.journal_entries e on e.id=l.entry_id join public.gl_accounts a on a.id=l.account_id
    where l.org_id=${kit.q(org.orgId)} and l.project_id=${kit.q(projectId)} and e.status in ('posted','reversed') and (a.account_type='cogs' or a.code in ('1160','1170'))`)[0].n
  const rows = kit.rows(`select cost_cents from public.job_cost_entries where org_id=${kit.q(org.orgId)} and project_id=${kit.q(projectId)} and source_type='cost_allocation' and status='posted' order by created_at, cost_cents desc`).map((row) => Number(row.cost_cents))
  return { ledger: Number(ledger), rows }
}
const poolCents = (kit, org, code) => Number(kit.rows(`select public.books_cost_pool_cents(${kit.q(org.orgId)}, ${kit.q(glOf(kit, org, code))}, '2026-07-31') n`)[0].n)
const tieOutStatus = async (kit, org, code) => (await kit.service(() => app("books/verifier").runLedgerTieOuts(org.orgId, "2026-07-31"))).find((row) => row.code === code)?.status

// Two contract jobs and a home the builder owns, an insurance pool paid in July,
// and a premium already charged to one job (which is not in the pool).
async function sharedCostOrg(kit, name, input) {
  const org = await greenfieldOrg(kit, { name, periods: ["2026-07"] })
  org.jobA = job(kit, org, { name: "Riverside clinic", billingModel: "fixed_price", contracts: [{ type: "fixed" }] })
  org.jobB = job(kit, org, { name: "Harbor offices", billingModel: "fixed_price", contracts: [{ type: "fixed" }] })
  org.home = job(kit, org, { name: "Lot 7 spec home", contracts: [{ type: "purchase_agreement" }] })
  org.costCodeId = randomUUID()
  kit.sql(`insert into public.cost_codes(id,org_id,code,name) values(${kit.q(org.costCodeId)},${kit.q(org.orgId)},'01-500','General conditions')`)
  await kit.as(org.owner, () => app("books/inventory").enableProjectInventory({ projectId: org.home.projectId, effectiveOn: "2026-07-01", evidenceUrl: "https://evidence.acceptance.example.test/rev-01/ownership" }))
  const { createAdjustingJournal } = app("books/bookkeeping")
  await kit.as(org.reviewer, () => createAdjustingJournal({ entryDate: "2026-07-02", memo: "Builder's risk and liability premium", lines: [
    { accountCode: "6010", debitCents: input.poolCents, creditCents: 0 }, { accountCode: "1000", debitCents: 0, creditCents: input.poolCents }] }))
  await kit.as(org.reviewer, () => createAdjustingJournal({ entryDate: "2026-07-02", memo: "Project-specific bond premium", lines: [
    { accountCode: "6010", debitCents: input.chargedCents, creditCents: 0, projectId: org.jobA.projectId }, { accountCode: "1000", debitCents: 0, creditCents: input.chargedCents }] }))
  return org
}
const proposal = (org, input, weights, extra = {}) => ({ date: "2026-07-31", reference: extra.reference ?? "July insurance", pool: "insurance", basis: "labor_hours", sourceAccountId: extra.accountId,
  costCodeId: org.costCodeId, totalCents: input.poolCents, weights, evidenceUrl: "https://evidence.acceptance.example.test/rev-01/labor-hours.pdf",
  note: "Insurance follows the field labor hours on each job this month.", correctsId: extra.correctsId ?? null })

// A pool spreads only after independent review, splits to the cent, stays out of
// a job's cost until approved and cannot be spent twice; the home's share is
// capitalized into its inventory.
async function sharedCostAllocatedOnce(kit, expected, check) {
  const input = expected.inputs
  const org = await sharedCostOrg(kit, "REV-01 shared cost", input)
  const accountId = glOf(kit, org, "6010")
  const poolBefore = poolCents(kit, org, "6010")
  const { id } = await kit.as(org.owner, () => allocations().proposeCostAllocation(proposal(org, input, [
    { projectId: org.jobA.projectId, weight: 50 }, { projectId: org.jobB.projectId, weight: 30 }, { projectId: org.home.projectId, weight: 15 }, { projectId: null, weight: 5 }], { accountId })))
  const beforeReview = jobCost(kit, org, org.jobA.projectId)
  const selfApproval = await refusal(() => kit.as(org.owner, () => allocations().reviewCostAllocation({ allocationId: id, approve: true })))
  await kit.as(org.reviewer, () => allocations().reviewCostAllocation({ allocationId: id, approve: true }))
  const register = await kit.as(org.owner, () => allocations().getCostAllocationRegister())
  const twice = await refusal(() => kit.as(org.owner, () => allocations().proposeCostAllocation({ ...proposal(org, input, [{ projectId: org.jobB.projectId, weight: 1 }], { accountId, reference: "July insurance again" }), totalCents: input.secondCents })))
  const homeInventory = kit.rows(`select coalesce(sum(l.debit_cents-l.credit_cents),0)::bigint n from public.journal_lines l join public.gl_accounts a on a.id=l.account_id where l.org_id=${kit.q(org.orgId)} and l.project_id=${kit.q(org.home.projectId)} and a.code='1160'`)[0].n
  check.equal("the pool is spread once, after review, in exact cents, and the home's share is capitalized", expected.expected, {
    poolBefore,
    jobCostBeforeReview: beforeReview.rows.length,
    selfApproval: /someone other than/.test(selfApproval) ? "refused: approved by someone other than the proposer" : selfApproval,
    shares: register.allocations[0].shares.map((share) => ({ to: share.projectId ? "job" : "retained", cents: share.cents })).sort((a, b) => b.cents - a.cents),
    jobs: { "Riverside clinic": jobCost(kit, org, org.jobA.projectId), "Harbor offices": jobCost(kit, org, org.jobB.projectId), "Lot 7 spec home": jobCost(kit, org, org.home.projectId) },
    homeInventory: Number(homeInventory),
    poolAfter: poolCents(kit, org, "6010"),
    allocatingTwice: /exceeds the unallocated pool/.test(twice) ? "refused: exceeds the unallocated pool" : twice,
    jobCostControl: await tieOutStatus(kit, org, "job_cost_control"),
  })
  return { orgId: org.orgId, allocationId: id }
}

// A reallocation reverses the original and posts the new split in one step:
// the original entry, its exact reversal and the negative job-cost rows all stay.
async function reallocationKeepsBothLegs(kit, expected, check) {
  const input = expected.inputs
  const org = await sharedCostOrg(kit, "REV-01 reallocation", input)
  const accountId = glOf(kit, org, "6010")
  const { id: original } = await kit.as(org.owner, () => allocations().proposeCostAllocation(proposal(org, input, [
    { projectId: org.jobA.projectId, weight: 50 }, { projectId: org.jobB.projectId, weight: 30 }, { projectId: org.home.projectId, weight: 20 }], { accountId })))
  await kit.as(org.reviewer, () => allocations().reviewCostAllocation({ allocationId: original, approve: true }))
  const { id: correction } = await kit.as(org.owner, () => allocations().proposeCostAllocation(proposal(org, input, [
    { projectId: org.jobA.projectId, weight: 60 }, { projectId: org.jobB.projectId, weight: 40 }], { accountId, reference: "July insurance corrected", correctsId: original })))
  await kit.as(org.reviewer, () => allocations().reviewCostAllocation({ allocationId: correction, approve: true }))
  const again = await refusal(() => kit.as(org.owner, () => allocations().proposeCostAllocation(proposal(org, input, [{ projectId: org.jobB.projectId, weight: 1 }], { accountId, reference: "July insurance third", correctsId: original }))))
  const rows = kit.rows(`select reference, status, journal_entry_id, reversal_entry_id from public.books_cost_allocations where org_id=${kit.q(org.orgId)} order by prepared_at`)
  const entry = (entryId) => entryId ? kit.rows(`select status, entry_kind from public.journal_entries where id=${kit.q(entryId)}`)[0] : null
  check.equal("the correction keeps the original, its reversal and the new split, and each job ends on the new share", expected.expected, {
    allocations: rows.map((row) => ({ reference: row.reference, status: row.status, entry: entry(row.journal_entry_id)?.status ?? null, reversal: entry(row.reversal_entry_id)?.entry_kind ?? null })),
    jobs: { "Riverside clinic": jobCost(kit, org, org.jobA.projectId), "Harbor offices": jobCost(kit, org, org.jobB.projectId), "Lot 7 spec home": jobCost(kit, org, org.home.projectId) },
    poolAfter: poolCents(kit, org, "6010"),
    reallocatingAgain: /Only an approved allocation can be reallocated/.test(again) ? "refused: only an approved allocation can be reallocated" : again,
    jobCostControl: await tieOutStatus(kit, org, "job_cost_control"),
  })
  return { orgId: org.orgId, original, correction }
}

// Job cost, budget (by cost code), WIP and the statements read the same cents.
async function allocationTreatmentsAgree(kit, expected, check) {
  const input = expected.inputs
  const org = await sharedCostOrg(kit, "REV-01 allocation treatments", input)
  const accountId = glOf(kit, org, "6010")
  const { id } = await kit.as(org.owner, () => allocations().proposeCostAllocation(proposal(org, input, [
    { projectId: org.jobA.projectId, weight: 2 }, { projectId: org.jobB.projectId, weight: 1 }], { accountId })))
  await kit.as(org.reviewer, () => allocations().reviewCostAllocation({ allocationId: id, approve: true }))
  // WIP is reviewed for every contract job at once: prepare Harbor, then prepare Riverside and review both.
  await kit.as(org.owner, () => app("books/wip-review").prepareWipSnapshot({ periodId: org.periods["2026-07"].periodId, projectId: org.jobB.projectId,
    originalContractCents: input.contractCents, approvedChangeOrdersCents: 0, eacCents: input.eacCents, note: "Contract and estimate per the reviewed fixture." }))
  await prepareAndReview(kit, { ...org, projectId: org.jobA.projectId }, "2026-07", { contractCents: input.contractCents, eacCents: input.eacCents })
  const wipCost = Number(kit.rows(`select cost_to_date_cents from public.poc_snapshots where org_id=${kit.q(org.orgId)} and project_id=${kit.q(org.jobA.projectId)} order by created_at desc limit 1`)[0].cost_to_date_cents)
  const byCostCode = kit.rows(`select c.code, sum(j.cost_cents)::bigint n from public.job_cost_entries j join public.cost_codes c on c.id=j.cost_code_id where j.org_id=${kit.q(org.orgId)} and j.source_type='cost_allocation' group by 1`)
  const statement = (code) => Number(kit.postedNet(org.orgId)[code] ?? 0)
  check.equal("job cost, the budget's cost code, WIP and the ledger agree on the allocation", expected.expected, {
    jobA: jobCost(kit, org, org.jobA.projectId).ledger,
    wipCostToDate: wipCost,
    byCostCode: Object.fromEntries(byCostCode.map((row) => [row.code, Number(row.n)])),
    ledger: { "6010": statement("6010"), "5000": statement("5000") },
    jobCostControl: await tieOutStatus(kit, org, "job_cost_control"),
    trialBalance: await tieOutStatus(kit, org, "trial_balance"),
  })
  return { orgId: org.orgId, allocationId: id }
}

module.exports = {
  id: "REV-01",
  subcases: {
    "explicit-policy-by-kind": explicitPolicyByKind,
    "settings-change-cannot-rewrite": settingsChangeCannotRewrite,
    "approved-change-from-its-date": approvedChangeFromItsDate,
    "superseded-contracts-reconstructible": supersededReconstructible,
    "mixed-contracts-reviewed": mixedContractsReviewed,
    "cost-plus-earns-once": costPlusEarnsOnce,
    "billed-cost-corrections": billedCostCorrections,
    "gmp-cap-and-settlement": gmpCapAndSettlement,
    "shared-cost-allocated-once": sharedCostAllocatedOnce,
    "reallocation-keeps-both-legs": reallocationKeepsBothLegs,
    "allocation-treatments-agree": allocationTreatmentsAgree,
  },
}
