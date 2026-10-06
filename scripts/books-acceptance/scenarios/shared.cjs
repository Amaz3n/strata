// Shared golden-scenario building blocks: a Books-only (greenfield) builder,
// periods and the real projector.
const { randomUUID } = require("node:crypto")

const app = (path) => require(`../../../lib/services/${path}`)

function monthBounds(period) {
  const [year, month] = period.split("-").map(Number)
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { year, month, periodStart: `${period}-01`, periodEnd: `${period}-${String(last).padStart(2, "0")}` }
}

// Fiscal years are named for the calendar year in which they start.
function fiscalLabel(bounds, startMonth) {
  return bounds.month >= startMonth
    ? { fiscalYear: bounds.year, fiscalPeriod: bounds.month - startMonth + 1 }
    : { fiscalYear: bounds.year - 1, fiscalPeriod: bounds.month + 13 - startMonth }
}

// The opening position a builder brings: an owner- and accountant-approved
// opening batch dated the day before launch.
async function postOpening(kit, org, cutoverDate, lines) {
  const { createOpeningBalanceBatch, approveOpeningBalanceBatch, postOpeningBalanceBatch } = app("books/opening-balances")
  const batch = await kit.as(org.owner, () => createOpeningBalanceBatch({ cutoverDate, sourceFilename: "opening-trial-balance.csv", sourceContent: JSON.stringify(lines), lines }))
  await kit.as(org.owner, () => approveOpeningBalanceBatch({ batchId: batch.batchId, approvalRole: "owner" }))
  await kit.as(org.reviewer, () => approveOpeningBalanceBatch({ batchId: batch.batchId, approvalRole: "accountant" }))
  await kit.as(org.owner, () => postOpeningBalanceBatch(batch.batchId))
}

// A Books-only builder: chart (plus any custom accounts), fiscal calendar,
// accounting periods, an optional opening position, then a greenfield launch so
// Arc is the official ledger (ledger_authority 'arc').
async function greenfieldOrg(kit, { name, periods, setup, fiscalYearStartMonth = 1, accounts = [], beforeOpening, opening }) {
  const { CONSTRUCTION_CHART_TEMPLATE } = app("books/chart-of-accounts")
  const { createAccountingPeriod } = app("books/period-close")
  const { launchGreenfieldBooks, GREENFIELD_ATTESTATION } = app("books/greenfield")
  const org = { ...kit.organization({ name, chart: CONSTRUCTION_CHART_TEMPLATE, reviewerRole: "org_accountant" }), periods: {} }
  if (setup) setup(org)
  if (fiscalYearStartMonth !== 1) await kit.as(org.owner, () => app("books/module").updateBooksFiscalSettings({ fiscalYearStartMonth }))
  for (const period of periods) {
    const bounds = monthBounds(period)
    const label = fiscalLabel(bounds, fiscalYearStartMonth)
    org.periods[period] = { ...bounds, ...label, periodId: await kit.as(org.owner, () => createAccountingPeriod({ periodStart: bounds.periodStart, periodEnd: bounds.periodEnd, ...label })) }
  }
  const { createGlAccount } = app("books/chart-management")
  for (const account of accounts) await kit.as(org.owner, () => createGlAccount(account))
  if (beforeOpening) await beforeOpening(org)
  const launchedOn = org.periods[periods[0]].periodStart
  if (opening) {
    const cutover = new Date(`${launchedOn}T00:00:00Z`)
    cutover.setUTCDate(cutover.getUTCDate() - 1)
    await postOpening(kit, org, cutover.toISOString().slice(0, 10), typeof opening === "function" ? opening(org) : opening)
  }
  await kit.as(org.owner, () => launchGreenfieldBooks({ launchedOn, openingPosition: opening ? "posted_opening_balances" : "zero", attestation: GREENFIELD_ATTESTATION }))
  return org
}

// One fixed-price contract job on a greenfield builder.
async function contractJob(kit, { name, contractCents, retainagePercent, periods, ...options }) {
  const { q } = kit
  const ids = { projectId: randomUUID(), vendorId: randomUUID(), costCodeId: randomUUID(), contractId: randomUUID() }
  return greenfieldOrg(kit, { ...options, name, periods, setup: (org) => {
    Object.assign(org, ids)
    kit.sql(`begin;
insert into public.projects(id,org_id,name,property_type,created_by) values(${q(org.projectId)},${q(org.orgId)},${q(`${name} — custom home`)},'residential',${q(org.owner.userId)});
insert into public.project_financial_settings(org_id,project_id) values(${q(org.orgId)},${q(org.projectId)}) on conflict do nothing;
insert into public.companies(id,org_id,name) values(${q(org.vendorId)},${q(org.orgId)},'Framing subcontractor');
insert into public.cost_codes(id,org_id,code,name) values(${q(org.costCodeId)},${q(org.orgId)},'06-100','Rough carpentry');
insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,retainage_percent,effective_date)
  values(${q(org.contractId)},${q(org.orgId)},${q(org.projectId)},'Fixed-price construction contract','active',${contractCents},'usd','fixed',${retainagePercent},'2026-07-01');
commit;`)
  } })
}



async function project(kit, org) {
  const { projectJournal } = app("books/projector")
  return kit.service(() => projectJournal(org.orgId, { full: true }))
}

module.exports = { app, monthBounds, greenfieldOrg, contractJob, project }
