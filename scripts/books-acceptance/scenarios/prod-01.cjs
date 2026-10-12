// PROD-01 — product and configuration (EP03). One production builder (Cypress Landing:
// twenty lots, the first ten taken down and developed; The Mangrove and The Palmetto
// released, active and offered; the option catalog priced per plan), made through Arc's
// own services by the role that owns each step. Every subcase acts through `kit.as`, so
// row-level security and permission checks are the real ones:
//
//   version-history-pins-the-sold-home            EP03-01  edits move revisions; the sale and release records keep theirs
//   group-confirmation-is-all-or-nothing          EP03-04  one unavailable member confirms nothing
//   stale-catalog-refuses-the-selection-write     EP03-04  a publication between read and write refuses the write
//   offering-holds-everywhere                     EP03-05  pinning and the lots import refuse an unoffered plan
//   lot-fit-refuses-and-overrides-with-evidence   EP03-06  a home that does not fit stands only under an evidenced override
//   production-pricing-never-guesses              EP03-07  no pinned version, no price; a plan row outranks the option's own
//   sold-price-and-margin-are-locked              EP03-08  a signed price and its margin baselines never move
//   plan-change-reaches-sold-homes                EP03-09  a new edition reaches each home only by an authorized decision
//   invalid-configuration-explains-and-fixes      EP03-10  violations come back structured, fixes apply, locks hold
//
// The configuration-rules flag (and an org-wide second selection group) is switched on only
// by the last subcase, since an org that has rules cannot switch it off again and every home
// sold afterwards would carry the new group; the earlier subcases run without them.
//
// SQL is used only for what a subcase is not about and says so where it happens: the
// flag row, an evidence file's record (the stack has no file storage), the session that
// holds a home's selection lock so a publication lands mid-write, and the direct writes
// the agreement guard and the baseline guard must refuse. Reads that check the outcome
// are SQL as the stack superuser.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")
const { psql } = require("./sessions.cjs")

// What a person is told when they are refused, or "allowed".
const attempt = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// The builder, built once per run and shared by the subcases.

const WORLDS = new WeakMap()
function world(kit) {
  if (!WORLDS.has(kit)) WORLDS.set(kit, build(kit))
  return WORLDS.get(kit)
}

async function build(kit) {
  const org = await seed.productionBuilder(kit, { name: "PROD-01 product and configuration" })
  await seed.seedCommunity(kit, org)
  await seed.seedProduct(kit, org)
  await seed.takeDownTranche(kit, org)
  // Several subcases release a home this week; the starts desk raises the week's even-flow
  // target so none of them waits on the release-slot confirmation (not under test).
  const monday = new Date(`${seed.isoDay(0)}T00:00:00Z`)
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
  await kit.as(org.team.starts, () => app("even-flow").setReleaseSlot(org.communityId, monday.toISOString().slice(0, 10), { targetStarts: 10 }))
  org.uses = { next: 0 }
  return { org }
}

/**
 * The next owned, developed lot of the first tranche, so no two homes share one. Lots 1
 * and 6 carry a lot premium; they are skipped so every sale is priced without one, in
 * whatever order (or subset) the subcases run.
 */
const SALE_LOTS = [1, 2, 3, 4, 6, 7, 8, 9]
function nextLot(org) {
  if (org.uses.next >= SALE_LOTS.length) throw Error("Out of developed lots")
  return org.lots[SALE_LOTS[org.uses.next++]]
}

const one = (kit, sql) => kit.rows(sql)[0]
const count = (kit, sql) => Number(kit.rows(`select count(*)::int n from (${sql}) t`)[0].n)

/** A buyer reserves the next lot (or `lot`), pays the deposit and signs for `skus` on The Mangrove (or `plan`, elevation A). */
async function sell(kit, org, name, skus, { plan = org.plans[0], lot = nextLot(org) } = {}) {
  const swing = one(kit, `select swing from public.lots where id=${kit.q(lot.id)}`).swing
  const prospect = await seed.registerBuyer(kit, org, { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@acceptance.example.test` })
  const { reservation } = await seed.reserveLot(kit, org, { prospect, lotId: lot.id, depositCents: 2000000, receivedOn: "2026-06-06" })
  const sale = await seed.signAgreement(kit, org, { reservationId: reservation.id, config: seed.configuration(org, { lotId: lot.id, plan, swing, skus }) })
  return { lot, reservation, ...sale }
}

/** Sell, choose and confirm the design, clear the gates and release: a started home. */
async function startedHome(kit, org, name, skus, options = {}) {
  const home = await sell(kit, org, name, skus, options)
  await seed.chooseDesign(kit, org, { projectId: home.projectId })
  const gates = await seed.clearStartGates(kit, org, { lotId: home.lot.id, projectId: home.projectId })
  const release = await seed.releaseHome(kit, org, { packageId: gates.packageId, projectId: home.projectId })
  return { ...home, packageId: gates.packageId, released: release.released.status }
}

/** A dedicated catalog option (its own category unless one is given), so editing it moves nothing another subcase sold. */
async function dedicatedOption(kit, org, { sku, name, category, categoryId = null, scope = "structural", priceCents, costCents, costCode = "03-300", vendor = "Gulf Concrete" }) {
  const catalog = app("option-catalog")
  if (!categoryId) {
    org.categoryIds[category] ??= (await kit.as(org.team.design, () => catalog.upsertCategory({ name: category, sortOrder: 20 + Object.keys(org.categoryIds).length }))).id
    categoryId = org.categoryIds[category]
  }
  const input = { categoryId, name, optionScope: scope, priceCents, costCents, costCodeId: org.costCodeIds[costCode], sku, vendor, sortOrder: 0, isAvailable: true }
  const saved = await kit.as(org.team.design, () => catalog.upsertOption(input))
  org.optionIds[sku] = saved.id
  return { id: saved.id, input: { ...input, id: saved.id } }
}

/** A plan with one takeoff, a released version, elevations A and B, made active; offered nowhere. */
/** The plan's takeoff: one line per trade; `unitCosts` also records each line's manual unit cost (cents). */
function takeoffLines(org, heatedSqft, { unitCosts = false } = {}) {
  return seed.TRADES.map((trade) => ({ costCodeId: org.costCodeIds[trade.costCode], description: `${trade.vendor} scope`, quantity: trade.uom === "sf" ? heatedSqft : 1, uom: trade.uom,
    ...(unitCosts ? { unitCostCents: trade.unitPriceDollars * 100 } : {}) }))
}

async function releasedPlan(kit, org, { code, name, heatedSqft, footprint = null, unitCosts = false }) {
  const plans = app("house-plans")
  const created = await kit.as(org.owner, () => plans.createHousePlan({ code, name, series: "Cypress Landing", heatedSqft, totalSqft: heatedSqft + 320, beds: 4, baths: 3, stories: 1, garageBays: 2,
    ...(footprint ? { footprintWidthFt: footprint.widthFt, footprintDepthFt: footprint.depthFt } : {}) }))
  const elevationIds = []
  for (const [index, [elevationCode, label]] of [["A", "Coastal"], ["B", "Craftsman"]].entries())
    elevationIds.push((await kit.as(org.owner, () => plans.upsertElevation(created.id, { code: elevationCode, name: label, sortOrder: index }))).id)
  const version = created.versions?.[0] ?? (await kit.as(org.owner, () => plans.listPlanVersions(created.id)))[0]
  await kit.as(org.owner, () => plans.replaceTakeoffLines(version.id, takeoffLines(org, heatedSqft, { unitCosts })))
  await kit.as(org.owner, () => plans.updatePlanVersion(version.id, { label: "Launch release", scheduleTemplateId: org.scheduleTemplateId, checklistTemplateIds: [], selectionCategoryIds: [] }))
  await kit.as(org.owner, () => plans.releasePlanVersion(version.id))
  await kit.as(org.owner, () => plans.updateHousePlan(created.id, { status: "active" }))
  return { id: created.id, code, versionId: version.id, elevationIds }
}

/** Developed lots made by the land manager outside the takedown tranche (a measured lot passes `dimensions`). */
async function newLots(kit, org, lots) {
  await kit.as(org.team.land, () => app("lots").createLots(org.communityId, { lots: lots.map((lot) => ({ status: "developed", address: `${lot.lotNumber} Cypress Landing Way`, ...lot })) }))
  return Object.fromEntries(lots.map((lot) => [lot.lotNumber, one(kit, `select id from public.lots where org_id=${kit.q(org.orgId)} and community_id=${kit.q(org.communityId)} and lot_number=${kit.q(lot.lotNumber)}`).id]))
}

const designRows = (kit, projectId) => kit.rows(`select s.id, c.name category, s.selected_option_id, s.status, s.confirmed_at, s.locked_at, s.price_cents_snapshot
  from public.project_selections s join public.selection_categories c on c.id=s.category_id where s.project_id=${kit.q(projectId)} and s.group_id is not null order by c.name`)

/** Option id → SKU (or name), so expectations read as the catalog does. */
function skuOf(kit, org) {
  const names = Object.fromEntries(kit.rows(`select id, coalesce(sku, name) label from public.selection_options where org_id=${kit.q(org.orgId)}`).map((row) => [row.id, row.label]))
  return (id) => names[id] ?? id
}

// ---------------------------------------------------------------------------
// 1. EP03-01: editing a sold elevation and option moves their revisions and history;
//    the home's sale record keeps what it was sold at, its release record what it was built from.

async function versionHistoryPinsTheSoldHome(kit, expected, check) {
  const { org } = await world(kit)
  const plans = app("house-plans"), catalog = app("option-catalog"), revisions = app("home-product-revisions")
  const plan = org.plans[0], elevationId = plan.elevationIds[0]
  const lanai = await dedicatedOption(kit, org, { sku: "ST-LAN", name: "Screened lanai", category: "Lanai", priceCents: 1200000, costCents: 700000 })
  const home = await sell(kit, org, "History Buyer", ["ST-GAR", "ST-LAN"])
  const sku = skuOf(kit, org)
  const record = (stage) => {
    const row = one(kit, `select plan_version_number, elevation_id, elevation_revision, revisions from public.home_product_revisions where project_id=${kit.q(home.projectId)} and stage=${kit.q(stage)}`)
    if (!row) return null
    return { planVersion: row.plan_version_number, elevationIsTheSoldOne: row.elevation_id === elevationId, elevationRevision: row.elevation_revision,
      options: Object.fromEntries(row.revisions.options.map((ref) => [sku(ref.id), ref.revision]).sort()) }
  }
  const status = async () => {
    const result = await kit.as(org.owner, async () => {
      const { supabase } = await require("../../../lib/services/context").requireOrgContext()
      return revisions.readHomeProductRevisionStatus(supabase, org.orgId, home.projectId)
    })
    return { stage: result.stage, summary: result.summary, changes: result.changes.map((change) => ({ kind: change.kind, subject: change.kind === "option" ? sku(change.id) : change.id === elevationId ? "sold elevation" : change.id, change: change.change, from: change.from, to: change.to })) }
  }
  const current = () => ({
    elevation: Number(one(kit, `select revision from public.house_plan_elevations where id=${kit.q(elevationId)}`).revision),
    lanai: Number(one(kit, `select revision from public.selection_options where id=${kit.q(lanai.id)}`).revision),
  })
  const observed = { soldRecord: record("agreement"), revisionsWhenSold: current() }

  // The owner renames the sold elevation; the design coordinator reprices the sold option.
  await kit.as(org.owner, () => plans.upsertElevation(plan.id, { id: elevationId, code: "A", name: "Coastal (revised roofline)", sortOrder: 0 }))
  await kit.as(org.team.design, () => catalog.upsertOption({ ...lanai.input, priceCents: 1250000 }))
  // A save that changes nothing a home is built or sold from leaves the revision alone.
  await kit.as(org.team.design, () => catalog.upsertOption({ ...lanai.input, priceCents: 1250000, sortOrder: 3 }))
  observed.revisionsAfterEdits = current()
  const elevationHistory = await kit.as(org.owner, () => revisions.listProductDefinitionHistory({ entityType: "house_plan_elevation", entityId: elevationId }))
  const optionHistory = await kit.as(org.team.design, () => revisions.listProductDefinitionHistory({ entityType: "selection_option", entityId: lanai.id }))
  observed.history = {
    elevation: elevationHistory.map((row) => ({ revision: row.revision, name: row.snapshot.name })),
    option: optionHistory.map((row) => ({ revision: row.revision, priceCents: row.snapshot.price_cents })),
  }
  observed.historyIsAppendOnly = await attempt(() => Promise.resolve(kit.sql(`update public.product_definition_revisions set snapshot='{}' where entity_id=${kit.q(lanai.id)} and revision=1`)))
    .then((text) => (text === "allowed" ? "changed" : "refused"))
  observed.soldRecordAfterEdits = record("agreement")
  observed.statusBeforeRelease = await status()

  // Choose, confirm, clear the gates and release: the release records what is built now.
  await seed.chooseDesign(kit, org, { projectId: home.projectId })
  const gates = await seed.clearStartGates(kit, org, { lotId: home.lot.id, projectId: home.projectId })
  const release = await seed.releaseHome(kit, org, { packageId: gates.packageId, projectId: home.projectId })
  observed.released = release.released.status
  observed.releaseRecord = record("release")
  observed.soldRecordAfterRelease = record("agreement")
  observed.statusAfterRelease = await status()
  // A later reprice of the sold option is what changed since the release.
  await kit.as(org.team.design, () => catalog.upsertOption({ ...lanai.input, priceCents: 1300000, sortOrder: 3 }))
  observed.statusAfterLaterEdit = await status()
  observed.recordsPerStage = Object.fromEntries(kit.rows(`select stage, count(*)::int n from public.home_product_revisions where project_id=${kit.q(home.projectId)} group by stage order by stage`).map((row) => [row.stage, row.n]))
  check.equal("editing the sold elevation and option moves their revisions with append-only history; the sale record keeps the revisions it was sold at, the release record the ones it was built from, and the home says what changed since", expected.expected, observed)
  return { orgId: org.orgId, projectId: home.projectId }
}

// ---------------------------------------------------------------------------
// 2. EP03-04: a selection group confirms every member in one write, or none.

async function groupConfirmationIsAllOrNothing(kit, expected, check) {
  const { org } = await world(kit)
  const catalog = app("option-catalog"), selections = app("selections")
  const butcher = await dedicatedOption(kit, org, { sku: "KT-BUT", name: "Butcher block countertops", categoryId: org.categoryIds.Kitchen, scope: "design_studio", priceCents: 350000, costCents: 210000, costCode: "06-100", vendor: "Palmetto Framing" })
  const home = await sell(kit, org, "Group Buyer", ["ST-GAR"])
  const picks = { Electrical: "EL-LGT", Flooring: "FL-LVP", Kitchen: "KT-BUT" }
  for (const row of designRows(kit, home.projectId))
    await kit.as(org.team.design, () => selections.selectProjectOption({ orgId: org.orgId, projectId: home.projectId, selectionId: row.id, optionId: org.optionIds[picks[row.category]] }))
  const state = () => designRows(kit, home.projectId).map((row) => ({ category: row.category, status: row.status, confirmed: Boolean(row.confirmed_at) }))
  const observed = { chosen: state() }
  // The design coordinator withdraws the kitchen pick from sale while the buyer is still choosing.
  await kit.as(org.team.design, () => catalog.upsertOption({ ...butcher.input, isAvailable: false }))
  observed.confirmWithOneUnavailable = await attempt(() => kit.as(org.team.design, () => selections.confirmSelectionGroup({ orgId: org.orgId, projectId: home.projectId, groupId: org.selectionGroupId })))
  observed.afterRefusal = state()
  // Back on sale, the whole group confirms in one write.
  await kit.as(org.team.design, () => catalog.upsertOption({ ...butcher.input, isAvailable: true }))
  observed.confirmed = (await kit.as(org.team.design, () => selections.confirmSelectionGroup({ orgId: org.orgId, projectId: home.projectId, groupId: org.selectionGroupId }))).confirmed
  observed.afterConfirmation = state()
  observed.confirmationInstants = count(kit, `select distinct confirmed_at from public.project_selections where project_id=${kit.q(home.projectId)} and group_id=${kit.q(org.selectionGroupId)}`)
  check.equal("a group with one unavailable member confirms nothing; once it is available again every member confirms in one write", expected.expected, observed)
  return { orgId: org.orgId, projectId: home.projectId }
}

// ---------------------------------------------------------------------------
// 3. EP03-04: a catalog publication that lands between a selection's validation and its
//    write refuses the write; nothing is written; a retry on the new catalog succeeds.

async function staleCatalogRefusesTheSelectionWrite(kit, expected, check) {
  const { org } = await world(kit)
  const selections = app("selections"), catalog = app("option-catalog")
  const probe = await dedicatedOption(kit, org, { sku: "KT-PRB", name: "Fence probe countertops", categoryId: org.categoryIds.Kitchen, scope: "design_studio", priceCents: 300000, costCents: 180000, costCode: "06-100", vendor: "Palmetto Framing" })
  const home = await sell(kit, org, "Fence Buyer", ["ST-GAR"])
  const kitchen = () => designRows(kit, home.projectId).find((row) => row.category === "Kitchen")
  const revision = () => one(kit, `select revision::text r from public.agreement_catalog_revisions where org_id=${kit.q(org.orgId)}`).r
  const choose = () => kit.as(org.team.design, () => selections.selectProjectOption({ orgId: org.orgId, projectId: home.projectId, selectionId: kitchen().id, optionId: org.optionIds["KT-QTZ"] }))

  // The write serializes on the home's selection lock (apply_project_selection_writes). A
  // separate session holds that lock (harness fixture), so the write waits after it has read
  // its fence and validated; the owner publishes a price meanwhile; then the lock is let go.
  const key = BigInt(one(kit, `select hashtextextended(${kit.q(`project-selections:${org.orgId}:${home.projectId}`)}, 0)::text k`).k)
  const unsigned = BigInt.asUintN(64, key)
  const lockFilter = `locktype='advisory' and classid=${unsigned >> 32n} and objid=${unsigned & 0xffffffffn} and objsubid=1`
  const holder = psql(kit, `select pg_advisory_lock(${key}); select pg_sleep(90);`, "supabase_admin")
  for (let i = 0; i < 100 && !count(kit, `select 1 from pg_locks where ${lockFilter} and granted`); i += 1) await wait(50)
  const before = revision()
  const write = attempt(choose)
  let waited = false
  for (let i = 0; i < 400 && !waited; i += 1) { waited = count(kit, `select 1 from pg_locks where ${lockFilter} and not granted`) > 0; if (!waited) await wait(50) }
  const published = await attempt(() => kit.as(org.owner, () => catalog.setCatalogPrice({ optionId: probe.id, housePlanVersionId: org.plans[0].versionId, priceCents: 310000, costCents: 185000, isAvailable: true })))
  const after = revision()
  kit.sql(`select pg_terminate_backend(pid) from pg_locks where ${lockFilter} and granted`, "supabase_admin")
  await holder
  const observed = {
    writeWaitedOnTheHomeLock: waited,
    publication: published,
    catalogRevisionMoved: BigInt(after) > BigInt(before),
    staleWrite: await write,
    kitchenAfterRefusal: { optionChosen: Boolean(kitchen().selected_option_id), status: kitchen().status },
  }
  const retried = await attempt(choose)
  observed.retry = retried
  observed.kitchenAfterRetry = { isQuartz: kitchen().selected_option_id === org.optionIds["KT-QTZ"], status: kitchen().status, priceCents: kitchen().price_cents_snapshot }
  check.equal("a price published while a selection write waits refuses that write with the catalog-changed message and writes nothing; the retry, validated on the new catalog, lands", expected.expected, observed)
  return { orgId: org.orgId, projectId: home.projectId }
}

// ---------------------------------------------------------------------------
// 4. EP03-05: a plan the community does not offer cannot be pinned, by hand or by import,
//    unless a person with plan-release authority recorded an override for that lot.

async function offeringHoldsEverywhere(kit, expected, check) {
  const { org } = await world(kit)
  const lots = app("lots"), instantiation = app("plan-instantiation"), imports = app("imports")
  const off = await releasedPlan(kit, org, { code: "OK1800", name: "The Oak", heatedSqft: 1800 })
  const lot = org.lots[10]
  const pin = (actor) => attempt(() => kit.as(actor, () => lots.assignPlanToLot(lot.id, { versionId: off.versionId, elevationId: off.elevationIds[0] })))
  const pinned = () => one(kit, `select house_plan_id from public.lots where id=${kit.q(lot.id)}`).house_plan_id
  const observed = { pinUnoffered: await pin(org.team.starts), pinnedAfterRefusal: pinned() === off.id }
  const override = (actor) => attempt(() => kit.as(actor, () => instantiation.recordPlanOfferingOverride({ lotId: lot.id, housePlanId: off.id, reason: "Builder's model-park exception approved by the division president" })))
  observed.overrideWithoutPlanRelease = await override(org.team.starts)
  observed.overrideByPurchasing = await override(org.team.purchasing)
  observed.overrideAudited = count(kit, `select 1 from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='lot' and entity_id=${kit.q(lot.id)} and actor_user_id=${kit.q(org.team.purchasing.userId)} and after_data->'offering_override'->>'house_plan_id'=${kit.q(off.id)}`)
  observed.pinWithOverride = await pin(org.team.starts)
  observed.pinnedAfterOverride = pinned() === off.id

  // The lots import, staged by the land manager: an unoffered plan on a new lot is refused;
  // the offered plan, and the unoffered plan on the lot that carries the override, are not.
  const rows = [
    { community: "Cypress Landing", lot_number: "41", status: "developed", plan_code: "OK1800", elevation_code: "A" },
    { community: "Cypress Landing", lot_number: "42", status: "developed", plan_code: "MG1650", elevation_code: "A" },
    { community: "Cypress Landing", lot_number: lot.lot_number, status: "controlled", plan_code: "OK1800", elevation_code: "A" },
  ]
  const batch = await kit.as(org.team.land, () => imports.stageImportBatch({ importer: "communities_lots", csvText: seed.csv(Object.keys(rows[0]), rows), sourceFilename: "cypress-landing-lots.csv" }))
  observed.lotsImport = kit.rows(`select parsed->>'lot_number' lot, status, issues from public.import_rows where batch_id=${kit.q(batch.id)} order by row_number`)
    .map((row) => ({ lot: row.lot === lot.lot_number ? "overridden lot" : row.lot, status: row.status, issues: row.issues.map((issue) => issue.code).sort() }))
  check.equal("pinning an unoffered plan is refused until a plan-release holder records an audited override for that lot; the lots import refuses the unoffered plan except on that lot", expected.expected, observed)
  return { orgId: org.orgId, lotId: lot.id, batchId: batch.id }
}

// ---------------------------------------------------------------------------
// 5. EP03-06: a plan that does not fit a lot is refused unless an override with a reason
//    and evidence, recorded by a holder of lot.fit_override, covers it; unmeasured lots never block.

async function lotFitRefusesAndOverridesWithEvidence(kit, expected, check) {
  const { org } = await world(kit)
  const lots = app("lots"), fit = app("lot-fit"), sales = app("community-sales")
  const wide = await releasedPlan(kit, org, { code: "WD2600", name: "The Wideleaf", heatedSqft: 2600, footprint: { widthFt: 50, depthFt: 70 } })
  await kit.as(org.owner, () => sales.offerPlanInCommunity({ communityId: org.communityId, housePlanId: wide.id, basePriceCents: 52500000 }))
  const ids = await newLots(kit, org, [
    { lotNumber: "51", dimensions: { widthFt: 40, depthFt: 120, frontSetbackFt: 20, rearSetbackFt: 15, sideSetbackFt: 5 } },
    { lotNumber: "52" },
  ])
  const assign = (lotId) => attempt(() => kit.as(org.team.starts, () => lots.assignPlanToLot(lotId, { versionId: wide.versionId, elevationId: wide.elevationIds[0] })))
  const observed = { narrowLot: await assign(ids["51"]) }
  const verdict = await kit.as(org.team.land, () => fit.getLotFit(ids["51"], { planId: wide.id, elevationId: wide.elevationIds[0] }))
  observed.verdict = { status: verdict.evaluation.status, violations: verdict.evaluation.violations.map((violation) => violation.code), buildable: verdict.evaluation.buildable }
  // The plot plan the override cites. The stack has no file storage, so its record stands in for the upload (fixture).
  const evidenceFileId = randomUUID()
  kit.sql(`insert into public.files(id,org_id,file_name,storage_path,metadata) values(${kit.q(evidenceFileId)},${kit.q(org.orgId)},'lot-51-plot-plan.pdf','acceptance/lot-51-plot-plan.pdf','{"document_kind":"plot_plan"}')`)
  const override = (actor, input) => attempt(() => kit.as(actor, () => fit.recordLotFitOverride({ lotId: ids["51"], housePlanId: wide.id, elevationId: wide.elevationIds[0], swing: null, reason: "Side-load garage variance granted by the architectural review board", evidenceFileId, ...input })))
  observed.overrideWithoutLotFitOverride = await override(org.team.starts, {})
  observed.overrideWithoutEvidenceOnFile = await override(org.team.purchasing, { evidenceFileId: randomUUID() })
  observed.overrideWithoutAReason = (await override(org.team.purchasing, { reason: "ok" })) === "allowed" ? "allowed" : "refused"
  observed.overridesRecordedBeforeEvidence = count(kit, `select 1 from public.lot_fit_overrides where lot_id=${kit.q(ids["51"])}`)
  observed.overrideWithReasonAndEvidence = await override(org.team.purchasing, {})
  const recorded = one(kit, `select id, approved_by, violations, evidence_file_id from public.lot_fit_overrides where lot_id=${kit.q(ids["51"])} and revoked_at is null`)
  observed.override = { by: recorded.approved_by === org.team.purchasing.userId ? "purchasing manager" : recorded.approved_by, violations: recorded.violations.map((violation) => violation.code), evidenceIsThePlotPlan: recorded.evidence_file_id === evidenceFileId }
  observed.overrideAudited = count(kit, `select 1 from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='lot_fit_override' and action='insert' and entity_id=${kit.q(recorded.id)} and actor_user_id=${kit.q(org.team.purchasing.userId)}`)
  observed.overrideEvented = count(kit, `select 1 from public.events where org_id=${kit.q(org.orgId)} and event_type='lot.fit_overridden' and entity_id=${kit.q(ids["51"])}`)
  observed.narrowLotWithOverride = await assign(ids["51"])
  observed.unmeasuredLot = await assign(ids["52"])
  observed.unmeasuredVerdict = (await kit.as(org.team.land, () => fit.getLotFit(ids["52"]))).evaluation.status
  observed.pinned = Object.fromEntries(kit.rows(`select lot_number, house_plan_id from public.lots where id in (${kit.q(ids["51"])},${kit.q(ids["52"])}) order by lot_number`).map((row) => [row.lot_number, row.house_plan_id === wide.id]))
  check.equal("a plan wider than the lot builds is refused; only a lot.fit_override holder with a reason and an evidence file on record may let it stand, and that is audited; an unmeasured lot does not block", expected.expected, observed)
  return { orgId: org.orgId, overrideId: recorded.id }
}

// ---------------------------------------------------------------------------
// 6. EP03-07: a production home without a pinned plan version is never priced; with one,
//    a plan row outranks the option's own price, which stands where the plan has no row.

async function productionPricingNeverGuesses(kit, expected, check) {
  const { org } = await world(kit)
  const lots = app("lots"), projects = app("projects"), selections = app("selections"), catalog = app("option-catalog"), pricingScope = app("home-pricing-scope")
  const plan = org.plans[0]
  const planPriced = await dedicatedOption(kit, org, { sku: "KT-PLN", name: "Plan-priced countertops", categoryId: org.categoryIds.Kitchen, scope: "design_studio", priceCents: 100000, costCents: 60000, costCode: "06-100", vendor: "Palmetto Framing" })
  await kit.as(org.team.design, () => catalog.setCatalogPrice({ optionId: planPriced.id, housePlanVersionId: plan.versionId, priceCents: 90000, costCents: 55000, isAvailable: true }))
  const ownPriced = await dedicatedOption(kit, org, { sku: "KT-OWN", name: "Own-priced countertops", categoryId: org.categoryIds.Kitchen, scope: "design_studio", priceCents: 55000, costCents: 30000, costCode: "06-100", vendor: "Palmetto Framing" })
  const ids = await newLots(kit, org, [{ lotNumber: "61" }, { lotNumber: "62" }])
  // Lot 62 carries a pinned plan before its home arrives; lot 61 carries none.
  await kit.as(org.team.starts, () => lots.assignPlanToLot(ids["62"], { versionId: plan.versionId, elevationId: plan.elevationIds[0] }))
  const home = async (name, lotId) => {
    const created = await kit.as(org.owner, () => projects.createProject({ input: { name, property_type: "production", status: "active", phase: "delivery", division_id: org.divisionId } }))
    await kit.as(org.owner, () => lots.attachProjectToLot(lotId, created.id))
    // The design coordinator opens the kitchen selection on a home in their division without being on its team.
    const selection = await kit.as(org.team.design, () =>selections.createProjectSelection({ input: { project_id: created.id, category_id: org.categoryIds.Kitchen } }))
    return { projectId: created.id, selectionId: selection.id }
  }
  const unpinned = await home("Cypress Landing lot 61", ids["61"])
  const pinned = await home("Cypress Landing lot 62", ids["62"])
  const choose = (h, optionId) => kit.as(org.team.design, () => selections.selectProjectOption({ orgId: org.orgId, projectId: h.projectId, selectionId: h.selectionId, optionId }))
  const row = (h) => one(kit, `select selected_option_id, status, price_cents_snapshot from public.project_selections where id=${kit.q(h.selectionId)}`)
  const sources = (optionIds) => catalog.resolveOptionPricing({ orgId: org.orgId, items: optionIds.map((optionId) => ({ optionId })), ...pricingScope.homePricingScope({ lot: { community_id: org.communityId, house_plan_version_id: null }, production: true }) })
  const observed = {
    unpinnedHome: await attempt(() => choose(unpinned, planPriced.id)),
    unpinnedHomeSelection: { chosen: Boolean(row(unpinned).selected_option_id), status: row(unpinned).status },
    resolverWithoutAVersion: await attempt(() => kit.service(() => sources([planPriced.id]))),
  }
  await choose(pinned, planPriced.id)
  observed.planRowOutranksTheOptionsOwnPrice = { priceCents: row(pinned).price_cents_snapshot }
  await choose(pinned, ownPriced.id)
  observed.ownPriceWhereThePlanHasNoRow = { priceCents: row(pinned).price_cents_snapshot }
  const resolved = await kit.service(() => catalog.resolveOptionPricing({ orgId: org.orgId, items: [{ optionId: planPriced.id }, { optionId: ownPriced.id }], ...pricingScope.homePricingScope({ lot: { community_id: org.communityId, house_plan_version_id: plan.versionId }, production: true }) }))
  observed.sources = resolved.map((item) => `${item.priceCents}:${item.source}`)
  check.equal("a production home with no pinned plan version is refused rather than priced; with one, the plan row outranks the option's own price and the own price stands where the plan has no row", expected.expected, observed)
  return { orgId: org.orgId, unpinned: unpinned.projectId, pinned: pinned.projectId }
}

// ---------------------------------------------------------------------------
// 7. EP03-08: a signed agreement's price cannot change for any role; a catalog change
//    leaves it and the margin baselines alone; release captures its baseline once.

async function soldPriceAndMarginAreLocked(kit, expected, check) {
  const { org } = await world(kit)
  const catalog = app("option-catalog"), baselines = app("home-margin-baselines"), reporting = app("production-reporting")
  const margin = await dedicatedOption(kit, org, { sku: "ST-MRG", name: "Tray ceilings", category: "Ceilings", priceCents: 900000, costCents: 500000 })
  const home = await sell(kit, org, "Margin Buyer", ["ST-GAR", "ST-MRG"])
  const agreement = () => one(kit, `select total_cents, snapshot from public.contracts where id=${kit.q(home.contractId)}`)
  const baselineRows = () => kit.rows(`select id, stage, sale_price_cents, lot_premium_cents, options_price_cents, incentives_cents, base_cost_cents, options_cost_cents, cost_cents, margin_cents, margin_bps, captured_at from public.home_margin_baselines where project_id=${kit.q(home.projectId)} order by stage`)
  const signed = agreement()
  const soldBaselines = baselineRows()
  const lockMessage = (text) => (text === "allowed" ? "allowed" : /A signed purchase agreement's price and configuration cannot be changed/.test(text) ? "refused: price and configuration are locked" : text.slice(0, 200))
  const viaClient = async (actor) => {
    const work = async () => {
      const { supabase } = actor ? await require("../../../lib/services/context").requireOrgContext() : { supabase: require("../../../lib/supabase/server").createServiceSupabaseClient() }
      const { data, error } = await supabase.from("contracts").update({ total_cents: Number(signed.total_cents) - 100000 }).eq("id", home.contractId).select("id")
      if (error) throw new Error(error.message)
      if (!data?.length) throw new Error("no row updated")
    }
    return lockMessage(await attempt(() => (actor ? kit.as(actor, work) : kit.service(work))))
  }
  const viaSql = async (statement) => lockMessage(await attempt(() => Promise.resolve(kit.sql(statement))))
  const observed = {
    soldTotalCents: Number(signed.total_cents),
    soldPricing: (({ basePriceCents, lotPremiumCents, structuralOptionsCents, designSelectionsCents, incentivesCents, totalCents }) => ({ basePriceCents, lotPremiumCents, structuralOptionsCents, designSelectionsCents, incentivesCents, totalCents }))(signed.snapshot.purchase_agreement.pricing),
    agreementBaseline: soldBaselines.map(({ id, captured_at, ...rest }) => rest),
    rewrite: {
      ownerTotal: await viaClient(org.owner),
      serviceRoleTotal: await viaClient(null),
      postgresTotal: await viaSql(`update public.contracts set total_cents = total_cents - 100000 where id=${kit.q(home.contractId)}`),
      postgresSnapshot: await viaSql(`update public.contracts set snapshot = jsonb_set(snapshot, '{purchase_agreement,pricing,totalCents}', '1') where id=${kit.q(home.contractId)}`),
    },
  }
  // The catalog moves after the sale: the sold option's plan price and its own price both rise.
  await kit.as(org.team.design, () => catalog.setCatalogPrice({ optionId: margin.id, housePlanVersionId: org.plans[0].versionId, priceCents: 975000, costCents: 560000, isAvailable: true }))
  await kit.as(org.team.design, () => catalog.upsertOption({ ...margin.input, priceCents: 990000, costCents: 570000 }))
  const later = agreement()
  observed.afterCatalogChange = {
    totalUnchanged: Number(later.total_cents) === Number(signed.total_cents),
    snapshotUnchanged: JSON.stringify(later.snapshot) === JSON.stringify(signed.snapshot),
    agreementBaselineUnchanged: JSON.stringify(baselineRows()) === JSON.stringify(soldBaselines),
  }

  await seed.chooseDesign(kit, org, { projectId: home.projectId })
  const gates = await seed.clearStartGates(kit, org, { lotId: home.lot.id, projectId: home.projectId })
  const release = await seed.releaseHome(kit, org, { packageId: gates.packageId, projectId: home.projectId })
  observed.released = release.released.status
  const afterRelease = baselineRows()
  const releaseBaseline = afterRelease.find((row) => row.stage === "release")
  observed.releaseBaseline = releaseBaseline ? (({ id, captured_at, ...rest }) => rest)(releaseBaseline) : null
  observed.agreementBaselineUnchangedByRelease = JSON.stringify(afterRelease.filter((row) => row.stage === "agreement")) === JSON.stringify(soldBaselines)
  // A retried capture (a recovered release) finds the row and writes nothing.
  const retried = await kit.service(() => baselines.captureHomeMarginBaseline({ orgId: org.orgId, projectId: home.projectId, stage: "release" }))
  observed.retriedCapture = { sameBaseline: retried.id === releaseBaseline?.id, rows: count(kit, `select 1 from public.home_margin_baselines where project_id=${kit.q(home.projectId)}`) }
  observed.baselineRewrite = await attempt(() => Promise.resolve(kit.sql(`update public.home_margin_baselines set margin_cents = 0 where project_id=${kit.q(home.projectId)}`)))
    .then((text) => (text === "allowed" ? "allowed" : /margin baseline cannot be changed/.test(text) ? "refused: a baseline cannot be changed" : text.slice(0, 200)))
  const report = await kit.as(org.owner, () => reporting.getProductionPortfolioReport({ communityId: org.communityId }))
  const lotRow = report.communities.flatMap((community) => community.lots).find((row) => row.projectId === home.projectId)
  observed.report = lotRow ? { originalMarginStage: lotRow.originalMarginStage, originalMarginCents: lotRow.originalMarginCents, originalMarginPercent: lotRow.originalMarginPercent, revenueCents: lotRow.revenueCents } : null
  check.equal("a signed agreement's total and snapshot are refused to the owner, the service role and the database superuser; a later catalog change moves neither them nor the baselines; release captures its baseline once and reporting shows it as the original margin", expected.expected, observed)
  return { orgId: org.orgId, projectId: home.projectId, contractId: home.contractId }
}

// ---------------------------------------------------------------------------
// 8. EP03-10: a configuration that breaks a rule comes back as structured violations with
//    fixes; an offered fix applies; a fix into a cutoff-locked selection is blocked and refused.

async function invalidConfigurationExplainsAndFixes(kit, expected, check) {
  const { org } = await world(kit)
  const catalog = app("option-catalog"), selections = app("selections"), rules = app("configuration-rules"), cutoffs = app("selection-cutoffs"), sales = app("community-sales")
  // The flag row is configuration this subcase is not about (fixture), as in LOT-01's configuration area.
  kit.sql(`insert into public.feature_flags(org_id, flag_key, enabled) values(${kit.q(org.orgId)}, '${rules.CONFIGURATION_RULES_FLAG}', true) on conflict (org_id, flag_key) do update set enabled=excluded.enabled`)
  const design = (input) => dedicatedOption(kit, org, { scope: "design_studio", costCode: "06-100", vendor: "Palmetto Framing", ...input })
  const laminate = await design({ sku: "KT-LAM", name: "Laminate countertops", categoryId: org.categoryIds.Kitchen, priceCents: 120000, costCents: 70000 })
  const alt = await design({ sku: "EL-ALT", name: "Alternate lighting", categoryId: org.categoryIds.Electrical, priceCents: 150000, costCents: 90000, costCode: "26-000", vendor: "Bright Electric" })
  const tile = await design({ sku: "FL-TIL", name: "Porcelain tile flooring", categoryId: org.categoryIds.Flooring, priceCents: 640000, costCents: 380000 })
  const extStd = await design({ sku: "EX-STD", name: "Standard exterior lighting", category: "Exterior lighting", priceCents: 0, costCents: 0, costCode: "26-000", vendor: "Bright Electric" })
  const extLux = await design({ sku: "EX-LUX", name: "Landscape lighting package", categoryId: org.categoryIds["Exterior lighting"], priceCents: 380000, costCents: 220000, costCode: "26-000", vendor: "Bright Electric" })
  // A second selection group for the new category, so one group can pass its cutoff while the other is still open.
  const exterior = await kit.as(org.team.design, () => catalog.upsertSelectionGroup({ name: "Exterior selections", scheduleTaskKey: "interior-finishes", cutoffOffsetDays: -14, cutoffAnchor: "start", sortOrder: 1, categoryIds: [org.categoryIds["Exterior lighting"]] }))
  // The rules: quartz countertops need the recessed lighting package; tile flooring needs landscape lighting.
  await kit.as(org.team.design, () => rules.addOptionConfigurationRule({ sourceId: org.optionIds["KT-QTZ"], targetId: org.optionIds["EL-LGT"], kind: "requires" }))
  await kit.as(org.team.design, () => rules.addOptionConfigurationRule({ sourceId: tile.id, targetId: extLux.id, kind: "requires" }))
  const sku = skuOf(kit, org)
  const describeViolations = (violations) => violations.map((violation) => ({ kind: violation.kind, source: sku(violation.sourceOptionId), target: sku(violation.targetOptionId), message: violation.message }))
  const describeFix = (fix) => fix ? { kind: fix.kind, label: fix.label, add: fix.add ? sku(fix.add.optionId) : null, remove: fix.remove ? sku(fix.remove.optionId) : null, priceDeltaCents: fix.priceDeltaCents, blockedBy: fix.blockedBy, applicable: fix.applicable } : null
  // The fix that adds what the rule requires, in full; the fixes that take the rule's source
  // away, in summary (which siblings are offered depends on what else the catalog holds).
  const describeIssues = (issues, { requires, source }) => {
    const ruleIds = issues.violations.map((violation) => violation.id)
    const away = issues.fixes.filter((fix) => fix.remove && sku(fix.remove.optionId) === source)
    return {
      violations: describeViolations(issues.violations),
      addsTheRequiredOption: describeFix(issues.fixes.find((fix) => fix.add && sku(fix.add.optionId) === requires)),
      replacesTheSource: { offered: away.length > 0, allApplicable: away.every((fix) => fix.applicable), keepTheSourceCategory: away.every((fix) => fix.kind === "swap_option") },
      everyFixClearsTheRuleAndAddsNoConflict: issues.fixes.length > 0 && issues.fixes.every((fix) => ruleIds.every((id) => fix.resolves.includes(id)) && fix.resultingViolations.length === 0),
      otherFixes: issues.fixes.filter((fix) => !(fix.add && sku(fix.add.optionId) === requires) && !away.includes(fix)).map(describeFix),
    }
  }
  const yesterday = seed.isoDay(-1)
  const dated = (text) => (typeof text === "string" ? text.replaceAll(yesterday, "<yesterday>") : text)
  const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return { message: dated(error.message), violations: error.violations ? describeViolations(error.violations) : null } } }
  const observed = {}

  // SALES: a draft that breaks the rule is refused with its violations, and is offered fixes; the added line prices.
  const draftLot = nextLot(org)
  const draftSwing = one(kit, `select swing from public.lots where id=${kit.q(draftLot.id)}`).swing
  const draft = seed.configuration(org, { lotId: draftLot.id, plan: org.plans[0], swing: draftSwing, skus: ["ST-GAR", "KT-QTZ", "EL-ALT"] })
  observed.salesQuote = await refusal(() => kit.as(org.team.sales, () => sales.priceAgreementDraft(draft)))
  const salesIssues = await kit.as(org.team.sales, () => rules.getSalesConfigurationFixes(draft))
  observed.salesIssues = describeIssues(salesIssues, { requires: "EL-LGT", source: "KT-QTZ" })
  const addLighting = salesIssues.fixes.find((fix) => fix.add && sku(fix.add.optionId) === "EL-LGT")
  const fixedDraft = { ...draft, optionItems: [...draft.optionItems.filter((item) => !addLighting?.remove || item.optionId !== addLighting.remove.optionId), ...(addLighting ? [{ optionId: addLighting.add.optionId }] : [])] }
  observed.salesQuoteWithTheFix = await refusal(() => kit.as(org.team.sales, () => sales.priceAgreementDraft(fixedDraft)))

  // BUYER (portal): a sold home with laminate, wide-plank and the alternate lighting chosen.
  const portal = (work) => kit.service(work)
  const home = await sell(kit, org, "Configuration Buyer", ["ST-GAR"])
  const rowOf = (projectId, category) => designRows(kit, projectId).find((row) => row.category === category)
  const pick = (projectId, category, optionId) => portal(() => selections.selectProjectOption({ orgId: org.orgId, projectId, selectionId: rowOf(projectId, category).id, optionId, portalAccess: true }))
  await pick(home.projectId, "Electrical", alt.id)
  await pick(home.projectId, "Flooring", org.optionIds["FL-LVP"])
  await pick(home.projectId, "Kitchen", laminate.id)
  await pick(home.projectId, "Exterior lighting", extStd.id)
  const proposal = { selectionId: rowOf(home.projectId, "Kitchen").id, optionId: org.optionIds["KT-QTZ"] }
  observed.buyerChoosesQuartz = await refusal(() => pick(home.projectId, "Kitchen", proposal.optionId))
  observed.kitchenAfterRefusal = sku(rowOf(home.projectId, "Kitchen").selected_option_id)
  const issues = await portal(() => rules.getHomeConfigurationFixes(org.orgId, home.projectId, { portalAccess: true, changes: [proposal] }))
  observed.buyerIssues = describeIssues(issues, { requires: "EL-LGT", source: "KT-QTZ" })
  // The buyer applies the offered fix, then the choice it corrected (as the portal's apply action does).
  const lightingFix = issues.fixes.find((fix) => fix.add && sku(fix.add.optionId) === "EL-LGT")
  const resolved = await portal(() => rules.resolveHomeConfigurationFix(org.orgId, home.projectId, { fixId: lightingFix.id, changes: [proposal] }, { portalAccess: true }))
  observed.resolvedFix = { selection: resolved.selectionId === rowOf(home.projectId, "Electrical").id ? "Electrical" : resolved.selectionId, option: sku(resolved.optionId) }
  await portal(() => selections.selectProjectOption({ orgId: org.orgId, projectId: home.projectId, selectionId: resolved.selectionId, optionId: resolved.optionId, portalAccess: true }))
  await pick(home.projectId, "Kitchen", proposal.optionId)
  observed.afterFix = Object.fromEntries(designRows(kit, home.projectId).map((row) => [row.category, sku(row.selected_option_id)]))
  observed.issuesAfterFix = (await portal(() => rules.getHomeConfigurationFixes(org.orgId, home.projectId, { portalAccess: true }))).violations.length

  // LOCKED: the exterior group's cutoff passes; the only fix that adds landscape lighting would
  // touch that selection, so it is offered blocked and the server refuses it.
  const locked = await sell(kit, org, "Cutoff Buyer", ["ST-GAR"])
  await pick(locked.projectId, "Electrical", org.optionIds["EL-LGT"])
  await pick(locked.projectId, "Flooring", org.optionIds["FL-LVP"])
  await pick(locked.projectId, "Kitchen", laminate.id)
  await pick(locked.projectId, "Exterior lighting", extStd.id)
  await kit.as(org.team.design, () => cutoffs.overrideGroupCutoff({ projectId: locked.projectId, groupId: exterior.id, cutoffDate: seed.isoDay(-1), reason: "Exterior package ordered with the lot's site work" }))
  const tileProposal = { selectionId: rowOf(locked.projectId, "Flooring").id, optionId: tile.id }
  observed.buyerChoosesTile = await refusal(() => pick(locked.projectId, "Flooring", tile.id))
  const lockedIssues = await portal(() => rules.getHomeConfigurationFixes(org.orgId, locked.projectId, { portalAccess: true, changes: [tileProposal] }))
  observed.lockedIssues = describeIssues(lockedIssues, { requires: "EX-LUX", source: "FL-TIL" })
  const blockedFix = lockedIssues.fixes.find((fix) => fix.add && sku(fix.add.optionId) === "EX-LUX")
  observed.applyBlockedFix = await refusal(() => portal(() => rules.resolveHomeConfigurationFix(org.orgId, locked.projectId, { fixId: blockedFix?.id ?? "missing", changes: [tileProposal] }, { portalAccess: true })))
  observed.writeIntoTheLockedSelection = await refusal(() => pick(locked.projectId, "Exterior lighting", extLux.id))
  observed.lockedHomeUnchanged = Object.fromEntries(designRows(kit, locked.projectId).map((row) => [row.category, sku(row.selected_option_id)]))
  check.equal("sales and buyer configurations that break a rule return their violations and proven fixes; an offered fix applies and clears them; a fix into a selection past its cutoff is offered blocked and refused, and the locked selection cannot be written", expected.expected, observed)
  return { orgId: org.orgId, projectId: home.projectId, lockedProjectId: locked.projectId }
}

// ---------------------------------------------------------------------------
// 9. EP03-09: a new plan edition reaches the homes on the old one only by a plan.adopt
//    holder's decision, home by home, by the path each home's state allows.

/** Lots 12-20 bought in Books and developed, as the first tranche was (lot 11 is subcase 4's). */
async function takeDownLaterLots(kit, org) {
  const communities = app("communities"), lotsService = app("lots"), inventory = app("books/inventory")
  const tranche = org.lots.slice(11, 20)
  const takedown = await kit.as(org.team.land, () => communities.createLotTakedown(org.communityId, { name: "Tranche 2", communityPhaseId: org.phaseIds[1], scheduledDate: "2026-06-03", lotCount: tranche.length, pricePerLotCents: 7200000, depositCents: 0 }))
  await kit.as(org.team.land, () => lotsService.bulkUpdateLots(org.communityId, { lotIds: tranche.map((row) => row.id), patch: { takedownId: takedown.id } }))
  await kit.as(org.owner, () => inventory.acquireLandInventory({ date: "2026-06-03", allocations: tranche.map((row) => ({ lotId: row.id, amountCents: 7200000 })), cashAccountId: seed.glId(kit, org, "1000"), cashCents: 7200000 * tranche.length, debtInstrumentId: null, debtCents: 0, reference: "Cypress Landing tranche 2", evidenceUrl: `${seed.EVIDENCE}/tranche-2` }))
  await kit.as(org.team.land, () => communities.closeLotTakedown(takedown.id, { actualDate: "2026-06-03" }))
  await kit.as(org.team.land, () => lotsService.bulkUpdateLots(org.communityId, { lotIds: tranche.map((row) => row.id), patch: { status: "developed" } }))
  return Object.fromEntries(tranche.map((row) => [row.lot_number, row]))
}

async function planChangeReachesSoldHomes(kit, expected, check) {
  const { org } = await world(kit)
  const plans = app("house-plans"), lots = app("lots"), sales = app("community-sales"), proposals = app("plan-change-proposals"), changeOrders = app("change-orders"), starts = app("starts")
  // The Heron: its own plan, so its new edition moves no home another subcase sold. Its takeoff
  // carries manual unit costs, the basis a review values the change on.
  const heron = await releasedPlan(kit, org, { code: "HR1900", name: "The Heron", heatedSqft: 1900, unitCosts: true })
  await kit.as(org.owner, () => sales.offerPlanInCommunity({ communityId: org.communityId, housePlanId: heron.id, basePriceCents: 41000000 }))
  const later = await takeDownLaterLots(kit, org)
  const narrow = await newLots(kit, org, [{ lotNumber: "71", dimensions: { widthFt: 40, depthFt: 120, frontSetbackFt: 20, rearSetbackFt: 15, sideSetbackFt: 5 } }, { lotNumber: "72" }])
  const pin = (lotId) => kit.as(org.team.starts, () => lots.assignPlanToLot(lotId, { versionId: heron.versionId, elevationId: heron.elevationIds[0] }))

  // Homes on v1 in every state: two unsold lots, a spec home, two contracted homes, a released home.
  await pin(later["15"].id)
  await pin(narrow["71"])
  await pin(narrow["72"])
  // A spec home: the starts desk opens the pinned lot's start package with no buyer, which creates its home.
  const specPackage = await kit.as(org.team.starts, () => starts.openStartPackage(narrow["72"], { isFinanced: false }))
  const adopted = await sell(kit, org, "Adopting Buyer", ["ST-GAR"], { plan: heron, lot: later["12"] })
  const keeping = await sell(kit, org, "Keeping Buyer", ["ST-GAR"], { plan: heron, lot: later["13"] })
  const released = await startedHome(kit, org, "Released Buyer", ["ST-GAR"], { plan: heron, lot: later["14"] })
  const homes = { [later["15"].id]: "unsold lot 15", [narrow["71"]]: "unsold lot 71", [narrow["72"]]: "spec lot 72", [later["12"].id]: "contracted lot 12 (adopts)", [later["13"].id]: "contracted lot 13 (keeps)", [later["14"].id]: "released lot 14" }
  const pinOf = (lotId) => { const row = one(kit, `select house_plan_version_id v from public.lots where id=${kit.q(lotId)}`); return row.v === heron.versionId ? "v1" : row.v === v2 ? "v2" : row.v }
  // After the lots were pinned the plan's drawn footprint is recorded: lot 71 no longer fits it.
  await kit.as(org.owner, () => plans.updateHousePlan(heron.id, { footprintWidthFt: 50, footprintDepthFt: 70 }))

  // v2: framing grows by 50 sf (50 x $44 = $2,200 of manual takeoff cost).
  const draft = await kit.as(org.owner, () => plans.createPlanVersion(heron.id, { copyFromVersionId: heron.versionId, label: "Larger lanai framing" }))
  const v2 = draft.id
  await kit.as(org.owner, () => plans.replaceTakeoffLines(v2, takeoffLines(org, 1950, { unitCosts: true })))
  await kit.as(org.owner, () => plans.updatePlanVersion(v2, { label: "Larger lanai framing", scheduleTemplateId: org.scheduleTemplateId, checklistTemplateIds: [], selectionCategoryIds: [] }))
  const release = await kit.as(org.owner, () => plans.releasePlanVersion(v2))
  const observed = {
    release: { version: release.version.version_number, status: release.version.status, homesOnEarlierVersions: release.homes_on_earlier_versions },
    pinsAfterRelease: Object.fromEntries(Object.entries(homes).map(([lotId, label]) => [label, pinOf(lotId)])),
  }

  // The review: every home on v1, its state and what moving it costs.
  const review = await kit.as(org.owner, () => proposals.createPlanChangeProposal({ planId: heron.id, toVersionId: v2, summary: "Larger lanai framing" }))
  const homeOf = (dto, lotId) => dto.homes.find((home) => home.lotId === lotId)
  const describeReview = (dto) => Object.fromEntries(dto.homes.map((home) => [homes[home.lotId] ?? home.lotLabel, { state: home.state, fromVersion: home.fromVersionNumber, costDeltaCents: home.costDeltaCents, priceDeltaCents: home.priceDeltaCents, decision: home.decision, allowed: home.allowedDecisions, path: home.path.kind }]))
  observed.review = { toVersion: review.toVersionNumber, status: review.status, homes: describeReview(review) }
  const decide = (actor, lotId, decision, extra = {}) => attempt(() => kit.as(actor, () => proposals.decidePlanChangeHome({ proposalHomeId: homeOf(review, lotId).id, decision, ...extra })))
  observed.decideBeforeSubmission = await decide(org.team.purchasing, later["15"].id, "adopt")
  await kit.as(org.owner, () => proposals.submitPlanChangeProposal(review.id))
  observed.decideWithoutPlanAdopt = await decide(org.team.starts, later["15"].id, "adopt")

  // Unsold: adoption re-pins at once; an adoption the lot no longer fits is refused.
  observed.adoptUnsold = await decide(org.team.purchasing, later["15"].id, "adopt")
  observed.adoptUnsoldThatNoLongerFits = await decide(org.team.purchasing, narrow["71"], "adopt")
  observed.declineUnsold = await decide(org.team.purchasing, narrow["71"], "decline", { reason: "Keep the original edition on this lot" })

  // Contracted: adoption drafts a change order to the buyer and leaves the agreement and the pin alone.
  const agreement = () => one(kit, `select total_cents, snapshot from public.contracts where id=${kit.q(adopted.contractId)}`)
  const signed = agreement()
  observed.adoptContracted = await decide(org.owner, later["12"].id, "adopt", { priceDeltaCents: 300000 })
  const current = await kit.as(org.owner, () => proposals.getPlanChangeReview(heron.id))
  const changeOrderId = homeOf(current, later["12"].id).changeOrderId
  const changeOrder = () => one(kit, `select status, requires_signature, client_visible, title, total_cents, metadata->'plan_adoption'->>'to_version_id' to_version from public.change_orders where id=${kit.q(changeOrderId)}`)
  const drafted = changeOrder()
  observed.changeOrder = { status: drafted.status, requiresBuyerSignature: drafted.requires_signature, title: drafted.title, totalCents: Number(drafted.total_cents), adoptsV2: drafted.to_version === v2 }
  observed.beforeExecution = { pin: pinOf(later["12"].id), adoptedAt: Boolean(homeOf(current, later["12"].id).adoptedAt),
    agreementUntouched: JSON.stringify(agreement()) === JSON.stringify(signed) }
  // The buyer signs the amendment on paper; the owner records the executed change order.
  await kit.as(org.owner, () => changeOrders.approveChangeOrder({ changeOrderId, approval: { signerName: "Adopting Buyer", signerEmail: "adopting.buyer@acceptance.example.test", note: "Signed at the design center" } }))
  const executed = await kit.as(org.owner, () => proposals.getPlanChangeReview(heron.id))
  observed.afterExecution = { changeOrder: changeOrder().status, pin: pinOf(later["12"].id), adoptedAt: Boolean(homeOf(executed, later["12"].id).adoptedAt),
    agreementUntouched: JSON.stringify(agreement()) === JSON.stringify(signed) }

  // Released: declining needs a reason, and keeps the home on the version it was released on.
  observed.declineReleasedWithoutReason = (await decide(org.owner, later["14"].id, "decline", { reason: "no" })) === "allowed" ? "allowed" : "refused"
  observed.declineReleased = await decide(org.owner, later["14"].id, "decline", { reason: "Framing is already underway on the original edition" })
  observed.releasedHome = { pin: pinOf(later["14"].id), package: one(kit, `select status from public.start_packages where id=${kit.q(released.packageId)}`).status,
    planGate: one(kit, `select g.status from public.start_package_gates g join public.start_gate_definitions d on d.id=g.gate_definition_id where g.start_package_id=${kit.q(released.packageId)} and d.key='plan_pinned'`).status }

  // A contracted home whose move is declined still starts on its superseded version: the plan gate passes and the release completes.
  observed.declineContracted = await decide(org.owner, later["13"].id, "decline", { reason: "Buyer keeps the edition they signed for" })
  await seed.chooseDesign(kit, org, { projectId: keeping.projectId })
  const keptGates = await seed.clearStartGates(kit, org, { lotId: later["13"].id, projectId: keeping.projectId })
  const planGate = (gates) => gates.find((gate) => gate.key === "plan_pinned")?.status
  observed.declinedContractedPlanGate = planGate(await kit.as(org.team.starts, () => starts.refreshAutoGates(keptGates.packageId)))
  const keptRelease = await seed.releaseHome(kit, org, { packageId: keptGates.packageId, projectId: keeping.projectId })
  observed.declinedContractedRelease = { package: keptRelease.released.status, pin: pinOf(later["13"].id) }

  // Spec: deferred, it stays on v1 — and, undecided, its start package does not pass the plan gate.
  observed.deferSpec = await decide(org.owner, narrow["72"], "defer", { reason: "Revisit at the next spec release" })
  // The lot v2 no longer fits waits too; with no home pending, the review is decided.
  observed.deferUnfitUnsold = await decide(org.team.purchasing, narrow["71"], "defer", { reason: "Needs a fit override before it can move" })
  observed.deferredSpec = { pin: pinOf(narrow["72"]), planGate: planGate(await kit.as(org.team.starts, () => starts.refreshAutoGates(specPackage.id))) }

  const final = await kit.as(org.owner, () => proposals.getPlanChangeReview(heron.id))
  observed.final = { status: final.status, homes: Object.fromEntries(final.homes.map((home) => [homes[home.lotId] ?? home.lotLabel, { decision: home.decision, adopted: Boolean(home.adoptedAt), changeOrder: Boolean(home.changeOrderId), pin: pinOf(home.lotId) }])) }
  observed.decisionsAudited = count(kit, `select 1 from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='plan_change_proposal_home' and action='update'`)
  check.equal("releasing a new edition reports the homes on the old one and moves none; a review lists each with its state and cost delta; only a plan.adopt holder decides; unsold homes re-pin under the lot's rules, a contracted home moves only when its buyer's change order executes, a declined home keeps — and starts on — its version, a deferred one waits", expected.expected, observed)
  return { orgId: org.orgId, proposalId: review.id, changeOrderId }
}

module.exports = {
  id: "PROD-01",
  subcases: {
    "version-history-pins-the-sold-home": versionHistoryPinsTheSoldHome,
    "group-confirmation-is-all-or-nothing": groupConfirmationIsAllOrNothing,
    "stale-catalog-refuses-the-selection-write": staleCatalogRefusesTheSelectionWrite,
    "offering-holds-everywhere": offeringHoldsEverywhere,
    "lot-fit-refuses-and-overrides-with-evidence": lotFitRefusesAndOverridesWithEvidence,
    "production-pricing-never-guesses": productionPricingNeverGuesses,
    "sold-price-and-margin-are-locked": soldPriceAndMarginAreLocked,
    "plan-change-reaches-sold-homes": planChangeReachesSoldHomes,
    "invalid-configuration-explains-and-fixes": invalidConfigurationExplainsAndFixes,
  },
}
