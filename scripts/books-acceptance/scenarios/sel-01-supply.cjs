// SEL-01 subcases for EP06-03 (cutoffs enforced in the database, in the community's day, with
// home-scoped override authority), EP06-04 (supplier lead times and released procurement) and
// EP06-05 (an approved selection change lands on the agreement, selections, purchase orders,
// budget and schedule together). Composed into SEL-01 by sel-01.cjs; each subcase is
// `async (kit, expected, check)`, acts through `kit.as` so permissions and row security are the
// real ones, and returns { orgId, projectId }.
//
//   override-needs-home-authority         03  a coordinator limited to another division is refused; in-division succeeds with before/after audit
//   data-api-cannot-move-a-cutoff         03  a member's direct writes to a group's cutoff/status/override or a choice's lock are refused
//   cutoff-holds-under-race               03  the sweep and a write on the cutoff boundary serialize on the home lock; never a write after the lock
//   cutoff-day-is-the-community-day       03  a cutoff that is today in the community is open even where the server's day has moved on
//   lead-time-closes-an-option-early      04  an option that cannot arrive in time is refused while the group is open, with alternates and an exception
//   unavailable-option-opens-an-exception 04  an option taken off sale opens one exception; an alternate resolves it; an expedite needs authority
//   released-po-routes-the-change         04  after the purchase order is released a direct change is refused; the change order revises the owning PO
//   approved-change-moves-everything-once 05  one buyer signature: agreement version, confirmed selection, VPO, budget revision, pending schedule impact
//   signed-change-is-frozen               05  a member never edits a raised selection change, its lines or its price
//   failed-apply-leaves-nothing           05  a selection that moved since pricing fails the approval; nothing lands; the change order says so
//   concurrent-changes-cannot-double-count 05 a second open change order on a selection is refused; two approvals of one land once
//
// The expected value for each subcase (expected/SEL-01.json, under each subcase's `expected`) is
// the observed object it builds.
//
// SQL is used only for what a subcase is not about, and says so: lead times and a schedule task
// on the home (fixtures), the community's time zone, the direct writes the database must refuse,
// and reads of outcomes.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")
const { asMember, race } = require("./sessions.cjs")

const lot = () => require("./lot-01.cjs").helpers
const equal = (check, label, expected, observed) => lot().equal(check, label, expected, observed)
const attempt = async (work) => {
  try { await work(); return "allowed" } catch (error) { return error.code ?? error.message }
}
const sqlAttempt = (kit, statement) => {
  try { kit.sql(statement); return "allowed" } catch (error) { const line = /ERROR:\s+([^\n]+)/.exec(error.message); return line ? line[1].trim() : error.message }
}
const one = (kit, sql) => kit.rows(sql)[0]
const count = (kit, sql) => Number(kit.rows(`select count(*)::int n from (${sql}) t`)[0].n)

// ---------------------------------------------------------------------------
// The organisation: a production builder with its community, catalog and a second division.

const ORGS = new WeakMap()
/** Countertop alternates beside the seed's quartz, priced on every plan. Lead times are set per subcase. */
const COUNTERTOPS = [
  { sku: "KT-LAM", name: "Laminate countertops", priceCents: 150000, costCents: 80000 },
  { sku: "KT-GRN", name: "Granite countertops", priceCents: 390000, costCents: 240000 },
]

/**
 * The supply org for a pool of subcases. A tranche develops ten lots, so the homes whose purchase
 * orders are released get an org of their own ("released") beside the one for open homes.
 */
function supplyOrg(kit, pool = "open") {
  if (!ORGS.has(kit)) ORGS.set(kit, new Map())
  const pools = ORGS.get(kit)
  if (!pools.has(pool)) pools.set(pool, (async () => {
    const org = await seed.productionBuilder(kit, { name: pool === "open" ? "SEL-01 supply" : `SEL-01 supply (${pool})` })
    await seed.seedCommunity(kit, org)
    await seed.seedProduct(kit, org)
    await seed.takeDownTranche(kit, org)
    const catalog = app("option-catalog")
    const kitchen = one(kit, `select category_id from public.selection_options where id=${kit.q(org.optionIds["KT-QTZ"])}`).category_id
    for (const [index, option] of COUNTERTOPS.entries()) {
      const saved = await kit.as(org.team.design, () => catalog.upsertOption({ categoryId: kitchen, name: option.name, optionScope: "design_studio", priceCents: option.priceCents, costCents: option.costCents, costCodeId: org.costCodeIds["06-100"], sku: option.sku, vendor: "Palmetto Framing", sortOrder: 10 + index, isAvailable: true }))
      org.optionIds[option.sku] = saved.id
      for (const plan of org.plans) await kit.as(org.team.design, () => catalog.setCatalogPrice({ optionId: saved.id, housePlanVersionId: plan.versionId, priceCents: option.priceCents, costCents: option.costCents, isAvailable: true }))
    }
    // A coordinator scoped to a division this community is not in.
    const elsewhere = await kit.as(org.owner, () => app("divisions").createDivision({ name: "Treasure Coast", code: "TC", region: "East Florida" }))
    org.outsideCoordinator = kit.addMember(org, "org_design_studio_coordinator")
    kit.sql(`begin;
      update public.memberships set division_scope='assigned' where org_id=${kit.q(org.orgId)} and user_id=${kit.q(org.outsideCoordinator.userId)};
      insert into public.membership_divisions(membership_id, division_id) select id, ${kit.q(elsewhere.id)} from public.memberships where org_id=${kit.q(org.orgId)} and user_id=${kit.q(org.outsideCoordinator.userId)};
      commit;`)
    org.uses = { next: 0, released: 0 }
    return org
  })())
  return pools.get(pool)
}

function nextLot(org) {
  if (org.uses.next > 9) throw Error("Out of developed lots")
  return org.lots[org.uses.next++]
}

/** A home with an executed agreement and every design choice made (unconfirmed). */
async function soldHome(kit, org, name) {
  const lotRow = nextLot(org)
  const prospect = await seed.registerBuyer(kit, org, { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@acceptance.example.test` })
  const { reservation } = await seed.reserveLot(kit, org, { prospect, lotId: lotRow.id, depositCents: 2000000, receivedOn: "2026-06-06" })
  const swing = one(kit, `select swing from public.lots where id=${kit.q(lotRow.id)}`).swing
  const sale = await seed.signAgreement(kit, org, { reservationId: reservation.id, config: seed.configuration(org, { lotId: lotRow.id, plan: org.plans[0], swing, skus: ["ST-GAR"] }) })
  const projectId = sale.projectId
  const rows = designRows(kit, projectId)
  for (const row of rows) await kit.as(org.team.design, () => app("selections").selectProjectOption({ orgId: org.orgId, projectId, selectionId: row.id, optionId: org.optionIds[seed.DESIGN_PICKS[row.category]] }))
  return { ...sale, projectId, lotId: lotRow.id, kitchenId: rows.find((row) => row.category === "Kitchen").id }
}

const designRows = (kit, projectId) => kit.rows(`select s.id, c.name category, s.selected_option_id, s.status, s.locked_at is not null locked, s.price_cents_snapshot, s.cost_cents_snapshot, s.source_change_order_id
  from public.project_selections s join public.selection_categories c on c.id=s.category_id where s.project_id=${kit.q(projectId)} and s.group_id is not null order by c.name`)
const kitchenOf = (kit, home) => designRows(kit, home.projectId).find((row) => row.id === home.kitchenId)
const groupOf = (kit, org, projectId) => one(kit, `select id, cutoff_date::text cutoff, cutoff_source source, status, locked_at is not null locked from public.project_selection_groups where project_id=${kit.q(projectId)} and group_id=${kit.q(org.selectionGroupId)}`)
const choose = (kit, org, home, sku, actor = org.team.design, extra = {}) => kit.as(actor, () => app("selections").selectProjectOption({ orgId: org.orgId, projectId: home.projectId, selectionId: home.kitchenId, optionId: org.optionIds[sku], ...extra }))

/** Fixture: the home's interior-finishes task `days` out, and the group re-anchored to it by the real recompute. */
async function anchorInteriorFinishes(kit, org, home, days) {
  kit.sql(`insert into public.schedule_items(org_id, project_id, name, start_date, end_date, metadata) values(${kit.q(org.orgId)}, ${kit.q(home.projectId)}, 'Interior finishes', ${kit.q(seed.isoDay(days))}, ${kit.q(seed.isoDay(days + 28))}, '{"template_item_key":"interior-finishes"}')`)
  await kit.service(() => app("selection-cutoffs").recomputeProjectSelectionCutoffs(home.projectId, org.orgId))
}
/** Fixture: an option's supplier lead time. */
const leadTime = (kit, org, sku, days) => kit.sql(`update public.selection_options set lead_time_days=${days === null ? "null" : Number(days)} where id=${kit.q(org.optionIds[sku])}`)

/** Confirmed, cutoff passed, released, and its purchase orders approved: the trades hold the order. */
async function builtHome(kit, org, name) {
  const home = await soldHome(kit, org, name)
  await seed.chooseDesign(kit, org, { projectId: home.projectId })
  const gates = await seed.clearStartGates(kit, org, { lotId: home.lotId, projectId: home.projectId })
  // One start a week, so no release asks to go over the community's weekly start slot.
  await seed.releaseHome(kit, org, { packageId: gates.packageId, projectId: home.projectId, startInDays: 7 * org.uses.released++ })
  const orders = kit.rows(`select id from public.commitments where project_id=${kit.q(home.projectId)} and commitment_type='purchase_order' and status='draft' order by contract_number`)
  for (const order of orders) await kit.as(org.owner, () => app("commitments").updateCommitment({ commitmentId: order.id, input: { status: "approved", prequal_override_note: "Acceptance trade: no prequalification on file for this vendor." } }))
  home.owningPurchaseOrderId = one(kit, `select c.id from public.commitments c join public.commitment_lines l on l.commitment_id=c.id where c.project_id=${kit.q(home.projectId)} and l.metadata->>'source_ref'=${kit.q(home.kitchenId)} limit 1`).id
  return home
}

const raiseChange = (kit, org, home, sku, input = {}) => kit.as(org.team.design, () => app("selection-change-orders").createPostCutoffSelectionChangeOrder({ projectId: home.projectId, changes: [{ selectionId: home.kitchenId, newOptionId: org.optionIds[sku] }], ...input }))
const buyerSigns = (kit, org, home, changeOrderId) => kit.service(() => app("change-orders").approveChangeOrderFromPortalSignature({
  orgId: org.orgId, projectId: home.projectId, changeOrderId, signerName: `${home.projectId.slice(0, 4)} buyer`, signerEmail: null, signatureImage: "data:image/png;base64,iVBORw0KGgo=", signerIp: "203.0.113.7",
}))
const versionsOf = (kit, projectId) => kit.rows(`select v.version_number, v.kind, v.price_delta_cents::bigint delta from public.purchase_agreement_versions v join public.contracts c on c.id=v.contract_id where c.project_id=${kit.q(projectId)} and c.contract_type='purchase_agreement' order by v.version_number`)
  .map((row) => ({ version: row.version_number, kind: row.kind, deltaCents: row.kind === "original" ? "agreement price" : Number(row.delta) }))

// ---------------------------------------------------------------------------
// EP06-03

async function overrideNeedsHomeAuthority(kit, expected, check) {
  const org = await supplyOrg(kit)
  const home = await soldHome(kit, org, "Authority Buyer")
  const cutoffs = app("selection-cutoffs")
  const override = (actor, reason = "Buyer travelling until next month") => attempt(() => kit.as(actor, () => cutoffs.overrideGroupCutoff({ projectId: home.projectId, groupId: org.selectionGroupId, cutoffDate: seed.isoDay(20), reason })))
  const observed = {
    outsideDivision: await override(org.outsideCoordinator),
    salesConsultant: await override(org.team.sales),
    afterRefusals: groupOf(kit, org, home.projectId).source,
    inDivision: await override(org.team.design),
  }
  const group = groupOf(kit, org, home.projectId)
  const audit = one(kit, `select actor_user_id, before_data, after_data from public.audit_log where entity_type='project_selection_group' and entity_id=${kit.q(group.id)} order by id desc limit 1`)
  observed.recorded = {
    source: group.source, status: group.status,
    auditBy: audit.actor_user_id === org.team.design.userId, auditBefore: audit.before_data.cutoff_source, auditAfter: audit.after_data.cutoff_source,
    events: count(kit, `select 1 from public.events where entity_id=${kit.q(group.id)} and event_type='selection_cutoff_overridden'`),
    deniedDecisionLogged: count(kit, `select 1 from public.authorization_audit_log where actor_user_id=${kit.q(org.outsideCoordinator.userId)} and action_key='selections.cutoff.override' and decision='deny'`) > 0,
  }
  equal(check, "a cutoff override needs the override permission on this home's division; the in-division coordinator's override is audited with its before and after", expected.expected, observed)
  return { orgId: org.orgId, projectId: home.projectId }
}

async function dataApiCannotMoveACutoff(kit, expected, check) {
  const org = await supplyOrg(kit)
  const home = await soldHome(kit, org, "Data Api Buyer")
  const group = groupOf(kit, org, home.projectId)
  // The owner reaches every row, so a refusal here is the guard's, not row security's.
  const asCoordinator = (statement) => sqlAttempt(kit, `${asMember(org.owner)} ${statement}`)
  const observed = {
    cutoffDate: asCoordinator(`update public.project_selection_groups set cutoff_date='2099-01-01' where id=${kit.q(group.id)}`),
    status: asCoordinator(`update public.project_selection_groups set status='locked', locked_at=now() where id=${kit.q(group.id)}`),
    override: asCoordinator(`update public.project_selection_groups set cutoff_source='manual_override', override_reason='because' where id=${kit.q(group.id)}`),
    choiceLock: asCoordinator(`update public.project_selections set locked_at=now() where id=${kit.q(home.kitchenId)}`),
    choiceMetadata: asCoordinator(`update public.project_selections set metadata=metadata || '{"approval_id":"forged"}'::jsonb where id=${kit.q(home.kitchenId)}`),
    unchanged: groupOf(kit, org, home.projectId).cutoff === group.cutoff && groupOf(kit, org, home.projectId).source === group.source,
  }
  for (const key of ["cutoffDate", "status", "override"]) observed[key] = /override with a reason/.test(observed[key]) ? "refused" : observed[key]
  for (const key of ["choiceLock", "choiceMetadata"]) observed[key] = /kept by the selection service/.test(observed[key]) ? "refused" : observed[key]
  equal(check, "a member's direct writes to a group's cutoff, status or override, or a choice's lock or evidence, are refused and nothing moves", expected.expected, observed)
  return { orgId: org.orgId, projectId: home.projectId }
}

async function cutoffHoldsUnderRace(kit, expected, check) {
  const org = await supplyOrg(kit)
  const home = await soldHome(kit, org, "Race Buyer")
  // Fixture: the cutoff is two days behind the community's day, so the sweep owes this group a lock.
  kit.sql(`update public.project_selection_groups set cutoff_date=(now() at time zone 'America/New_York')::date - 2 where project_id=${kit.q(home.projectId)} and group_id=${kit.q(org.selectionGroupId)}`)
  const fence = one(kit, `select f->>'catalogRevision' "catalogRevision", f->>'homeState' "homeState" from public.read_project_selection_fence(${kit.q(org.orgId)}, ${kit.q(home.projectId)}) f`)
  const write = JSON.stringify([{ id: home.kitchenId, selected_option_id: org.optionIds["KT-LAM"], status: "selected", price_cents_snapshot: 150000, cost_cents_snapshot: 80000 }])
  const [sweep, buyer] = await race(kit, [
    `begin; select count(*) from public.lock_due_selection_groups(${kit.q(org.orgId)}, 10); commit;`,
    `begin; select public.apply_project_selection_writes(${kit.q(org.orgId)}, ${kit.q(home.projectId)}, ${kit.q(write)}::jsonb, ${kit.q(fence.catalogRevision)}, ${kit.q(fence.homeState)}); commit;`,
  ])
  const after = kitchenOf(kit, home)
  equal(check, "the sweep and a write on a passed cutoff serialize on the home's lock: the write never lands, and the group and its choices end locked", expected.expected, {
    sweepRan: sweep.ok, writeLanded: buyer.ok, kitchenStillQuartz: after.selected_option_id === org.optionIds["KT-QTZ"], kitchenLocked: after.locked, group: groupOf(kit, org, home.projectId).status,
  })
  return { orgId: org.orgId, projectId: home.projectId }
}

async function cutoffDayIsTheCommunityDay(kit, expected, check) {
  const org = await supplyOrg(kit)
  const home = await soldHome(kit, org, "Zone Buyer")
  const zone = (name) => kit.sql(`update public.communities set time_zone=${kit.q(name)} where id=${kit.q(org.communityId)}`)
  // Today in Pago Pago (UTC-11) is always a day or more behind Kiritimati (UTC+14), and never ahead of UTC.
  const pagoToday = one(kit, `select ((now() at time zone 'Pacific/Pago_Pago')::date)::text d`).d
  kit.sql(`update public.project_selection_groups set cutoff_date=${kit.q(pagoToday)} where project_id=${kit.q(home.projectId)} and group_id=${kit.q(org.selectionGroupId)}`)
  const observed = {}
  zone("Pacific/Kiritimati")
  observed.whereTheDayHasPassed = await attempt(() => choose(kit, org, home, "KT-LAM"))
  zone("Pacific/Pago_Pago")
  observed.whereItIsStillTheCutoffDay = await attempt(() => choose(kit, org, home, "KT-LAM"))
  zone("America/New_York")
  observed.whereTheDayHasPassed = observed.whereTheDayHasPassed === "SELECTION_LOCKED_CUTOFF" ? "refused: past the cutoff" : observed.whereTheDayHasPassed
  equal(check, "the cutoff day is the community's day: the same cutoff is open where it is still that day and refused where it has passed", expected.expected, observed)
  return { orgId: org.orgId, projectId: home.projectId }
}

// ---------------------------------------------------------------------------
// EP06-04

async function leadTimeClosesAnOptionEarly(kit, expected, check) {
  const org = await supplyOrg(kit)
  const home = await soldHome(kit, org, "Lead Time Buyer")
  await choose(kit, org, home, "KT-LAM")
  // Interior finishes start 40 days out (cutoff 26 days out, so the group is open); granite takes 60 days.
  await anchorInteriorFinishes(kit, org, home, 40)
  leadTime(kit, org, "KT-GRN", 60)
  leadTime(kit, org, "KT-QTZ", 21)
  let refusalMessage = null
  const granite = await attempt(() => choose(kit, org, home, "KT-GRN").catch((error) => { refusalMessage = error.message; throw error }))
  const exception = one(kit, `select reason, status, option_id, detail->>'order_by' order_by from public.selection_exceptions where selection_id=${kit.q(home.kitchenId)} order by opened_at desc limit 1`)
  const observed = {
    group: groupOf(kit, org, home.projectId).status,
    granite,
    namesTheOrderByDate: refusalMessage?.includes("had to be ordered by") ?? false,
    offersQuartz: refusalMessage?.includes("Quartz countertops") ?? false,
    exception: { reason: exception.reason, status: exception.status, forGranite: exception.option_id === org.optionIds["KT-GRN"], orderByDays: Math.round((Date.parse(exception.order_by) - Date.parse(seed.isoDay(0))) / 86400000) },
    quartz: await attempt(() => choose(kit, org, home, "KT-QTZ")),
    exceptionAfterQuartz: one(kit, `select status from public.selection_exceptions where selection_id=${kit.q(home.kitchenId)} and reason='lead_time_exceeded' order by opened_at desc limit 1`).status,
  }
  // Moving the deadline is not an expedite.
  await kit.as(org.team.design, () => app("selection-cutoffs").overrideGroupCutoff({ projectId: home.projectId, groupId: org.selectionGroupId, cutoffDate: seed.isoDay(35), reason: "Buyer asked for more time" }))
  observed.graniteAfterOverride = await attempt(() => choose(kit, org, home, "KT-GRN"))
  leadTime(kit, org, "KT-GRN", null)
  leadTime(kit, org, "KT-QTZ", null)
  equal(check, "an option that cannot arrive in time is refused while the group is open, naming its order-by date and the options still in time, with an exception on record; a cutoff override does not lift it", expected.expected, observed)
  return { orgId: org.orgId, projectId: home.projectId }
}

async function unavailableOptionOpensAnException(kit, expected, check) {
  const org = await supplyOrg(kit)
  const home = await soldHome(kit, org, "Withdrawn Buyer")
  const selections = app("selections"), exceptions = app("selection-exceptions"), catalog = app("option-catalog")
  await choose(kit, org, home, "KT-GRN")
  const granite = one(kit, `select id, category_id, name, price_cents, cost_cents, cost_code_id, sku, vendor, sort_order from public.selection_options where id=${kit.q(org.optionIds["KT-GRN"])}`)
  await kit.as(org.team.design, () => catalog.upsertOption({ id: granite.id, categoryId: granite.category_id, name: granite.name, optionScope: "design_studio", priceCents: granite.price_cents, costCents: granite.cost_cents, costCodeId: granite.cost_code_id, sku: granite.sku, vendor: granite.vendor, sortOrder: granite.sort_order, isAvailable: false }))
  await kit.service(() => app("selection-cutoffs").recomputeProjectSelectionCutoffs(home.projectId, org.orgId))
  const listed = await kit.as(org.team.design, () => selections.listHomeSelectionExceptions(home.projectId))
  const open = listed.exceptions.find((row) => row.status === "open" && row.selection_id === home.kitchenId)
  const observed = {
    opened: open ? { reason: open.reason, alternates: open.alternates.map((row) => row.name).sort() } : null,
    oneOpen: count(kit, `select 1 from public.selection_exceptions where selection_id=${kit.q(home.kitchenId)} and status='open'`),
    waiveRefused: await attempt(() => kit.as(org.team.design, () => exceptions.closeSelectionException({ exceptionId: open.id, resolution: "waived", reason: "Vendor found one slab" }))),
    salesCannotChoose: await attempt(() => kit.as(org.team.sales, () => selections.chooseSelectionAlternate({ exceptionId: open.id, optionId: org.optionIds["KT-LAM"] }))),
  }
  await kit.as(org.team.design, () => selections.chooseSelectionAlternate({ exceptionId: open.id, optionId: org.optionIds["KT-LAM"] }))
  const closed = one(kit, `select status, resolved_by from public.selection_exceptions where id=${kit.q(open.id)}`)
  observed.resolved = { status: closed.status, byTheCoordinator: closed.resolved_by === org.team.design.userId, kitchenIsLaminate: kitchenOf(kit, home).selected_option_id === org.optionIds["KT-LAM"] }
  await kit.as(org.team.design, () => catalog.upsertOption({ id: granite.id, categoryId: granite.category_id, name: granite.name, optionScope: "design_studio", priceCents: granite.price_cents, costCents: granite.cost_cents, costCodeId: granite.cost_code_id, sku: granite.sku, vendor: granite.vendor, sortOrder: granite.sort_order, isAvailable: true }))
  equal(check, "an option taken off sale opens one exception with the alternates still offered; only a lead time can be expedited; choosing an alternate resolves it in the coordinator's name", expected.expected, observed)
  return { orgId: org.orgId, projectId: home.projectId }
}

async function releasedPoRoutesTheChange(kit, expected, check) {
  const org = await supplyOrg(kit, "released")
  const home = await builtHome(kit, org, "Released Buyer")
  // Reopen the deadline: the purchase order, not the cutoff, is what stops the direct change here.
  await kit.as(org.team.design, () => app("selection-cutoffs").overrideGroupCutoff({ projectId: home.projectId, groupId: org.selectionGroupId, cutoffDate: seed.isoDay(10), reason: "Buyer asked to revisit the kitchen" }))
  // An older purchase order on the same cost code that carries no line for this selection: routing
  // by cost code alone would pick it.
  const decoy = randomUUID()
  kit.sql(`begin;
    insert into public.commitments(id, org_id, project_id, company_id, title, commitment_type, status, total_cents, created_at) values(${kit.q(decoy)}, ${kit.q(org.orgId)}, ${kit.q(home.projectId)}, ${kit.q(org.vendorIds["Palmetto Framing"])}, 'Trim carpentry', 'purchase_order', 'approved', 100000, '2020-01-01');
    insert into public.commitment_lines(org_id, commitment_id, cost_code_id, description, quantity, unit_cost_cents) values(${kit.q(org.orgId)}, ${kit.q(decoy)}, ${kit.q(org.costCodeIds["06-100"])}, 'Trim', 1, 100000);
    commit;`)
  const direct = await attempt(() => choose(kit, org, home, "KT-GRN"))
  const changeOrder = await kit.as(org.team.design, () => app("selection-change-orders").createPostCutoffSelectionChangeOrder({ projectId: home.projectId, changes: [{ selectionId: home.kitchenId, newOptionId: org.optionIds["KT-GRN"] }] }))
  await buyerSigns(kit, org, home, changeOrder.id)
  await kit.drainOutbox(org.orgId)
  const vpos = kit.rows(`select commitment_id, total_cents::bigint total, status from public.commitment_change_orders where prime_change_order_id=${kit.q(changeOrder.id)}`)
  equal(check, "after the purchase order is released a direct change is refused; the change order carries no post-cutoff fee and its variance order lands on the purchase order that owns the line", expected.expected, {
    direct,
    fee: changeOrder.metadata.selection_change.fee_cents,
    variance: vpos.map((row) => ({ onTheOwningPo: row.commitment_id === home.owningPurchaseOrderId, onTheDecoy: row.commitment_id === decoy, totalCents: Number(row.total), status: row.status })),
  })
  return { orgId: org.orgId, projectId: home.projectId }
}

// ---------------------------------------------------------------------------
// EP06-05

async function approvedChangeMovesEverythingOnce(kit, expected, check) {
  const org = await supplyOrg(kit, "released")
  const home = await builtHome(kit, org, "Propagation Buyer")
  // The home's superintendent, as the starts desk assigns one: the person a pending schedule impact waits on.
  await kit.as(org.owner, () => app("starts").setProjectSuperintendent(home.projectId, org.team.superintendent.userId))
  // Granite takes 90 days and the interior finishes start in 70: ordered today it lands 20 days late.
  const finishes = one(kit, `select id, start_date::text start from public.schedule_items where project_id=${kit.q(home.projectId)} and name='Interior finishes'`)
  kit.sql(`update public.schedule_items set start_date=${kit.q(seed.isoDay(70))}, end_date=${kit.q(seed.isoDay(98))} where id=${kit.q(finishes.id)}`)
  // The seed's past override never anchored the group to the schedule; reverting does, and the
  // override that closes the window again keeps the anchor.
  const cutoffs = app("selection-cutoffs")
  await kit.as(org.team.design, () => cutoffs.revertCutoffToSchedule({ projectId: home.projectId, groupId: org.selectionGroupId, reason: "Back to the schedule date" }))
  await kit.as(org.team.design, () => cutoffs.overrideGroupCutoff({ projectId: home.projectId, groupId: org.selectionGroupId, cutoffDate: seed.isoDay(-2), reason: "Design window closed" }))
  leadTime(kit, org, "KT-GRN", 90)
  const before = kitchenOf(kit, home)
  const changeOrder = await raiseChange(kit, org, home, "KT-GRN")
  const [change] = changeOrder.metadata.selection_change.changes
  await buyerSigns(kit, org, home, changeOrder.id)
  await buyerSigns(kit, org, home, changeOrder.id)
  await kit.drainOutbox(org.orgId)
  const after = kitchenOf(kit, home)
  const budget = kit.rows(`select r.total_cents::bigint total, count(l.id)::int lines from public.budget_revisions r left join public.budget_revision_lines l on l.budget_revision_id=r.id where r.change_order_id=${kit.q(changeOrder.id)} group by r.id`)
  const impact = one(kit, `select id, schedule_item_id, days_adjusted, applied_at is not null applied from public.schedule_item_change_orders where change_order_id=${kit.q(changeOrder.id)}`)
  const observed = {
    changeOrder: { daysImpact: one(kit, `select days_impact from public.change_orders where id=${kit.q(changeOrder.id)}`).days_impact, feeCents: changeOrder.metadata.selection_change.fee_cents, totalCents: Number(one(kit, `select total_cents from public.change_orders where id=${kit.q(changeOrder.id)}`).total_cents) },
    versions: versionsOf(kit, home.projectId),
    selection: { option: after.selected_option_id === org.optionIds["KT-GRN"], status: after.status, priceCents: Number(after.price_cents_snapshot), costCents: Number(after.cost_cents_snapshot), byTheChangeOrder: after.source_change_order_id === changeOrder.id, priceDelta: Number(after.price_cents_snapshot) - Number(before.price_cents_snapshot) },
    variance: kit.rows(`select commitment_id, total_cents::bigint total from public.commitment_change_orders where prime_change_order_id=${kit.q(changeOrder.id)}`).map((row) => ({ onTheOwningPo: row.commitment_id === home.owningPurchaseOrderId, totalCents: Number(row.total) })),
    budget: budget.map((row) => ({ totalCents: Number(row.total), lines: row.lines })),
    schedule: { onInteriorFinishes: impact.schedule_item_id === finishes.id, days: impact.days_adjusted, applied: impact.applied },
    claimsOpen: count(kit, `select 1 from public.selection_change_claims where change_order_id=${kit.q(changeOrder.id)} and released_at is null`),
    superintendentNotified: count(kit, `select 1 from public.notifications where user_id=${kit.q(org.team.superintendent.userId)} and notification_type='selection_change_schedule_pending' and payload->>'entity_id'=${kit.q(changeOrder.id)}`) > 0,
    costDeltaMatchesVariance: Number(change.cost_delta_cents),
  }
  // The superintendent applies the pending impact once.
  const applied = await kit.as(org.team.superintendent, () => app("schedule").applyScheduleChangeOrderImpact(impact.id))
  observed.applied = { shiftedDays: Math.round((Date.parse(applied.after.start_date) - Date.parse(applied.before.start_date)) / 86400000), again: await attempt(() => kit.as(org.team.superintendent, () => app("schedule").applyScheduleChangeOrderImpact(impact.id))) }
  leadTime(kit, org, "KT-GRN", null)
  equal(check, "one buyer signature amends the agreement, confirms the selection at the signed price, revises the owning purchase order, posts the budget revision and records a schedule impact the superintendent applies once; a redelivered signature changes nothing", expected.expected, observed)
  return { orgId: org.orgId, projectId: home.projectId }
}

async function signedChangeIsFrozen(kit, expected, check) {
  const org = await supplyOrg(kit)
  const home = await soldHome(kit, org, "Frozen Buyer")
  await seed.chooseDesign(kit, org, { projectId: home.projectId })
  const changeOrder = await raiseChange(kit, org, home, "KT-GRN")
  const asOwner = (statement) => sqlAttempt(kit, `${asMember(org.owner)} ${statement}`)
  const observed = {
    selectionChange: asOwner(`update public.change_orders set metadata=jsonb_set(metadata, '{selection_change,changes,0,price_cents}', '1') where id=${kit.q(changeOrder.id)}`),
    lines: asOwner(`update public.change_order_lines set unit_cost_cents=1 where change_order_id=${kit.q(changeOrder.id)}`),
    price: asOwner(`update public.change_orders set total_cents=1 where id=${kit.q(changeOrder.id)}`),
    serviceEdit: await attempt(() => kit.as(org.owner, () => app("change-orders").updateChangeOrder({ changeOrderId: changeOrder.id, input: { project_id: home.projectId, title: "Edited", tax_rate: 0, markup_percent: 0, markup_mode: "percent", lines: [{ description: "x", quantity: 1, unit_cost: 1 }] } }))),
    smuggled: asOwner(`insert into public.change_orders(org_id, project_id, title, metadata) values(${kit.q(org.orgId)}, ${kit.q(home.projectId)}, 'Smuggled', '{"selection_change":{"changes":[]}}')`),
  }
  observed.selectionChange = /fixed once raised/.test(observed.selectionChange) ? "refused" : observed.selectionChange
  observed.lines = /selections' prices/.test(observed.lines) ? "refused" : observed.lines
  observed.price = /selections' prices/.test(observed.price) ? "refused" : observed.price
  observed.serviceEdit = /fixed as raised/.test(observed.serviceEdit) ? "refused" : observed.serviceEdit
  observed.smuggled = /never written with it/.test(observed.smuggled) ? "refused" : observed.smuggled
  equal(check, "a raised selection change, its lines and its price are fixed: a member's direct edits and the edit form are refused", expected.expected, observed)
  return { orgId: org.orgId, projectId: home.projectId }
}

async function failedApplyLeavesNothing(kit, expected, check) {
  const org = await supplyOrg(kit, "released")
  const home = await builtHome(kit, org, "Stale Buyer")
  const changeOrder = await raiseChange(kit, org, home, "KT-GRN")
  const original = kitchenOf(kit, home)
  // Fixture: a write landed on the selection after the change order was priced.
  kit.sql(`update public.project_selections set price_cents_snapshot=price_cents_snapshot+1 where id=${kit.q(home.kitchenId)}`)
  const signed = await attempt(() => buyerSigns(kit, org, home, changeOrder.id))
  const state = () => ({
    changeOrder: one(kit, `select status from public.change_orders where id=${kit.q(changeOrder.id)}`).status,
    versions: versionsOf(kit, home.projectId).length,
    variance: count(kit, `select 1 from public.commitment_change_orders where prime_change_order_id=${kit.q(changeOrder.id)}`),
    budget: count(kit, `select 1 from public.budget_revisions where change_order_id=${kit.q(changeOrder.id)}`),
    schedule: count(kit, `select 1 from public.schedule_item_change_orders where change_order_id=${kit.q(changeOrder.id)}`),
    kitchenUnchanged: kitchenOf(kit, home).selected_option_id === original.selected_option_id,
  })
  const observed = {
    signed: /changed after this change order was priced/.test(signed) ? "refused: the selection moved" : signed,
    afterRefusal: state(),
    stuckOnTheChangeOrder: one(kit, `select metadata->'approval_blocked'->>'code' code from public.change_orders where id=${kit.q(changeOrder.id)}`).code,
    approvalsRecorded: count(kit, `select 1 from public.approvals where entity_type='change_order' and entity_id=${kit.q(changeOrder.id)}`),
  }
  // The stray write is undone; the redelivered signature lands once.
  kit.sql(`update public.project_selections set price_cents_snapshot=price_cents_snapshot-1 where id=${kit.q(home.kitchenId)}`)
  await buyerSigns(kit, org, home, changeOrder.id)
  observed.afterRetry = { ...state(), stuck: one(kit, `select metadata ? 'approval_blocked' stuck from public.change_orders where id=${kit.q(changeOrder.id)}`).stuck }
  equal(check, "an approval whose selection moved since pricing fails whole: no agreement version, selection, variance order, budget revision or schedule impact; the change order shows the stuck signature; the retry lands once", expected.expected, observed)
  return { orgId: org.orgId, projectId: home.projectId }
}

async function concurrentChangesCannotDoubleCount(kit, expected, check) {
  const org = await supplyOrg(kit, "released")
  const home = await builtHome(kit, org, "Concurrent Buyer")
  const first = await raiseChange(kit, org, home, "KT-GRN")
  const second = await attempt(() => raiseChange(kit, org, home, "KT-LAM"))
  const drafts = count(kit, `select 1 from public.change_orders where project_id=${kit.q(home.projectId)} and metadata ? 'selection_change'`)
  // Two sessions record the same buyer approval at once; the change order row lock lets one transition happen.
  const approve = `begin; update public.change_orders set status='approved', lifecycle='approved', approved_at=now(), metadata=metadata || '{"approval_method":"portal_native_signature","approved_via_portal_signature":true}' where id=${kit.q(first.id)} and status <> 'approved'; commit;`
  const results = await race(kit, [approve, approve])
  const observed = {
    secondChangeOrder: /already has an open change order/.test(second) ? "refused: already open" : second,
    selectionChangeOrders: drafts,
    bothSessionsFinished: results.every((result) => result.ok),
    versions: versionsOf(kit, home.projectId).filter((row) => row.kind === "amendment").length,
    variance: count(kit, `select 1 from public.commitment_change_orders where prime_change_order_id=${kit.q(first.id)}`),
    budget: count(kit, `select 1 from public.budget_revisions where change_order_id=${kit.q(first.id)}`),
    // Cents are conserved: the agreement's amendment equals the change order, and the variance equals the selection's cost delta.
    agreementDeltaIsTheChangeOrder: Number(one(kit, `select price_delta_cents from public.purchase_agreement_versions where change_order_id=${kit.q(first.id)}`).price_delta_cents) === Number(one(kit, `select total_cents from public.change_orders where id=${kit.q(first.id)}`).total_cents),
    varianceIsTheCostDelta: Number(one(kit, `select coalesce(sum(total_cents),0)::bigint n from public.commitment_change_orders where prime_change_order_id=${kit.q(first.id)}`).n) === Number(first.metadata.selection_change.changes[0].cost_delta_cents),
  }
  equal(check, "one selection carries one open change order; two concurrent approvals of it land one amendment, one variance order and one budget revision, with the cents conserved", expected.expected, observed)
  return { orgId: org.orgId, projectId: home.projectId }
}

const subcases = {
  "override-needs-home-authority": overrideNeedsHomeAuthority,
  "data-api-cannot-move-a-cutoff": dataApiCannotMoveACutoff,
  "cutoff-holds-under-race": cutoffHoldsUnderRace,
  "cutoff-day-is-the-community-day": cutoffDayIsTheCommunityDay,
  "lead-time-closes-an-option-early": leadTimeClosesAnOptionEarly,
  "unavailable-option-opens-an-exception": unavailableOptionOpensAnException,
  "released-po-routes-the-change": releasedPoRoutesTheChange,
  "approved-change-moves-everything-once": approvedChangeMovesEverythingOnce,
  "signed-change-is-frozen": signedChangeIsFrozen,
  "failed-apply-leaves-nothing": failedApplyLeavesNothing,
  "concurrent-changes-cannot-double-count": concurrentChangesCannotDoubleCount,
}

module.exports = { subcases }
