// Books for a trade company already on the acceptance stack (TRADE-TIME-01, TRADE-BILL-01). A trade
// company is provisioned without a ledger; turning Books on is the company's own step, done here the
// way greenfieldOrg does it for a builder: the settings row and construction chart a Books workspace
// starts from, the fiscal periods, then the greenfield launch that makes Arc the official ledger.
const { app, project } = require("./shared.cjs")

function monthBounds(period) {
  const [year, month] = period.split("-").map(Number)
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { year, month, periodStart: `${period}-01`, periodEnd: `${period}-${String(last).padStart(2, "0")}` }
}

/** Books on for `w.orgId`, with one fiscal period per month in `periods`; the first month's first day is the launch. */
async function enableBooks(kit, w, periods) {
  const { q } = kit
  const owner = w.actors.owner
  const { CONSTRUCTION_CHART_TEMPLATE } = app("books/chart-of-accounts")
  const { createAccountingPeriod } = app("books/period-close")
  const { launchGreenfieldBooks, GREENFIELD_ATTESTATION } = app("books/greenfield")
  const statements = ["begin;",
    `insert into public.books_settings(org_id,workspace_enabled,ledger_authority,arc_ledger_mode,external_sync_posture,functional_currency,reporting_basis,active_policy_version,created_by,updated_by) values(${q(w.orgId)},true,'external','shadow','normal','usd','accrual',1,${q(owner.userId)},${q(owner.userId)});`]
  for (const a of CONSTRUCTION_CHART_TEMPLATE)
    statements.push(`insert into public.gl_accounts(org_id,code,name,account_type,subtype,normal_balance,cash_flow_category,is_system,active,created_by,updated_by) values(${q(w.orgId)},${q(a.code)},${q(a.name)},${q(a.accountType)},${q(a.subtype)},${q(a.normalBalance)},${q(a.cashFlowCategory ?? null)},${a.system},true,${q(owner.userId)},${q(owner.userId)});`)
  statements.push("commit;")
  kit.sql(statements.join("\n"))
  const ids = {}
  for (const period of periods) {
    const bounds = monthBounds(period)
    ids[period] = await kit.as(owner, () => createAccountingPeriod({ periodStart: bounds.periodStart, periodEnd: bounds.periodEnd, fiscalYear: bounds.year, fiscalPeriod: bounds.month }))
  }
  await kit.as(owner, () => launchGreenfieldBooks({ launchedOn: monthBounds(periods[0]).periodStart, openingPosition: "zero", attestation: GREENFIELD_ATTESTATION }))
  return { periodIds: ids }
}

/** The real projector over the company's facts, as the scenarios' other Books steps run it. */
const projectBooks = (kit, w) => project(kit, { orgId: w.orgId })

module.exports = { enableBooks, projectBooks }
