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

module.exports = {
  id: "REV-01",
  subcases: {
    "explicit-policy-by-kind": explicitPolicyByKind,
    "settings-change-cannot-rewrite": settingsChangeCannotRewrite,
    "approved-change-from-its-date": approvedChangeFromItsDate,
    "superseded-contracts-reconstructible": supersededReconstructible,
    "mixed-contracts-reviewed": mixedContractsReviewed,
  },
}
