// CONSOL-01 — consolidated books (B14.4): the group's trial balance is the sum of
// its companies' less an elimination bridge holding only what they owe each other
// and their internal sale and its unearned profit. Consolidating never posts or
// changes a company's own books; a closed month's group statements stay as closed
// and survive a restore. Every active company is in the group from its start
// (group membership changing over time is a documented deviation).
const { app } = require("./shared.cjs")

const silent = { equal: () => true, checks: [] }

/** Company trial balances summed, minus the consolidated one: the elimination bridge. */
async function bridge(kit, org, companies, asOf) {
  const { trialBalance } = require("./entity-01.cjs").helpers
  const sum = {}
  for (const entityId of companies) for (const [code, cents] of Object.entries((await trialBalance(kit, org, entityId, asOf)).accounts)) sum[code] = (sum[code] ?? 0) + cents
  const group = (await trialBalance(kit, org, null, asOf)).accounts
  const codes = [...new Set([...Object.keys(sum), ...Object.keys(group)])].sort()
  return Object.fromEntries(codes.map((code) => [code, (sum[code] ?? 0) - (group[code] ?? 0)]).filter(([, cents]) => cents !== 0))
}

const lineCount = (kit, orgId) => Number(kit.rows(`select count(*) n from public.journal_lines where org_id=${kit.q(orgId)}`)[0].n)
const companyBalances = (kit, orgId) => kit.rows(`select l.legal_entity_id::text e, a.code, sum(l.debit_cents-l.credit_cents)::bigint n from public.journal_lines l join public.gl_accounts a on a.id=l.account_id
  where l.org_id=${kit.q(orgId)} group by 1,2 having sum(l.debit_cents-l.credit_cents)<>0 order by 1,2`).map((row) => `${row.e}:${row.code}:${row.n}`).join("|")

// What the builder and its land company owe each other is the whole bridge; the
// July group statements read as closed, unchanged by August and by a restore.
async function reciprocalBalances(kit, expected, check) {
  const interco = require("./interco-01.cjs")
  const built = await interco.subcases["company-business"](kit, require("../expected/INTERCO-01.json").subcases["company-business"], silent)
  const org = interco.helpers.describe(kit, built.orgId)
  const linesBefore = lineCount(kit, org.orgId), booksBefore = companyBalances(kit, org.orgId)
  const august = await bridge(kit, org, [org.builder, org.land], "2026-08-31")
  const july = kit.rows(`select s.id from public.accounting_periods s where s.org_id=${kit.q(org.orgId)} and s.period_start='2026-07-01'`)[0].id
  const groupJuly = () => kit.rows(`select statement_type, content_hash from public.financial_statement_snapshots where period_id=${kit.q(july)} and legal_entity_id is null order by 1, 2`).map((row) => `${row.statement_type}:${row.content_hash}`).join("|")
  const julyRead = async () => { const read = await kit.as(org.owner, () => app("books/statement-detail").getStatementsForPeriod({ startDate: "2026-07-01", endDate: "2026-07-31", comparison: "none", legalEntityId: null }))
    return { closed: Boolean(read.closedPeriod), netIncome: read.profitLoss.netIncomeCents } }
  const before = { snapshots: groupJuly(), read: await julyRead(), august }
  const consolidationPostsNothing = lineCount(kit, org.orgId) === linesBefore && companyBalances(kit, org.orgId) === booksBefore
  require("./restore-01.cjs").helpers.restore(kit, org.orgId)
  const after = { snapshots: groupJuly(), read: await julyRead(), august: await bridge(kit, org, [org.builder, org.land], "2026-08-31") }
  check.equal("the bridge is only what the companies owe each other; consolidating posts nothing; July's group statements are kept as closed and survive a restore", expected.expected, {
    august, consolidationPostsNothing, julyGroup: before.read, groupSnapshotsSaved: before.snapshots.length > 0,
    restoredIdentical: JSON.stringify(after) === JSON.stringify(before),
  })
  return { orgId: org.orgId }
}

// A lot sold by the land company to the builder's home: before the home sells
// outside, the bridge removes the internal sale, its cost and the profit still in
// the home; after, only the internal sale and cost, so the group earns what the
// two companies earned together.
async function internalProfit(kit, expected, check) {
  const built = await require("./entity-01.cjs").subcases["intercompany-lot-sale"](kit, require("../expected/ENTITY-01.json").subcases["intercompany-lot-sale"], silent)
  const orgId = built.orgId
  const companies = kit.rows(`select id from public.books_legal_entities where org_id=${kit.q(orgId)} order by is_primary desc`).map((row) => row.id)
  const org = { orgId }
  const statements = app("books/statements")
  const profit = async (entityId) => (await kit.service(async () => statements.buildProfitAndLoss(orgId, "2026-06-01", "2026-08-31", await statements.ledgerForCompany(orgId, await statements.loadPostedLedger(orgId, "2026-08-31"), entityId)))).netIncomeCents
  const [builder, land, group] = [await profit(companies[0]), await profit(companies[1]), await profit(null)]
  check.equal("the bridge removes the internal sale, its cost and the unearned profit, which is earned once the home sells", expected.expected, {
    beforeOutsideSale: await bridge(kit, org, companies, "2026-07-31"),
    afterOutsideSale: await bridge(kit, org, companies, "2026-08-31"),
    groupProfitIsCompaniesProfit: group === builder + land,
  })
  return { orgId }
}

module.exports = {
  id: "CONSOL-01",
  subcases: {
    "reciprocal-balances": reciprocalBalances,
    "internal-profit": internalProfit,
  },
}
