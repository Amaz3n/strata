// LOT-01 — a presold home from lot takedown to warranty (EP14-01). One production
// builder, one lot, each step done by the role that owns it through Arc's real
// services: the land is bought and the takedown closes, a buyer reserves the lot
// with a deposit, the agreement is quoted and signed, the buyer's design choices
// pass their cutoff, the start package clears its gates and releases (schedule,
// purchase orders, budget), the trades are billed against their orders, the home
// completes, closes, and enrolls in warranty. The books are checked the way
// HOME-01 checks them: component by component, with the four home controls tying.
//
// The lifecycle is one story, so the subcases share one organisation: each runs the
// stages it needs once and later subcases reuse them. Steps this chain cannot take
// yet are listed in expected/LOT-01.json as NOT_IMPLEMENTED with the reason (a
// product defect, or file storage the stack only has under --storage-env); the
// defect ones have their check written, and `--include-pending` runs it.
const seed = require("../production-seed.cjs")
const { app, project } = require("./shared.cjs")
const { helpers: home } = require("./home-01.cjs")

const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0)
const total = (record) => Object.values(record).reduce((all, value) => all + value, 0)
// Objects compare by content, not by the order their keys were written.
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
const equal = (check, label, expected, observed) => check.equal(label, canonical(expected), canonical(observed))
const orgNet = (kit, org, code) => kit.postedNet(org.orgId)[code] ?? 0
const houseNet = (kit, org, projectId, code) => home.balances(kit, org, { projectId, codes: [code] })[code]
const lotStatus = (kit, lotId) => kit.rows(`select status from public.lots where id=${kit.q(lotId)}`)[0].status

// ---------------------------------------------------------------------------
// Stages. Each runs once per organisation and returns what it observed.

const STAGES = new WeakMap()
function stage(kit, name) {
  const state = STAGES.get(kit) ?? (STAGES.set(kit, { done: new Map(), org: null }), STAGES.get(kit))
  if (!state.done.has(name)) state.done.set(name, STEPS[name](kit, state).then((observed) => ({ ...observed, org: state.org })))
  return state.done.get(name)
}

const STEPS = {
  async land(kit, state) {
    const org = state.org = await seed.productionBuilder(kit, { name: "LOT-01 presold home" })
    await seed.seedCommunity(kit, org)
    await seed.seedProduct(kit, org)
    // A tranche whose land has not been bought cannot close on its expected price.
    const communities = app("communities"), lotsService = app("lots")
    const second = await kit.as(org.team.land, () => communities.createLotTakedown(org.communityId, { name: "Tranche 2", scheduledDate: seed.isoDay(60), lotCount: 2, pricePerLotCents: 7200000 }))
    await kit.as(org.team.land, () => lotsService.bulkUpdateLots(org.communityId, { lotIds: org.lots.slice(10, 12).map((lot) => lot.id), patch: { takedownId: second.id } }))
    const closeWithoutLand = await refusal(() => kit.as(org.team.land, () => communities.closeLotTakedown(second.id, { actualDate: seed.isoDay(0) })))
    await seed.takeDownTranche(kit, org)
    await project(kit, org)
    const counts = kit.rows(`select status, count(*)::int n from public.lots where org_id=${kit.q(org.orgId)} and community_id=${kit.q(org.communityId)} group by 1 order by 1`)
    return {
      closeWithoutLand,
      lotsByStatus: Object.fromEntries(counts.map((row) => [row.status, row.n])),
      takedown: kit.rows(`select status from public.lot_takedowns where id=${kit.q(org.takedownId)}`)[0].status,
      landInventoryCents: orgNet(kit, org, "1120"), cashCents: orgNet(kit, org, "1000"),
    }
  },

  async reservation(kit, state) {
    const { org } = await stage(kit, "land")
    const lot = org.lots[0]
    const prospect = await seed.registerBuyer(kit, org, { name: "Dana Whitfield", email: "dana.whitfield@acceptance.example.test" })
    // Only the sales desk holds lots.
    const landManagerHold = await refusal(() => kit.as(org.team.land, () => app("community-sales").createLotHold({ lotId: lot.id, buyerContactId: org.owner.userId, expiresAt: new Date(Date.now() + 86400000).toISOString() })))
    const { reservation } = await seed.reserveLot(kit, org, { prospect, lotId: lot.id, depositCents: 2000000, receivedOn: "2026-06-06" })
    const other = await seed.registerBuyer(kit, org, { name: "Marcus Bell", email: "marcus.bell@acceptance.example.test" })
    const secondHold = await refusal(() => kit.as(org.team.sales, () => app("community-sales").createLotHoldFromProspect({ prospectId: other.id, lotId: lot.id, expiresAt: new Date(Date.now() + 86400000).toISOString() })))
    await kit.drainOutbox(org.orgId)
    await project(kit, org)
    org.reservationId = reservation.id
    org.projectId = kit.rows(`select project_id from public.lots where id=${kit.q(lot.id)}`)[0].project_id
    const deposit = kit.rows(`select i.total_cents, i.metadata->>'invoice_kind' kind, (select sum(amount_cents)::bigint from public.payments where invoice_id=i.id) received from public.invoices i where i.id=${kit.q(reservation.depositInvoiceId)}`)[0]
    return {
      reservation, landManagerHold, secondHold, otherProspectId: other.id,
      reservationStatus: kit.rows(`select status from public.lot_reservations where id=${kit.q(reservation.id)}`)[0].status,
      lotStatus: lotStatus(kit, lot.id),
      homePosture: kit.rows(`select property_type from public.projects where id=${kit.q(org.projectId)}`)[0].property_type,
      deposit: { kind: deposit.kind, totalCents: Number(deposit.total_cents), receivedCents: Number(deposit.received) },
      depositHeldCents: -houseNet(kit, org, org.projectId, "2300"),
    }
  },

  async agreement(kit) {
    const { org, reservation } = await stage(kit, "reservation")
    const lotId = org.lots[0].id
    const skus = ["ST-GAR", ...Object.values(seed.DESIGN_PICKS)]
    const config = seed.configuration(org, { lotId, plan: org.plans[0], swing: "right", skus })
    // A second buyer's reservation, to prove an agreement is refused on a stale quote.
    const other = await seed.registerBuyer(kit, org, { name: "Priya Nair", email: "priya.nair@acceptance.example.test" })
    const { reservation: otherReservation } = await seed.reserveLot(kit, org, { prospect: other, lotId: org.lots[3].id, depositCents: 1000000 })
    const otherConfig = seed.configuration(org, { lotId: org.lots[3].id, plan: org.plans[1], swing: "left", skus: ["ST-GAR"] })
    const staleQuote = await refusal(() => kit.as(org.team.sales, () => app("community-sales").createPurchaseAgreement({ ...otherConfig, ...seed.agreementPacketFor(kit, org, otherConfig.lotId), reservationId: otherReservation.id, expectedQuoteHash: "0".repeat(64) })))
    const sale = await seed.signAgreement(kit, org, { reservationId: reservation.id, config })
    org.contractId = sale.contractId
    org.projectId = sale.projectId
    const contract = kit.rows(`select status, total_cents from public.contracts where id=${kit.q(sale.contractId)}`)[0]
    return {
      ...sale, staleQuote, otherReservationId: otherReservation.id,
      executed: { status: contract.status, totalCents: Number(contract.total_cents) },
      reservationStatus: kit.rows(`select status from public.lot_reservations where id=${kit.q(reservation.id)}`)[0].status,
      prospectStatus: kit.rows(`select p.status from public.prospects p join public.lot_reservations r on r.prospect_id=p.id where r.id=${kit.q(reservation.id)}`)[0].status,
      closings: kit.rows(`select status from public.closings where project_id=${kit.q(sale.projectId)}`).map((row) => row.status),
    }
  },

  async selections(kit) {
    const { org } = await stage(kit, "agreement")
    const projectId = org.projectId
    const design = await seed.chooseDesign(kit, org, { projectId })
    const afterCutoff = await refusal(() => kit.as(org.team.design, () => app("selections").selectProjectOption({ orgId: org.orgId, projectId, selectionId: design.rows[0].id, optionId: org.optionIds["EL-LGT"] })))
    const rows = kit.rows(`select c.name, s.status, s.price_cents_snapshot p, s.cost_cents_snapshot c from public.project_selections s join public.selection_categories c on c.id=s.category_id where s.project_id=${kit.q(projectId)} and s.group_id is not null order by c.name`)
    return { ...design, afterCutoff, choices: rows, group: kit.rows(`select status from public.project_selection_groups where project_id=${kit.q(projectId)}`)[0].status }
  },

  async gates(kit) {
    const { org } = await stage(kit, "selections")
    const projectId = org.projectId
    const gates = await seed.clearStartGates(kit, org, { lotId: org.lots[0].id, projectId })
    org.packageId = gates.packageId
    const starts = app("starts")
    const superintendentRelease = await refusal(() => kit.as(org.team.superintendent, () => starts.releaseStart(gates.packageId, { scheduledStartDate: seed.isoDay(0) })))
    const salesRelease = await refusal(() => kit.as(org.team.sales, () => starts.releaseStart(gates.packageId, { scheduledStartDate: seed.isoDay(0) })))
    const purchasingPreview = await refusal(() => kit.as(org.team.purchasing, () => app("po-generation").generatePurchaseOrders({ projectId, mode: "dry_run" })))
    return { ...gates, superintendentRelease, salesRelease, purchasingPreview }
  },

  async release(kit) {
    const { org, packageId, preview } = await stage(kit, "gates")
    const projectId = org.projectId
    const release = await seed.releaseHome(kit, org, { packageId, projectId })
    const countOrders = () => Number(kit.rows(`select count(*)::int n from public.commitments where project_id=${kit.q(projectId)} and commitment_type='purchase_order'`)[0].n)
    const ordersBefore = countOrders()
    await kit.service(() => app("starts-pipeline").runStartsPipeline())
    const ordersAfterRerun = countOrders()
    await kit.drainOutbox(org.orgId)
    await project(kit, org)
    const orders = seed.purchaseOrdersByVendor(kit, projectId)
    return {
      ...release, orders, ordersBefore, ordersAfterRerun, previewTotalCents: sum(preview.purchaseOrders, "totalCents"),
      lotStatus: lotStatus(kit, org.lots[0].id),
      scheduleItems: kit.rows(`select count(*)::int n from public.schedule_items where project_id=${kit.q(projectId)}`)[0].n,
      budgetCents: Number(kit.rows(`select total_cents from public.budgets where project_id=${kit.q(projectId)}`)[0].total_cents),
      openExceptions: kit.rows(`select count(*)::int n from public.po_generation_exceptions where project_id=${kit.q(projectId)} and status='open'`)[0].n,
      landInHouse: { lot: home.balances(kit, org, { lotId: org.lots[0].id, codes: ["1120"] })["1120"], house: houseNet(kit, org, projectId, "1160") },
    }
  },

  async build(kit) {
    const { org } = await stage(kit, "release")
    const projectId = org.projectId
    const built = await seed.buildHome(kit, org, { projectId })
    const bills = kit.rows(`select status, total_cents from public.vendor_bills where project_id=${kit.q(projectId)}`)
    const orders = kit.rows(`select status from public.commitments where project_id=${kit.q(projectId)} and commitment_type='purchase_order'`)
    return {
      ...built,
      ordersApproved: orders.every((row) => row.status === "approved") ? orders.length : orders.map((row) => row.status),
      billsApproved: bills.every((row) => row.status === "approved") ? bills.length : bills.map((row) => row.status),
      billedCents: sum(bills, "total_cents"), payableCents: -orgNet(kit, org, "2000"), houseInventoryCents: houseNet(kit, org, projectId, "1160"),
    }
  },

  async completion(kit) {
    const { org } = await stage(kit, "build")
    const projectId = org.projectId
    await seed.completeHome(kit, org, { projectId, reserveCents: 650000 })
    const books = home.balances(kit, org, { projectId, codes: ["1160", "1170"] })
    return { building: books["1160"], completed: books["1170"] }
  },

  async closing(kit) {
    const { org } = await stage(kit, "completion")
    const projectId = org.projectId
    const closed = await seed.closeHome(kit, org, { projectId })
    const settlement = kit.rows(`select settlement from public.closings where id=${kit.q(closed.closingId)}`)[0].settlement
    return {
      ...closed,
      settlement: { finalPriceCents: settlement.finalPriceCents, depositsApplied: settlement.depositsApplied.map((row) => row.amountCents), balanceDueCents: settlement.balanceDueCents },
      costOfSalesByComponent: home.reliefByComponent(kit, org, projectId),
      inventoryLeft: home.balances(kit, org, { projectId, codes: ["1160", "1170"] }),
      landLeft: home.balances(kit, org, { lotId: org.lots[0].id, codes: ["1120"] })["1120"],
      homeDepositsHeld: home.depositsHeld(kit, org, projectId),
      revenue: -houseNet(kit, org, projectId, "4000"),
      grossMarginCents: -houseNet(kit, org, projectId, "4000") - houseNet(kit, org, projectId, "5000"),
      closing: kit.rows(`select c.status, l.status lot from public.closings c join public.lots l on l.id=c.lot_id where c.id=${kit.q(closed.closingId)}`)[0],
      reserveProvidedCents: -houseNet(kit, org, projectId, "2260"),
      controlsTie: await home.controls(kit, org, seed.isoDay(60)),
    }
  },
}

// ---------------------------------------------------------------------------
// Subcases.

async function landTakedown(kit, expected, check) {
  const seen = await stage(kit, "land")
  const { org } = seen
  equal(check, "the land is bought in Books before the takedown closes, and its ten lots are developed and sellable", expected.expected, {
    lotsByStatus: seen.lotsByStatus,
    takedown: seen.takedown,
    closeWithoutLandPurchase: /Record the actual land acquisition/.test(seen.closeWithoutLand) ? "refused: record the land acquisition first" : seen.closeWithoutLand,
    landInventoryCents: seen.landInventoryCents,
    cashCents: seen.cashCents,
    plansReleased: org.plans.length,
    optionsInCatalog: Object.keys(org.optionIds).length,
  })
  return { orgId: org.orgId, communityId: org.communityId }
}

async function reservationAndDeposit(kit, expected, check) {
  const seen = await stage(kit, "reservation")
  equal(check, "the consultant reserves the lot; the buyer's deposit is a liability of that home alone, and nobody else can take the lot", expected.expected, {
    reservation: seen.reservationStatus,
    lot: seen.lotStatus,
    homePosture: seen.homePosture,
    deposit: seen.deposit,
    depositHeldCents: seen.depositHeldCents,
    landManagerCannotHold: /Missing permission/.test(seen.landManagerHold) ? "refused" : seen.landManagerHold,
    secondBuyerCannotHold: /home belongs to another buyer/.test(seen.secondHold) ? "refused: the lot's home is another buyer's" : /already has a live reservation/.test(seen.secondHold) ? "refused: live reservation" : seen.secondHold,
  })
  return { orgId: seen.org.orgId, reservationId: seen.reservation.id }
}

async function agreementPricedAndSigned(kit, expected, check) {
  const seen = await stage(kit, "agreement")
  const { quote } = seen
  equal(check, "the quote is the plan, the lot premium and the chosen options; it is saved as a draft and executes once; a stale quote is refused", expected.expected, {
    quote: { baseCents: quote.basePriceCents, lotPremiumCents: quote.lotPremiumCents, structuralCents: quote.structuralOptionsCents, designCents: quote.designSelectionsCents, totalCents: quote.totalCents },
    savedAs: seen.draft.status,
    executed: seen.executed,
    reservation: seen.reservationStatus,
    prospect: seen.prospectStatus,
    closing: seen.closings,
    staleQuote: /quote changed/.test(seen.staleQuote) ? "refused: quote changed" : seen.staleQuote,
  })
  return { orgId: seen.org.orgId, contractId: seen.contractId }
}

async function selectionsByCutoff(kit, expected, check) {
  const seen = await stage(kit, "selections")
  equal(check, "the buyer's design choices are confirmed at the prices they were made at, the group locks at its cutoff, and a late change is refused", expected.expected, {
    choices: Object.fromEntries(seen.choices.map((row) => [row.name, { status: row.status, priceCents: Number(row.p), costCents: Number(row.c) }])),
    priceCents: sum(seen.choices, "p"),
    costCents: sum(seen.choices, "c"),
    group: seen.group,
    lateChange: /deadline|locked/i.test(seen.afterCutoff) ? "refused: past the cutoff" : seen.afterCutoff,
  })
  return { orgId: seen.org.orgId }
}

async function startGatesAndRoles(kit, expected, check) {
  const seen = await stage(kit, "gates")
  const keys = (pkg) => Object.fromEntries(pkg.gates.map((gate) => [gate.key, gate.status]))
  const refused = (message) => /Missing permission: start\.release/.test(message) ? "refused: start.release" : message
  equal(check, "the package opens with its gates pending, clears them through the people who own them, and only the starts desk can release", expected.expected, {
    opened: keys(seen.opened),
    ready: { status: seen.ready.status, gates: keys(seen.ready) },
    superintendentRelease: refused(seen.superintendentRelease),
    salesConsultantRelease: refused(seen.salesRelease),
  })
  return { orgId: seen.org.orgId, packageId: seen.packageId }
}

async function releaseCreatesTheHouse(kit, expected, check) {
  const seen = await stage(kit, "release")
  equal(check, "the release schedules the house and issues one purchase order per trade exactly once; the land moves into the house", expected.expected, {
    package: seen.released.status,
    lot: seen.lotStatus,
    scheduleItems: seen.scheduleItems,
    purchaseOrders: seen.orders,
    purchaseOrderCents: total(seen.orders),
    budgetCents: seen.budgetCents,
    openExceptions: seen.openExceptions,
    rerunIssuesNothingNew: seen.ordersBefore === seen.ordersAfterRerun,
    landInHouse: seen.landInHouse,
  })
  return { orgId: seen.org.orgId, projectId: seen.org.projectId }
}

async function builtAndBilled(kit, expected, check) {
  const seen = await stage(kit, "build")
  equal(check, "each trade is billed in full against its approved order and the cost lands in the house, tying AP to the orders", expected.expected, {
    ordersApproved: seen.ordersApproved,
    billsApproved: seen.billsApproved,
    billedCents: seen.billedCents,
    payableCents: seen.payableCents,
    houseInventoryCents: seen.houseInventoryCents,
  })
  return { orgId: seen.org.orgId, orders: seen.orders }
}

async function completionAndClosing(kit, expected, check) {
  const completed = await stage(kit, "completion")
  const seen = await stage(kit, "closing")
  equal(check, "the home completes into inventory, the sale relieves it component by component, and only its own deposit settles", expected.expected, {
    completedInventory: { building: completed.building, completed: completed.completed },
    costOfSalesByComponent: seen.costOfSalesByComponent,
    inventoryLeft: seen.inventoryLeft,
    landLeft: seen.landLeft,
    settlement: seen.settlement,
    homeDepositsHeld: seen.homeDepositsHeld,
    revenue: seen.revenue,
    grossMarginCents: seen.grossMarginCents,
    closing: seen.closing,
    controlsTie: seen.controlsTie,
  })
  return { orgId: seen.org.orgId, closingId: seen.closingId }
}

async function warrantyEnrolled(kit, expected, check) {
  const seen = await stage(kit, "closing")
  const { org } = seen
  const projectId = org.projectId
  const coverage = kit.rows(`select effective_source, effective_date::text date, jsonb_array_length(terms_snapshot)::int terms from public.project_warranty_coverage where project_id=${kit.q(projectId)}`)
  const closingDate = kit.rows(`select actual_date::text d from public.closings where project_id=${kit.q(projectId)}`)[0].d
  equal(check, "closing enrolls the home in warranty from the closing date, and the reserve provided for it ties to the ledger", expected.expected, {
    enrollments: coverage.length,
    source: coverage[0]?.effective_source,
    startsOnClosingDate: coverage[0]?.date === closingDate,
    coverageTerms: coverage[0]?.terms,
    reserveProvidedCents: seen.reserveProvidedCents,
    reserveControl: seen.controlsTie.warranty_reserve_control,
  })
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// Checks for steps the chain cannot take yet: each states the policy and fails
// while its defect stands (see expected/LOT-01.json for the defect and its source).

async function designChoicesOpenAfterSigning(kit, expected, check) {
  const seen = await stage(kit, "selections")
  equal(check, "signing the agreement leaves the buyer's design choices open until their cutoff", expected.expected, { lockedAtSigning: seen.lockedAfterSigning })
  return { orgId: seen.org.orgId }
}

async function purchasingManagerReachesAHouse(kit, expected, check) {
  const seen = await stage(kit, "gates")
  equal(check, "the purchasing manager can preview a house's purchase orders", expected.expected, { purchasingManagerPreview: /Missing permission/.test(seen.purchasingPreview) ? "refused" : "allowed" })
  return { orgId: seen.org.orgId }
}

async function previewMatchesRelease(kit, expected, check) {
  const seen = await stage(kit, "release")
  equal(check, "the purchase orders previewed before release are the ones the release issues", expected.expected, { previewMatchesIssued: seen.previewTotalCents === total(seen.orders) })
  return { orgId: seen.org.orgId }
}

async function agreedOptionsReachPurchaseOrders(kit, expected, check) {
  const seen = await stage(kit, "release")
  equal(check, "every option in the signed agreement, structural included, is bought by the release", expected.expected, { purchaseOrderCents: total(seen.orders) })
  return { orgId: seen.org.orgId }
}

async function presoldHomeAdoptsInventoryWithoutRepair(kit, expected, check) {
  const seen = await stage(kit, "release")
  equal(check, "a home sold from the sales desk can be adopted for owned-inventory accounting without anyone approving revenue policies by hand", expected.expected, { policyRepairedByHand: seen.policyRepairedByHand })
  return { orgId: seen.org.orgId }
}

async function depositInvoiceReachesTheBuyer(kit, expected, check) {
  const seen = await stage(kit, "reservation")
  const row = kit.rows(`select coalesce(array_length(sent_to_emails, 1), 0)::int n from public.invoices where id=${kit.q(seen.reservation.depositInvoiceId)}`)[0]
  equal(check, "the earnest deposit invoice is addressed to the buyer it bills", expected.expected, { recipients: row.n })
  return { orgId: seen.org.orgId }
}

async function closingCompletesWithoutRepair(kit, expected, check) {
  const seen = await stage(kit, "closing")
  equal(check, "closing a home sold on a real agreement completes without anyone repairing its evidence", expected.expected, { evidenceRepairedByHand: seen.evidenceRepaired })
  return { orgId: seen.org.orgId }
}

const subcases = {
  "land-takedown": landTakedown,
  "reservation-and-deposit": reservationAndDeposit,
  "agreement-priced-and-signed": agreementPricedAndSigned,
  "selections-by-cutoff": selectionsByCutoff,
  "start-gates-and-roles": startGatesAndRoles,
  "release-creates-the-house": releaseCreatesTheHouse,
  "built-and-billed": builtAndBilled,
  "completion-and-closing": completionAndClosing,
  "warranty-enrolled": warrantyEnrolled,
  "design-choices-open-after-signing": designChoicesOpenAfterSigning,
  "purchasing-manager-reaches-a-house": purchasingManagerReachesAHouse,
  "preview-matches-release": previewMatchesRelease,
  "agreed-options-reach-purchase-orders": agreedOptionsReachPurchaseOrders,
  "presold-home-adopts-inventory-without-repair": presoldHomeAdoptsInventoryWithoutRepair,
  "deposit-invoice-reaches-the-buyer": depositInvoiceReachesTheBuyer,
  "closing-completes-without-repair": closingCompletesWithoutRepair,
}

// Production workflow proof (EP03-EP13): one module per area, each adding subcases that act as the
// owning role through the real services, on top of this chain. They take what they need from `helpers`.
const AREAS = ["config", "sales", "starts", "release", "purchasing", "completion", "pickers"]
// Each area builds its own organisation, so one area's homes and lots never use up another's:
// the chain is cached per kit, and an area runs on a derived kit of its own.
const areaKits = new WeakMap()
const areaKit = (kit, area) => {
  const kits = areaKits.get(kit) ?? (areaKits.set(kit, new Map()), areaKits.get(kit))
  if (!kits.has(area)) kits.set(area, Object.create(kit))
  return kits.get(area)
}
// The race checks (two independent sessions per case) belong to RACE-02.
for (const area of AREAS) for (const [name, run] of Object.entries(require(`./lot-01-${area}.cjs`).subcases))
  if (!name.startsWith("race-")) subcases[name] = async (kit, expected, check) => {
    // Cancelled and parked release jobs from an earlier case would be claimed by this one's workers or fail its drain.
    kit.sql("update public.outbox set status='completed' where status in ('pending','processing','failed') and job_type in ('start_release','start_release_trade_notice','process_drawing_set','trade_schedule_change_notice')")
    return run(areaKit(kit, area), expected, check)
  }

module.exports = { subcases, helpers: { stage, refusal, sum, total, equal, canonical, orgNet, houseNet, lotStatus } }
