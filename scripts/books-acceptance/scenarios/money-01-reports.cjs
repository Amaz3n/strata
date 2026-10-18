// MONEY-01 reports (EP10-03, EP10-04, EP10-05) — the production money reports, read through Arc's own
// services by the member who owns them. One builder (two divisions, a home in each stage) is made with
// SQL because the subcases are about what the reports add up to, not how a home gets sold or started;
// the land tranche goes through the land services. Every subcase reads as a real member (`kit.as`), so
// division scope and permissions are the real ones. Expected values are hand-derived in
// expected/MONEY-01.json.
//
//   forecast-includes-starts-closings-takedowns        planned starts, closings and a land takedown land in their months
//   forecast-respects-division-scope-and-reconciles    a division reader sees only their homes; totals equal the source tables
//   forecast-scenario-shifts-closings                  closings +4 weeks and starts at 50% move only those, by whole months
//   house-margin-original-vs-revised                   a home's locked margin beside its revised budget, actuals and variance
//   margin-rollup-uses-locked-baseline                 a budget change after the baseline moves the revised margin, never the original
//   margin-rollup-counts-every-home                    1,100 homes and 2,200 cost rows: every home and cost counts, exactly
const { randomUUID } = require("node:crypto")
const { app } = require("./shared.cjs")

const subcases = {}
const WORLDS = new WeakMap()

const dollars = (cents) => Math.round(cents / 100)
const q = (kit, value) => kit.q(value)

function seedOrg(kit, name) {
  const org = kit.organization({ name, productTier: "production", chart: [] })
  org.reader = kit.addMember(org, "org_project_lead")
  return org
}

/** One home: project, lot, optional plan version, budget, agreement, invoices, bills, commitments, start and closing. */
function homeSql(kit, org, h) {
  const { q: Q } = kit
  const sql = []
  sql.push(`insert into public.projects(id,org_id,name,property_type,division_id,phase,status,end_date,created_by) values(${Q(h.projectId)},${Q(org.orgId)},${Q(h.name)},'production',${Q(h.divisionId)},${Q(h.phase ?? "delivery")},${Q(h.status)},${Q(h.endDate)},${Q(org.owner.userId)});`)
  sql.push(`insert into public.lots(id,org_id,community_id,lot_number,status,project_id,house_plan_id,house_plan_version_id,delivered_at) values(${Q(h.lotId)},${Q(org.orgId)},${Q(h.communityId)},${Q(h.lotNumber)},'assigned',${Q(h.projectId)},${Q(h.planId)},${Q(h.versionId)},now());`)
  if (h.budgetCents != null) sql.push(`insert into public.budgets(id,org_id,project_id,version,status,total_cents) values(${Q(randomUUID())},${Q(org.orgId)},${Q(h.projectId)},1,'approved',${h.budgetCents});`)
  if (h.agreementCents != null) sql.push(`insert into public.contracts(id,org_id,project_id,title,status,total_cents,contract_type) values(${Q(h.contractId)},${Q(org.orgId)},${Q(h.projectId)},'Purchase agreement','active',${h.agreementCents},'purchase_agreement');`)
  for (const inv of h.invoices ?? []) sql.push(`insert into public.invoices(id,org_id,project_id,status,due_date,total_cents,balance_due_cents,invoice_number,metadata) values(${Q(randomUUID())},${Q(org.orgId)},${Q(h.projectId)},${Q(inv.status)},${Q(inv.dueDate)},${inv.cents},${inv.balanceCents},${Q(`${h.lotNumber}-${inv.number}`)},${Q(JSON.stringify(inv.metadata ?? {}))}::jsonb);`)
  for (const bill of h.bills ?? []) sql.push(`insert into public.vendor_bills(id,org_id,project_id,company_id,status,due_date,total_cents,paid_cents,retainage_cents) values(${Q(randomUUID())},${Q(org.orgId)},${Q(h.projectId)},${Q(org.vendorId)},'approved',${Q(bill.dueDate)},${bill.cents},0,0);`)
  for (const c of h.commitments ?? []) sql.push(`insert into public.commitments(id,org_id,project_id,title,status,total_cents,commitment_type) values(${Q(c.id)},${Q(org.orgId)},${Q(h.projectId)},${Q(c.title)},${Q(c.status)},${c.cents},${Q(c.type ?? "subcontract")});`)
  if (h.start) sql.push(`insert into public.start_packages(id,org_id,lot_id,community_id,project_id,status,scheduled_start_date,target_week) values(${Q(randomUUID())},${Q(org.orgId)},${Q(h.lotId)},${Q(h.communityId)},${Q(h.projectId)},${Q(h.start.status)},${Q(h.start.date ?? null)},${Q(h.start.targetWeek ?? null)});`)
  if (h.closing) sql.push(`insert into public.closings(id,org_id,project_id,lot_id,community_id,status,scheduled_date) values(${Q(randomUUID())},${Q(org.orgId)},${Q(h.projectId)},${Q(h.lotId)},${Q(h.communityId)},${Q(h.closing.status)},${Q(h.closing.date)});`)
  if (h.baseline) sql.push(`insert into public.home_margin_baselines(id,org_id,project_id,stage,sale_price_cents,cost_cents,margin_cents,margin_bps,captured_at) values(${Q(randomUUID())},${Q(org.orgId)},${Q(h.projectId)},'release',${h.baseline.sale},${h.baseline.cost},${h.baseline.sale - h.baseline.cost},${Math.round(((h.baseline.sale - h.baseline.cost) / h.baseline.sale) * 10000)},'2099-01-05T00:00:00Z');`)
  return sql.join("\n")
}

async function build(kit) {
  const org = seedOrg(kit, "MONEY-01 reports")
  const { q: Q } = kit
  const [gulf, atlantic, cypress, harbor, plan, v1, v2] = Array.from({ length: 7 }, () => randomUUID())
  Object.assign(org, { gulf, atlantic, cypress, harbor, plan, v1, v2, vendorId: randomUUID() })
  kit.sql(`begin;
insert into public.divisions(id,org_id,name) values(${Q(gulf)},${Q(org.orgId)},'Gulf Coast'),(${Q(atlantic)},${Q(org.orgId)},'Atlantic');
insert into public.communities(id,org_id,name,division_id) values(${Q(cypress)},${Q(org.orgId)},'Cypress Landing',${Q(gulf)}),(${Q(harbor)},${Q(org.orgId)},'Harbor Walk',${Q(atlantic)});
insert into public.house_plans(id,org_id,code,name) values(${Q(plan)},${Q(org.orgId)},'MNG','Mangrove');
insert into public.house_plan_versions(id,org_id,house_plan_id,version_number,status,released_at,released_by,bundle_snapshot) values(${Q(v1)},${Q(org.orgId)},${Q(plan)},1,'superseded',now(),${Q(org.owner.userId)},'{}'::jsonb),(${Q(v2)},${Q(org.orgId)},${Q(plan)},2,'released',now(),${Q(org.owner.userId)},'{}'::jsonb);
insert into public.companies(id,org_id,name) values(${Q(org.vendorId)},${Q(org.orgId)},'Framing subcontractor');
update public.memberships set division_scope='assigned' where org_id=${Q(org.orgId)} and user_id=${Q(org.reader.userId)};
insert into public.membership_divisions(membership_id,division_id) select id,${Q(gulf)} from public.memberships where org_id=${Q(org.orgId)} and user_id=${Q(org.reader.userId)};
commit;`)

  // Cypress Landing's land: ten lots at $72,000 taken down in March 2099, $50,000 of earnest money credited against it.
  const communities = app("communities"), landContracts = app("land-contracts")
  const contract = await kit.as(org.owner, () => landContracts.createLandContract(cypress, { title: "Cypress Landing purchase", kind: "purchase", totalLots: 10, basePricePerLotCents: 7200000 }))
  const takedown = await kit.as(org.owner, () => communities.createLotTakedown(cypress, { name: "Tranche 1", scheduledDate: "2099-03-15", lotCount: 10, pricePerLotCents: 7200000, landContractId: contract.id }))
  await kit.as(org.owner, () => landContracts.scheduleLandContractDeposit(contract.id, { label: "Earnest money", takedownId: takedown.id, dueOn: "2099-01-15", amountCents: 5000000, refundability: "refundable" }))

  const ids = () => ({ projectId: randomUUID(), lotId: randomUUID(), contractId: randomUUID() })
  const po = randomUUID(), reason = randomUUID()
  // H1 builds on plan v1 in Gulf Coast: $300,000 approved budget, a $450,000 agreement, $220,000 already billed (a $20,000 deposit, a $100,000 progress invoice and a $100,000 closing invoice left issued by a failed settlement),
  // a release baseline of $450,000 at $280,000, a $12,000 approved variance order and $100,000 of posted job cost.
  org.h1 = { ...ids(), name: "Cypress Lot 1", lotNumber: "1", divisionId: gulf, communityId: cypress, planId: plan, versionId: v1, status: "active", endDate: "2099-04-30",
    budgetCents: 30000000, agreementCents: 45000000,
    invoices: [{ number: "D", status: "paid", dueDate: "2099-01-10", cents: 2000000, balanceCents: 0 }, { number: "P", status: "sent", dueDate: "2099-02-10", cents: 10000000, balanceCents: 10000000 },
      // A closing invoice a failed settlement left issued: a receivable already, so closing proceeds must not count it again.
      { number: "C", status: "sent", dueDate: "2099-05-20", cents: 10000000, balanceCents: 10000000, metadata: { invoice_kind: "closing" } }],
    bills: [{ dueDate: "2099-02-20", cents: 4000000 }],
    commitments: [{ id: po, title: "Framing PO", status: "approved", cents: 15000000, type: "purchase_order" }],
    start: { status: "released", date: "2099-01-04" }, closing: { status: "scheduled", date: "2099-05-14" },
    baseline: { sale: 45000000, cost: 28000000 } }
  // H2 is a planned start (March) on plan v1 in Gulf Coast, still in pre-construction (its PO and deposit must still count), with $50,000 already committed to a trade.
  org.h2 = { ...ids(), name: "Cypress Lot 2", lotNumber: "2", divisionId: gulf, communityId: cypress, planId: plan, versionId: v1, status: "planning", phase: "precon", endDate: "2099-06-30",
    budgetCents: 25000000, agreementCents: 40000000,
    invoices: [{ number: "D", status: "paid", dueDate: "2099-01-12", cents: 1000000, balanceCents: 0 }],
    commitments: [{ id: randomUUID(), title: "Site work", status: "executed", cents: 5000000 }],
    start: { status: "open", date: "2099-03-02" }, closing: { status: "scheduled", date: "2099-07-09" },
    baseline: { sale: 40000000, cost: 24000000 } }
  // H3 is a planned start (April, by target week) on plan v2 in Atlantic, outside the division reader's scope.
  org.h3 = { ...ids(), name: "Harbor Lot 1", lotNumber: "1", divisionId: atlantic, communityId: harbor, planId: plan, versionId: v2, status: "planning", endDate: "2099-09-30",
    budgetCents: 28000000, agreementCents: 50000000,
    start: { status: "open", targetWeek: "2099-04-06" }, closing: { status: "scheduled", date: "2099-08-14" } }
  kit.sql(["begin;", homeSql(kit, org, org.h1), homeSql(kit, org, org.h2), homeSql(kit, org, org.h3),
    // The reader works on all three homes (row security shows invoices and bills only to a home's members), yet only
    // Gulf Coast is in their division: the division wall, not membership, keeps Harbor Walk out.
    `insert into public.project_members(org_id,project_id,user_id,role_id) select ${Q(org.orgId)},p.id,${Q(org.reader.userId)},r.id from public.projects p, public.roles r where p.id in (${[org.h1, org.h2, org.h3].map((h) => Q(h.projectId)).join(",")}) and r.key='org_project_lead';`,
    `insert into public.variance_reason_codes(id,org_id,code,label,sort_order) values(${Q(reason)},${Q(org.orgId)},'missed_scope','Missed scope',1);`,
    `insert into public.commitment_change_orders(id,org_id,project_id,commitment_id,title,status,total_cents,reason_code_id,origin) values(${Q(randomUUID())},${Q(org.orgId)},${Q(org.h1.projectId)},${Q(po)},'Added framing scope','approved',1200000,${Q(reason)},'office');`,
    `insert into public.job_cost_entries(id,org_id,project_id,source_type,source_id,incurred_on,cost_cents,status) values
  (${Q(randomUUID())},${Q(org.orgId)},${Q(org.h1.projectId)},'project_expense','m-1','2099-01-20',6000000,'posted'),
  (${Q(randomUUID())},${Q(org.orgId)},${Q(org.h1.projectId)},'project_expense','m-2','2099-01-25',4000000,'posted');`, "commit;"].join("\n"))
  return org
}

const world = (kit) => {
  if (!WORLDS.has(kit)) WORLDS.set(kit, build(kit))
  return WORLDS.get(kit)
}

const monthNets = (report) => Object.fromEntries(report.rows.map((row) => [row.month, dollars(row.net_cents)]))
const columnByMonth = (report, key) => Object.fromEntries(report.rows.filter((row) => row[key]).map((row) => [row.month, dollars(row[key])]))
const forecast = (kit, actor, input = {}) => kit.as(actor, () => app("reports/cash-flow-forecast").getCashFlowForecast(input))
const shape = (report) => ({
  net: monthNets(report),
  starts: columnByMonth(report, "starts_cost_cents"),
  closings: columnByMonth(report, "closing_proceeds_cents"),
  land: columnByMonth(report, "land_obligations_cents"),
  totalNet: dollars(report.totals.net_cents),
})

subcases["forecast-includes-starts-closings-takedowns"] = async (kit, spec, check) => {
  const org = await world(kit)
  const report = await forecast(kit, org.owner)
  check.equal("planned starts, closings, land and net by month, in whole dollars", spec.expected, {
    ...shape(report),
    receivables: columnByMonth(report, "inflow_cents"),
    bills: columnByMonth(report, "outflow_cents"),
    committedUnbilled: columnByMonth(report, "committed_unbilled_cents"),
    financingNote: "not part of the forecast",
  })
  return { orgId: org.orgId }
}

subcases["forecast-respects-division-scope-and-reconciles"] = async (kit, spec, check) => {
  const org = await world(kit)
  const report = await forecast(kit, org.reader)
  // The source tables, summed in SQL for the division the reader may open.
  const sources = kit.rows(`
    select
      (select coalesce(sum(greatest(0, b.total_cents - coalesce((select sum(c.total_cents) from public.commitments c where c.project_id=s.project_id and c.status in ('approved','executed')),0))),0)::bigint
         from public.start_packages s join lateral (select total_cents from public.budgets b where b.project_id=s.project_id order by version desc limit 1) b on true
         join public.projects p on p.id=s.project_id
        where s.org_id=${q(kit, org.orgId)} and s.status in ('open','ready','releasing','attention') and p.division_id=${q(kit, org.gulf)}) starts,
      (select coalesce(sum(greatest(0, k.total_cents - coalesce((select sum(i.total_cents) from public.invoices i where i.project_id=k.project_id and i.status in ('sent','partial','paid','overdue')),0))),0)::bigint
         from public.closings cl join public.contracts k on k.project_id=cl.project_id and k.status='active'
         join public.projects p on p.id=cl.project_id
        where cl.org_id=${q(kit, org.orgId)} and cl.status in ('projected','scheduled','cleared_to_close') and p.division_id=${q(kit, org.gulf)}) closings`)[0]
  check.equal("a Gulf Coast reader's forecast, and its starts and closings against the source tables", spec.expected, {
    ...shape(report),
    drivers: { starts: report.drivers.starts.count, closings: report.drivers.closings.count },
    reconciles: {
      startsMatchSource: dollars(report.totals.starts_cost_cents) === dollars(Number(sources.starts)),
      closingsMatchSource: dollars(report.totals.closing_proceeds_cents) === dollars(Number(sources.closings)),
    },
  })
  return { orgId: org.orgId }
}

subcases["forecast-scenario-shifts-closings"] = async (kit, spec, check) => {
  const org = await world(kit)
  const base = await forecast(kit, org.owner)
  const slipped = await forecast(kit, org.owner, { scenario: { closingShiftWeeks: 4, startPacePercent: 50 } })
  check.equal("closings four weeks later and starts at half pace, against the base plan", spec.expected, {
    ...shape(slipped),
    unchanged: {
      receivables: dollars(slipped.totals.inflow_cents) === dollars(base.totals.inflow_cents),
      closingProceeds: dollars(slipped.totals.closing_proceeds_cents) === dollars(base.totals.closing_proceeds_cents),
      land: dollars(slipped.totals.land_obligations_cents) === dollars(base.totals.land_obligations_cents),
    },
    startsAtHalfPace: dollars(slipped.totals.starts_cost_cents) * 2 === dollars(base.totals.starts_cost_cents),
  })
  return { orgId: org.orgId }
}

const overview = (kit, actor, projectId) => kit.as(actor, () => app("production-house-overview").getProductionHouseOverview(projectId))

subcases["house-margin-original-vs-revised"] = async (kit, spec, check) => {
  const org = await world(kit)
  const money = (await overview(kit, org.owner, org.h1.projectId)).money
  check.equal("original (locked at release) beside revised (approved budget + variance, or posted cost if higher), in dollars", spec.expected, {
    originalSale: dollars(money.originalSalePriceCents),
    originalCost: dollars(money.originalCostCents),
    originalMargin: dollars(money.originalMarginCents),
    revisedSale: dollars(money.revisedSalePriceCents),
    revisedCost: dollars(money.revisedCostCents),
    revisedMargin: dollars(money.projectedMarginCents),
    approvedVariance: dollars(money.vpoCents),
    budget: dollars(money.budgetCents),
    actual: dollars(money.actualCostCents),
  })
  return { orgId: org.orgId, projectId: org.h1.projectId }
}

const portfolio = (kit, actor, filters = {}) => kit.as(actor, () => app("production-reporting").getProductionPortfolioReport(filters))
const rollupShape = (row) => ({
  homes: row.homes,
  margin: dollars(row.marginCents),
  originalMargin: row.baselinedHomes ? dollars(row.originalMarginCents) : null,
  drift: row.baselinedHomes ? dollars(row.driftCents) : null,
  noBaseline: row.unbaselinedHomes,
})

subcases["margin-rollup-uses-locked-baseline"] = async (kit, spec, check) => {
  const org = await world(kit)
  const { q: Q } = kit
  const read = async () => {
    const report = await portfolio(kit, org.owner)
    return {
      portfolio: rollupShape(report.rollup),
      divisions: Object.fromEntries(report.divisions.map((row) => [row.divisionName, rollupShape(row)])),
      planVersions: Object.fromEntries(report.planVersions.map((row) => [`v${row.versionNumber}`, rollupShape(row)])),
      communities: Object.fromEntries(report.communities.map((row) => [row.communityName, { homes: row.lotCount, margin: dollars(row.projectedMarginCents), originalMargin: row.originalMarginCents === null ? null : dollars(row.originalMarginCents), drift: row.originalMarginHomes ? dollars(row.driftCents) : null }])),
      cohort: report.cohort.kind,
    }
  }
  const before = await read()
  // H2's approved budget is raised by $40,000 after its baseline was locked.
  kit.sql(`update public.budgets set total_cents = total_cents + 4000000 where org_id=${Q(org.orgId)} and project_id=${Q(org.h2.projectId)}`)
  const after = await read()
  kit.sql(`update public.budgets set total_cents = total_cents - 4000000 where org_id=${Q(org.orgId)} and project_id=${Q(org.h2.projectId)}`)
  check.equal("division, plan-version and community rollups before and after a budget changes post-baseline", spec.expected, {
    before,
    after,
    originalMoved: before.portfolio.originalMargin !== after.portfolio.originalMargin,
    revisedMoved: after.portfolio.margin - before.portfolio.margin,
  })
  return { orgId: org.orgId }
}

subcases["margin-rollup-counts-every-home"] = async (kit, spec, check) => {
  const org = seedOrg(kit, "MONEY-01 every home")
  const { q: Q } = kit
  const [division, community, plan, version] = Array.from({ length: 4 }, () => randomUUID())
  const homes = 1100
  // 1,100 homes, each: a $130,000 agreement, a $100,000 approved budget, two posted costs ($30,000 + $20,000),
  // and a release baseline of $130,000 sale at $95,000 cost. Every one is past a 1,000-row API page.
  kit.sql(`begin;
insert into public.divisions(id,org_id,name) values(${Q(division)},${Q(org.orgId)},'Gulf Coast');
insert into public.communities(id,org_id,name,division_id) values(${Q(community)},${Q(org.orgId)},'Big Sky',${Q(division)});
insert into public.house_plans(id,org_id,code,name) values(${Q(plan)},${Q(org.orgId)},'BIG','Big plan');
insert into public.house_plan_versions(id,org_id,house_plan_id,version_number,status,released_at,released_by,bundle_snapshot) values(${Q(version)},${Q(org.orgId)},${Q(plan)},1,'released',now(),${Q(org.owner.userId)},'{}'::jsonb);
create temp table seed_homes on commit drop as select n, gen_random_uuid() project_id, gen_random_uuid() lot_id from generate_series(1,${homes}) n;
insert into public.projects(id,org_id,name,property_type,division_id,phase,status,created_by) select project_id,${Q(org.orgId)},'Big Sky '||n,'production',${Q(division)},'delivery','active',${Q(org.owner.userId)} from seed_homes;
insert into public.lots(id,org_id,community_id,lot_number,status,project_id,house_plan_id,house_plan_version_id,delivered_at) select lot_id,${Q(org.orgId)},${Q(community)},n::text,'assigned',project_id,${Q(plan)},${Q(version)},now() from seed_homes;
insert into public.budgets(org_id,project_id,version,status,total_cents) select ${Q(org.orgId)},project_id,1,'approved',10000000 from seed_homes;
insert into public.contracts(org_id,project_id,title,status,total_cents,contract_type) select ${Q(org.orgId)},project_id,'Purchase agreement','active',13000000,'purchase_agreement' from seed_homes;
insert into public.job_cost_entries(org_id,project_id,source_type,source_id,incurred_on,cost_cents,status) select ${Q(org.orgId)},project_id,'project_expense','a-'||n,'2099-01-10',3000000,'posted' from seed_homes;
insert into public.job_cost_entries(org_id,project_id,source_type,source_id,incurred_on,cost_cents,status) select ${Q(org.orgId)},project_id,'project_expense','b-'||n,'2099-01-11',2000000,'posted' from seed_homes;
insert into public.home_margin_baselines(org_id,project_id,stage,sale_price_cents,cost_cents,margin_cents,margin_bps,captured_at) select ${Q(org.orgId)},project_id,'release',13000000,9500000,3500000,2692,'2099-01-05T00:00:00Z' from seed_homes;
commit;`)
  const report = await portfolio(kit, org.owner)
  const sourceCostRows = Number(kit.rows(`select count(*)::int n from public.job_cost_entries where org_id=${Q(org.orgId)}`)[0].n)
  check.equal("every home and cost row counts: totals in whole dollars against the seeded sources", spec.expected, {
    sourceCostRows,
    homes: report.rollup.homes,
    communityHomes: report.communities[0].lotCount,
    revenue: dollars(report.totals.revenueCents),
    actualCost: dollars(report.totals.actualCostCents),
    revisedCost: dollars(report.rollup.projectedCostCents),
    margin: dollars(report.rollup.marginCents),
    originalMargin: dollars(report.rollup.originalMarginCents),
    drift: dollars(report.rollup.driftCents),
    noBaseline: report.rollup.unbaselinedHomes,
  })
  return { orgId: org.orgId }
}

module.exports = { subcases }
