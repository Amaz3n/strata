// LOT-01 workflow proof: purchasing (EP08-01, EP08-02, EP08-04, EP08-06, EP08-12).
// The buyer (org_purchasing_manager) creates community/plan bid packages, awards them into the price book,
// previews and commits purchase orders, resolves price exceptions and reads the variance report; the
// owner stands in only where the product gives a step to project.manage alone (invites, manual bids).
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")

const lot = () => require("./lot-01.cjs").helpers
const dueIn = (days) => new Date(Date.now() + days * 86400000).toISOString()
const pad = (n, width = 2) => String(n).padStart(width, "0")
// A refusal reduced to a stable phrase so expectations never carry stack or JSON noise.
const reason = (message) => {
  const patterns = [
    [/Missing permission/, "refused: missing permission"], [/outside your division access/, "refused: outside division access"],
    [/Choose one project, prospect, or community\/plan context/, "refused: one context only"], [/Community not found/, "refused: community not found"],
    [/House plan not found/, "refused: house plan not found"], [/Review the subcontract terms|reviewed_terms/, "refused: terms not reviewed"],
    [/Resolve pre-award warnings/, "refused: pre-award warnings"], [/already been awarded/, "refused: already awarded"],
    [/Production bid package not found/, "refused: not a production package"],
  ]
  for (const [pattern, text] of patterns) if (pattern.test(message)) return text
  return message
}
const same = (check, label, expected, observed) => lot().equal(check, label, expected, observed)
const attempt = async (work) => { try { await work(); return "allowed" } catch (error) { return reason(error.message) } }

// ---------------------------------------------------------------------------
// Fixture: a second division and community (so scope can be refused), and buyers limited to one division.

const FIXTURES = new WeakMap()
function fixture(kit) {
  if (!FIXTURES.has(kit)) FIXTURES.set(kit, lot().stage(kit, "land").then(({ org }) => decorate(kit, org)))
  return FIXTURES.get(kit)
}
// Price-agreement changes, awards and exceptions are organisation-wide, so the purchase-order subcases run in an
// organisation of their own and cannot change how the LOT-01 homes were priced or started.
const PO_FIXTURES = new WeakMap()
function purchaseOrderFixture(kit) {
  if (!PO_FIXTURES.has(kit)) PO_FIXTURES.set(kit, (async () => {
    const org = await seed.productionBuilder(kit, { name: "LOT-01 purchasing price book" })
    // The seed's trade companies carry no directory role; a manual price needs a vendor, as a real one is.
    kit.sql(`insert into public.party_roles(org_id,company_id,relationship_type_id,status,source) select ${kit.q(org.orgId)}, c.id, t.id, 'active', 'system' from public.companies c join public.directory_relationship_types t on t.org_id=c.org_id and t.key='subcontractor' where c.org_id=${kit.q(org.orgId)}`)
    await seed.seedCommunity(kit, org)
    await seed.seedProduct(kit, org)
    await seed.takeDownTranche(kit, org)
    return decorate(kit, org)
  })())
  return PO_FIXTURES.get(kit)
}
async function decorate(kit, org) {
  const divisions = app("divisions"), communities = app("communities")
  const divisionB = await kit.as(org.owner, () => divisions.createDivision({ name: "Atlantic", code: "AT", region: "Treasure Coast" }))
  const communityB = await kit.as(org.owner, () => communities.createCommunity({ name: "Harbor Walk", code: "HW", divisionId: divisionB.id, status: "active", city: "Stuart", state: "FL", postalCode: "34994", plannedLotCount: 40, targetAbsorptionPerMonth: 2 }))
  const limited = (divisionId) => {
    const actor = kit.addMember(org, "org_purchasing_manager")
    kit.sql(`update public.memberships set division_scope='assigned' where org_id=${kit.q(org.orgId)} and user_id=${kit.q(actor.userId)};
insert into public.membership_divisions(membership_id, division_id) select id, ${kit.q(divisionId)} from public.memberships where org_id=${kit.q(org.orgId)} and user_id=${kit.q(actor.userId)};`)
    return actor
  }
  return { org, divisionA: org.divisionId, divisionB: divisionB.id, communityA: org.communityId, communityB: communityB.id, buyerA: limited(org.divisionId), buyerB: limited(divisionB.id) }
}

const packageRow = (kit, id) => kit.rows(`select community_id, house_plan_id, project_id, prospect_id, award_target, status, cost_code_id from public.bid_packages where id=${kit.q(id)}`)[0]

// A package scoped to the community/plan, with scope items, an invite and a bid, ready to award.
async function packageWithBid(kit, f, { title, communityId = f.communityA, planId = f.org.plans[0].id, vendor = "Palmetto Framing", items, alternate = false, bidderTotal }) {
  const { org } = f, bids = app("bids"), buyer = org.team.purchasing
  const pkg = await kit.as(buyer, () => bids.createBidPackage({ input: { community_id: communityId, house_plan_id: planId, title, trade: "Framing", due_at: dueIn(14) } }))
  const scope = await kit.as(buyer, () => bids.saveBidScopeItems({ input: { bid_package_id: pkg.id, items } }))
  await kit.as(buyer, () => bids.updateBidPackage({ bidPackageId: pkg.id, input: { status: "open" } }))
  const company = org.vendorIds[vendor]
  await kit.as(org.owner, () => bids.createBidInvite({ input: { bid_package_id: pkg.id, company_id: company, status: "sent" } }))
  const submission = await kit.as(org.owner, () => bids.createManualBidSubmission({ input: { bid_package_id: pkg.id, company_id: company, total_cents: bidderTotal,
    items: scope.map((item, index) => ({ bid_scope_item_id: item.id, description: item.description, response: "priced", amount_cents: items[index].amountCents, quantity: items[index].quantity ?? null })) } }))
  return { pkg, scope, submission, company }
}

// ---------------------------------------------------------------------------
// EP08-01

async function productionBidsReachThePriceBook(kit, expected, check) {
  const f = await fixture(kit), { org } = f, bids = app("bids")
  const buyer = org.team.purchasing, plan = org.plans[0], sales = org.team.sales
  const create = (actor, input) => kit.as(actor, () => bids.createBidPackage({ input }))

  // Scoped package creation: community only, plan only, both. Each is a price-agreement package with no job.
  const made = {}
  for (const [key, scopeInput] of [["community", { community_id: f.communityA }], ["plan", { house_plan_id: plan.id }], ["both", { community_id: f.communityA, house_plan_id: plan.id }]]) {
    const pkg = await create(buyer, { ...scopeInput, title: `Scoped ${key}`, trade: "Framing" })
    const row = packageRow(kit, pkg.id)
    const trail = kit.rows(`select (select count(*)::int from public.events where org_id=${kit.q(org.orgId)} and event_type='bid_package_created' and entity_id=${kit.q(pkg.id)}) events,
      (select count(*)::int from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='bid_package' and entity_id=${kit.q(pkg.id)} and action='insert') audits`)[0]
    made[key] = { onCommunity: row.community_id === f.communityA, onPlan: row.house_plan_id === plan.id, awardTarget: row.award_target, jobless: row.project_id === null && row.prospect_id === null, status: row.status, events: trail.events, audits: trail.audits }
  }
  const refusals = {
    noContext: await attempt(() => create(buyer, { title: "No context" })),
    projectAndCommunity: await attempt(() => create(buyer, { title: "Two parents", project_id: randomUUID(), community_id: f.communityA })),
    unknownCommunity: await attempt(() => create(buyer, { title: "Ghost community", community_id: randomUUID() })),
    unknownPlan: await attempt(() => create(buyer, { title: "Ghost plan", house_plan_id: randomUUID() })),
    salesConsultant: await attempt(() => create(sales, { title: "Sales package", community_id: f.communityA })),
    otherDivisionBuyerInAnotherDivision: await attempt(() => create(f.buyerB, { title: "Cross division", community_id: f.communityA })),
    sameDivisionBuyer: await attempt(() => create(f.buyerA, { title: "Own division", community_id: f.communityA, house_plan_id: plan.id })),
    sharedPlanForOtherDivisionBuyer: await attempt(() => create(f.buyerB, { title: "Shared plan, own community", community_id: f.communityB, house_plan_id: plan.id })),
  }

  // The bid workbench: the buyer reaches the package and its tabs, and the production queue lists it.
  const target = await packageWithBid(kit, f, { title: "Framing — Cypress Landing Mangrove", items: [
    { item_type: "base", description: "Frame the shell", quantity: 1650, unit: "sf", cost_code_id: org.costCodeIds["06-100"], amountCents: 9000000 },
    { item_type: "base", description: "Slab package", cost_code_id: org.costCodeIds["03-300"], amountCents: 4500000 },
    { item_type: "alternate", description: "Add electrical rough", cost_code_id: org.costCodeIds["26-000"], amountCents: 700000 },
  ], bidderTotal: 13500000 })
  const workbench = await kit.as(buyer, async () => {
    const [pkg, scope, invites, submissions, queue] = await Promise.all([bids.getBidPackage(target.pkg.id), bids.listBidScopeItems(target.pkg.id), bids.listBidInvites(target.pkg.id), bids.listBidSubmissions(target.pkg.id), app("production-bid-queue").listProductionBidQueue({ search: "Cypress Landing Mangrove" })])
    return { community: pkg.community_id === f.communityA, plan: pkg.house_plan_id === plan.id, awardTarget: pkg.award_target, scopeItems: scope.length, invites: invites.length, bids: submissions.length, queued: queue.items.map((item) => item.jobName) }
  })

  // The award: reviewed scope and terms are mandatory, readiness warnings need a recorded exception,
  // the wrong role and a buyer outside the division are refused, and nothing is written by a refusal.
  const award = (actor, input) => kit.as(actor, () => bids.awardBidSubmission({ input: { bid_submission_id: target.submission.id, ...input } }))
  const countAgreements = () => kit.rows(`select count(*)::int n from public.vendor_price_agreements where org_id=${kit.q(org.orgId)} and source='bid_award'`)[0].n
  const before = countAgreements()
  await kit.as(org.owner, () => bids.createBidInvite({ input: { bid_package_id: target.pkg.id, company_id: org.vendorIds["Gulf Concrete"], status: "sent" } }))
  const rival = await kit.as(org.owner, () => bids.createManualBidSubmission({ input: { bid_package_id: target.pkg.id, company_id: org.vendorIds["Gulf Concrete"], total_cents: 12000000,
    items: target.scope.map((item, index) => ({ bid_scope_item_id: item.id, description: item.description, response: "priced", amount_cents: [8000000, 4000000, 0][index] })) } }))
  const awardRefusals = {
    noTerms: await attempt(() => award(buyer, { reviewed_scope: "Frame shell + slab" })),
    blankTerms: await attempt(() => award(buyer, { reviewed_scope: "Frame shell + slab", reviewed_terms: "   " })),
    unresolvedWarnings: await attempt(() => award(buyer, { reviewed_scope: "Frame shell + slab", reviewed_terms: "Net 30" })),
    salesConsultant: await attempt(() => award(sales, { reviewed_scope: "Frame shell + slab", reviewed_terms: "Net 30", readiness_exception: "Acceptance vendor." })),
    buyerOutsideDivision: await attempt(() => award(f.buyerB, { reviewed_scope: "Frame shell + slab", reviewed_terms: "Net 30", readiness_exception: "Acceptance vendor." })),
  }
  const writtenByRefusals = countAgreements() - before
  const awarded = await award(buyer, { reviewed_scope: "Frame shell and slab, accepted as bid", reviewed_terms: "Net 30, 5% retainage", readiness_exception: "Acceptance vendor: no compliance documents on file." })
  const today = kit.rows(`select current_date::text d`)[0].d
  const agreements = kit.rows(`select co.code, a.pricing_kind, a.uom, a.unit_cost_cents, a.lump_sum_cents, a.status, a.source, a.effective_from::text effective_from,
      a.community_id = ${kit.q(f.communityA)} in_community, a.house_plan_id = ${kit.q(plan.id)} on_plan, a.source_bid_award_id = ${kit.q(awarded.awardId)} from_award,
      a.notes like '%Reviewed scope: Frame shell and slab, accepted as bid%' scope_reviewed, a.notes like '%Commercial terms: Net 30, 5% retainage%' terms_reviewed
    from public.vendor_price_agreements a join public.cost_codes co on co.id=a.cost_code_id where a.org_id=${kit.q(org.orgId)} and a.source_bid_award_id=${kit.q(awarded.awardId)} order by co.code`)
  const after = kit.rows(`select (select status from public.bid_packages where id=${kit.q(target.pkg.id)}) package_status,
      (select count(*)::int from public.events where org_id=${kit.q(org.orgId)} and event_type='bid_package.awarded_to_price_book' and entity_id=${kit.q(target.pkg.id)}) events,
      (select count(*)::int from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='bid_package' and entity_id=${kit.q(target.pkg.id)} and action='update') audits,
      (select count(*)::int from public.bid_awards where bid_package_id=${kit.q(target.pkg.id)} and rescinded_at is null and awarded_submission_id=${kit.q(target.submission.id)}) awards`)[0]
  // Awarding the same bid again returns the award it already made; a different bid on an awarded package is refused.
  const again = await award(buyer, { reviewed_scope: "again", reviewed_terms: "again", readiness_exception: "again" })
  const reAward = { sameBidReturnsTheSameAward: again.awardId === awarded.awardId, sameBidAddsAgreements: countAgreements() - before - awarded.agreementIds.length, differentBid: await attempt(() => kit.as(buyer, () => bids.awardBidSubmission({ input: { bid_submission_id: rival.id, reviewed_scope: "x", reviewed_terms: "x", readiness_exception: "x" } }))) }

  // A later package for the same vendor and scope replaces the earlier unit price instead of stacking beside it.
  const second = await packageWithBid(kit, f, { title: "Framing — repriced", items: [{ item_type: "base", description: "Frame the shell", quantity: 1650, unit: "sf", cost_code_id: org.costCodeIds["06-100"], amountCents: 9900000 }], bidderTotal: 9900000 })
  const secondAward = await kit.as(buyer, () => bids.awardBidSubmission({ input: { bid_submission_id: second.submission.id, reviewed_scope: "Frame shell", reviewed_terms: "Net 30", readiness_exception: "Acceptance vendor." } }))
  const framing = kit.rows(`select a.status, a.unit_cost_cents, a.effective_to::text effective_to, a.effective_from::text effective_from, a.id = ${kit.q(secondAward.agreementIds[0])} newest,
      coalesce(a.superseded_by_id = ${kit.q(secondAward.agreementIds[0])}, false) replaced_by_newest from public.vendor_price_agreements a join public.cost_codes co on co.id=a.cost_code_id
    where a.org_id=${kit.q(org.orgId)} and co.code='06-100' and a.source='bid_award' and a.community_id=${kit.q(f.communityA)} and a.house_plan_id=${kit.q(plan.id)} order by a.created_at`)
  const vendorRole = kit.rows(`select count(*)::int n from public.party_roles where org_id=${kit.q(org.orgId)} and company_id=${kit.q(target.company)}`)[0].n

  same(check, "the three scoped packages are price-agreement packages with no job, each leaving an event and an audit row", expected.expected.packages, made)
  same(check, "contradictory, unknown, wrong-role and out-of-division package creation is refused", expected.expected.creationRefusals, refusals)
  same(check, "the buyer reaches the bid workbench for the package and its production queue entry", expected.expected.workbench, workbench)
  same(check, "an award without reviewed terms, with unresolved warnings, by the wrong role or outside the division is refused and writes nothing", expected.expected.awardRefusals, { ...awardRefusals, agreementsWritten: writtenByRefusals })
  same(check, "the award writes one reviewed-terms price agreement per priced base scope item and leaves the unaccepted alternate out", expected.expected.agreements, agreements.map((row) => ({ ...row, effective_from: row.effective_from === today ? "today" : row.effective_from })))
  same(check, "the package is awarded once, with its event and audit, and a second award is refused", expected.expected.awarded, { ...after, reAward, agreementIdsReturned: awarded.agreementIds.length, vendorRoleRows: vendorRole > 0 })
  same(check, "a later award for the same vendor and scope supersedes the earlier unit price", expected.expected.superseded, framing.map((row) => ({ status: row.status, unitCostCents: Number(row.unit_cost_cents), endsOnStart: row.effective_to === row.effective_from, newest: row.newest, replacedByNewest: row.replaced_by_newest })))
  return { orgId: org.orgId, packageId: target.pkg.id, awardId: awarded.awardId, secondAwardId: secondAward.awardId }
}


// ---------------------------------------------------------------------------
// EP08-02

const sameIds = (observed, wanted) => JSON.stringify(observed) === JSON.stringify(wanted)

const PICKERS = new WeakMap()
const pickerObservations = (kit) => PICKERS.get(kit) ?? (PICKERS.set(kit, observePickers(kit)), PICKERS.get(kit))

async function observePickers(kit) {
  const out = {}
  const f = await fixture(kit), { org } = f, bids = app("bids"), buyer = org.team.purchasing
  const queue = app("production-bid-queue"), vendors = app("production-bid-vendors")
  // Fifty packages across both communities. The first thirty share one due date, so page order
  // depends on the tie-break, not on luck; every ninth title carries a literal percent sign.
  const due = dueIn(30)
  const dataset = Array.from({ length: 50 }, (_, i) => {
    const communityId = i % 5 === 0 ? f.communityB : i % 4 === 0 ? null : f.communityA
    const planId = communityId === f.communityB ? null : org.plans[i % 2].id
    return { i, communityId, planId, title: `Queue ${pad(i)}${i % 9 === 0 ? " 50% off" : ""}`, due: i < 30 ? due : null, cancelled: [3, 13, 23].includes(i), sent: [4, 5].includes(i) }
  })
  const created = []
  for (let offset = 0; offset < dataset.length; offset += 10)
    created.push(...await Promise.all(dataset.slice(offset, offset + 10).map((row) => kit.as(buyer, () => bids.createBidPackage({ input: {
      title: row.title, trade: "Framing", ...(row.communityId ? { community_id: row.communityId } : {}), ...(row.planId ? { house_plan_id: row.planId } : {}), ...(row.due ? { due_at: row.due } : {}) } })))))
  dataset.forEach((row, index) => { row.id = created[index].id })
  for (const row of dataset.filter((entry) => entry.cancelled || entry.sent))
    await kit.as(buyer, () => bids.updateBidPackage({ bidPackageId: row.id, input: { status: row.cancelled ? "cancelled" : "sent" } }))
  // Queue 01 collects three invitations, two bidders and a revision: two responses count, not three.
  const first = dataset[1]
  await kit.as(buyer, () => bids.updateBidPackage({ bidPackageId: first.id, input: { status: "open" } }))
  const bidders = ["Palmetto Framing", "Gulf Concrete", "Bright Electric"].map((name) => org.vendorIds[name])
  for (const company of bidders) await kit.as(org.owner, () => bids.createBidInvite({ input: { bid_package_id: first.id, company_id: company, status: "sent" } }))
  for (const [company, total] of [[bidders[0], 5000000], [bidders[1], 5200000], [bidders[1], 5100000]])
    await kit.as(org.owner, () => bids.createManualBidSubmission({ input: { bid_package_id: first.id, company_id: company, total_cents: total } }))

  const byDueThenId = (a, b) => (a.due === null) - (b.due === null) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const listed = dataset.filter((row) => !row.cancelled).sort(byDueThenId)
  // A plan-only package prices every division's homes, so a division-limited buyer never lists it.
  const visibleTo = (division) => listed.filter((row) => row.communityId !== null && (row.communityId === f.communityA ? division === f.divisionA : division === f.divisionB)).map((row) => row.id)
  const read = (actor, input) => kit.as(actor, () => queue.listProductionBidQueue(input))
  // A page past the end is an ordinary state (the list shrank while the reader sat on its last page).
  const readPage = (actor, input) => read(actor, input).catch((error) => ({ items: [], count: error.message }))
  const pages = []
  for (let page = 1; page <= 4; page++) pages.push(await readPage(buyer, { search: "Queue", page, pageSize: 20 }))
  const ids = pages.flatMap((page) => page.items.map((item) => item.id))
  const repeat = await read(buyer, { search: "Queue", page: 2, pageSize: 20 })
  const cancelledOnly = await read(buyer, { search: "Queue", status: "cancelled" })
  const percent = await read(buyer, { search: "50%" })
  const underscore = await read(buyer, { search: "_" })
  const inCommunityB = await read(buyer, { search: "Queue", communityId: f.communityB })
  const scopedA = await read(f.buyerA, { search: "Queue", pageSize: 100 }), scopedB = await read(f.buyerB, { search: "Queue", pageSize: 100 })
  const lensOutside = await read(f.buyerA, { search: "Queue", divisionId: f.divisionB })
  const firstRow = (await read(buyer, { search: "Queue 01" })).items[0]
  out.pastEnd = { queue: { items: pages[3].items.length, total: pages[3].count } }
  out.queue = {
    pageSizes: pages.map((page) => page.items.length), totals: [...new Set(pages.slice(0, 3).map((page) => page.count))], 
    orderIsDueDateThenId: sameIds(ids, listed.map((row) => row.id)), noRepeats: new Set(ids).size === ids.length,
    pageIsRepeatable: sameIds(repeat.items.map((item) => item.id), pages[1].items.map((item) => item.id)),
    cancelledHiddenByDefault: ids.every((id) => !dataset.find((row) => row.id === id).cancelled),
    cancelledOnly: { count: cancelledOnly.count, isTheCancelledThree: sameIds(cancelledOnly.items.map((item) => item.id).sort(), dataset.filter((row) => row.cancelled).map((row) => row.id).sort()) },
    literalPercent: { count: percent.count, isTheSix: sameIds(percent.items.map((item) => item.id).sort(), dataset.filter((row) => row.i % 9 === 0).map((row) => row.id).sort()) },
    literalUnderscoreMatches: underscore.count, communityFilter: inCommunityB.count,
    divisionScope: { buyerA: scopedA.count, buyerB: scopedB.count, buyerAItemsAreHerOwn: sameIds(scopedA.items.map((item) => item.id), visibleTo(f.divisionA)), buyerBItemsAreHisOwn: sameIds(scopedB.items.map((item) => item.id), visibleTo(f.divisionB)), lensOutsideScope: { items: lensOutside.items.length, count: lensOutside.count } },
    rowCounts: { invites: firstRow.invites, responses: firstRow.responses, job: firstRow.jobName },
  }
  const queueRefusals = { salesConsultant: await attempt(() => read(org.team.sales, {})), pageSizeAboveCap: await attempt(() => read(buyer, { pageSize: 101 })), pageZero: await attempt(() => read(buyer, { page: 0 })) }
  out.queueRefusals = {
    salesConsultant: queueRefusals.salesConsultant, pageSizeAboveCap: /too_big|less than or equal/i.test(queueRefusals.pageSizeAboveCap) ? "refused: page size capped at 100" : queueRefusals.pageSizeAboveCap,
    pageZero: /too_small|greater than or equal/i.test(queueRefusals.pageZero) ? "refused: pages start at 1" : queueRefusals.pageZero }

  // Vendors: fifty-three "Vendor NNN", twenty-five "Boundary Co NN" (exactly one full page), beside the five trades.
  const names = [...Array.from({ length: 53 }, (_, n) => `Vendor ${pad(n + 1, 3)}`), ...Array.from({ length: 25 }, (_, n) => `Boundary Co ${pad(n + 1)}`)]
  kit.sql(`insert into public.companies(id,org_id,name) values ${names.map((name) => `(${kit.q(randomUUID())},${kit.q(org.orgId)},${kit.q(name)})`).join(",")};`)
  const search = (actor, input) => kit.as(actor, () => vendors.searchProductionBidVendors({ packageId: dataset[0].id, ...input }))
  const vendorPages = []
  for (let page = 1; page <= 4; page++) vendorPages.push(await search(buyer, { search: "Vendor", page }).catch((error) => ({ items: [], more: error.message })))
  const vendorNames = vendorPages.flatMap((page) => page.items.map((item) => item.name))
  const boundary = await search(buyer, { search: "Boundary" })
  const narrow = await search(buyer, { search: "Vendor 04" })
  const everyone = []
  for (let page = 1; ; page++) { const result = await search(buyer, { page }); everyone.push(...result.items.map((item) => item.name)); if (!result.more) break }
  // A job's own bid package (awarded as a subcontract commitment) is not a price-book package.
  const customHome = randomUUID()
  kit.sql(`insert into public.projects(id,org_id,name,property_type,created_by) values(${kit.q(customHome)},${kit.q(org.orgId)},'Custom home beside the community','residential',${kit.q(org.owner.userId)});
insert into public.project_financial_settings(org_id,project_id) values(${kit.q(org.orgId)},${kit.q(customHome)}) on conflict do nothing;`)
  const commitmentPackage = await kit.as(org.owner, () => bids.createBidPackage({ input: { project_id: customHome, title: "Commitment package" } }))
  const lookups = {
    notAProductionPackage: await attempt(() => kit.as(buyer, () => vendors.searchProductionBidVendors({ packageId: commitmentPackage.id, search: "" }))),
    unknownPackage: await attempt(() => kit.as(buyer, () => vendors.searchProductionBidVendors({ packageId: randomUUID(), search: "" }))),
    salesConsultant: await attempt(() => search(org.team.sales, { search: "" })),
  }
  const retried = await search(buyer, { search: "Vendor 05" })
  out.pastEnd.vendors = { items: vendorPages[3].items.length, more: vendorPages[3].more }
  out.vendors = {
    pageSizes: vendorPages.slice(0, 3).map((page) => page.items.length), more: vendorPages.slice(0, 3).map((page) => page.more),
    namesAreAllVendorsInOrder: sameIds(vendorNames, Array.from({ length: 53 }, (_, n) => `Vendor ${pad(n + 1, 3)}`)),
    exactlyOneFullPage: { items: boundary.items.length, more: boundary.more },
    narrowSearch: narrow.items.map((item) => item.name), walkingEveryPageSeesEveryCompanyOnce: { seen: everyone.length, unique: new Set(everyone).size, inserted: kit.rows(`select count(*)::int n from public.companies where org_id=${kit.q(org.orgId)}`)[0].n },
  }
  out.lookupFailures = { ...lookups, retry: retried.items.map((item) => item.name) }
  out.orgId = org.orgId
  return out
}

async function bidAndVendorPickersPageAndCount(kit, expected, check) {
  const seen = await pickerObservations(kit)
  same(check, "the production bid queue pages stably, totals every match, and honours search, status, community and division scope", expected.expected.queue, seen.queue)
  same(check, "the queue refuses a role without bid access and out-of-range paging", expected.expected.queueRefusals, seen.queueRefusals)
  same(check, "the vendor picker pages the directory server-side with a truthful more flag and stable order", expected.expected.vendors, seen.vendors)
  same(check, "a lookup that cannot be served fails loudly, and the same request succeeds when retried", expected.expected.lookupFailures, seen.lookupFailures)
  return { orgId: seen.orgId }
}

async function pickerPastTheEndIsEmpty(kit, expected, check) {
  const seen = await pickerObservations(kit)
  same(check, "a page past the end of the bid queue and of the vendor picker is an empty page, not an error", expected.expected, seen.pastEnd)
  return { orgId: seen.orgId }
}


// ---------------------------------------------------------------------------
// A spec home on a developed lot: plan pinned, start package opened and its gates cleared by the starts desk.
const HOMES = new WeakMap()
function specHome(kit, f, lotIndex, planIndex = 1, { awardable = false } = {}) {
  const key = `${f.org.orgId}:${lotIndex}:${awardable}`
  const homes = HOMES.get(kit) ?? (HOMES.set(kit, new Map()), HOMES.get(kit))
  if (!homes.has(key)) homes.set(key, (async () => {
    const { org } = f
    seed.pinSpecPlan(kit, { lot: org.lots[lotIndex], plan: org.plans[planIndex] })
    const gates = await seed.clearStartGates(kit, org, { lotId: org.lots[lotIndex].id, spec: true, superintendent: false })
    const home = { ...gates, lotId: org.lots[lotIndex].id, plan: org.plans[planIndex] }
    if (awardable) {
      // The home carries its purchase orders and budget, the way a started home does.
      await issuePurchaseOrders(kit, home, org.team.purchasing)
      // DEFECT P2: a started home stays in the 'precon' phase, and awarding a bid on a precon job reads
      // project_precon_handoffs with the member's client, a table revoked from authenticated (lib/services/bids.ts,
      // awardBidSubmission). The phase is moved by hand so a subcontract can be awarded on the home.
      kit.sql(`update public.projects set phase='delivery' where id=${kit.q(gates.projectId)}`)
    }
    return home
  })())
  return homes.get(key)
}
// Preview, then commit the previewed purchase orders, as the buyer.
async function issuePurchaseOrders(kit, home, actor) {
  const generation = app("po-generation")
  const preview = await kit.as(actor, () => generation.generatePurchaseOrders({ projectId: home.projectId, mode: "dry_run" }))
  return kit.as(actor, () => generation.generatePurchaseOrders({ projectId: home.projectId, mode: "commit", expectedFingerprint: preview.inputFingerprint }))
}

// ---------------------------------------------------------------------------
// EP08-04

const company = (kit, org, name) => {
  const id = randomUUID()
  kit.sql(`insert into public.companies(id,org_id,name) values(${kit.q(id)},${kit.q(org.orgId)},${kit.q(name)})`)
  return id
}
// The buyer joins a home's team, which is what row-level security asks of anyone who is not an admin.
const joinHome = (kit, org, actor, projectId) => kit.sql(`insert into public.project_members(org_id,project_id,user_id,role_id,status) select ${kit.q(org.orgId)},${kit.q(projectId)},${kit.q(actor.userId)},id,'active' from public.roles where key='pm'
  and not exists (select 1 from public.project_members where project_id=${kit.q(projectId)} and user_id=${kit.q(actor.userId)})`)
const openPackage = async (kit, f, { title, communityId = f.communityA, planId = f.org.plans[0].id, costCode = "06-100", items = [] }) => {
  const { org } = f, bids = app("bids"), buyer = org.team.purchasing
  const pkg = await kit.as(buyer, () => bids.createBidPackage({ input: { community_id: communityId, house_plan_id: planId, title, trade: "Framing", cost_code_id: org.costCodeIds[costCode] } }))
  const scope = items.length ? await kit.as(buyer, () => bids.saveBidScopeItems({ input: { bid_package_id: pkg.id, items } })) : []
  await kit.as(buyer, () => bids.updateBidPackage({ bidPackageId: pkg.id, input: { status: "open" } }))
  return { pkg, scope }
}
const bidOn = async (kit, org, packageId, companyId, total, scope = [], amounts = []) => {
  const bids = app("bids")
  await kit.as(org.owner, () => bids.createBidInvite({ input: { bid_package_id: packageId, company_id: companyId, status: "sent" } })).catch((error) => { if (!/already|duplicate/i.test(error.message)) throw error })
  return kit.as(org.owner, () => bids.createManualBidSubmission({ input: { bid_package_id: packageId, company_id: companyId, total_cents: total,
    items: scope.map((item, index) => ({ bid_scope_item_id: item.id, description: item.description, response: "priced", amount_cents: amounts[index], quantity: item.quantity ?? null })) } }))
}

async function packageIntelligenceReadsEveryCurrentBid(kit, expected, check) {
  const f = await fixture(kit), { org } = f, bids = app("bids"), intel = app("bid-intelligence"), buyer = org.team.purchasing
  // Four bidders, one of whom revises, and an addendum between the first two bids and the rest.
  const { pkg } = await openPackage(kit, f, { title: "Intelligence — four bids" })
  const [one, two, three, four] = ["Intel One", "Intel Two", "Intel Three", "Intel Four"].map((name) => company(kit, org, name))
  await bidOn(kit, org, pkg.id, one, 10000000)
  await bidOn(kit, org, pkg.id, two, 10200000)
  // DEFECT P3: createBidAddendum fails for every member (the addendum trigger writes bid_scope_revisions, revoked
  // from authenticated and not security definer), so the addendum is issued by the stack's superuser; see
  // addendum-can-be-issued-on-an-open-package.
  kit.sql(`insert into public.bid_addenda(org_id,bid_package_id,number,title,message,created_by) values(${kit.q(org.orgId)},${kit.q(pkg.id)},1,'Revised slab detail','See sheet S-2.',${kit.q(org.owner.userId)})`)
  await bidOn(kit, org, pkg.id, three, 9800000)
  await bidOn(kit, org, pkg.id, four, 9900000)
  await bidOn(kit, org, pkg.id, four, 6000000)
  const read = await kit.as(buyer, () => intel.getPackageIntelligence(pkg.id))
  const current = kit.rows(`select s.total_cents from public.bid_submissions s join public.bid_invites i on i.id=s.bid_invite_id where i.bid_package_id=${kit.q(pkg.id)} and s.is_current order by 1`).map((row) => Number(row.total_cents))
  const priorVersions = kit.rows(`select count(*)::int n from public.bid_submissions s join public.bid_invites i on i.id=s.bid_invite_id where i.bid_package_id=${kit.q(pkg.id)} and not s.is_current`)[0].n
  same(check, "package intelligence reads each vendor's current bid once, medians and spreads them, flags the low outlier and the bids older than the addendum", expected.expected.fourBids, {
    currentBidsInTheDatabase: current, supersededVersions: priorVersions,
    sampleSize: read.sample_size, medianCents: read.median_cents, spreadPct: read.spread_pct,
    signals: read.signals.map((signal) => ({ totalCents: signal.total_cents, deviationPct: signal.deviation_from_median_pct, lowOutlier: signal.is_low_outlier, staleVersusAddendum: signal.is_stale_vs_addenda })).sort((a, b) => a.totalCents - b.totalCents),
  })

  // More current bids than one read page (500): every one is counted.
  const { pkg: wide } = await openPackage(kit, f, { title: "Intelligence — six hundred and twenty bids" })
  const bidders = Array.from({ length: 620 }, (_, n) => ({ company: randomUUID(), invite: randomUUID(), n }))
  kit.sql(`begin;
insert into public.companies(id,org_id,name) values ${bidders.map((row) => `(${kit.q(row.company)},${kit.q(org.orgId)},${kit.q(`Wide bidder ${pad(row.n, 3)}`)})`).join(",")};
insert into public.bid_invites(id,org_id,bid_package_id,company_id,status) values ${bidders.map((row) => `(${kit.q(row.invite)},${kit.q(org.orgId)},${kit.q(wide.id)},${kit.q(row.company)},'submitted')`).join(",")};
insert into public.bid_submissions(org_id,bid_invite_id,status,total_cents,submitted_at,source) values ${bidders.map((row) => `(${kit.q(org.orgId)},${kit.q(row.invite)},'submitted',${10000000 + row.n * 1000},now(),'manual')`).join(",")};
commit;`)
  const wideRead = await kit.as(buyer, () => intel.getPackageIntelligence(wide.id))
  same(check, "a package with more bids than one read page is read in full", expected.expected.sixHundredTwentyBids, { sampleSize: wideRead.sample_size, signals: wideRead.signals.length, medianCents: wideRead.median_cents, spreadPct: wideRead.spread_pct })

  // A corrupt bid total fails the read, naming the problem, rather than skewing the median.
  const { pkg: corrupt } = await openPackage(kit, f, { title: "Intelligence — corrupt total" })
  await bidOn(kit, org, corrupt.id, one, 10000000)
  await bidOn(kit, org, corrupt.id, two, 9000000)
  kit.sql(`update public.bid_submissions set total_cents=-500 where is_current and bid_invite_id in (select id from public.bid_invites where bid_package_id=${kit.q(corrupt.id)} and company_id=${kit.q(two)})`)
  const failures = {
    negativeTotal: await attempt(() => kit.as(buyer, () => intel.getPackageIntelligence(corrupt.id))),
    unknownPackage: await attempt(() => kit.as(buyer, () => intel.getPackageIntelligence(randomUUID()))),
    salesConsultant: await attempt(() => kit.as(org.team.sales, () => intel.getPackageIntelligence(pkg.id))),
  }
  same(check, "an invalid bid total, a missing package and a role without bid access each fail explicitly", expected.expected.failures, {
    negativeTotal: /bid total is invalid/.test(failures.negativeTotal) ? "refused: invalid bid total" : failures.negativeTotal, unknownPackage: failures.unknownPackage, salesConsultant: failures.salesConsultant })
  return { orgId: org.orgId, packageId: pkg.id }
}

async function addendumCanBeIssuedOnAnOpenPackage(kit, expected, check) {
  const f = await fixture(kit), { org } = f
  const { pkg } = await openPackage(kit, f, { title: "Addendum — open package" })
  const issued = await kit.as(org.owner, () => app("bids").createBidAddendum({ input: { bid_package_id: pkg.id, title: "Revised slab detail", message: "See sheet S-2." } })).then((row) => ({ number: row.number }), (error) => error.message)
  same(check, "the owner issues addendum 1 on an open production package", expected.expected, { issued })
  return { orgId: org.orgId }
}

const HISTORY = new WeakMap()
const costCodeObservations = (kit) => HISTORY.get(kit) ?? (HISTORY.set(kit, observeCostCodeHistory(kit)), HISTORY.get(kit))

async function observeCostCodeHistory(kit) {
  const out = {}
  const f = await fixture(kit), { org } = f, bids = app("bids"), intel = app("bid-intelligence"), buyer = org.team.purchasing
  const home = await specHome(kit, f, 5, 1, { awardable: true })
  const code = org.costCodeIds["06-100"]
  // A subcontract awarded on the home: framing, 11,000,000 cents against the 9,240,000 budget line (2100 sf at 44 dollars).
  const pkg = await kit.as(buyer, () => bids.createBidPackage({ input: { project_id: home.projectId, title: "Framing — spec home", cost_code_id: code, trade: "Framing" } }))
  const scope = await kit.as(buyer, () => bids.saveBidScopeItems({ input: { bid_package_id: pkg.id, items: [{ item_type: "base", description: "Frame the shell", cost_code_id: code }] } }))
  await kit.as(buyer, () => bids.updateBidPackage({ bidPackageId: pkg.id, input: { status: "open" } }))
  const framer = company(kit, org, "Intel Framer")
  const submission = await bidOn(kit, org, pkg.id, framer, 11000000, scope, [11000000])
  const awarded = await kit.as(buyer, () => bids.awardBidSubmission({ input: { bid_submission_id: submission.id, reviewed_scope: "Frame the shell", reviewed_terms: "Net 30", readiness_exception: "Acceptance vendor." } }))
  // A production package on the same cost code awards to the price book and creates no commitment.
  const production = await openPackage(kit, f, { title: "Framing price book", communityId: f.communityB, items: [{ item_type: "base", description: "Frame the shell", quantity: 1650, unit: "sf", cost_code_id: code }] })
  const priceBookBid = await bidOn(kit, org, production.pkg.id, framer, 9000000, production.scope, [9000000])
  await kit.as(buyer, () => bids.awardBidSubmission({ input: { bid_submission_id: priceBookBid.id, reviewed_scope: "Frame", reviewed_terms: "Net 30", readiness_exception: "Acceptance vendor." } }))

  const budgetCents = Number(kit.rows(`select bl.amount_cents from public.budget_lines bl join public.budgets b on b.id=bl.budget_id where b.project_id=${kit.q(home.projectId)} and bl.cost_code_id=${kit.q(code)}`)[0].amount_cents)
  const commitmentCents = Number(kit.rows(`select total_cents from public.commitments where id=${kit.q(awarded.commitmentId)}`)[0].total_cents)
  const history = (actor) => kit.as(actor, () => intel.getCostCodeBidHistory(code))
  // The buyer, not yet on the home's team, reads the same history (row-level security hides subcontracts from non-members).
  out.buyerNotOnTheTeam = await history(buyer).then((row) => ({ awards: row.award_count, medianPct: row.median_bid_to_budget_pct }), (error) => error.message)
  joinHome(kit, org, f.buyerA, home.projectId); joinHome(kit, org, f.buyerB, home.projectId)
  const seen = { owner: await history(org.owner), buyerInTheHomesDivision: await history(f.buyerA), buyerInAnotherDivision: await history(f.buyerB) }
  const pick = (row) => ({ awards: row.award_count, medianPct: row.median_bid_to_budget_pct, minCents: row.min_award_cents, maxCents: row.max_award_cents })
  out.history = {
    inputs: { commitmentCents, budgetCents }, owner: pick(seen.owner), buyerInTheHomesDivision: pick(seen.buyerInTheHomesDivision), buyerInAnotherDivision: pick(seen.buyerInAnotherDivision),
    salesConsultant: await attempt(() => history(org.team.sales)) }

  // Corrupt or dangling history fails the read instead of producing a quiet average.
  kit.sql(`update public.commitments set total_cents=-1 where id=${kit.q(awarded.commitmentId)}`)
  const negative = await attempt(() => history(org.owner))
  kit.sql(`update public.commitments set total_cents=${commitmentCents} where id=${kit.q(awarded.commitmentId)}`)
  const dangling = randomUUID(), danglingPackage = await openPackage(kit, f, { title: "Framing — dangling award" })
  const danglingBid = await bidOn(kit, org, danglingPackage.pkg.id, framer, 8000000)
  kit.sql(`begin; set local session_replication_role = replica;
insert into public.bid_awards(org_id,bid_package_id,awarded_submission_id,awarded_commitment_id) values(${kit.q(org.orgId)},${kit.q(danglingPackage.pkg.id)},${kit.q(danglingBid.id)},${kit.q(dangling)}); commit;`, "supabase_admin")
  const missing = await attempt(() => history(org.owner))
  kit.sql(`delete from public.bid_awards where bid_package_id=${kit.q(danglingPackage.pkg.id)}`)
  const recovered = pick(await history(org.owner))
  out.explicitFailures = {
    negativeAward: /invalid monetary amounts/.test(negative) ? "refused: invalid monetary amounts" : negative,
    missingCommitment: /references missing amounts/.test(missing) ? "refused: award history references missing amounts" : missing, recovered }
  out.orgId = org.orgId
  return out
}

async function purchasingManagerRunsTheBidWorkbench(kit, expected, check) {
  const f = await fixture(kit), { org } = f, bids = app("bids"), buyer = org.team.purchasing
  // The package stays a draft: sending is the step under test, and an already-open package refuses it.
  const pkg = await kit.as(buyer, () => bids.createBidPackage({ input: { community_id: f.communityA, house_plan_id: org.plans[0].id, title: "Workbench — buyer runs it", trade: "Framing", cost_code_id: org.costCodeIds["06-100"], due_at: dueIn(14) } }))
  const scope = await kit.as(buyer, () => bids.saveBidScopeItems({ input: { bid_package_id: pkg.id, items: [{ item_type: "base", description: "Frame the shell", quantity: 1650, unit: "sf", cost_code_id: org.costCodeIds["06-100"] }] } }))
  const vendor = org.vendorIds["Palmetto Framing"]
  const invited = await attempt(() => kit.as(buyer, () => bids.createBidInvite({ input: { bid_package_id: pkg.id, company_id: vendor, status: "draft" } })))
  const sent = await attempt(() => kit.as(buyer, () => bids.sendBidPackage({ bidPackageId: pkg.id })))
  const manual = await attempt(() => kit.as(buyer, () => bids.createManualBidSubmission({ input: { bid_package_id: pkg.id, company_id: vendor, total_cents: 9000000, items: scope.map((item) => ({ bid_scope_item_id: item.id, description: item.description, response: "priced", amount_cents: 9000000 })) } })))
  same(check, "the buyer who creates and awards production bid packages can also invite vendors, send the package and enter a bid on it", expected.expected, { invited, sent, manual })
  return { orgId: org.orgId }
}

async function costCodeHistoryIsScopedAndExplicit(kit, expected, check) {
  const seen = await costCodeObservations(kit)
  same(check, "the cost-code history counts the home's subcontract against its budget line, leaves out the price-book award, and shows nothing outside the reader's division", expected.expected.history, seen.history)
  same(check, "an invalid award amount and an award pointing at a missing commitment each fail the read explicitly; removing them restores it", expected.expected.explicitFailures, seen.explicitFailures)
  return { orgId: seen.orgId }
}

async function purchasingManagerReadsTheHistoryOfAwardedHomes(kit, expected, check) {
  const seen = await costCodeObservations(kit)
  same(check, "the buyer reads the same cost-code history as the owner before joining the home's team", expected.expected, seen.buyerNotOnTheTeam)
  return { orgId: seen.orgId }
}

async function vendorHistoryCountsEachProductionAwardOnceAndStaysInScope(kit, expected, check) {
  const f = await fixture(kit), { org } = f, bids = app("bids"), intel = app("bid-intelligence"), buyer = org.team.purchasing, cc = org.costCodeIds
  const vendor = company(kit, org, "Intel Vendor"), subcontractor = company(kit, org, "Intel Subcontractor")
  const awardTo = (actor, submissionId) => kit.as(actor, () => bids.awardBidSubmission({ input: { bid_submission_id: submissionId, reviewed_scope: "As bid", reviewed_terms: "Net 30", readiness_exception: "Acceptance vendor." } }))
  const unit = (description, costCode) => ({ item_type: "base", description, quantity: 1650, unit: "sf", cost_code_id: cc[costCode] })
  const lump = (description, costCode) => ({ item_type: "base", description, cost_code_id: cc[costCode] })
  // Two price-book awards to one vendor: the first prices three scope items, the second reprices framing and adds plumbing.
  // Both price-book awards are in the Harbor Walk community (division B); a competing vendor's agreement in the lots'
  // own community would make their framing price ambiguous and hold the starts gates.
  const first = await openPackage(kit, f, { title: "History — first award", communityId: f.communityB, items: [unit("Frame", "06-100"), lump("Slab", "03-300"), lump("Clear lot", "31-000")] })
  const firstBid = await bidOn(kit, org, first.pkg.id, vendor, 14000000, first.scope, [9000000, 4000000, 1000000])
  const firstAward = await awardTo(buyer, firstBid.id)
  const second = await openPackage(kit, f, { title: "History — second award", communityId: f.communityB, items: [unit("Frame", "06-100"), lump("Rough plumbing", "22-000")] })
  const secondBid = await bidOn(kit, org, second.pkg.id, vendor, 13000000, second.scope, [9900000, 3100000])
  const secondAward = await awardTo(buyer, secondBid.id)
  // A bid on a package in the other community that the vendor then declines.
  const third = await openPackage(kit, f, { title: "History — declined elsewhere", communityId: f.communityA, planId: null })
  await kit.as(org.owner, () => bids.createBidInvite({ input: { bid_package_id: third.pkg.id, company_id: vendor, status: "sent" } }))
  kit.sql(`update public.bid_invites set status='declined', declined_at=now() where bid_package_id=${kit.q(third.pkg.id)} and company_id=${kit.q(vendor)}`)
  // A subcontract on a home, then an approved change order of 550,000 against it.
  const home = await specHome(kit, f, 5, 1, { awardable: true })
  joinHome(kit, org, buyer, home.projectId); joinHome(kit, org, f.buyerA, home.projectId); joinHome(kit, org, f.buyerB, home.projectId)
  const job = await kit.as(buyer, () => bids.createBidPackage({ input: { project_id: home.projectId, title: "History — plumbing on the home", cost_code_id: cc["22-000"], trade: "Plumbing" } }))
  const jobScope = await kit.as(buyer, () => bids.saveBidScopeItems({ input: { bid_package_id: job.id, items: [lump("Rough plumbing", "22-000")] } }))
  await kit.as(buyer, () => bids.updateBidPackage({ bidPackageId: job.id, input: { status: "open" } }))
  const jobBid = await bidOn(kit, org, job.id, subcontractor, 11000000, jobScope, [11000000])
  const commitment = await awardTo(buyer, jobBid.id)
  const change = await kit.as(buyer, () => app("commitment-change-orders").createCommitmentChangeOrder({ input: { commitment_id: commitment.commitmentId, title: "Added fixtures", lines: [{ description: "Added fixtures", quantity: 1, unit_cost_cents: 550000 }] } }))
  await kit.as(org.owner, () => app("commitment-change-orders").approveCommitmentChangeOrder({ commitmentChangeOrderId: change.id }))

  const stats = (actor, ids = [vendor, subcontractor]) => kit.as(actor, () => intel.getVendorBidStats(ids))
  const pick = (map, id) => { const row = map.get(id); return { invited: row.invited_count, submitted: row.submitted_count, declined: row.declined_count, subcontracts: row.awarded_count, priceBookAwards: row.production_awarded_count, changeOrderGrowthPct: row.change_order_growth_pct } }
  const readers = { owner: await stats(org.owner), buyerInTheAwardsDivision: await stats(f.buyerB), buyerInTheHomesDivision: await stats(f.buyerA) }
  const rows = Object.fromEntries(Object.entries(readers).map(([name, map]) => [name, { priceBookVendor: pick(map, vendor), subcontractor: pick(map, subcontractor) }]))
  const agreementRows = kit.rows(`select count(*)::int n, count(distinct source_bid_award_id)::int awards from public.vendor_price_agreements where org_id=${kit.q(org.orgId)} and company_id=${kit.q(vendor)} and source='bid_award'`)[0]
  same(check, "a vendor's history counts each price-book award once however many agreement rows or revisions it produced, adds subcontracts and change-order growth, and shows a reader only their division", expected.expected.stats, {
    agreementRowsFromTwoAwards: { rows: agreementRows.n, awards: agreementRows.awards, awardIdsDiffer: firstAward.awardId !== secondAward.awardId }, ...rows })

  const failures = {}
  failures.salesConsultant = await attempt(() => stats(org.team.sales))
  failures.notAnId = await attempt(() => stats(org.owner, ["vendor"]).then(() => "allowed"))
  // A price agreement whose award row is gone, and a subcontract with a negative total, are corrupt history.
  const orphan = randomUUID()
  kit.sql(`begin; set local session_replication_role = replica;
insert into public.vendor_price_agreements(id,org_id,company_id,cost_code_id,pricing_kind,uom,unit_cost_cents,effective_from,status,source,source_bid_award_id) values(${kit.q(orphan)},${kit.q(org.orgId)},${kit.q(vendor)},${kit.q(cc["06-100"])},'unit','sf',100,current_date,'void','bid_award',${kit.q(randomUUID())}); commit;`, "supabase_admin")
  failures.missingAward = await attempt(() => stats(org.owner))
  kit.sql(`delete from public.vendor_price_agreements where id=${kit.q(orphan)}`)
  const commitmentCents = Number(kit.rows(`select total_cents from public.commitments where id=${kit.q(commitment.commitmentId)}`)[0].total_cents)
  kit.sql(`update public.commitments set total_cents=-1 where id=${kit.q(commitment.commitmentId)}`)
  failures.negativeSubcontract = await attempt(() => stats(org.owner))
  kit.sql(`update public.commitments set total_cents=${commitmentCents} where id=${kit.q(commitment.commitmentId)}`)
  const recovered = pick(await stats(org.owner), vendor)
  same(check, "a non-id, a role without bid access, a missing award and an invalid subcontract total each fail explicitly; repairing the data restores the read", expected.expected.explicitFailures, {
    salesConsultant: failures.salesConsultant, notAnId: /invalid|uuid/i.test(failures.notAnId) ? "refused: not a company id" : failures.notAnId,
    missingAward: /references missing awards/.test(failures.missingAward) ? "refused: production history references missing awards" : failures.missingAward,
    negativeSubcontract: /invalid monetary amounts/.test(failures.negativeSubcontract) ? "refused: invalid monetary amounts" : failures.negativeSubcontract,
    recovered: recovered.priceBookAwards })
  return { orgId: org.orgId, vendor, subcontractor }
}

// ---------------------------------------------------------------------------
// EP08-06

const POS = new WeakMap()
const poObservations = (kit) => POS.get(kit) ?? (POS.set(kit, observePurchaseOrders(kit)), POS.get(kit))

async function observePurchaseOrders(kit) {
  const f = await purchaseOrderFixture(kit), { org } = f, generation = app("po-generation"), book = app("price-book")
  const buyer = org.team.purchasing, out = {}
  const home = await specHome(kit, f, 6, 1)
  const projectId = home.projectId
  const preview = (actor = buyer, extra = {}) => kit.as(actor, () => generation.generatePurchaseOrders({ projectId, mode: "dry_run", ...extra }))
  const commit = (actor, fingerprint, extra = {}) => kit.as(actor, () => generation.generatePurchaseOrders({ projectId, mode: "commit", ...(fingerprint ? { expectedFingerprint: fingerprint } : {}), ...extra }))
  const agreementOf = (vendor) => kit.rows(`select id from public.vendor_price_agreements where org_id=${kit.q(org.orgId)} and company_id=${kit.q(org.vendorIds[vendor])} and status='active' and source='import' limit 1`)[0].id
  const shape = (result) => ({
    status: result.status,
    purchaseOrders: Object.fromEntries(result.purchaseOrders.map((po) => [po.companyName, { totalCents: po.totalCents, lines: po.lines.map((line) => ({ description: line.description, quantity: line.quantity, unit: line.unit, unitCostCents: line.unitCostCents, totalCents: line.totalCents })) }])),
    totalCents: result.purchaseOrders.reduce((sum, po) => sum + po.totalCents, 0),
    exceptions: result.exceptions.map((item) => ({ reason: item.reason, description: item.description })).sort((a, b) => a.description.localeCompare(b.description)),
    expiring: result.expiringAgreements.map((row) => ({ vendor: row.companyName, daysRemaining: row.daysRemaining })),
    fingerprintIs64Hex: /^[0-9a-f]{64}$/.test(result.inputFingerprint),
  })
  const today = kit.rows(`select current_date::text d`)[0].d
  const inDays = (days) => kit.rows(`select (current_date + ${days})::text d`)[0].d

  // 1. A clean preview: every trade priced from its agreement, no exceptions, nothing about to lapse.
  const previewRuns = () => kit.rows(`select count(*)::int n from public.po_generation_runs where project_id=${kit.q(projectId)} and mode='dry_run' and status in ('succeeded','succeeded_with_exceptions')`)[0].n
  const runsBefore = previewRuns()
  const clean = await preview()
  out.clean = shape(clean)
  out.cleanWrote = { purchaseOrders: kit.rows(`select count(*)::int n from public.commitments where project_id=${kit.q(projectId)} and commitment_type='purchase_order'`)[0].n, previewRunsAdded: previewRuns() - runsBefore }

  // 2. One agreement ends in ten days: the preview warns, inside the org's 30-day window.
  await kit.as(buyer, () => book.setAgreementEnd(agreementOf("Cypress Sitework"), { effective_to: inDays(10), reason: "Agreement runs out with the community phase" }))
  out.expiring = shape(await preview()).expiring

  // 3. Gulf Concrete's agreement lapsed yesterday and Coastal Plumbing's is void: two price exceptions.
  await kit.as(buyer, () => book.setAgreementEnd(agreementOf("Gulf Concrete"), { effective_to: inDays(-1), reason: "Vendor price lapsed" }))
  const coastal = agreementOf("Coastal Plumbing")
  await kit.as(buyer, () => book.voidPriceAgreement(coastal, { reason: "Entered against the wrong plan" }))
  const withExceptions = await preview()
  out.withExceptions = shape(withExceptions)
  out.exceptionCandidates = Object.fromEntries(withExceptions.exceptions.map((item) => [item.reason, item.candidates.length]))
  const queue = await kit.as(buyer, () => generation.listPoExceptions({ projectId }))
  out.queue = { open: queue.count, reasons: queue.items.map((item) => item.reason).sort() }

  // 4. Commit refuses a missing preview, a malformed one, a fingerprint with no recorded preview, a client as-of date that is ignored, and prices that moved since.
  const fingerprint = withExceptions.inputFingerprint
  const before = () => kit.rows(`select count(*)::int n from public.commitments where project_id=${kit.q(projectId)} and commitment_type='purchase_order'`)[0].n
  const refusal = (message) => /Preview the purchase orders before generating/.test(message) ? "refused: preview first" : /Pricing or selections changed/.test(message) ? "refused: inputs changed since the preview" : message
  out.commitRefusals = {
    noFingerprint: refusal(await attempt(() => commit(buyer, null))),
    malformedFingerprint: /regex|Invalid/i.test(await attempt(() => commit(buyer, "not-a-hash"))) ? "refused: malformed fingerprint" : "allowed",
    // A client-sent as-of date is ignored: the preview stamps its own, so a date cannot move the fingerprint or select a preview.
    clientAsOfDateIgnoredByPreview: (await preview(buyer, { asOfDate: inDays(1) })).inputFingerprint === fingerprint ? "ignored" : "changed the preview",
    fingerprintWithNoPreviewOnRecord: refusal(await attempt(() => commit(buyer, "f".repeat(64), { asOfDate: inDays(1) }))),
  }
  await kit.as(buyer, () => book.repriceAgreement(agreementOf("Palmetto Framing"), { effective_from: today, unit_cost_cents: 4500, reason: "Lumber index moved" }))
  out.commitRefusals.priceMovedAfterPreview = refusal(await attempt(() => commit(buyer, fingerprint)))
  out.commitRefusals.wrongRole = reason(await attempt(() => commit(org.team.sales, fingerprint)))
  out.commitRefusals.purchaseOrdersWritten = before()

  // 5. A fresh preview prices framing at the new rate; committing it issues the three priced orders once.
  const fresh = await preview()
  const issued = await commit(buyer, fresh.inputFingerprint)
  const again = await commit(buyer, fresh.inputFingerprint)
  const orders = kit.rows(`select co.name vendor, c.total_cents, c.contract_number, c.status, (select count(*)::int from public.commitment_lines l where l.commitment_id=c.id) lines from public.commitments c join public.companies co on co.id=c.company_id where c.project_id=${kit.q(projectId)} and c.commitment_type='purchase_order' order by co.name`)
  out.committed = { status: issued.status, orders: orders.map((row) => ({ vendor: row.vendor, totalCents: Number(row.total_cents), lines: row.lines })), numbersAreCommunityLotSequence: orders.every((row) => /^PO-CYP-\d+-0[1-9]$/.test(row.contract_number)),
    reCommitReturnsTheSameRun: again.runId === issued.runId, ordersAfterReCommit: before(),
    budgetLines: Object.fromEntries(kit.rows(`select co.code, bl.amount_cents from public.budget_lines bl join public.budgets b on b.id=bl.budget_id join public.cost_codes co on co.id=bl.cost_code_id where b.project_id=${kit.q(projectId)} order by 1`).map((row) => [row.code, Number(row.amount_cents)])),
    openExceptions: kit.rows(`select reason from public.po_generation_exceptions where project_id=${kit.q(projectId)} and status='open' order by 1`).map((row) => row.reason),
    auditAndEvent: kit.rows(`select (select count(*)::int from public.events where org_id=${kit.q(org.orgId)} and event_type='po_generation.completed' and entity_id=${kit.q(issued.runId)}) events, (select count(*)::int from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='po_generation_run' and entity_id=${kit.q(issued.runId)}) audits`)[0] }

  // 6. Resolving an exception: bad manual vendors, bad prices and bad agreements are refused and change nothing.
  const open = (await kit.as(buyer, () => generation.listPoExceptions({ projectId }))).items
  const byReason = Object.fromEntries(open.map((item) => [item.reason, item.id]))
  const otherOrg = kit.organization({ name: "Another builder", chart: [] })
  const strangerVendor = company(kit, { orgId: otherOrg.orgId }, "Stranger Concrete")
  const resolve = (actor, id, resolution) => kit.as(actor, () => generation.resolvePoException(id, resolution))
  const wrongCostCodeAgreement = agreementOf("Bright Electric")
  const gulfAgreementVoided = (() => { const row = kit.rows(`select id from public.vendor_price_agreements where org_id=${kit.q(org.orgId)} and id=${kit.q(coastal)}`)[0]; return row.id })()
  const sensible = (message) => /not available in this organization/.test(message) ? "refused: vendor not available" : /cannot price this line/.test(message) ? "refused: agreement cannot price this line" : /no longer available/.test(message) ? "refused: agreement no longer available" : /greater than or equal to 0|too_small/.test(message) ? "refused: negative price" : /integer|invalid_type/.test(message) ? "refused: price is not whole cents" : reason(message)
  const expiredId = byReason.expired_agreement, noAgreementId = byReason.no_agreement
  const gulf = org.vendorIds["Gulf Concrete"]
  const countOrders = before()
  out.resolveRefusals = {
    unknownVendor: sensible(await attempt(() => resolve(buyer, expiredId, { kind: "manual", company_id: randomUUID(), unit_cost_cents: 5800000 }))),
    otherOrganisationsVendor: sensible(await attempt(() => resolve(buyer, expiredId, { kind: "manual", company_id: strangerVendor, unit_cost_cents: 5800000 }))),
    negativePrice: sensible(await attempt(() => resolve(buyer, expiredId, { kind: "manual", company_id: gulf, unit_cost_cents: -1 }))),
    fractionalPrice: sensible(await attempt(() => resolve(buyer, expiredId, { kind: "manual", company_id: gulf, unit_cost_cents: 100.5 }))),
    agreementForAnotherCostCode: sensible(await attempt(() => resolve(buyer, expiredId, { kind: "agreement", agreement_id: wrongCostCodeAgreement }))),
    voidAgreement: sensible(await attempt(() => resolve(buyer, noAgreementId, { kind: "agreement", agreement_id: gulfAgreementVoided }))),
    unknownAgreement: sensible(await attempt(() => resolve(buyer, noAgreementId, { kind: "agreement", agreement_id: randomUUID() }))),
    startsCoordinator: reason(await attempt(() => resolve(org.team.starts, expiredId, { kind: "manual", company_id: gulf, unit_cost_cents: 5800000 }))),
    salesConsultant: reason(await attempt(() => resolve(org.team.sales, expiredId, { kind: "manual", company_id: gulf, unit_cost_cents: 5800000 }))),
    divisionBuyerOutsideDivision: reason(await attempt(() => resolve(f.buyerB, expiredId, { kind: "manual", company_id: gulf, unit_cost_cents: 5800000 }))),
    ordersCreated: before() - countOrders,
    stillOpen: kit.rows(`select count(*)::int n from public.po_generation_exceptions where project_id=${kit.q(projectId)} and status='open'`)[0].n,
  }

  // 7. Valid resolutions are additive: a manual price for the lapsed concrete, a new agreement for plumbing.
  const issuedBefore = Object.fromEntries(orders.map((row) => [row.vendor, row.contract_number]))
  // DEFECT P4: the buyer is not on the home's team, so row-level security hides the issued orders from her; the
  // numbering and the covered-lines check then start from nothing and the order number collides. She joins the team to go on.
  const manualResolution = { kind: "manual", company_id: gulf, unit_cost_cents: 5900000, note: "Spot price while the agreement is renewed." }
  const fromOutsideTheTeam = await resolve(buyer, expiredId, manualResolution).then((row) => ({ ok: true, row }), (error) => ({ ok: false, message: error.message }))
  out.resolveWithoutTeamMembership = fromOutsideTheTeam.ok ? "resolved" : /commitments_generated_po_number_uidx/.test(fromOutsideTheTeam.message) ? "refused: duplicate order number" : fromOutsideTheTeam.message
  if (!fromOutsideTheTeam.ok) joinHome(kit, org, buyer, projectId)
  const manual = fromOutsideTheTeam.ok ? fromOutsideTheTeam.row : await resolve(buyer, expiredId, manualResolution)
  const newPlumbing = await kit.as(buyer, () => book.createPriceAgreement({ company_id: org.vendorIds["Coastal Plumbing"], cost_code_id: org.costCodeIds["22-000"], house_plan_id: home.plan.id, pricing_kind: "lump_sum", lump_sum_cents: 4300000, effective_from: today, scope_of_work: "Plumbing, Palmetto plan" }))
  const byAgreement = await resolve(buyer, noAgreementId, { kind: "agreement", agreement_id: newPlumbing.id })
  const afterOrders = kit.rows(`select co.name vendor, c.total_cents, c.contract_number from public.commitments c join public.companies co on co.id=c.company_id where c.project_id=${kit.q(projectId)} and c.commitment_type='purchase_order' order by co.name`)
  const resolved = kit.rows(`select id, status, resolution, resolved_by from public.po_generation_exceptions where project_id=${kit.q(projectId)} and id in (${kit.q(expiredId)}, ${kit.q(noAgreementId)}) order by status`)
  out.resolved = {
    statuses: Object.fromEntries(resolved.map((row) => [row.status, row.resolution.kind])), resolvedByTheBuyer: resolved.every((row) => row.resolved_by === buyer.userId),
    orders: afterOrders.map((row) => ({ vendor: row.vendor, totalCents: Number(row.total_cents) })),
    issuedOrdersKeepTheirNumbers: Object.entries(issuedBefore).every(([vendor, number]) => afterOrders.find((row) => row.vendor === vendor).contract_number === number),
    resolutionsReturnedRuns: [typeof manual.regeneration.runId, typeof byAgreement.regeneration.runId],
    nothingLeftOpen: kit.rows(`select count(*)::int n from public.po_generation_exceptions where project_id=${kit.q(projectId)} and status='open'`)[0].n,
    resolveAgain: reason(await attempt(() => resolve(buyer, expiredId, { kind: "manual", company_id: gulf, unit_cost_cents: 1 }))).replace(/.*already been resolved.*/, "refused: already resolved"),
    audit: kit.rows(`select count(*)::int n from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='po_generation_exception' and entity_id in (${kit.q(expiredId)}, ${kit.q(noAgreementId)}) and action='update'`)[0].n,
  }
  out.orgId = org.orgId
  return out
}

async function purchaseOrderPreviewShowsLinesExceptionsAndExpiry(kit, expected, check) {
  const seen = await poObservations(kit)
  same(check, "a preview lists each trade's order with its priced lines, writes no order, and finds no exceptions on a fully priced home", expected.expected.clean, { preview: seen.clean, ordersAndRunsWritten: seen.cleanWrote })
  same(check, "an agreement ending inside the lead window is reported with the days remaining", expected.expected.expiring, seen.expiring)
  same(check, "a lapsed and a void agreement surface as price exceptions beside the orders still priced, and the buyer's queue lists them", expected.expected.exceptions, { preview: seen.withExceptions, candidates: seen.exceptionCandidates, queue: seen.queue })
  return { orgId: seen.orgId }
}

async function purchaseOrderCommitRejectsChangedInputs(kit, expected, check) {
  const seen = await poObservations(kit)
  same(check, "commit refuses a missing, malformed or stale preview and a different as-of date, and writes nothing", expected.expected.refusals, seen.commitRefusals)
  same(check, "committing a fresh preview issues the priced orders once, with budget, numbering, event and audit, and re-committing returns the same run", expected.expected.committed, seen.committed)
  return { orgId: seen.orgId }
}

async function purchasingManagerResolvesAnExceptionOnAHouse(kit, expected, check) {
  const seen = await poObservations(kit)
  same(check, "the purchasing manager resolves a price exception on a house without being added to its team", expected.expected, { resolution: seen.resolveWithoutTeamMembership })
  return { orgId: seen.orgId }
}

async function purchaseOrderExceptionsResolveOnlyValidly(kit, expected, check) {
  const seen = await poObservations(kit)
  same(check, "invalid manual vendors, prices and agreements, and the wrong role or division, are refused and change nothing", expected.expected.refusals, seen.resolveRefusals)
  same(check, "a manual price and a new agreement each add their order without touching those already issued", expected.expected.resolved, seen.resolved)
  return { orgId: seen.orgId }
}

// ---------------------------------------------------------------------------
// EP08-12

const VARIANCE = new WeakMap()
const varianceObservations = (kit) => VARIANCE.get(kit) ?? (VARIANCE.set(kit, observeVariance(kit)), VARIANCE.get(kit))

async function observeVariance(kit) {
  const { stage } = lot()
  const closed = await stage(kit, "closing")
  const f = await fixture(kit), { org } = f, buyer = org.team.purchasing, orders = app("commitment-change-orders"), report = app("reports/variance-analysis")
  const out = {}
  const closedHome = org.projectId
  const second = await specHome(kit, f, 7, 1, { awardable: true })
  const secondHome = second.projectId
  const orderOf = (projectId, vendor) => kit.rows(`select id from public.commitments where project_id=${kit.q(projectId)} and commitment_type='purchase_order' and company_id=${kit.q(org.vendorIds[vendor])} limit 1`)[0].id
  const reasons = Object.fromEntries((await kit.as(buyer, () => app("purchasing-settings").listVarianceReasonCodes())).map((row) => [row.code, row.id]))
  // Variance orders change an issued order, so both homes' generated orders are approved first, as the office would before work starts.
  kit.sql(`update public.commitments set status='approved' where project_id in (${kit.q(closedHome)},${kit.q(secondHome)}) and commitment_type='purchase_order' and status='draft'`)

  // The buyer asks for a variance order before she is on either home's team.
  out.requestWithoutTeamMembership = await kit.as(buyer, () => orders.createCommitmentChangeOrder({ input: { commitment_id: orderOf(closedHome, "Gulf Concrete"), reason_code_id: reasons.missed_scope, title: "Probe", lines: [{ description: "Probe", quantity: 1, unit_cost_cents: 100 }] } })).then(() => "allowed", (error) => /Commitment not found/.test(error.message) ? "refused: commitment not found" : error.message)
  joinHome(kit, org, buyer, closedHome); joinHome(kit, org, buyer, secondHome)
  joinHome(kit, org, f.buyerA, closedHome); joinHome(kit, org, f.buyerA, secondHome); joinHome(kit, org, f.buyerB, closedHome); joinHome(kit, org, f.buyerB, secondHome)
  // The superintendent runs the closed home only; the second home has none.
  kit.sql(`insert into public.project_members(org_id,project_id,user_id,role_id,status) select ${kit.q(org.orgId)},${kit.q(closedHome)},${kit.q(org.team.superintendent.userId)},id,'active' from public.roles where key='field' on conflict (project_id,user_id) do nothing`)

  const requested = []
  // The buyer attaches the vendor's quote to each order: from the org threshold up, and for every back-charge, approval needs cost evidence.
  const quoteOf = (projectId) => { const id = randomUUID(); kit.sql(`insert into public.files(id,org_id,project_id,file_name,storage_path,category) values(${kit.q(id)},${kit.q(org.orgId)},${kit.q(projectId)},'quote.pdf',${kit.q(`${org.orgId}/${projectId}/variance-quote-${id}.pdf`)},'financials')`); return id }
  const request = async (projectId, vendor, reasonCode, cents, approvedAt) => {
    const created = await kit.as(buyer, () => orders.createCommitmentChangeOrder({ input: { commitment_id: orderOf(projectId, vendor), reason_code_id: reasons[reasonCode], title: `${reasonCode} ${vendor}`, evidence_file_ids: [quoteOf(projectId)], lines: [{ description: reasonCode, quantity: 1, unit_cost_cents: cents }] } }))
    await kit.as(org.owner, () => orders.approveCommitmentChangeOrder({ commitmentChangeOrderId: created.id }))
    kit.sql(`update public.commitment_change_orders set approved_at=${kit.q(approvedAt)}::timestamptz where id=${kit.q(created.id)}`)
    requested.push({ id: created.id, projectId, vendor, reasonCode, cents, approvedAt })
  }
  await request(closedHome, "Gulf Concrete", "missed_scope", 120000, "2026-09-10T12:00:00Z")
  await request(secondHome, "Bright Electric", "plan_error", 80000, "2026-09-30T23:59:59.999999Z")
  await request(closedHome, "Palmetto Framing", "back_charge", -50000, "2026-09-01T00:00:00Z")
  await request(secondHome, "Bright Electric", "site_condition", 200000, "2026-09-15T08:00:00Z")
  await request(secondHome, "Gulf Concrete", "missed_scope", 30000, "2026-10-01T00:00:00Z")
  // Eleven hundred small approved orders on the second home: more facts than one read page of a thousand.
  const brightOrder = orderOf(secondHome, "Bright Electric")
  kit.sql(`insert into public.commitment_change_orders(org_id,project_id,commitment_id,company_id,title,status,total_cents,approved_at,approved_by,reason_code_id,origin,requested_by)
    select ${kit.q(org.orgId)}, ${kit.q(secondHome)}, ${kit.q(brightOrder)}, ${kit.q(org.vendorIds["Bright Electric"])}, 'Small order '||g, 'approved', 100, '2026-09-20T09:00:00Z', ${kit.q(org.owner.userId)}, ${kit.q(reasons.other)}, 'office', ${kit.q(buyer.userId)} from generate_series(1,1100) g`)

  const budgetOf = (projectId) => Number(kit.rows(`select total_cents from public.budgets where project_id=${kit.q(projectId)} order by version desc limit 1`)[0].total_cents)
  out.budgets = { closedHome: budgetOf(closedHome), secondHome: budgetOf(secondHome) }
  out.homeDivisions = kit.rows(`select p.id = ${kit.q(closedHome)} closed, p.division_id is not null on_project, l.division_id is not null on_lot from public.projects p join public.lots l on l.project_id=p.id where p.id in (${kit.q(closedHome)}, ${kit.q(secondHome)}) order by 1 desc`)
  const run = (actor, startDate, endDate, extra = {}) => kit.as(actor, () => report.getVarianceAnalysis({ startDate, endDate, ...extra }))
  const rowsOf = (result) => result.rows.map((row) => ({ dimension: row.dimension, id: row.dimension_id, label: row.dimension_label, net: row.net_variance_cents, abs: row.absolute_variance_cents, incidence: row.incidence, budget: row.direct_cost_budget_cents, rate: Math.round(row.variance_rate * 1e9) / 1e9 }))
    .sort((a, b) => a.dimension.localeCompare(b.dimension) || a.label.localeCompare(b.label))
  const slim = (rows) => rows.map(({ id, ...rest }) => rest)
  const summarise = (result) => ({ ...result.summary, varianceRate: Math.round(result.summary.varianceRate * 1e9) / 1e9 })
  const september = { owner: await run(org.owner, "2026-09-01", "2026-09-30"), buyer: await run(buyer, "2026-09-01", "2026-09-30"), division: await run(f.buyerA, "2026-09-01", "2026-09-30"), elsewhere: await run(f.buyerB, "2026-09-01", "2026-09-30") }
  out.september = { rows: slim(rowsOf(september.owner).filter((row) => row.dimension !== "superintendent")), summary: summarise(september.owner), scoped: { owner: september.owner.scoped, buyer: september.buyer.scoped, division: september.division.scoped, elsewhere: september.elsewhere.scoped },
    buyerSeesWhatTheOwnerSees: JSON.stringify(rowsOf(september.buyer)) === JSON.stringify(rowsOf(september.owner)),
    divisionReportMatchesTheOrganisationReport: JSON.stringify(rowsOf(september.division)) === JSON.stringify(rowsOf(september.owner)) && JSON.stringify(summarise(september.division)) === JSON.stringify(summarise(september.owner)),
    divisionSees: { abs: september.division.summary.totalAbsoluteCents, incidence: september.division.summary.incidence },
    otherDivision: { rows: september.elsewhere.rows.length, abs: september.elsewhere.summary.totalAbsoluteCents },
    reasonBudgetsSum: september.owner.rows.filter((row) => row.dimension === "reason").reduce((sum, row) => sum + row.direct_cost_budget_cents, 0) }
  out.superintendents = september.owner.rows.filter((row) => row.dimension === "superintendent").map((row) => ({ label: row.dimension_label, id: row.dimension_id === "" ? "none" : "person", abs: row.absolute_variance_cents })).sort((a, b) => a.label.localeCompare(b.label))
  // Inclusive end dates keep microseconds: the 30 September order was approved at 23:59:59.999999.
  const totals = async (actor, start, end) => { const result = await run(actor, start, end); return { abs: result.summary.totalAbsoluteCents, incidence: result.summary.incidence } }
  const windows = {}
  for (const [name, actor] of [["owner", org.owner], ["division", f.buyerA]]) {
    const thirtieth = await totals(actor, "2026-09-01", "2026-09-30"), twentyNinth = await totals(actor, "2026-09-01", "2026-09-29"), october = await totals(actor, "2026-10-01", "2026-10-01")
    windows[name] = { endOnTheThirtyFirstMinute: { abs: thirtieth.abs - twentyNinth.abs, incidence: thirtieth.incidence - twentyNinth.incidence }, firstOfOctoberOnly: october }
  }
  out.dateRanges = { ...windows, septemberExcludesTheFirstOfOctober: (await run(org.owner, "2026-09-01", "2026-09-30")).rows.filter((row) => row.dimension === "month").map((row) => row.dimension_label), octoberMonthLabel: (await run(org.owner, "2026-10-01", "2026-10-01")).rows.filter((row) => row.dimension === "month").map((row) => row.dimension_label) }
  const refused = (work) => attempt(work).then((message) => /valid calendar dates/.test(message) ? "refused: not a calendar date" : /on or before its end date/.test(message) ? "refused: start after end" : message)
  out.refusals = { impossibleDate: await refused(() => run(org.owner, "2026-02-30", "2026-03-01")), startAfterEnd: await refused(() => run(org.owner, "2026-09-30", "2026-09-01")), salesConsultant: await attempt(() => run(org.team.sales, "2026-09-01", "2026-09-30")), startsCoordinator: await attempt(() => run(org.team.starts, "2026-09-01", "2026-09-30")) }
  // With the closed home's division written onto the project too (a harness repair for P5), the division-limited
  // path, which aggregates in application code, must agree with the organisation RPC to the last cent and row.
  kit.sql(`update public.projects p set division_id = l.division_id from public.lots l where l.project_id = p.id and p.id = ${kit.q(closedHome)}`)
  const repaired = await run(f.buyerA, "2026-09-01", "2026-09-30")
  out.afterRepair = { rowsEqualTheOrganisationRows: JSON.stringify(rowsOf(repaired).filter((row) => row.dimension !== "superintendent")) === JSON.stringify(rowsOf(september.owner).filter((row) => row.dimension !== "superintendent")),
    summary: summarise(repaired), organisationSummary: summarise(september.owner), scoped: repaired.scoped }
  out.orgId = org.orgId
  return out
}

async function divisionScopedVarianceReportCountsEachHomeOnce(kit, expected, check) {
  const seen = await varianceObservations(kit)
  const both = seen.budgets.closedHome + seen.budgets.secondHome
  same(check, "the division-limited path agrees with the organisation report row for row and counts each home's budget once", expected.expected, {
    rowsEqualTheOrganisationRows: seen.afterRepair.rowsEqualTheOrganisationRows, summaryEqualsTheOrganisationSummary: JSON.stringify(seen.afterRepair.summary) === JSON.stringify(seen.afterRepair.organisationSummary),
    budgetOnce: seen.afterRepair.summary.directCostBudgetCents === both, totalAbsoluteCents: seen.afterRepair.summary.totalAbsoluteCents, incidence: seen.afterRepair.summary.incidence, scoped: seen.afterRepair.scoped })
  return { orgId: seen.orgId }
}

async function varianceReportReadsEveryScopedFact(kit, expected, check) {
  const seen = await varianceObservations(kit)
  const { closedHome, secondHome } = seen.budgets
  const both = closedHome + secondHome
  const exp = expected.expected
  const budgetFor = (key) => key === "both" ? both : key === "closed" ? closedHome : secondHome
  const rows = exp.rows.map((row) => ({ ...row, budget: budgetFor(row.budget), rate: Math.round(row.abs / budgetFor(row.budget) * 1e9) / 1e9 }))
  same(check, "the report reads every approved variance order in the window across both homes (1,104 facts) with its supporting labels, by all seven dimensions", rows, seen.september.rows)
  same(check, "the summary adds the facts once and the budget denominator counts each contributing home once", { ...exp.summary, directCostBudgetCents: both, varianceRate: Math.round(560000 / both * 1e9) / 1e9, benchmarkLow: 0.01, benchmarkHigh: 0.02 }, seen.september.summary)
  same(check, "summing the per-reason denominators would count a home once per reason; the summary does not", { reasonBudgetsSum: 2 * closedHome + 3 * secondHome, summaryBudget: both }, { reasonBudgetsSum: seen.september.reasonBudgetsSum, summaryBudget: seen.september.summary.directCostBudgetCents })
  same(check, "the purchasing manager sees the organisation's report; a reader limited to another division sees none of it", exp.readers, { scoped: seen.september.scoped, buyerSeesWhatTheOwnerSees: seen.september.buyerSeesWhatTheOwnerSees, otherDivision: seen.september.otherDivision })
  return { orgId: seen.orgId }
}

async function divisionScopedVarianceReportMatchesTheOrganisationReport(kit, expected, check) {
  const seen = await varianceObservations(kit)
  same(check, "the division-limited report includes every home in the division, including one whose division is recorded on its lot only", expected.expected, { homesAndWhereTheirDivisionIsRecorded: seen.homeDivisions, divisionSees: seen.september.divisionSees, matchesTheOrganisationReport: seen.september.divisionReportMatchesTheOrganisationReport })
  return { orgId: seen.orgId }
}

async function varianceReportLabelsTheSuperintendent(kit, expected, check) {
  const seen = await varianceObservations(kit)
  same(check, "the superintendent label comes from the home's team and a home without one is Unassigned", expected.expected, seen.superintendents)
  return { orgId: seen.orgId }
}

async function varianceReportInclusiveEndDatesKeepTimestampPrecision(kit, expected, check) {
  const seen = await varianceObservations(kit)
  same(check, "an order approved at 23:59:59.999999 on the end date is in that day's report, one second-day-later is out, and the start date is inclusive, on both the organisation and the division-scoped path", expected.expected.dateRanges, seen.dateRanges)
  same(check, "impossible dates, a reversed range and roles without price-book access are refused", expected.expected.refusals, seen.refusals)
  return { orgId: seen.orgId }
}

async function purchasingManagerRequestsAVarianceOrderOnAHouse(kit, expected, check) {
  const seen = await varianceObservations(kit)
  same(check, "the purchasing manager (vpo.request) raises a variance order against a house's purchase order without being added to its team", expected.expected, { request: seen.requestWithoutTeamMembership })
  return { orgId: seen.orgId }
}

module.exports = { subcases: { "production-bids-reach-the-price-book": productionBidsReachThePriceBook, "bid-and-vendor-pickers-page-and-count": bidAndVendorPickersPageAndCount, "picker-page-past-the-end-is-empty": pickerPastTheEndIsEmpty, "package-intelligence-reads-every-current-bid": packageIntelligenceReadsEveryCurrentBid, "cost-code-history-is-scoped-and-explicit": costCodeHistoryIsScopedAndExplicit, "purchasing-manager-runs-the-bid-workbench": purchasingManagerRunsTheBidWorkbench, "purchasing-manager-reads-the-history-of-awarded-homes": purchasingManagerReadsTheHistoryOfAwardedHomes, "addendum-can-be-issued-on-an-open-package": addendumCanBeIssuedOnAnOpenPackage, "vendor-history-counts-each-production-award-once-and-stays-in-scope": vendorHistoryCountsEachProductionAwardOnceAndStaysInScope, "purchase-order-preview-shows-lines-exceptions-and-expiry": purchaseOrderPreviewShowsLinesExceptionsAndExpiry, "purchase-order-commit-rejects-changed-inputs": purchaseOrderCommitRejectsChangedInputs, "purchase-order-exceptions-resolve-only-validly": purchaseOrderExceptionsResolveOnlyValidly, "purchasing-manager-resolves-an-exception-on-a-house": purchasingManagerResolvesAnExceptionOnAHouse, "variance-report-reads-every-scoped-fact": varianceReportReadsEveryScopedFact, "variance-report-inclusive-end-dates-keep-timestamp-precision": varianceReportInclusiveEndDatesKeepTimestampPrecision, "purchasing-manager-requests-a-variance-order-on-a-house": purchasingManagerRequestsAVarianceOrderOnAHouse, "division-scoped-variance-report-matches-the-organisation-report": divisionScopedVarianceReportMatchesTheOrganisationReport, "variance-report-labels-the-superintendent": varianceReportLabelsTheSuperintendent, "division-scoped-variance-report-counts-each-home-once": divisionScopedVarianceReportCountsEachHomeOnce }, fixture, packageWithBid, attempt, reason, pad, dueIn }
