// LOT-01 workflow proof: search-to-pick (EP01-03). Homes, lots, plans, buyers, projects and vendors are
// chosen by typing words into a scoped, paged search; nobody pastes an id. Every subcase acts as the role
// that uses the picker, through the services the picker's server action calls, and checks the answer
// against what the fixture was built to contain (never against the output).
//
// Fixture (one organisation, community A "Cypress Landing" in division A, community B "Harbor Walk" in
// division B): the first tranche's ten lots "1".."10" are developed with no plan; lots PK-01..PK-14 are added.
//   PK-01 PK-02 PK-03   Mangrove, elevation A (PK-03 carries a $2,500 lot premium)
//   PK-04 PK-05 PK-06   Mangrove, elevation B  (the sheet prices B $10,000 above A)
//   PK-07 PK-08 PK-09   Palmetto, elevation A  (A's own price row ended yesterday: the plan-wide row prices them)
//   PK-10 PK-11         Palmetto, elevation B  (B is priced $10,000 above the plan-wide row)
//   PK-12 held for a buyer, PK-13 sold on an executed agreement, PK-14 free with no plan
//   PK-05 is a started spec home with a confirmed $18,500 structural option; PK-06 is a started spec home
//   whose asking price a sales manager overrode.
// Lot HB-01 is in community B.
const { randomUUID } = require("node:crypto")
const Module = require("node:module")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")
const fx = require("./lot-01-sales-fixtures.cjs")

// The pickers' services read the ambient desk lens from the request's cookies. A scenario has no request,
// so it stands in a request that carries none (a user who never pinned a division or community).
const loadModule = Module._load
Module._load = function (request, ...args) {
  const real = loadModule.call(this, request, ...args)
  return request === "next/headers" ? { ...real, cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }) } : real
}

const lot = () => require("./lot-01.cjs").helpers
const { refusal } = fx
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PRICE_REASON = "Repriced after the model home walk-through"

const FIXTURES = new WeakMap()
function fixture(kit) {
  if (!FIXTURES.has(kit)) FIXTURES.set(kit, build(kit))
  return FIXTURES.get(kit)
}

async function build(kit) {
  const { org } = await lot().stage(kit, "land")
  const q = kit.q
  const lots = app("lots"), sales = app("community-sales"), starts = app("starts")
  const divisions = app("divisions"), communities = app("communities")

  // Fourteen more lots in community A, developed.
  const numbers = Array.from({ length: 14 }, (_, index) => `PK-${String(index + 1).padStart(2, "0")}`)
  await kit.as(org.team.land, () => lots.createLots(org.communityId, { lots: numbers.map((lotNumber, index) => ({
    lotNumber, phaseId: org.phaseIds[0], takedownId: null, status: "developed", address: `${8800 + index} ${index % 2 ? "Heron Lane" : "Sandpiper Court"}`,
    dimensions: { widthFt: 52, depthFt: 115 }, swing: "right", premiumCents: lotNumber === "PK-03" ? 250000 : 0, costBasisCents: 7200000 })) }))
  const byNumber = Object.fromEntries(kit.rows(`select id, lot_number from public.lots where org_id=${q(org.orgId)} and community_id=${q(org.communityId)} and lot_number like 'PK-%'`).map((row) => [row.lot_number, row.id]))

  // A released plan is offered from the sheet as it stands; it is assignable to a lot once the plan itself is active.
  for (const plan of org.plans) await kit.as(org.owner, () => app("house-plans").updateHousePlan(plan.id, { status: "active" }))
  // The starts coordinator (who holds plan.instantiate) picks each lot's plan from the plan picker's own answer (its version and elevation ids).
  const options = {}
  for (const name of ["Mangrove", "Palmetto"]) options[name] = (await kit.as(org.team.starts, () => lots.listPlanAssignmentOptions(org.communityId, { search: name }))).plans[0]
  const assign = async (number, name, elevationCode) => {
    const plan = options[name]
    const elevation = plan.elevations.find((row) => row.code === elevationCode)
    await kit.as(org.team.starts, () => lots.assignPlanToLot(byNumber[number], { versionId: plan.versions[0].id, elevationId: elevation.id }))
  }
  for (const number of ["PK-01", "PK-02", "PK-03"]) await assign(number, "Mangrove", "A")
  for (const number of ["PK-04", "PK-05", "PK-06"]) await assign(number, "Mangrove", "B")
  for (const number of ["PK-07", "PK-08", "PK-09"]) await assign(number, "Palmetto", "A")
  for (const number of ["PK-10", "PK-11"]) await assign(number, "Palmetto", "B")

  // The sheet prices elevation B ten thousand dollars over its plan; Palmetto A's own row ended yesterday.
  const sheet = await kit.as(org.owner, () => sales.getCommunityPriceSheet(org.communityId))
  const sheetRow = (planCode, elevationName) => sheet.rows.find((row) => row.planCode === planCode && row.elevationName === elevationName)
  await kit.as(org.owner, () => sales.setCommunityPlanPrice({ communityId: org.communityId, availabilityId: sheetRow("MG1650", "Craftsman").availabilityId, basePriceCents: 39500000 }))
  await kit.as(org.owner, () => sales.setCommunityPlanPrice({ communityId: org.communityId, availabilityId: sheetRow("PL2100", "Craftsman").availabilityId, basePriceCents: 45500000 }))
  kit.sql(`update public.community_plan_availability set effective_end = current_date - 1 where id=${q(sheetRow("PL2100", "Coastal").availabilityId)}`)

  // A held lot and a sold lot (no plan assigned, so the reservation and agreement set their own).
  const held = await fx.reservedBuyer(kit, org, { name: "Held Buyer", depositCents: 100000, receivedOn: null, lot: { id: byNumber["PK-12"], lot_number: "PK-12" } })
  const sold = await fx.reservedBuyer(kit, org, { name: "Sold Buyer", depositCents: 100000, receivedOn: null, lot: { id: byNumber["PK-13"], lot_number: "PK-13" } })
  await fx.agreementFor(kit, org, sold)

  // Two spec homes: the starts desk opens their packages; one carries a structural option, one a price override.
  const homeOf = (number) => kit.rows(`select project_id from public.lots where id=${q(byNumber[number])}`)[0].project_id
  for (const number of ["PK-05", "PK-06"]) await kit.as(org.team.starts, () => starts.openStartPackage(byNumber[number], { isFinanced: false }))
  kit.sql(`insert into public.project_selections(org_id, project_id, category_id, selected_option_id, status, price_cents_snapshot, cost_cents_snapshot)
    values(${q(org.orgId)}, ${q(homeOf("PK-05"))}, ${q(org.categoryIds.Structure)}, ${q(org.optionIds["ST-GAR"])}, 'confirmed', 1850000, 1100000)`)
  const current = (await kit.as(org.owner, () => sales.listSpecInventoryPage({ communityId: org.communityId, search: "PK-06", includeToBeBuilt: true }))).lots[0].askingPriceCents
  // A move past the price band waits for a second person: the consultant proposes it and the owner approves.
  const move = await kit.as(org.team.sales, () => sales.proposeSpecPriceChange({ kind: "price", lotId: byNumber["PK-06"], toCents: 41234500, expectedAskingPriceCents: current, reason: PRICE_REASON }))
  if (move.status === "proposed") await kit.as(org.owner, () => sales.decideSpecPriceChange({ proposalId: move.proposalId, approve: true }))

  // A second division with a community and one lot, and consultants limited to each division.
  const divisionB = await kit.as(org.owner, () => divisions.createDivision({ name: "Atlantic", code: "AT", region: "Treasure Coast" }))
  const communityB = await kit.as(org.owner, () => communities.createCommunity({ name: "Harbor Walk", code: "HW", divisionId: divisionB.id, status: "active", city: "Stuart", state: "FL", postalCode: "34994", plannedLotCount: 40, targetAbsorptionPerMonth: 2 }))
  await kit.as(org.owner, () => lots.createLots(communityB.id, { lots: [{ lotNumber: "HB-01", status: "developed", address: "11 Harbor Walk Way", dimensions: { widthFt: 50, depthFt: 110 }, swing: "right", premiumCents: 0, costBasisCents: 6000000 }] }))
  const limited = (role, divisionId) => {
    const actor = kit.addMember(org, role)
    kit.sql(`update public.memberships set division_scope='assigned' where org_id=${q(org.orgId)} and user_id=${q(actor.userId)};
insert into public.membership_divisions(membership_id, division_id) select id, ${q(divisionId)} from public.memberships where org_id=${q(org.orgId)} and user_id=${q(actor.userId)};`)
    return actor
  }
  // A new organisation's directory vocabulary: the buyer roles a registration promotes into. Recorded as found, then
  // completed so the buyer subcases can run past it (see the buyer-search subcase for the check).
  const vocabulary = Object.fromEntries(["prospect", "buyer", "homeowner", "agent"].map((key) => [key, Number(kit.rows(`select count(*)::int n from public.directory_relationship_types where org_id=${q(org.orgId)} and key=${q(key)}`)[0].n) === 1]))
  kit.sql(`insert into public.directory_relationship_types(org_id, key, label, canonical_category, applies_to, is_system, is_active, sort_order) values
    (${q(org.orgId)}, 'prospect', 'Prospect', 'client', 'both', true, true, 100), (${q(org.orgId)}, 'buyer', 'Buyer', 'client', 'both', true, true, 101),
    (${q(org.orgId)}, 'homeowner', 'Homeowner', 'client', 'both', true, true, 102), (${q(org.orgId)}, 'agent', 'Agent', 'other', 'both', true, true, 103) on conflict (org_id, key) do nothing`)
  const consultantA = limited("org_sales_agent", org.divisionId), consultantB = limited("org_sales_agent", divisionB.id)
  return { org, byNumber, held, sold, options, vocabulary, divisionB: divisionB.id, communityB: communityB.id, consultantA, consultantB }
}

// What the sellable lots of community A are, by construction: lots "1".."10" and PK-01..PK-11 and PK-14.
// PK-12 is held and PK-13 is sold. Prices are the sheet's base price plus premium plus structural options,
// or the override; a lot with no plan has no price.
const PLAIN = Array.from({ length: 10 }, (_, index) => String(index + 1))
const ASKING = {
  "PK-01": 38500000, "PK-02": 38500000, "PK-03": 38750000, "PK-04": 39500000, "PK-05": 41350000, "PK-06": 41234500,
  "PK-07": 44500000, "PK-08": 44500000, "PK-09": 44500000, "PK-10": 45500000, "PK-11": 45500000,
}
const labels = (rows) => rows.map((row) => row.lotLabel)
const sortedLabels = (rows) => labels(rows).sort()

const findHomes = (kit, f, actor, opts) => kit.as(actor, () => app("community-sales").listSpecInventoryPage({ communityId: f.org.communityId, includeToBeBuilt: true, limit: 250, ...opts }))

/** Walks a result set page by page from `nextOffset`, the way the dialog's "Show more" does. */
async function walk(kit, f, actor, opts, limit) {
  const pages = []
  let offset = 0
  for (let guard = 0; guard < 40; guard += 1) {
    const page = await findHomes(kit, f, actor, { ...opts, limit, offset })
    pages.push(page)
    if (page.nextOffset == null) break
    offset = page.nextOffset
  }
  return pages
}

// ---------------------------------------------------------------------------
// EP01-03 #0: find a home.

async function findAHomeSearchNarrows(kit, expected, check) {
  const f = await fixture(kit)
  const consultant = f.org.team.sales
  const search = async (term) => sortedLabels((await findHomes(kit, f, consultant, { search: term })).lots)
  const unfiltered = await findHomes(kit, f, consultant, {})
  const everywhere = await kit.as(f.org.owner, () => app("community-sales").listSpecInventoryPage({ includeToBeBuilt: true, limit: 250 }))
  lot().equal(check, "typing a lot number, a plan code or name, or a community narrows Find a home to exactly the sellable lots that match", expected.expected, {
    allSellableInCommunityA: sortedLabels(unfiltered.lots),
    lotNumber: await search("PK-07"),
    partialLotNumber: await search("PK-1"),
    planCode: await search("PL2100"),
    planName: await search("mangrove"),
    communityName: (await search("cypress")).length,
    otherCommunityName: await search("Harbor"),
    noMatch: await search("zzzz-nothing"),
    withoutCommunityTheOwnerSeesBothCommunities: everywhere.lots.length,
  })
  return { orgId: f.org.orgId }
}

async function findAHomePagingWalksEveryLotOnce(kit, expected, check) {
  const f = await fixture(kit)
  const consultant = f.org.team.sales
  const pages = await walk(kit, f, consultant, { order: "lot" }, 5)
  const seen = pages.flatMap((page) => labels(page.lots))
  const filtered = await walk(kit, f, consultant, { order: "lot", search: "PK-" }, 4)
  const filteredSeen = filtered.flatMap((page) => labels(page.lots))
  const planFiltered = await walk(kit, f, consultant, { order: "lot", search: "Palmetto" }, 2)
  lot().equal(check, "a small page walked with nextOffset shows every sellable lot exactly once, never a held or sold one, and the last page ends the walk", expected.expected, {
    walkedLots: seen.length,
    distinctLots: new Set(seen).size,
    walkedSet: [...seen].sort(),
    heldOrSoldShown: seen.filter((label) => label === "PK-12" || label === "PK-13"),
    everyPageWithinItsSize: pages.every((page) => page.lots.length <= 5),
    lastPageEnds: pages[pages.length - 1].nextOffset === null && pages[pages.length - 1].truncated === false,
    searchedWalk: { lots: filteredSeen.length, distinct: new Set(filteredSeen).size, onlyPk: filteredSeen.every((label) => label.startsWith("PK-")) },
    planWalkInPairs: [...planFiltered.flatMap((page) => labels(page.lots))].sort(),
  })
  return { orgId: f.org.orgId }
}

async function findAHomePriceBandAndSortAgreeWithThePriceSheet(kit, expected, check) {
  const f = await fixture(kit)
  const consultant = f.org.team.sales
  const band = async (min, max) => sortedLabels((await findHomes(kit, f, consultant, { minPriceCents: min, maxPriceCents: max })).lots)
  const priced = (lots) => lots.filter((row) => row.askingPriceCents != null)
  const ascending = await findHomes(kit, f, consultant, { order: "price_asc" })
  const descending = await findHomes(kit, f, consultant, { order: "price_desc" })
  const firstUnpriced = (lots) => lots.findIndex((row) => row.askingPriceCents == null)
  const fourBeds = await findHomes(kit, f, consultant, { minBeds: 4 })
  lot().equal(check, "a price band keeps the lots whose price lies in it (an unpriced lot is in no band) and the price sort orders by that price, unpriced last, ties by lot number", expected.expected, {
    band38To40Million: await band(38600000, 40000000),
    bandIsHalfOpen: await band(44500000, 45500000),
    bandNoMinimum: await band(undefined, 38600000),
    unpricedInNoBand: (await band(0, 100000000000)).filter((label) => !(label in ASKING)),
    ascending: labels(priced(ascending.lots)),
    descending: labels(priced(descending.lots)),
    unpricedAreLastAscending: firstUnpriced(ascending.lots) === priced(ascending.lots).length,
    unpricedAreLastDescending: firstUnpriced(descending.lots) === priced(descending.lots).length,
    fourBedroomsOrMore: sortedLabels(fourBeds.lots),
  })
  return { orgId: f.org.orgId }
}

// The view prices structural options only for a member of the org or the service role (the app's
// server reads), never for a bare database superuser, so the check reads it the way the app does.
const asService = (kit, text) => JSON.parse(kit.sql(`set role service_role;\n\\o /dev/null\nselect set_config('request.jwt.claims', '{"role":"service_role"}', false);\n\\o\nselect coalesce(json_agg(t),'[]') from (${text}) t;`) || "[]")

async function viewAskingPriceEqualsTheAppsOwnPrice(kit, expected, check) {
  const f = await fixture(kit)
  const consultant = f.org.team.sales
  const { lots } = await findHomes(kit, f, consultant, {})
  const view = Object.fromEntries(asService(kit, `select lot_number, asking_price_cents from public.sellable_lot_inventory where org_id=${kit.q(f.org.orgId)} and community_id=${kit.q(f.org.communityId)}`).map((row) => [row.lot_number, row.asking_price_cents == null ? null : Number(row.asking_price_cents)]))
  const shown = Object.fromEntries(lots.map((row) => [row.lotLabel, row.askingPriceCents]))
  const ownersView = Object.fromEntries((await findHomes(kit, f, f.org.owner, {})).lots.map((row) => [row.lotLabel, row.askingPriceCents]))
  const sheet = await kit.as(f.org.owner, () => app("community-sales").getCommunityPriceSheet(f.org.communityId))
  // A plain lot (no structural option, no override) costs the sheet row for its elevation, or the plan-wide row, plus its premium.
  const sheetPrice = (planCode, elevationName) => (sheet.rows.find((row) => row.planCode === planCode && row.elevationName === elevationName) ?? sheet.rows.find((row) => row.planCode === planCode && row.elevationName === "Standard"))?.basePriceCents
  const premium = (number) => Number(kit.rows(`select premium_cents from public.lots where org_id=${kit.q(f.org.orgId)} and community_id=${kit.q(f.org.communityId)} and lot_number=${kit.q(number)}`)[0].premium_cents)
  const fromSheet = {
    "PK-01": sheetPrice("MG1650", "Coastal") + premium("PK-01"), "PK-03": sheetPrice("MG1650", "Coastal") + premium("PK-03"), "PK-04": sheetPrice("MG1650", "Craftsman") + premium("PK-04"),
    "PK-07": sheetPrice("PL2100", "Coastal") + premium("PK-07"), "PK-10": sheetPrice("PL2100", "Craftsman") + premium("PK-10"),
  }
  const compared = Object.keys(shown)
  lot().equal(check, "the view's asking price is the price the app shows for every sellable lot: sheet row, premium, structural options, override, an ended row, no plan", expected.expected, {
    lotsCompared: compared.length,
    drift: compared.filter((label) => view[label] !== shown[label]).map((label) => ({ lot: label, view: view[label], app: shown[label] })),
    appPricesAreTheDesignedOnes: Object.fromEntries(Object.keys(ASKING).map((label) => [label, shown[label]])),
    viewPricesAreTheDesignedOnes: Object.fromEntries(Object.keys(ASKING).map((label) => [label, view[label]])),
    unplannedLotsHaveNoPrice: PLAIN.concat("PK-14").every((label) => shown[label] === null && view[label] === null),
    everyViewerSeesTheSamePrice: compared.every((label) => ownersView[label] === shown[label]),
    priceSheetAgrees: Object.fromEntries(Object.entries(fromSheet).map(([label, price]) => [label, price === shown[label]])),
  })
  return { orgId: f.org.orgId }
}

async function findAHomeStaysInTheConsultantsDivision(kit, expected, check) {
  const f = await fixture(kit)
  const read = (actor, opts = {}) => kit.as(actor, () => app("community-sales").listSpecInventoryPage({ includeToBeBuilt: true, limit: 250, ...opts }))
  const owner = await read(f.org.owner), a = await read(f.consultantA), b = await read(f.consultantB)
  const bSearch = await read(f.consultantB, { search: "PK-0" })
  const bAsksForA = await refusal(() => read(f.consultantB, { communityId: f.org.communityId }))
  const aAsksForB = await read(f.consultantA, { divisionId: f.divisionB })
  lot().equal(check, "a consultant limited to one division finds only that division's homes, in every search, and none of another's", expected.expected, {
    ownerSeesBothCommunities: owner.lots.filter((row) => row.lotLabel === "HB-01" || row.lotLabel.startsWith("PK-")).length,
    consultantInDivisionA: { sellable: a.lots.length, seesCommunityBLot: labels(a.lots).includes("HB-01") },
    consultantInDivisionB: { lots: labels(b.lots), total: b.total },
    divisionBSearchForDivisionALots: { lots: bSearch.lots.length, total: bSearch.total },
    divisionBNamingCommunityA: /Community not found/.test(bAsksForA) ? "refused" : bAsksForA,
    divisionANamingDivisionB: { lots: aAsksForB.lots.length, total: aAsksForB.total },
  })
  return { orgId: f.org.orgId }
}

// ---------------------------------------------------------------------------
// EP01-03 #0: buyers.

/** The answer's size, or the failure a page past the last one raises. */
const sizeOrError = (work, size) => work().then(size, (error) => `error: ${error.message}`)
/** A directory contact entered the way the directory's own importer does, with no role yet. */
const addContact = (kit, org, { name, email, phone }) => {
  const id = randomUUID()
  kit.sql(`insert into public.contacts(id, org_id, full_name, email, phone) values(${kit.q(id)}, ${kit.q(org.orgId)}, ${kit.q(name)}, ${kit.q(email)}, ${kit.q(phone)})`)
  return { id }
}
const countByEmail = (kit, orgId, email) => Number(kit.rows(`select count(*)::int n from public.contacts where org_id=${kit.q(orgId)} and lower(email::text)=lower(${kit.q(email)})`)[0].n)
const countRows = (kit, table, orgId) => Number(kit.rows(`select count(*)::int n from public.${table} where org_id=${kit.q(orgId)}`)[0].n)

async function buyerSearchFindsAndAttaches(kit, expected, check) {
  const f = await fixture(kit)
  const { org } = f
  const sales = app("sales-inquiries")
  const stamp = randomUUID().slice(0, 6)
  const email = `ingrid.solberg.${stamp}@acceptance.example.test`
  // A returning buyer already in the directory, and twenty-eight more so the picker has pages.
  const ingrid = addContact(kit, org, { name: "Ingrid Solberg", email, phone: "239-555-0177" })
  kit.sql(`insert into public.contacts(org_id, full_name, email, phone) select ${kit.q(org.orgId)}, 'Pageable Buyer ' || lpad(n::text, 2, '0'), 'pageable.' || n || '@acceptance.example.test', '239-555-' || lpad((2000 + n)::text, 4, '0') from generate_series(1, 28) n`)
  const find = (search, page = 1, pageSize = 25) => kit.as(org.team.sales, () => sales.searchBuyerContacts({ search, page, pageSize }))
  const names = async (search) => (await find(search)).buyers.map((buyer) => buyer.name)
  const first = await find("Pageable", 1, 10), second = await find("Pageable", 2, 10), third = await find("Pageable", 3, 10), fourth = await sizeOrError(() => find("Pageable", 4, 10), (page) => page.buyers.length)
  const seen = [...first.buyers, ...second.buyers, ...third.buyers].map((buyer) => buyer.name)

  // Registering from the picked buyer attaches to that contact; it never makes a second one.
  const before = countByEmail(kit, org.orgId, email)
  const register = (input) => kit.as(org.team.sales, () => sales.registerProductionInquiry({ communityId: org.communityId, ownerUserId: org.team.sales.userId, channel: "walk_in", loggedDate: seed.isoDay(0), ...input }))
  const attached = await register({ buyerName: "Ingrid S", existingContactId: ingrid.id })
  const linked = kit.rows(`select name, (select coalesce(contact_id, promoted_contact_id) from public.prospect_contacts c where c.prospect_id=p.id and c.is_primary limit 1) contact from public.prospects p where p.id=${kit.q(attached.id)}`)[0]
  // The same person typed again in another case.
  const retyped = await register({ buyerName: "Ingrid Solberg", email: email.toUpperCase(), phone: "239-555-0177" })
  const afterRetype = countByEmail(kit, org.orgId, email)
  const retypedLinked = kit.rows(`select coalesce(contact_id, promoted_contact_id) c from public.prospect_contacts where prospect_id=${kit.q(retyped.id)} and is_primary`)[0]

  // Another organisation's contact is refused and writes nothing.
  const foreign = await seed.productionBuilder(kit, { name: "PICK-01 other builder" })
  const foreignContact = randomUUID()
  kit.sql(`insert into public.contacts(id, org_id, full_name, email) values(${kit.q(foreignContact)}, ${kit.q(foreign.orgId)}, 'Foreign Buyer', ${kit.q(`foreign.${stamp}@acceptance.example.test`)})`)
  const prospectsBefore = countRows(kit, "prospects", org.orgId), contactsBefore = countRows(kit, "contacts", org.orgId)
  const crossOrg = await refusal(() => register({ buyerName: "Foreign Buyer", existingContactId: foreignContact }))
  const theirSearch = await kit.as(foreign.team.sales, () => sales.searchBuyerContacts({ search: "Pageable" }))
  lot().equal(check, "the consultant finds a returning buyer by name, email or phone, pages through many, attaches the registration to that contact, and never duplicates a buyer typed in another case or takes another organisation's contact", expected.expected, {
    aNewOrganisationKnowsTheBuyerRoles: f.vocabulary,
    byName: await names("Solberg"),
    byEmail: await names(email.toUpperCase()),
    byPhone: await names("555-0177"),
    byFirstNameFragment: await names("ingri"),
    pagedInTens: { pages: [first.buyers.length, second.buyers.length, third.buyers.length, fourth], total: first.total, distinct: new Set(seen).size, inOrder: JSON.stringify(seen) === JSON.stringify([...seen].sort()) },
    pickedBuyerIsAttached: { prospectCarriesTheirName: linked.name === "Ingrid Solberg", linkedToTheirContact: linked.contact === ingrid.id, contactsWithTheirEmail: countByEmail(kit, org.orgId, email) - before },
    retypedInOtherCase: { contactsWithThatEmail: afterRetype, attachedToTheExistingContact: retypedLinked.c === ingrid.id },
    anotherOrganisationsContact: { refused: /no longer in the directory/i.test(crossOrg) ? "refused" : crossOrg, prospectsWritten: countRows(kit, "prospects", org.orgId) - prospectsBefore, contactsWritten: countRows(kit, "contacts", org.orgId) - contactsBefore },
    otherOrganisationSeesNoneOfOurBuyers: theirSearch.total,
  })
  return { orgId: org.orgId, contactId: ingrid.id }
}

// ---------------------------------------------------------------------------
// EP01-03 #0: projects (homes).

async function projectSearchFindsHomesByNameOrAddress(kit, expected, check) {
  const f = await fixture(kit)
  const { org } = f
  const projects = app("projects")
  const search = (actor, input) => kit.as(actor, () => projects.searchVisibleProjects(input))
  const homes = kit.rows(`select p.id, p.name, p.location->>'address' address, l.lot_number from public.projects p join public.lots l on l.project_id=p.id where p.org_id=${kit.q(org.orgId)} and l.community_id=${kit.q(org.communityId)} and l.lot_number in ('PK-05','PK-06') order by l.lot_number`)
  const byName = await search(org.owner, { search: homes[0].name })
  const byWord = await search(org.owner, { search: homes[0].name.split(/\s+/).find((word) => word.length > 3) })
  const byAddress = await search(org.owner, { search: String(homes[1].address).split(/\s+/)[1] })
  const all = await search(org.owner, { pageSize: 50 })
  const walked = []
  for (let page = 1, guard = 0; guard < 30; guard += 1, page += 1) {
    const got = await search(org.owner, { pageSize: 2, page })
    walked.push(...got.projects.map((row) => row.id))
    if (got.projects.length < 2 || page * 2 >= got.total) break
  }
  const limitedB = await search(f.consultantB, { pageSize: 50 })
  const limitedBSearching = await search(f.consultantB, { search: homes[0].name })
  const limitedA = await search(f.consultantA, { pageSize: 50 })
  lot().equal(check, "a project picker finds a home by the name or address typed, pages through all of them, calls a production home a Home, and a consultant limited to another division finds none", expected.expected, {
    typingTheName: { found: byName.projects.some((row) => row.id === homes[0].id), noun: byName.projects.find((row) => row.id === homes[0].id)?.noun },
    typingAWordOfTheName: byWord.projects.some((row) => row.id === homes[0].id),
    typingAStreetName: byAddress.projects.some((row) => row.id === homes[1].id),
    everyProductionHomeIsAHome: all.projects.filter((row) => homes.some((home) => home.id === row.id)).every((row) => row.noun === "Home"),
    pagedInPairsWalksEveryProjectOnce: { distinct: new Set(walked).size === walked.length, matchesTotal: walked.length === all.total, containsBothSpecHomes: homes.every((home) => walked.includes(home.id)) },
    pageSizeIsCapped: (await search(org.owner, { pageSize: 500 })).pageSize,
    limitedToDivisionB: { projects: limitedB.projects.length, total: limitedB.total, findsDivisionAHomeByName: limitedBSearching.projects.length },
    limitedToDivisionAFindsTheHomes: homes.every((home) => limitedA.projects.some((row) => row.id === home.id)),
  })
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// EP01-03 #0: plans.

/** Released plans (the last of `count` left as an unreleased draft) that the community does not sell yet. */
const EXTRA_PLANS = new WeakMap()
function extraPlans(kit, org, { prefix, count, draftLast }) {
  const key = `${prefix}`
  const cache = EXTRA_PLANS.get(kit) ?? (EXTRA_PLANS.set(kit, new Map()), EXTRA_PLANS.get(kit))
  if (!cache.has(key)) cache.set(key, (async () => {
    const plans = app("house-plans")
    const trees = ["Alder", "Birch", "Cedar", "Dogwood", "Elm"]
    for (let index = 0; index < count; index += 1) {
      const created = await kit.as(org.owner, () => plans.createHousePlan({ code: `${prefix}${3000 + index}`, name: `${prefix === "ZX" ? "Zephyr" : "Nimbus"} ${trees[index % 5]}`, series: "Series", heatedSqft: 1800 + index * 50, totalSqft: 2100 + index * 50, beds: 3, baths: 2, stories: 1, garageBays: 2 }))
      await kit.as(org.owner, () => plans.upsertElevation(created.id, { code: "A", name: "Coastal", sortOrder: 0 }))
      const version = created.versions?.[0] ?? (await kit.as(org.owner, () => plans.listPlanVersions(created.id)))[0]
      await kit.as(org.owner, () => plans.replaceTakeoffLines(version.id, [{ costCodeId: org.costCodeIds["06-100"], description: "Framing scope", quantity: 1800, uom: "sf" }]))
      await kit.as(org.owner, () => plans.updatePlanVersion(version.id, { label: "Launch release", scheduleTemplateId: org.scheduleTemplateId, checklistTemplateIds: [], selectionCategoryIds: [] }))
      if (!(draftLast && index === count - 1)) {
        await kit.as(org.owner, () => plans.releasePlanVersion(version.id))
        await kit.as(org.owner, () => plans.updateHousePlan(created.id, { status: "active" }))
      }
    }
  })())
  return cache.get(key)
}

async function planPickersSearchAndPage(kit, expected, check) {
  const f = await fixture(kit)
  const { org } = f
  const sales = app("community-sales"), lots = app("lots")
  await extraPlans(kit, org, { prefix: "ZX", count: 5, draftLast: true })
  const offerable = (communityId, input, actor = org.team.sales) => kit.as(actor, () => sales.searchOfferablePlans(communityId, input))
  const codes = async (input) => (await offerable(org.communityId, input)).plans.map((plan) => plan.code)
  const walked = []
  let pages = 0
  for (let page = 1; page < 10; page += 1) {
    const got = await offerable(org.communityId, { search: "Zephyr", pageSize: 2, page })
    pages += 1
    walked.push(...got.plans.map((plan) => plan.code))
    if (page * 2 >= got.total) break
  }
  const assignable = async (search) => (await kit.as(org.team.starts, () => lots.listPlanAssignmentOptions(org.communityId, { search }))).plans.map((plan) => plan.code)
  const harbor = (await offerable(f.communityB, {})).plans.map((plan) => plan.code).sort()
  const harborAsConsultantA = await refusal(() => offerable(f.communityB, {}, f.consultantA))
  lot().equal(check, "the plan pickers find a plan by its code or name, offer only released plans the community does not sell yet, and page without skipping or repeating", expected.expected, {
    offerableByCode: await codes({ search: "ZX3002" }),
    offerableByName: await codes({ search: "birch" }),
    offerableByWordOfName: (await codes({ search: "zeph" })).sort(),
    alreadyOfferedAreNotOffered: (await codes({ search: "Mangrove" })).concat(await codes({ search: "PL2100" })),
    unreleasedPlanIsNotOffered: await codes({ search: "ZX3004" }),
    walkedInPairs: { pages, codes: walked, distinct: new Set(walked).size },
    total: (await offerable(org.communityId, { search: "Zephyr" })).total,
    pageSizeIsCapped: (await offerable(org.communityId, { pageSize: 500 })).pageSize,
    pageBeyondTheEndIsEmpty: await sizeOrError(() => offerable(org.communityId, { search: "Zephyr", page: 9 }), (page) => page.plans.length),
    otherCommunityOffersTheWholeLibrary: harbor.filter((code) => /^(MG|PL|ZX)/.test(code)),
    consultantOfAnotherDivision: /Community not found/.test(harborAsConsultantA) ? "refused: community not found" : harborAsConsultantA,
    assignmentSearchByName: await assignable("palm"),
    assignmentSearchByCode: await assignable("MG16"),
    assignmentSearchSkipsAPlanWithNoReleasedVersion: await assignable("Zephyr"),
  })
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// EP01-03 #0: vendors (and the purchasing desk's other pickers).

async function vendorPickersSearchAndPage(kit, expected, check) {
  const f = await fixture(kit)
  const { org } = f
  const purchasing = app("purchasing-workspace"), directory = app("directory")
  const stamp = randomUUID().slice(0, 6)
  kit.sql(`insert into public.companies(org_id, name) select ${kit.q(org.orgId)}, 'Quarry Supply ' || lpad(n::text, 2, '0') || ' ${stamp}' from generate_series(1, 30) n`)
  const foreign = await seed.productionBuilder(kit, { name: "PICK-01 vendor neighbour" })
  kit.sql(`insert into public.companies(org_id, name) values(${kit.q(foreign.orgId)}, 'Quarry Supply Foreign ${stamp}')`)
  const lookup = (kind, search, page = 1, actor = org.team.purchasing) => kit.as(actor, () => purchasing.searchPurchasingEntities({ kind, search, page }))
  const walked = []
  const pageSizes = []
  for (let page = 1, guard = 0; guard < 10; guard += 1) {
    const got = await lookup("vendor", stamp, page)
    pageSizes.push(got.items.length)
    walked.push(...got.items.map((item) => item.name))
    if (got.nextPage == null) break
    page = got.nextPage
  }
  const warrantyWalk = []
  for (let page = 1, guard = 0; guard < 10; guard += 1, page += 1) {
    const got = await kit.as(org.team.warranty, () => directory.listDirectoryPage({ kind: "company", page, pageSize: 25, search: stamp, sort: "name", direction: "asc" }))
    warrantyWalk.push(...got.entries.map((entry) => entry.name))
    if (page * got.pageSize >= got.total) break
  }
  const named = await lookup("vendor", "gulf conc")
  // The purchasing desk's home picker lists homes under construction (delivery phase); PK-06's release stands in as a phase change.
  const specHome = kit.rows(`select p.id, p.name from public.projects p join public.lots l on l.project_id=p.id where p.org_id=${kit.q(org.orgId)} and l.lot_number='PK-06'`)[0]
  kit.sql(`update public.projects set phase='delivery' where id=${kit.q(specHome.id)}`)
  const homes = await lookup("home", specHome.name)
  const communities = await lookup("community", "cypress")
  const plans = await lookup("plan", "palmetto")
  lot().equal(check, "the purchasing and warranty desks find a vendor by the words of its name, page through thirty of them without skipping or repeating any, and never see another organisation's", expected.expected, {
    byWordsOfItsName: named.items.map((item) => item.name),
    walkedPages: pageSizes,
    walkedNames: { count: walked.length, distinct: new Set(walked).size, allMine: walked.every((name) => name.startsWith("Quarry Supply ") && !name.includes("Foreign")), inOrder: JSON.stringify(walked) === JSON.stringify([...walked].sort()) },
    warrantyDeskWalk: { count: warrantyWalk.length, distinct: new Set(warrantyWalk).size, foreignOnes: warrantyWalk.filter((name) => name.includes("Foreign")).length },
    otherOrganisationsVendorIsUnreachable: (await lookup("vendor", `Foreign ${stamp}`)).items.length,
    homePickerFindsAHomeByName: homes.items.some((item) => item.id === specHome.id && item.name === specHome.name),
    communityPicker: communities.items.map((item) => item.name),
    planPicker: plans.items.map((item) => item.name),
  })
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// EP01-03 #1: operators never paste an id.

async function noPickerAsksForAnId(kit, expected, check) {
  const f = await fixture(kit)
  const { org } = f
  const sales = app("community-sales"), inquiries = app("sales-inquiries"), lots = app("lots"), purchasing = app("purchasing-workspace")
  const consultant = org.team.sales
  const stamp = randomUUID().slice(0, 6)
  await extraPlans(kit, org, { prefix: "NP", count: 1, draftLast: false })
  // Every picker answers a typed word with rows that carry a human label and the id the form will submit.
  const homeRows = (await kit.as(consultant, () => sales.listSpecInventoryPage({ communityId: org.communityId, includeToBeBuilt: true, search: "PK-10" }))).lots
  const lotPicker = await kit.as(consultant, () => sales.listSellableLots(org.communityId, "PK-10"))
  const vendorRows = (await kit.as(org.team.purchasing, () => purchasing.searchPurchasingEntities({ kind: "vendor", search: "Gulf" }))).items
  const planRows = (await kit.as(org.team.purchasing, () => purchasing.searchPurchasingEntities({ kind: "plan", search: "Mangrove" }))).items
  const humanLabel = (label) => typeof label === "string" && label.length > 0 && !UUID.test(label)
  // The whole sale, reaching every record by typing words: pick the lot, pick the buyer, hold it.
  const contact = addContact(kit, org, { name: `Verity Lindqvist ${stamp}`, email: `verity.${stamp}@acceptance.example.test`, phone: "239-555-0188" })
  const foundBuyer = (await kit.as(consultant, () => inquiries.searchBuyerContacts({ search: `lindqvist ${stamp}` }))).buyers[0]
  const prospect = await kit.as(consultant, () => inquiries.registerProductionInquiry({ buyerName: foundBuyer.name, existingContactId: foundBuyer.id, communityId: org.communityId, ownerUserId: consultant.userId, channel: "walk_in", loggedDate: seed.isoDay(0) }))
  const hold = await kit.as(consultant, () => sales.createLotHoldFromProspect({ prospectId: prospect.id, lotId: homeRows[0].lotId, expiresAt: new Date(Date.now() + 86400000).toISOString() }))
  const holdRow = kit.rows(`select lot_id, buyer_contact_id, status from public.lot_reservations where id=${kit.q(hold.id)}`)[0]
  // The offering and the plan assignment, from the plans the pickers returned.
  const offered = (await kit.as(consultant, () => sales.searchOfferablePlans(org.communityId, { search: "NP3000" }))).plans[0]
  await kit.as(org.owner, () => sales.offerPlanInCommunity({ communityId: org.communityId, housePlanId: offered.id, basePriceCents: 41000000 }))
  const options = (await kit.as(org.team.starts, () => lots.listPlanAssignmentOptions(org.communityId, { search: "NP3000" }))).plans[0]
  const targetLot = (await kit.as(consultant, () => sales.listSellableLots(org.communityId, "PK-14"))).lots[0]
  await kit.as(org.team.starts, () => lots.assignPlanToLot(targetLot.id, { versionId: options.versions[0].id, elevationId: options.elevations[0].id }))
  const priced = (await kit.as(consultant, () => sales.listSpecInventoryPage({ communityId: org.communityId, includeToBeBuilt: true, search: "PK-14" }))).lots[0]
  lot().equal(check, "every picker is searched with words and returns a labelled row with the id the form submits; a sale, an offering and a plan assignment are reached with no id typed or pasted", expected.expected, {
    findAHome: { rows: homeRows.length, label: humanLabel(homeRows[0].lotLabel) && humanLabel(homeRows[0].planLabel), idIsAUuid: UUID.test(homeRows[0].lotId) },
    lotPicker: { rows: lotPicker.lots.length, label: humanLabel(lotPicker.lots[0].lotNumber), idIsAUuid: UUID.test(lotPicker.lots[0].id), tellsWhenItTruncates: typeof lotPicker.truncated === "boolean" },
    vendorPicker: { rows: vendorRows.length, label: humanLabel(vendorRows[0].name), idIsAUuid: UUID.test(vendorRows[0].id) },
    planPicker: { rows: planRows.length, label: humanLabel(planRows[0].name), idIsAUuid: UUID.test(planRows[0].id) },
    buyerPicker: { label: humanLabel(foundBuyer.name), idIsAUuid: UUID.test(foundBuyer.id), isTheContactEntered: foundBuyer.id === contact.id },
    holdFromWords: { status: holdRow.status, onThePickedLot: holdRow.lot_id === homeRows[0].lotId, forThePickedBuyer: holdRow.buyer_contact_id === contact.id },
    planAssignedFromThePickers: { lot: priced.lotLabel, plan: priced.planLabel, askingPriceCents: priced.askingPriceCents },
  })
  return { orgId: org.orgId, reservationId: hold.id }
}

const subcases = {
  "find-a-home-search-narrows": findAHomeSearchNarrows,
  "find-a-home-paging-walks-every-lot-once": findAHomePagingWalksEveryLotOnce,
  "find-a-home-price-band-and-sort-agree-with-the-price-sheet": findAHomePriceBandAndSortAgreeWithThePriceSheet,
  "view-asking-price-equals-the-apps-own-price": viewAskingPriceEqualsTheAppsOwnPrice,
  "find-a-home-stays-in-the-consultants-division": findAHomeStaysInTheConsultantsDivision,
  "buyer-search-finds-and-attaches": buyerSearchFindsAndAttaches,
  "project-search-finds-homes-by-name-or-address": projectSearchFindsHomesByNameOrAddress,
  "plan-pickers-search-and-page": planPickersSearchAndPage,
  "vendor-pickers-search-and-page": vendorPickersSearchAndPage,
  "no-picker-asks-for-an-id": noPickerAsksForAnId,
}
module.exports = { subcases }
