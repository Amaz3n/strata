// Shared golden-scenario building blocks: a Books-only (greenfield) builder,
// periods and the real projector.
const { randomUUID } = require("node:crypto")

const app = (path) => require(`../../../lib/services/${path}`)

function monthBounds(period) {
  const [year, month] = period.split("-").map(Number)
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { year, month, periodStart: `${period}-01`, periodEnd: `${period}-${String(last).padStart(2, "0")}` }
}

// A Books-only builder: chart, accounting periods, then a greenfield launch with a
// zero opening so Arc is the official ledger (ledger_authority 'arc').
async function greenfieldOrg(kit, { name, periods, setup }) {
  const { CONSTRUCTION_CHART_TEMPLATE } = app("books/chart-of-accounts")
  const { createAccountingPeriod } = app("books/period-close")
  const { launchGreenfieldBooks, GREENFIELD_ATTESTATION } = app("books/greenfield")
  const org = { ...kit.organization({ name, chart: CONSTRUCTION_CHART_TEMPLATE, reviewerRole: "org_accountant" }), periods: {} }
  if (setup) setup(org)
  for (const period of periods) {
    const bounds = monthBounds(period)
    org.periods[period] = { ...bounds, periodId: await kit.as(org.owner, () => createAccountingPeriod({ periodStart: bounds.periodStart, periodEnd: bounds.periodEnd, fiscalYear: bounds.year, fiscalPeriod: bounds.month })) }
  }
  await kit.as(org.owner, () => launchGreenfieldBooks({ launchedOn: org.periods[periods[0]].periodStart, openingPosition: "zero", attestation: GREENFIELD_ATTESTATION }))
  return org
}

// One fixed-price contract job on a greenfield builder.
async function contractJob(kit, { name, contractCents, retainagePercent, periods }) {
  const { q } = kit
  const ids = { projectId: randomUUID(), vendorId: randomUUID(), costCodeId: randomUUID(), contractId: randomUUID() }
  return greenfieldOrg(kit, { name, periods, setup: (org) => {
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
