// A production builder on the isolated acceptance stack (EP13-01, EP14-01,
// EP14-07): one division, one community of twenty lots, two released house
// plans with a priced option catalog, a price book, and homes at every stage of
// the lifecycle. Everything goes through Arc's own services acting as the role
// that owns the step. What the stack cannot do (file storage, e-signature
// delivery) is set up directly and says so where it happens; the product
// defects the chain runs into are named `DEFECT` where they are worked around.
//
// Used by browser-seed.cjs (journey "production") and scenarios/lot-01.cjs.
const { createHash, randomUUID } = require("node:crypto")
const { app, greenfieldOrg, project } = require("./scenarios/shared.cjs")

const EVIDENCE = "https://evidence.acceptance.example.test/production"

const COST_CODES = [
  { code: "31-000", name: "Sitework" },
  { code: "03-300", name: "Foundation" },
  { code: "06-100", name: "Framing" },
  { code: "22-000", name: "Plumbing" },
  { code: "26-000", name: "Electrical" },
]

// Trade agreements (dollars, as the price-book importer reads them) and the plan
// takeoffs they price. A plan's purchase orders total what these say.
const TRADES = [
  { vendor: "Cypress Sitework", costCode: "31-000", uom: "ls", unitPriceDollars: 34000 },
  { vendor: "Gulf Concrete", costCode: "03-300", uom: "ls", unitPriceDollars: 58000 },
  { vendor: "Palmetto Framing", costCode: "06-100", uom: "sf", unitPriceDollars: 44 },
  { vendor: "Coastal Plumbing", costCode: "22-000", uom: "ls", unitPriceDollars: 41000 },
  { vendor: "Bright Electric", costCode: "26-000", uom: "ls", unitPriceDollars: 46000 },
]

const PLANS = [
  { code: "MG1650", name: "The Mangrove", heatedSqft: 1650, beds: 3, baths: 2, basePriceCents: 38500000 },
  { code: "PL2100", name: "The Palmetto", heatedSqft: 2100, beds: 4, baths: 3, basePriceCents: 44500000 },
]

// What the trades cost on a plan: lump sums plus framing by square foot.
function planTradeCostCents(plan) {
  return TRADES.reduce((sum, trade) => sum + Math.round((trade.uom === "sf" ? plan.heatedSqft : 1) * trade.unitPriceDollars * 100), 0)
}

// Options. Structural options change the house; design-studio options are the
// buyer's choices. `vendor` names the trade that supplies it, so a selected
// option is bought from that trade without needing its own price agreement.
const OPTIONS = [
  { category: "Structure", name: "Extended garage bay", scope: "structural", priceCents: 1850000, costCents: 1100000, costCode: "03-300", sku: "ST-GAR", vendor: "Gulf Concrete" },
  { category: "Kitchen", name: "Quartz countertops", scope: "design_studio", priceCents: 480000, costCents: 290000, costCode: "06-100", sku: "KT-QTZ", vendor: "Palmetto Framing" },
  { category: "Flooring", name: "Wide-plank LVP throughout", scope: "design_studio", priceCents: 720000, costCents: 430000, costCode: "06-100", sku: "FL-LVP", vendor: "Palmetto Framing" },
  { category: "Electrical", name: "Recessed lighting package", scope: "design_studio", priceCents: 260000, costCents: 150000, costCode: "26-000", sku: "EL-LGT", vendor: "Bright Electric" },
]
const DESIGN_PICKS = { Kitchen: "KT-QTZ", Flooring: "FL-LVP", Electrical: "EL-LGT" }

const csv = (headers, rows) => [headers.join(","), ...rows.map((row) => headers.map((h) => { const t = String(row[h] ?? ""); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }).join(","))].join("\n")
const glId = (kit, org, code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0].id
/**
 * The seeded builder's day. Orgs default to America/New_York and the seeded
 * community sets no zone of its own, so selection cutoffs (EP06-03) are judged
 * on this day, not the server's UTC date, which runs a day ahead every evening.
 */
const SEED_TIME_ZONE = "America/New_York"
const seedToday = (now) => new Intl.DateTimeFormat("en-CA", { timeZone: SEED_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
const isoDay = (offsetDays = 0, now = new Date()) => new Date(Date.parse(`${seedToday(now)}T12:00:00Z`) + offsetDays * 86400000).toISOString().slice(0, 10)

// Months from June 2026 through the month after next, so a release dated a few
// days from now always lands in an open accounting period.
function defaultPeriods(now = new Date()) {
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1))
  const periods = []
  for (let cursor = new Date(Date.UTC(2026, 5, 1)); cursor <= last; cursor.setUTCMonth(cursor.getUTCMonth() + 1))
    periods.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`)
  return periods
}

/** The organisation: Books launched, one member per production role. */
async function productionBuilder(kit, { name = "Production builder", password = null, periods = defaultPeriods(), lots = 20 } = {}) {
  const { q } = kit
  const ids = { vendorIds: {}, costCodeIds: {}, scheduleTemplateId: randomUUID() }
  const org = await greenfieldOrg(kit, { name, password, periods, productTier: "production", reviewerRole: "org_accountant", setup: (org) => {
    const statements = ["begin;"]
    for (const code of COST_CODES) {
      ids.costCodeIds[code.code] = randomUUID()
      statements.push(`insert into public.cost_codes(id,org_id,code,name) values(${q(ids.costCodeIds[code.code])},${q(org.orgId)},${q(code.code)},${q(code.name)});`)
    }
    for (const trade of TRADES) {
      ids.vendorIds[trade.vendor] = randomUUID()
      statements.push(`insert into public.companies(id,org_id,name) values(${q(ids.vendorIds[trade.vendor])},${q(org.orgId)},${q(trade.vendor)});`)
    }
    const items = [["Permit release", -35, 1], ["Foundation", 0, 14], ["Framing", 14, 21], ["Dry-in", 35, 10], ["MEP rough", 45, 18], ["Drywall", 63, 14], ["Interior finishes", 77, 28], ["Punch and close", 105, 14]]
      .map(([name, start_offset_days, duration_days]) => ({ name, start_offset_days, duration_days }))
    statements.push(`insert into public.schedule_templates(id,org_id,name,property_type,items,created_by) values(${q(ids.scheduleTemplateId)},${q(org.orgId)},'120-day production build','production',${q(JSON.stringify(items))}::jsonb,${q(org.owner.userId)});`, "commit;")
    kit.sql(statements.join("\n"))
    Object.assign(org, ids)
  } })
  const roles = {
    land: "org_land_manager", sales: "org_sales_agent", starts: "org_starts_coordinator", purchasing: "org_purchasing_manager",
    superintendent: "org_superintendent", warranty: "org_warranty_manager", design: "org_design_studio_coordinator",
  }
  org.team = Object.fromEntries(Object.entries(roles).map(([key, role]) => [key, kit.addMember(org, role, { password })]))
  seedAgreementPacket(kit, org)
  org.plans = []
  org.lots = []
  org.lotCount = lots
  return org
}

/**
 * The org's own purchase agreement, published for its Florida homes (Arc ships
 * no legal text; every production community the scenarios build is in Florida). The stack has no file storage: the template is a file row and a
 * checksum, which is all the packet binds; rendering it needs --storage-env.
 */
function seedAgreementPacket(kit, org) {
  const { q } = kit
  const fileId = randomUUID(), templateId = randomUUID(), versionId = randomUUID()
  kit.sql(`begin;
insert into public.files(id,org_id,file_name,storage_path,mime_type,size_bytes) values(${q(fileId)},${q(org.orgId)},'purchase-agreement.pdf','acceptance/purchase-agreement.pdf','application/pdf',48000);
insert into public.agreement_templates(id,org_id,kind,name,created_by) values(${q(templateId)},${q(org.orgId)},'agreement','Florida purchase agreement',${q(org.owner.userId)});
insert into public.agreement_template_versions(id,org_id,template_id,version_number,title,required,applies_to_states,source_file_id,content_sha256,size_bytes,page_count,storage_path,created_by)
  values(${q(versionId)},${q(org.orgId)},${q(templateId)},1,'Florida new home purchase agreement',true,'{FL}',${q(fileId)},${q("a".repeat(64))},48000,12,'acceptance/purchase-agreement.pdf',${q(org.owner.userId)});
select public.publish_agreement_template_version(${q(org.orgId)},${q(versionId)},${q(org.owner.userId)});
commit;`)
  org.agreementTemplateId = templateId
}

/** The documents a sale on this lot is written on, as the seller reviews them: none optional picked, and the hash creation checks. */
function agreementPacketFor(kit, org, lotId, optionalAddendumTemplateIds = []) {
  const { q } = kit
  const [row] = kit.rows(`select public.resolve_agreement_packet(${q(org.orgId)},(select community_id from public.lots where id=${q(lotId)}),${q(JSON.stringify(optionalAddendumTemplateIds))}::jsonb)->>'hash' as hash`)
  return { optionalAddendumTemplateIds, expectedPacketHash: row.hash }
}

/** The copy of a change order the buyer signed on paper, as a file on the home: what an offline amendment approval must carry. */
function signedCopyFile(kit, org, projectId, name = "signed-change-order.pdf") {
  const id = randomUUID()
  kit.sql(`insert into public.files(id,org_id,project_id,file_name,storage_path,mime_type) values(${kit.q(id)},${kit.q(org.orgId)},${kit.q(projectId)},${kit.q(name)},${kit.q(`acceptance/${id}.pdf`)},'application/pdf')`)
  return id
}

/** Division, community, phases, lots, takedown and team assignments. */
async function seedCommunity(kit, org) {
  const { createDivision } = app("divisions"), communities = app("communities"), lotsService = app("lots")
  const division = await kit.as(org.owner, () => createDivision({ name: "Gulf Coast", code: "GC", region: "Southwest Florida" }))
  org.divisionId = division.id
  const community = await kit.as(org.owner, () => communities.createCommunity({ name: "Cypress Landing", code: "CYP", divisionId: division.id, status: "active", city: "Naples", state: "FL", postalCode: "34119", plannedLotCount: org.lotCount, targetAbsorptionPerMonth: 3 }))
  org.communityId = community.id
  const phase1 = await kit.as(org.team.land, () => communities.createCommunityPhase(community.id, { name: "Phase 1", phaseNumber: 1, status: "open" }))
  const phase2 = await kit.as(org.team.land, () => communities.createCommunityPhase(community.id, { name: "Phase 2", phaseNumber: 2, status: "planned" }))
  org.phaseIds = [phase1.id, phase2.id]
  // The first tranche is bought under a signed purchase contract whose $10,000
  // earnest money is credited against it at close: the takedown joins the
  // contract while it is a draft, the deposit is scheduled against the takedown,
  // then the contract is executed and the deposit paid, each with its document.
  const landContracts = app("land-contracts")
  const contract = await kit.as(org.team.land, () => landContracts.createLandContract(community.id, { title: "Cypress Landing phase 1 purchase", kind: "purchase", totalLots: 10, basePricePerLotCents: 7200000 }))
  const takedown = await kit.as(org.team.land, () => communities.createLotTakedown(community.id, { name: "Tranche 1", communityPhaseId: phase1.id, scheduledDate: "2026-06-01", lotCount: 10, pricePerLotCents: 7200000, landContractId: contract.id }))
  org.takedownId = takedown.id
  const deposit = await kit.as(org.team.land, () => landContracts.scheduleLandContractDeposit(contract.id, { label: "Earnest money", takedownId: takedown.id, dueOn: "2026-05-15", amountCents: 1000000, refundability: "refundable" }))
  // The stack has no file storage: the signed contract and the wire receipt are file rows.
  const [signedFileId, receiptFileId] = [randomUUID(), randomUUID()]
  kit.sql(`insert into public.files(id,org_id,file_name,storage_path,mime_type) values(${kit.q(signedFileId)},${kit.q(org.orgId)},'cypress-landing-purchase-agreement.pdf','acceptance/cypress-landing-purchase-agreement.pdf','application/pdf'),(${kit.q(receiptFileId)},${kit.q(org.orgId)},'cypress-landing-earnest-wire.pdf','acceptance/cypress-landing-earnest-wire.pdf','application/pdf')`)
  await kit.as(org.team.land, () => landContracts.executeLandContract(contract.id, { executedOn: "2026-05-01", executedFileId: signedFileId }))
  await kit.as(org.team.land, () => landContracts.recordLandContractDepositPayment(deposit.id, { paidOn: "2026-05-15", paymentReference: "Wire 0515", evidenceFileId: receiptFileId }))
  // Ten lots in the first tranche, ten later; premiums on every fifth lot.
  const lotRows = Array.from({ length: org.lotCount }, (_, index) => ({
    lotNumber: String(index + 1), phaseId: index < 10 ? phase1.id : phase2.id, takedownId: index < 10 ? takedown.id : null,
    status: "controlled", address: `${4100 + index} Cypress Landing Way`, dimensions: { widthFt: 52 + (index % 4), depthFt: 115 },
    swing: index % 2 ? "left" : "right", premiumCents: index % 5 === 0 ? 1500000 : 0, costBasisCents: 7200000,
  }))
  await kit.as(org.team.land, () => lotsService.createLots(community.id, { lots: lotRows }))
  org.lots = kit.rows(`select id, lot_number from public.lots where org_id=${kit.q(org.orgId)} and community_id=${kit.q(community.id)} order by lot_number::int`)
  for (const [role, key] of [["land", "land"], ["sales", "sales"], ["superintendent", "superintendent"], ["warranty", "warranty"]])
    kit.sql(`insert into public.community_assignments(org_id,community_id,user_id,role) values(${kit.q(org.orgId)},${kit.q(community.id)},${kit.q(org.team[key].userId)},${kit.q(role)}) on conflict do nothing;`)
  return org
}

/** Plans with takeoffs and a released version, the option catalog and prices, the price book, and the community's offering. */
async function seedProduct(kit, org) {
  const plansService = app("house-plans"), catalog = app("option-catalog"), sales = app("community-sales"), imports = app("imports")
  for (const plan of PLANS) {
    const created = await kit.as(org.owner, () => plansService.createHousePlan({ code: plan.code, name: plan.name, series: "Cypress Landing", heatedSqft: plan.heatedSqft, totalSqft: plan.heatedSqft + 320, beds: plan.beds, baths: plan.baths, stories: 1, garageBays: 2 }))
    const elevations = []
    for (const [index, [code, label]] of [["A", "Coastal"], ["B", "Craftsman"]].entries())
      elevations.push(await kit.as(org.owner, () => plansService.upsertElevation(created.id, { code, name: label, sortOrder: index })))
    const version = created.versions?.[0] ?? (await kit.as(org.owner, () => plansService.listPlanVersions(created.id)))[0]
    await kit.as(org.owner, () => plansService.replaceTakeoffLines(version.id, TRADES.map((trade) => ({
      costCodeId: org.costCodeIds[trade.costCode], description: `${trade.vendor} scope`, quantity: trade.uom === "sf" ? plan.heatedSqft : 1, uom: trade.uom,
    }))))
    await kit.as(org.owner, () => plansService.updatePlanVersion(version.id, { label: "Launch release", scheduleTemplateId: org.scheduleTemplateId, checklistTemplateIds: [], selectionCategoryIds: [] }))
    await kit.as(org.owner, () => plansService.releasePlanVersion(version.id))
    // A plan is offered for sale once it is active; only an active plan can be priced.
    await kit.as(org.owner, () => plansService.updateHousePlan(created.id, { status: "active" }))
    org.plans.push({ ...plan, id: created.id, versionId: version.id, elevationIds: elevations.map((e) => e.id), tradeCostCents: planTradeCostCents(plan) })
  }
  // Price book: one agreement per trade, effective before any start.
  const rows = TRADES.map((trade) => ({ vendor: trade.vendor, cost_code: trade.costCode, description: `${trade.vendor} agreement`, uom: trade.uom, unit_price_cents: trade.unitPriceDollars, effective_start: "2026-01-01" }))
  const batch = await kit.as(org.owner, () => imports.stageImportBatch({ importer: "price_book", csvText: csv(Object.keys(rows[0]), rows), sourceFilename: "trade-agreements.csv" }))
  if (batch.error_count > 0) throw Error(`Price book failed validation: ${JSON.stringify(batch.report).slice(0, 400)}`)
  await kit.as(org.owner, () => imports.commitImportBatch(batch.id))
  // Option catalog, priced per plan version.
  const categories = {}
  for (const [index, name] of [...new Set(OPTIONS.map((o) => o.category))].entries())
    categories[name] = (await kit.as(org.team.design, () => catalog.upsertCategory({ name, sortOrder: index }))).id
  org.optionIds = {}
  for (const [index, option] of OPTIONS.entries()) {
    const saved = await kit.as(org.team.design, () => catalog.upsertOption({ categoryId: categories[option.category], name: option.name, optionScope: option.scope, priceCents: option.priceCents, costCents: option.costCents, costCodeId: org.costCodeIds[option.costCode], sku: option.sku, vendor: option.vendor, sortOrder: index, isAvailable: true }))
    org.optionIds[option.sku] = saved.id
    for (const plan of org.plans) await kit.as(org.team.design, () => catalog.setCatalogPrice({ optionId: saved.id, housePlanVersionId: plan.versionId, priceCents: option.priceCents, costCents: option.costCents, isAvailable: true }))
  }
  org.categoryIds = categories
  const group = await kit.as(org.team.design, () => catalog.upsertSelectionGroup({ name: "Interior selections", scheduleTaskKey: "interior-finishes", cutoffOffsetDays: -14, cutoffAnchor: "start", sortOrder: 0, categoryIds: Object.keys(DESIGN_PICKS).map((name) => categories[name]) }))
  org.selectionGroupId = group.id
  for (const plan of org.plans) await kit.as(org.owner, () => sales.offerPlanInCommunity({ communityId: org.communityId, housePlanId: plan.id, basePriceCents: plan.basePriceCents }))
  return org
}

/**
 * The first land tranche: the actual purchase is recorded in Books (the ledger
 * authority refuses to close a takedown on an expected price), the takedown
 * closes and its lots are owned, then the land manager develops them.
 */
async function takeDownTranche(kit, org, { date = "2026-06-02" } = {}) {
  const communities = app("communities"), lotsService = app("lots"), inventory = app("books/inventory")
  const tranche = org.lots.slice(0, 10)
  const landCents = 7200000
  org.trancheLotIds = tranche.map((lot) => lot.id)
  org.landCentsPerLot = landCents
  await kit.as(org.owner, () => inventory.acquireLandInventory({ date, allocations: tranche.map((lot) => ({ lotId: lot.id, amountCents: landCents })), cashAccountId: glId(kit, org, "1000"), cashCents: landCents * tranche.length, debtInstrumentId: null, debtCents: 0, reference: "Cypress Landing tranche 1", evidenceUrl: `${EVIDENCE}/tranche-1` }))
  await kit.as(org.team.land, () => communities.closeLotTakedown(org.takedownId, { actualDate: date }))
  await kit.as(org.team.land, () => lotsService.bulkUpdateLots(org.communityId, { lotIds: org.trancheLotIds, patch: { status: "developed" } }))
}

/** A phone of the buyer's own, derived from their email: leads are matched on phone too, so buyers never share one. */
function buyerPhone(email) {
  const n = createHash("sha256").update(email).digest().readUInt32BE(0)
  return `239-${200 + (n % 800)}-${String(Math.floor(n / 800) % 10000).padStart(4, "0")}`
}

/** A buyer registered at the model home; the consultant owns the deal. */
function registerBuyer(kit, org, { name, email, date = "2026-06-04" }) {
  return kit.as(org.team.sales, () => app("sales-inquiries").registerProductionInquiry({ buyerName: name, email, phone: buyerPhone(email), communityId: org.communityId, ownerUserId: org.team.sales.userId, channel: "walk_in", planInterest: "Mangrove", loggedDate: date }))
}

/**
 * The consultant's two steps on the reservation dialog: save a review of the hold, then
 * reserve, which commits the home, the earnest invoice and the lot in one database step.
 * Returns the reservation with the home and deposit invoice the commit receipted.
 */
async function reserveHold(kit, actor, { reservationId, depositCents }) {
  const sales = app("community-sales")
  const identity = { scope: { orgId: actor.orgId, actorId: actor.userId, reservationId }, requestKey: randomUUID() }
  const review = await kit.as(actor, () => sales.registerReservationConversion({ ...identity, input: { reservationId, depositCents } }))
  const state = await kit.as(actor, () => sales.convertHoldToReservation({ ...identity, input: review.input }))
  return { id: reservationId, projectId: state.receipt.projectId, depositInvoiceId: state.receipt.invoiceId }
}

/** Hold, then reservation with the earnest deposit invoiced; the deposit received when `receivedOn` is given. */
async function reserveLot(kit, org, { prospect, lotId, depositCents, receivedOn = null }) {
  const sales = app("community-sales")
  const hold = await kit.as(org.team.sales, () => sales.createLotHoldFromProspect({ prospectId: prospect.id, lotId, expiresAt: new Date(Date.now() + 14 * 86400000).toISOString() }))
  const reservation = await reserveHold(kit, org.team.sales, { reservationId: hold.id, depositCents })
  if (receivedOn) await kit.as(org.owner, () => app("payments").recordMultiInvoicePayment({ received_at: `${receivedOn}T12:00:00Z`, method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: reservation.depositInvoiceId, amount_cents: depositCents }] }))
  return { hold, reservation }
}

/** The agreement configuration for a lot: plan, elevation, swing and the chosen options. */
function configuration(org, { lotId, plan, swing, skus = [], incentiveIds = [] }) {
  return { lotId, housePlanVersionId: plan.versionId, elevationId: plan.elevationIds[0], swing, optionItems: skus.map((sku) => ({ optionId: org.optionIds[sku] })), incentiveIds }
}

/**
 * Quote, create and execute a purchase agreement. E-signature delivery needs file
 * storage, which the acceptance stack only has under --storage-env; without it the
 * agreement stays saved as a draft until execution, which runs through the same
 * service the envelope-completion handler calls.
 */
async function signAgreement(kit, org, { reservationId, config }) {
  const sales = app("community-sales")
  const quote = await kit.as(org.team.sales, () => sales.priceAgreementDraft(config))
  const created = await kit.as(org.team.sales, () => sales.createPurchaseAgreement({ ...config, ...agreementPacketFor(kit, org, config.lotId), reservationId, expectedQuoteHash: quote.quoteHash }))
    .catch((error) => { if (!/^Missing (R2 credentials|DOCUMENT_SIGNING_SECRET)/.test(error.message)) throw error; return null })
  const contract = kit.rows(`select id, status, project_id, total_cents from public.contracts where org_id=${kit.q(org.orgId)} and contract_type='purchase_agreement' and id in (select contract_id from public.lot_reservations where id=${kit.q(reservationId)})`)[0]
  if (!contract) throw Error("The purchase agreement was not saved")
  const draft = { ...contract }
  await kit.service(() => sales.executePurchaseAgreementFromEnvelopeExecution({ orgId: org.orgId, contractId: contract.id, envelopeId: randomUUID() }))
  return { quote, contractId: contract.id, projectId: contract.project_id, draft, signingPrepared: Boolean(created?.signing?.documentId) }
}

/**
 * The buyer approves a group's selections at the design studio table (EP06-02):
 * the approval is bound to the terms on screen and carries the buyer's signed
 * copy, filed on the home. Returns how many of the group's selections are now
 * confirmed.
 */
async function approveSelectionsInPerson(kit, org, { projectId, groupId = org.selectionGroupId, actor = org.team.design }) {
  const approvals = app("selection-approvals")
  const group = (await kit.as(actor, () => approvals.listHomeSelectionApprovals(projectId))).find((row) => row.groupId === groupId)
  if (!group) throw Error("The home has no such selection group")
  await kit.as(actor, () => approvals.recordInPersonSelectionApproval({ projectId, groupId, termsHash: group.terms.termsHash, signedCopyFileId: signedCopyFile(kit, org, projectId, "signed-selections.pdf") }))
  return kit.rows(`select count(*)::int n from public.project_selections where project_id=${kit.q(projectId)} and group_id=${kit.q(groupId)} and status='confirmed'`)[0].n
}

/**
 * The buyer's design choices, approved, and the group's cutoff passed. Signing
 * locks only the structural rows the agreement wrote; design rows stay open until
 * their group's cutoff.
 */
async function chooseDesign(kit, org, { projectId, picks = DESIGN_PICKS }) {
  const selections = app("selections"), cutoffs = app("selection-cutoffs")
  const rows = kit.rows(`select s.id, c.name, s.locked_at from public.project_selections s join public.selection_categories c on c.id=s.category_id where s.project_id=${kit.q(projectId)} and s.group_id is not null order by c.name`)
  const lockedAfterSigning = rows.filter((row) => row.locked_at).length
  for (const row of rows) await kit.as(org.team.design, () => selections.selectProjectOption({ orgId: org.orgId, projectId, selectionId: row.id, optionId: org.optionIds[picks[row.name]] }))
  await approveSelectionsInPerson(kit, org, { projectId, actor: org.owner })
  await kit.as(org.team.design, () => cutoffs.overrideGroupCutoff({ projectId, groupId: org.selectionGroupId, cutoffDate: isoDay(-1), reason: "Buyer finished the design appointment" }))
  return { rows, lockedAfterSigning }
}

/** A document on the home. The stack has no file storage, so its record stands in for the upload. */
function homeFile(kit, org, projectId, name) {
  const id = randomUUID()
  kit.sql(`insert into public.files(id,org_id,project_id,file_name,storage_path,mime_type) values(${kit.q(id)},${kit.q(org.orgId)},${kit.q(projectId)},${kit.q(name)},${kit.q(`acceptance/${id}.pdf`)},'application/pdf')`)
  return id
}

/** The county the builder pulls building permits from: a directory company, created once per org. */
function permitAuthority(kit, org) {
  if (!org.permitAuthorityId) {
    org.permitAuthorityId = randomUUID()
    kit.sql(`insert into public.companies(id,org_id,name) values(${kit.q(org.permitAuthorityId)},${kit.q(org.orgId)},'Collier County Growth Management')`)
  }
  return org.permitAuthorityId
}

/**
 * The home's building permit, applied for and approved through the permits
 * service by the starts coordinator: the plot plan attached, the submission
 * recorded (snapshotting the lot's pinned plan), and the approval recorded on
 * the issued permit and the approved plan set. The permit and plot-plan start
 * gates read this application.
 */
async function approvePermit(kit, org, { projectId }) {
  const permits = app("permits")
  const as = (operation) => kit.as(org.team.starts, operation)
  const { applicationId } = await as(() => permits.createPermitApplication({ projectId, jurisdictionCompanyId: permitAuthority(kit, org), permitType: "building" }))
  await as(() => permits.setPermitDocument({ applicationId, documentKind: "plot_plan", fileId: homeFile(kit, org, projectId, "plot-plan.pdf") }))
  await as(() => permits.recordPermitSubmission({ applicationId, submittedOn: isoDay(-30), reference: "CYP-PLAN-REVIEW" }))
  await as(() => permits.recordPermitDecision({
    applicationId, decision: "approved", decidedOn: isoDay(-2), permitNumber: `BLD-${projectId.slice(0, 8).toUpperCase()}`,
    issuedPermitFileId: homeFile(kit, org, projectId, "building-permit.pdf"), approvedPlansFileId: homeFile(kit, org, projectId, "approved-plans.pdf"),
  }))
  return applicationId
}

/** Opens the lot's start package and clears every gate a person owns. */
async function clearStartGates(kit, org, { lotId, projectId: known = null, spec = false }) {
  const starts = app("starts"), generation = app("po-generation")
  const pkg = await kit.as(org.team.starts, () => starts.openStartPackage(lotId, { isFinanced: false }))
  const projectId = known ?? kit.rows(`select project_id from public.start_packages where id=${kit.q(pkg.id)}`)[0].project_id
  const permitApplicationId = await approvePermit(kit, org, { projectId })
  const preview = await kit.as(org.team.starts, () => generation.generatePurchaseOrders({ projectId, mode: "dry_run" }))
  const gates = await kit.as(org.team.starts, () => starts.refreshAutoGates(pkg.id))
  const gateId = (key) => gates.find((gate) => gate.key === key).id
  // A spec home has no buyer and so no selection groups to lock; the starts desk waives that gate with its reason.
  if (spec) await kit.as(org.team.starts, () => starts.waiveGate(pkg.id, gateId("selections_locked"), { reason: "Spec home: the builder makes the selections, no buyer to lock them." }))
  await kit.as(org.team.starts, () => starts.attestGate(pkg.id, gateId("final_approval"), { notes: "Approved for the week's release" }))
  return { packageId: pkg.id, projectId, permitApplicationId, opened: pkg, preview, ready: await kit.as(org.team.starts, () => starts.getStartPackage(pkg.id)) }
}

/**
 * Adopts the home for owned-inventory accounting (DEFECT D4: the placeholder
 * contract the sale creates beside the purchase agreement must be given a revenue
 * policy first) and releases it, running the release worker to completion. File
 * storage is what copies the plan-set PDF, so without it that one step is settled
 * directly and nothing else about the release is.
 */
async function releaseHome(kit, org, { packageId, projectId, startInDays = 0, adoptInventory = true }) {
  const policies = app("books/revenue-policies"), inventory = app("books/inventory"), starts = app("starts")
  const adopt = () => kit.as(org.owner, () => inventory.enableProjectInventory({ projectId, effectiveOn: "2026-06-01", evidenceUrl: `${EVIDENCE}/ownership` }))
  let policyRepairedByHand = false
  if (adoptInventory) await adopt().catch(async (error) => {
    if (!/earn revenue differently|recognizes revenue at sale/.test(error.message)) throw error
    policyRepairedByHand = true
    // A home with one contract earns under its project-level policy: the baseline recorded at
    // reservation (before any agreement existed) reads as percentage of completion and a
    // contract-scoped policy is ignored beside it (defect D16).
    const contracts = kit.rows(`select id, contract_type from public.contracts where project_id=${kit.q(projectId)} and status='active'`)
    for (const contract of contracts) {
      const proposal = await kit.as(org.owner, () => policies.proposeRevenuePolicy({ projectId, contractId: contracts.length === 1 ? null : contract.id, method: "closing", billingMethod: contract.contract_type === "purchase_agreement" ? "purchase_agreement" : "fixed_price", effectiveFrom: "2026-06-01", rationale: "A home earns its revenue at closing; the placeholder contract carries none." }))
      await kit.as(org.reviewer, () => policies.reviewRevenuePolicy({ policyId: proposal.policyId, approve: true }))
    }
    await adopt()
  })
  const startDate = isoDay(startInDays)
  const queued = await kit.as(org.team.starts, () => starts.releaseStart(packageId, { scheduledStartDate: startDate }))
  if (!queued.released) throw Error(`The release was not queued: ${JSON.stringify(queued)}`)
  if (!kit.storage) kit.sql(`update public.start_release_steps set status='completed', completed_at=now(), detail='{"harness":"no file storage on the acceptance stack"}' where start_package_id=${kit.q(packageId)} and step_key='drawings'`)
  const pipeline = app("starts-pipeline")
  let released
  for (let attempt = 0; attempt < 6; attempt++) {
    await kit.service(() => pipeline.runStartsPipeline())
    released = await kit.as(org.team.starts, () => starts.getStartPackage(packageId))
    if (["released", "attention"].includes(released.status)) break
  }
  return { startDate, released, policyRepairedByHand }
}

/** The release's purchase orders, by vendor name, in cents. */
function purchaseOrdersByVendor(kit, projectId) {
  return Object.fromEntries(kit.rows(`select co.name, sum(c.total_cents)::bigint n from public.commitments c join public.companies co on co.id=c.company_id
    where c.project_id=${kit.q(projectId)} and c.commitment_type='purchase_order' and c.status<>'void' group by co.name order by co.name`).map((row) => [row.name, Number(row.n)]))
}

/** Approves each purchase order and bills it in full against the order. */
async function buildHome(kit, org, { projectId, billDate = isoDay(7) }) {
  const commitments = app("commitments"), bills = app("vendor-bills")
  org.bookkeeper ??= kit.addMember(org, "org_office_admin")
  const orders = kit.rows(`select id, company_id, contract_number, total_cents from public.commitments where project_id=${kit.q(projectId)} and commitment_type='purchase_order' and status='draft' order by contract_number`)
  for (const order of orders) {
    await kit.as(org.owner, () => commitments.updateCommitment({ commitmentId: order.id, input: { status: "approved", prequal_override_note: "Acceptance trade: no prequalification on file for this vendor." } }))
    const lines = kit.rows(`select cost_code_id, description, round(quantity*unit_cost_cents)::bigint cents from public.commitment_lines where commitment_id=${kit.q(order.id)} order by sort_order`)
    const bill = await kit.as(org.bookkeeper, () => bills.createProjectVendorBill({ projectId, input: { company_id: order.company_id, commitment_id: order.id, bill_number: `B-${order.contract_number}`, bill_date: billDate, due_date: isoDay(37),
      total_cents: Number(order.total_cents), actual_lines: lines.map((line) => ({ cost_code_id: line.cost_code_id, description: line.description, amount_cents: Number(line.cents), project_id: projectId })) } }))
    // Whoever enters a payable cannot approve it: the bookkeeper enters, the owner approves.
    await kit.as(org.owner, () => bills.approveVendorBillsAtomic([{ id: bill.id }]))
  }
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  return { orders: orders.length }
}

/** Completion: the warranty reserve is estimated and the home moves to completed inventory. */
async function completeHome(kit, org, { projectId, reserveCents, date = isoDay(14) }) {
  await kit.as(org.owner, () => app("books/warranty-accounting").setWarrantyReserveEstimate({ projectId, date, amountCents: reserveCents, evidenceUrl: `${EVIDENCE}/warranty-reserve` }))
  await kit.as(org.owner, () => app("books/inventory").completeProjectInventory({ projectId, date, evidenceUrl: `${EVIDENCE}/completion` }))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
}


const PRICED_ITEM_KEYS = ["optionId", "packageId", "category", "label", "priceCents", "source"]
const PRICING_KEYS = ["basePriceCents", "lotPremiumCents", "structuralOptions", "designSelections", "incentives", "structuralOptionsCents", "designSelectionsCents", "incentivesCents", "totalCents"]
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]))
function normaliseSettlementEvidence(kit, closingId) {
  const row = kit.rows(`select settlement, closing_invoice_id from public.closings where id=${kit.q(closingId)}`)[0]
  const reduce = (settlement) => ({ ...settlement, pricing: { ...pick(settlement.pricing, PRICING_KEYS),
    structuralOptions: settlement.pricing.structuralOptions.map((item) => pick(item, PRICED_ITEM_KEYS)), designSelections: settlement.pricing.designSelections.map((item) => pick(item, PRICED_ITEM_KEYS)) } })
  const json = (value) => kit.q(JSON.stringify(value))
  const invoice = kit.rows(`select metadata from public.invoices where id=${kit.q(row.closing_invoice_id)}`)[0]
  // The evidence is write-once by trigger; this harness repair runs as the stack's superuser with triggers off.
  kit.sql(`begin;
set local session_replication_role = replica;
update public.closings set settlement=${json(reduce(row.settlement))}::jsonb where id=${kit.q(closingId)};
update public.invoices set metadata=jsonb_set(metadata,'{settlement}',${json(reduce(invoice.metadata.settlement))}::jsonb) where id=${kit.q(row.closing_invoice_id)};
commit;`, "supabase_admin")
}

/**
 * The closing desk's gates as a coordinator clears them: the certificate of
 * occupancy gate completed with its evidence file on the home (it cannot be
 * waived), every other gate waived with a reason, every contingency or
 * lender/title milestone that holds closing waived with a reason, and, for an
 * agreement that never had commission terms, the sales desk declaring none
 * (terms a scenario set itself are left for it to approve).
 */
async function prepareClosingGates(kit, org, closingId) {
  const closings = app("closings"), milestones = app("agreement-milestones")
  const { project_id: projectId } = kit.rows(`select project_id from public.closings where id=${kit.q(closingId)}`)[0]
  for (const item of kit.rows(`select id, evidence_required from public.closing_checklist_items where closing_id=${kit.q(closingId)} and is_gate and status='open'`)) {
    if (item.evidence_required) {
      // File storage is not on the stack; the file record stands in for the uploaded certificate.
      const fileId = randomUUID()
      kit.sql(`insert into public.files(id,org_id,project_id,file_name,storage_path,metadata) values(${kit.q(fileId)},${kit.q(org.orgId)},${kit.q(projectId)},'certificate-of-occupancy.pdf',${kit.q(`acceptance/co-${closingId}.pdf`)},'{}')`)
      await kit.as(org.owner, () => closings.updateClosingChecklistItem({ itemId: item.id, status: "complete", fileId }))
    } else {
      await kit.as(org.owner, () => closings.updateClosingChecklistItem({ itemId: item.id, status: "waived", notes: "Verified at the closing table by the title agent." }))
    }
  }
  for (const row of kit.rows(`select m.id, m.version from public.agreement_milestones m join public.contracts c on c.id=m.contract_id and c.status='active' where m.project_id=${kit.q(projectId)} and m.required_before='closing' and m.status in ('open','failed') order by m.sort_order`))
    await kit.as(org.owner, () => milestones.resolveAgreementMilestone({ milestoneId: row.id, version: row.version, resolution: "waived", resolvedOn: isoDay(0), note: "Cleared by the title agent at the closing table." }))
  for (const row of kit.rows(`select c.id from public.contracts c where c.project_id=${kit.q(projectId)} and c.contract_type='purchase_agreement' and c.status='active'
    and not exists (select 1 from public.sales_commission_plans p where p.contract_id=c.id and p.status in ('proposed','approved'))`))
    await kit.as(org.owner, () => app("sales-commissions").proposeCommissionPlan({ contractId: row.id, plan: { coopBroker: "none", lines: [] } }))
}

/** The closing desk's path, as in HOME-01: clear every gate, settle, let the outbox post it. */
async function closeHome(kit, org, { projectId, date = isoDay(21) }) {
  const closings = app("closings")
  const closingId = kit.rows(`select id from public.closings where project_id=${kit.q(projectId)} and status<>'cancelled'`)[0].id
  const status = () => kit.rows(`select status from public.closings where id=${kit.q(closingId)}`)[0].status
  await kit.as(org.owner, () => closings.scheduleClosing({ closingId, scheduledDate: date }))
  await prepareClosingGates(kit, org, closingId)
  await kit.as(org.owner, () => closings.markClearedToClose(closingId))
  // The closing statement PDF needs file storage; recording the closing does not.
  const settle = () => kit.as(org.owner, () => closings.settleClosing({ closingId, actualDate: date, paymentMethod: "wire", paymentReference: "WIRE-PRODUCTION" }))
    .catch((error) => { if (!/^Closing is recorded; retry completion after resolving the statement: Missing R2/.test(error.message)) throw error })
  // DEFECT D10: the money is recorded, then completion refuses the evidence it just wrote,
  // because the settlement keeps the whole agreement quote and the reader keeps only the
  // fields it knows. The evidence is reduced to those fields and completion is retried.
  let evidenceRepaired = false
  await settle().catch(async (error) => {
    if (!/Recorded closing invoice does not reconcile with the settlement/.test(error.message)) throw error
    evidenceRepaired = true
    normaliseSettlementEvidence(kit, closingId)
    await settle()
  })
  if (status() !== "closed") throw Error("Closing was not recorded")
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  return { closingId, evidenceRepaired }
}

/** One home sold, built and closed: the whole lifecycle for a lot, for fixtures that need a closed home. */
async function presoldThroughClosing(kit, org, { lot, plan, buyer, swing = "right", skus, depositCents = 2000000 }) {
  const prospect = await registerBuyer(kit, org, buyer)
  const { reservation } = await reserveLot(kit, org, { prospect, lotId: lot.id, depositCents, receivedOn: "2026-06-06" })
  const sale = await signAgreement(kit, org, { reservationId: reservation.id, config: configuration(org, { lotId: lot.id, plan, swing, skus }) })
  await chooseDesign(kit, org, { projectId: sale.projectId })
  const gates = await clearStartGates(kit, org, { lotId: lot.id, projectId: sale.projectId })
  await releaseHome(kit, org, { packageId: gates.packageId, projectId: sale.projectId })
  await buildHome(kit, org, { projectId: sale.projectId })
  await completeHome(kit, org, { projectId: sale.projectId, reserveCents: 650000 })
  const closed = await closeHome(kit, org, { projectId: sale.projectId })
  return { prospect, reservation, projectId: sale.projectId, contractId: sale.contractId, packageId: gates.packageId, closingId: closed.closingId }
}

/** A spec home: no buyer. DEFECT D9: nothing in the app pins a plan to an unsold lot, so the pin is written directly. */
function pinSpecPlan(kit, { lot, plan }) {
  kit.sql(`update public.lots set house_plan_id=${kit.q(plan.id)}, house_plan_version_id=${kit.q(plan.versionId)}, house_plan_elevation_id=${kit.q(plan.elevationIds[1])}, swing='right' where id=${kit.q(lot.id)}`)
}

/** A land deal under diligence beside the community: the land desk and deal workbench have a record to open. */
async function seedLandDeal(kit, org) {
  const deals = require("../../lib/services/land-opportunities")
  const deal = await kit.as(org.team.land, () => deals.createLandOpportunity({ name: "Cypress Landing North parcel", code: "CLN", divisionId: org.divisionId, city: "Naples", state: "FL", county: "Collier",
    acreage: 12.5, plannedLotCount: 40, purchasePriceCents: 280000000, depositCents: 5000000, diligenceEndsOn: isoDay(30), leadUserId: org.team.land.userId }))
  await kit.as(org.team.land, () => deals.seedDiligenceChecklist(deal.id))
  return deal
}

module.exports = {
  EVIDENCE, COST_CODES, TRADES, PLANS, OPTIONS, DESIGN_PICKS,
  defaultPeriods, isoDay, glId, csv, planTradeCostCents,
  productionBuilder, seedCommunity, seedProduct, takeDownTranche, registerBuyer, reserveHold, reserveLot, configuration, signAgreement,
  agreementPacketFor, signedCopyFile, homeFile, permitAuthority, approvePermit,
  approveSelectionsInPerson, chooseDesign, clearStartGates, releaseHome, purchaseOrdersByVendor, buildHome, completeHome, prepareClosingGates, closeHome, presoldThroughClosing, pinSpecPlan, seedLandDeal,
}
