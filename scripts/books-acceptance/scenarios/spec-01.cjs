// SPEC-01 — a spec home from a start without a buyer to warranty (EP14-02). One production builder,
// one lot, each step by the role that owns it through Arc's real services:
//
//   spec-start-without-buyer                     the plan is pinned on an unsold lot, the start opens the home with
//                                                no contract, the starts desk releases it: orders, budget and the
//                                                release margin baseline (at the asking price) exist, nobody is the buyer
//   spec-inventory-ages-from-completion          built and completed into inventory; the home is spec stock whose age
//                                                runs from the recorded completion, at its asking price
//   buyer-conversion-keeps-released-costs-and-plan
//                                                a buyer reserves and signs for the home; a different plan version or
//                                                elevation is refused; the released budget, its orders, the pinned plan
//                                                version and the release baseline are exactly what they were
//   settlement-margin-and-warranty-reconcile     the closing relieves inventory by component, the deposit settles, the
//                                                four home controls tie, the margin by plan version reads the locked
//                                                release baseline, and warranty starts on the closing date
//
// The subcases share one organisation and one home, staged once. Expected values are in expected/SPEC-01.json.
const seed = require("../production-seed.cjs")
const { app, project } = require("./shared.cjs")
const { helpers: home } = require("./home-01.cjs")

const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const named = (message, patterns) => Object.entries(patterns).find(([, pattern]) => pattern.test(message))?.[0] ?? message
const houseNet = (kit, org, projectId, code) => home.balances(kit, org, { projectId, codes: [code] })[code]

const STAGES = new WeakMap()
function stage(kit, name) {
  const state = STAGES.get(kit) ?? (STAGES.set(kit, { done: new Map(), org: null }), STAGES.get(kit))
  if (!state.done.has(name)) state.done.set(name, STEPS[name](kit, state))
  return state.done.get(name)
}

/** What the release fixed for the home: its budget, its orders and its plan, as rows that must not move. */
function released(kit, org, projectId, lotId) {
  const q = kit.q
  return {
    budget: kit.rows(`select id, version, status, total_cents::bigint total, baseline_locked_at is not null locked, md5(coalesce(baseline_lines::text,'')) baseline from public.budgets where project_id=${q(projectId)} order by version`),
    budgetLines: kit.rows(`select l.id, l.cost_code_id, l.amount_cents::bigint amount from public.budget_lines l join public.budgets b on b.id=l.budget_id where b.project_id=${q(projectId)} order by l.id`),
    orders: kit.rows(`select c.id, c.status, c.total_cents::bigint total, (select md5(string_agg(cl.id::text||':'||cl.quantity||':'||cl.unit_cost_cents, ',' order by cl.id)) from public.commitment_lines cl where cl.commitment_id=c.id) lines
      from public.commitments c where c.project_id=${q(projectId)} and c.commitment_type='purchase_order' order by c.id`),
    lotPlan: kit.rows(`select house_plan_id, house_plan_version_id, house_plan_elevation_id, swing from public.lots where id=${q(lotId)}`)[0],
    releaseBaseline: kit.rows(`select id, sale_price_cents::bigint sale, cost_cents::bigint cost, margin_cents::bigint margin, basis->>'sale_price_source' source from public.home_margin_baselines where project_id=${q(projectId)} and stage='release'`),
    releaseRevision: kit.rows(`select id, house_plan_version_id, plan_version_number from public.home_product_revisions where project_id=${q(projectId)} and stage='release'`),
  }
}

const STEPS = {
  async start(kit, state) {
    const org = state.org = await seed.productionBuilder(kit, { name: "SPEC-01 spec home" })
    await seed.seedCommunity(kit, org)
    await seed.seedProduct(kit, org)
    await seed.takeDownTranche(kit, org)
    await project(kit, org)
    const lot = org.lots[1], plan = org.plans[0]
    org.specLot = lot
    // The land manager pins the plan the builder will start without a buyer.
    const pin = { versionId: plan.versionId, elevationId: plan.elevationIds[1], swing: "left" }
    const salesPin = await refusal(() => kit.as(org.team.sales, () => app("lots").assignPlanToLot(lot.id, pin)))
    await kit.as(org.owner, () => app("lots").assignPlanToLot(lot.id, pin))
    const gates = await seed.clearStartGates(kit, org, { lotId: lot.id, spec: true })
    org.projectId = gates.projectId
    org.packageId = gates.packageId
    const contractsAtOpening = Number(kit.rows(`select count(*)::int n from public.contracts where project_id=${kit.q(gates.projectId)}`)[0].n)
    const release = await seed.releaseHome(kit, org, { packageId: gates.packageId, projectId: gates.projectId })
    await kit.drainOutbox(org.orgId)
    await project(kit, org)
    return { salesPin, contractsAtOpening, release, gates, snapshot: released(kit, org, gates.projectId, lot.id) }
  },

  async inventory(kit) {
    const started = await stage(kit, "start")
    const org = STAGES.get(kit).org
    await seed.buildHome(kit, org, { projectId: org.projectId, billDate: seed.isoDay(1) })
    await seed.completeHome(kit, org, { projectId: org.projectId, reserveCents: 650000, date: seed.isoDay(2) })
    // A release cannot be dated in the past, so neither can the completion that follows it. The home is
    // completed through the services and its recorded completion day is then set thirty days back: the
    // clock moving, not the computation (as LOT-01's spec-age-starts-at-actual-completion does).
    kit.sql(`update public.project_financial_settings set books_inventory_completed_on=(current_date - 30) where project_id=${kit.q(org.projectId)}`)
    // The schedule's projected end is long past; it must never start the clock.
    kit.sql(`update public.projects set end_date=${kit.q(seed.isoDay(-200))} where id=${kit.q(org.projectId)}`)
    const page = await kit.as(org.team.sales, () => app("community-sales").listSpecInventoryPage({ communityId: org.communityId, availability: "spec", limit: 50 }))
    return { started, page, books: home.balances(kit, org, { projectId: org.projectId, codes: ["1160", "1170"] }) }
  },

  async conversion(kit) {
    await stage(kit, "inventory")
    const org = STAGES.get(kit).org
    const lot = org.specLot, sales = app("community-sales")
    // The house as it stands for sale: released, its orders approved and billed, completed.
    const before = released(kit, org, org.projectId, lot.id)
    const prospect = await seed.registerBuyer(kit, org, { name: "Teresa Lindqvist", email: "teresa.lindqvist@acceptance.example.test" })
    const { reservation } = await seed.reserveLot(kit, org, { prospect, lotId: lot.id, depositCents: 1000000, receivedOn: "2026-06-20" })
    await kit.drainOutbox(org.orgId)
    await project(kit, org)
    const pinned = seed.configuration(org, { lotId: lot.id, plan: org.plans[0], swing: "left" })
    pinned.elevationId = org.plans[0].elevationIds[1]
    // The buyer cannot be sold another plan or another elevation of the house already built.
    const otherPlan = await refusal(() => kit.as(org.team.sales, () => sales.priceAgreementDraft({ ...pinned, housePlanVersionId: org.plans[1].versionId, elevationId: org.plans[1].elevationIds[1] })))
    const otherElevation = await refusal(() => kit.as(org.team.sales, () => sales.priceAgreementDraft({ ...pinned, elevationId: org.plans[0].elevationIds[0] })))
    const sale = await seed.signAgreement(kit, org, { reservationId: reservation.id, config: pinned })
    org.contractId = sale.contractId
    await kit.drainOutbox(org.orgId)
    await project(kit, org)
    return { before, reservation, sale, otherPlan, otherElevation, after: released(kit, org, org.projectId, lot.id) }
  },

  async closing(kit) {
    await stage(kit, "conversion")
    const org = STAGES.get(kit).org
    const closed = await seed.closeHome(kit, org, { projectId: org.projectId, date: seed.isoDay(3) })
    return closed
  },
}

async function specStartWithoutBuyer(kit, spec, check) {
  const seen = await stage(kit, "start")
  const org = STAGES.get(kit).org
  const { snapshot } = seen
  const lotRow = kit.rows(`select status, project_id, house_plan_version_id from public.lots where id=${kit.q(org.specLot.id)}`)[0]
  const homeRow = kit.rows(`select property_type, client_id from public.projects where id=${kit.q(org.projectId)}`)[0]
  check.equal("a plan pinned on an unsold lot starts a home with no buyer and no contract, and the release orders it, budgets it and baselines its margin at the asking price", spec.expected, {
    salesConsultantPins: named(seen.salesPin, { "refused: lot.write": /Missing permission: (lot\.write|plan\.instantiate)/ }),
    lot: { status: lotRow.status, pinnedVersion: lotRow.house_plan_version_id === org.plans[0].versionId, home: lotRow.project_id === org.projectId },
    home: { posture: homeRow.property_type, buyer: homeRow.client_id },
    contracts: { atOpening: seen.contractsAtOpening, afterRelease: Number(kit.rows(`select count(*)::int n from public.contracts where project_id=${kit.q(org.projectId)}`)[0].n) },
    policyRepairedByHand: seen.release.policyRepairedByHand,
    package: seen.release.released.status,
    purchaseOrders: seed.purchaseOrdersByVendor(kit, org.projectId),
    budgetCents: snapshot.budget.map((row) => Number(row.total)),
    releaseBaseline: snapshot.releaseBaseline.map((row) => ({ saleCents: Number(row.sale), costCents: Number(row.cost), marginCents: Number(row.margin), saleSource: row.source })),
    releaseRevision: snapshot.releaseRevision.map((row) => ({ version: row.plan_version_number, pinned: row.house_plan_version_id === org.plans[0].versionId })),
  })
  return { orgId: org.orgId, projectId: org.projectId, packageId: org.packageId }
}

async function specInventoryAgesFromCompletion(kit, spec, check) {
  const seen = await stage(kit, "inventory")
  const org = STAGES.get(kit).org
  const row = seen.page.lots.find((item) => item.lotId === org.specLot.id)
  const homes = await kit.as(org.team.sales, () => app("community-sales").listSpecInventoryPage({ communityId: org.communityId, availability: "spec", order: "aging", limit: 50 }))
  check.equal("the completed home sits in inventory as spec stock aged from its recorded completion, at its asking price, first by age", spec.expected, {
    books: seen.books,
    listed: row ? { isSpec: row.isSpec, underConstruction: row.underConstruction, agingDays: row.agingDays, completionFromBooks: row.completionFromBooks, askingPriceCents: row.askingPriceCents } : "not listed",
    oldestFirst: homes.lots[0]?.lotId === org.specLot.id,
  })
  return { orgId: org.orgId, projectId: org.projectId }
}

async function buyerConversionKeepsReleasedCostsAndPlan(kit, spec, check) {
  const seen = await stage(kit, "conversion")
  const org = STAGES.get(kit).org
  const { before, after } = seen
  const agreement = kit.rows(`select status, total_cents::bigint total from public.contracts where id=${kit.q(org.contractId)}`)[0]
  const baselines = kit.rows(`select stage, sale_price_cents::bigint sale, cost_cents::bigint cost from public.home_margin_baselines where project_id=${kit.q(org.projectId)} order by stage`)
  const money = (await kit.as(org.owner, () => app("production-house-overview").getProductionHouseOverview(org.projectId))).money
  check.equal("the buyer signs for the house that was built: another plan or elevation is refused, and the released budget, orders, plan version and release baseline are unchanged", spec.expected, {
    otherPlanVersion: named(seen.otherPlan, { "refused: the pinned plan version": /pinned plan version cannot be changed|plan ancestry/ }),
    otherElevation: named(seen.otherElevation, { "refused: the pinned elevation": /pinned elevation cannot be changed/ }),
    agreement: { status: agreement.status, totalCents: Number(agreement.total) },
    reservation: kit.rows(`select status from public.lot_reservations where id=${kit.q(seen.reservation.id)}`)[0].status,
    buyerIsTheHomesClient: kit.rows(`select client_id is not null c from public.projects where id=${kit.q(org.projectId)}`)[0].c,
    unchanged: {
      budget: JSON.stringify(before.budget) === JSON.stringify(after.budget),
      budgetLines: JSON.stringify(before.budgetLines) === JSON.stringify(after.budgetLines),
      purchaseOrders: JSON.stringify(before.orders) === JSON.stringify(after.orders),
      lotPlan: JSON.stringify(before.lotPlan) === JSON.stringify(after.lotPlan),
      releaseBaseline: JSON.stringify(before.releaseBaseline) === JSON.stringify(after.releaseBaseline),
      releaseRevision: JSON.stringify(before.releaseRevision) === JSON.stringify(after.releaseRevision),
    },
    baselines: baselines.map((row) => ({ stage: row.stage, saleCents: Number(row.sale), costCents: Number(row.cost) })),
    houseMoney: { originalSaleCents: money.originalSalePriceCents, originalMarginCents: money.originalMarginCents, revisedSaleCents: money.revisedSalePriceCents },
  })
  return { orgId: org.orgId, projectId: org.projectId, contractId: org.contractId }
}

async function settlementMarginAndWarrantyReconcile(kit, spec, check) {
  const closed = await stage(kit, "closing")
  const org = STAGES.get(kit).org
  const projectId = org.projectId
  const settlement = kit.rows(`select settlement, actual_date::text d from public.closings where id=${kit.q(closed.closingId)}`)[0]
  const coverage = kit.rows(`select effective_source, effective_date::text d from public.project_warranty_coverage where project_id=${kit.q(projectId)} and voided_at is null`)
  const report = await kit.as(org.owner, () => app("production-reporting").getProductionPortfolioReport({ cohort: { kind: "closed", from: null, to: null } }))
  const version = report.planVersions.find((row) => row.planVersionId === org.plans[0].versionId)
  check.equal("the sale relieves the home by component, only its deposit settles, the home controls tie, the plan version's margin reads the locked release baseline, and warranty starts at closing", spec.expected, {
    settlement: { finalPriceCents: settlement.settlement.finalPriceCents, depositsApplied: settlement.settlement.depositsApplied.map((row) => row.amountCents), balanceDueCents: settlement.settlement.balanceDueCents },
    evidenceRepairedByHand: closed.evidenceRepaired,
    revenueCents: -houseNet(kit, org, projectId, "4000"),
    costOfSalesByComponent: home.reliefByComponent(kit, org, projectId),
    grossMarginCents: -houseNet(kit, org, projectId, "4000") - houseNet(kit, org, projectId, "5000"),
    inventoryLeft: home.balances(kit, org, { projectId, codes: ["1160", "1170"] }),
    depositsHeld: home.depositsHeld(kit, org, projectId),
    reserveProvidedCents: -houseNet(kit, org, projectId, "2260"),
    controls: await home.controls(kit, org, seed.isoDay(60)),
    lot: kit.rows(`select status from public.lots where id=${kit.q(org.specLot.id)}`)[0].status,
    planVersion: version ? { homes: version.homes, originalMarginCents: version.originalMarginCents, baselinedHomes: version.baselinedHomes } : "missing",
    warranty: { enrollments: coverage.length, source: coverage[0]?.effective_source, startsOnClosingDate: coverage[0]?.d === settlement.d },
  })
  return { orgId: org.orgId, projectId, closingId: closed.closingId }
}

/**
 * A home whose last bill and completion land on the same day: the bills post to work in progress, the
 * completion re-posts them to completed inventory (a reversal and a new entry), and the sale must still
 * relieve the home by component (defect fixed in 20261021100000: reversals were dropped from the breakdown).
 */
async function sameDayCostAndCompletionStillSells(kit, spec, check) {
  await stage(kit, "start")
  const org = STAGES.get(kit).org
  const lot = org.lots[2]
  const buyer = await seed.registerBuyer(kit, org, { name: "Odile Ferreira", email: "odile.ferreira@acceptance.example.test" })
  const { reservation } = await seed.reserveLot(kit, org, { prospect: buyer, lotId: lot.id, depositCents: 1000000, receivedOn: "2026-06-20" })
  const sale = await seed.signAgreement(kit, org, { reservationId: reservation.id, config: seed.configuration(org, { lotId: lot.id, plan: org.plans[0], swing: "right" }) })
  await seed.chooseDesign(kit, org, { projectId: sale.projectId })
  const gates = await seed.clearStartGates(kit, org, { lotId: lot.id, projectId: sale.projectId })
  await seed.releaseHome(kit, org, { packageId: gates.packageId, projectId: sale.projectId })
  await seed.buildHome(kit, org, { projectId: sale.projectId, billDate: seed.isoDay(14) })
  await seed.completeHome(kit, org, { projectId: sale.projectId, reserveCents: 650000, date: seed.isoDay(14) })
  const reposted = Number(kit.rows(`select count(*)::int n from public.journal_entries e where e.org_id=${kit.q(org.orgId)} and e.source_type='vendor_bill' and e.status='reversed' and e.id in (select entry_id from public.journal_lines where project_id=${kit.q(sale.projectId)})`)[0].n)
  const closed = await seed.closeHome(kit, org, { projectId: sale.projectId, date: seed.isoDay(21) })
  check.equal("bills re-posted to completed inventory on the completion day still relieve by component at the sale", spec.expected, {
    billsRepostedAtCompletion: reposted,
    closing: kit.rows(`select status from public.closings where id=${kit.q(closed.closingId)}`)[0].status,
    costOfSalesByComponent: home.reliefByComponent(kit, org, sale.projectId),
    inventoryLeft: home.balances(kit, org, { projectId: sale.projectId, codes: ["1160", "1170"] }),
  })
  return { orgId: org.orgId, projectId: sale.projectId }
}

module.exports = {
  id: "SPEC-01",
  subcases: {
    "spec-start-without-buyer": specStartWithoutBuyer,
    "spec-inventory-ages-from-completion": specInventoryAgesFromCompletion,
    "buyer-conversion-keeps-released-costs-and-plan": buyerConversionKeepsReleasedCostsAndPlan,
    "settlement-margin-and-warranty-reconcile": settlementMarginAndWarrantyReconcile,
    "same-day-cost-and-completion-still-sells": sameDayCostAndCompletionStillSells,
  },
}
