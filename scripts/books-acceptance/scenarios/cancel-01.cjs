// CANCEL-01 — a sale cancelled before and after the house starts (EP14-03). One production
// builder, each home on its own lot, each step through the services the sales, starts and
// closing desks use:
//
//   cancel-before-release-refunds-and-reopens   a sold home ready to start is cancelled with the deposit refunded:
//                                               the agreement, closing and reservation end, the package reopens,
//                                               nothing was ordered, the refund is the deposit and the lot sells again
//   cancel-after-release-forfeits-and-keeps-building
//                                               a released home is cancelled with the deposit forfeited: the house
//                                               keeps building as a spec home (orders, budget and schedule untouched),
//                                               the forfeiture is income and the deposit liability clears
//   released-cancellation-flags-picks-for-purchasing
//                                               that cancellation tells starts and purchasing once and flags the orders
//                                               carrying the previous buyer's picks; purchasing keeps the framing picks and
//                                               cancels the electrical one on its issued order by a variance order
//   forfeited-home-resells-and-closes           that house is sold to a new buyer, built, completed and closed: only
//                                               the new buyer's deposit settles, revenue is the price plus the earlier
//                                               forfeiture, and the four home controls tie
//   reservation-release-and-split-deposit       a reservation released before any agreement refunds or forfeits its
//                                               deposit; an agreement cancelled with a split keeps part, refunds the rest
//   interrupted-cancellation-settles-once       the refund fails once after the void commits; the cancellation is
//                                               recorded as failed, two retries at once refund once, a later retry is quiet
//   lost-reply-and-simultaneous-voids           a void whose reply is lost is not repeated by the retry, and settles from
//                                               the deal's record; two voids released together in separate sessions
//                                               leave one cancellation and one refund
//
// RACE-03 already proves a cancellation racing the signature and the start release; this file
// reuses its fault and lost-reply harness and does not repeat those races.
// Expected values are in expected/CANCEL-01.json.
const seed = require("../production-seed.cjs")
const { app, project } = require("./shared.cjs")
const fx = require("./lot-01-sales-fixtures.cjs")
const { helpers: home } = require("./home-01.cjs")
const { helpers: races } = require("./race-03.cjs")
const sessions = require("./sessions.cjs")

const ORGS = new WeakMap()
const HOMES = new WeakMap()

function orgOf(kit) {
  if (!ORGS.has(kit)) ORGS.set(kit, (async () => {
    const org = await seed.productionBuilder(kit, { name: "CANCEL-01 cancelled sales" })
    await seed.seedCommunity(kit, org)
    await seed.seedProduct(kit, org)
    await seed.takeDownTranche(kit, org)
    await project(kit, org)
    // The releases this run makes fall in this week; the slot is raised as the starts desk would.
    const day = new Date(`${seed.isoDay(0)}T12:00:00Z`)
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
    await kit.as(org.owner, () => app("even-flow").setReleaseSlot(org.communityId, day.toISOString().slice(0, 10), { targetStarts: 10, notes: "CANCEL-01 releases" }))
    return org
  })())
  return ORGS.get(kit)
}

const settledLabel = (result) => {
  if (result.status === "fulfilled") return "done"
  const message = result.reason?.message ?? String(result.reason)
  if (/^Active purchase agreement not found$/.test(message)) return "refused: the agreement is no longer open"
  if (/^This cancellation is already being settled/.test(message)) return "refused: already being settled"
  if (/^The sale was cancelled, but refunding the deposit did not finish: .*Injected failure/.test(message)) return "cancelled; refund failed (injected)"
  if (/fetch failed: connection reset/.test(message)) return "lost reply"
  return `error: ${message.slice(0, 200)}`
}
const attempt = (work) => work().then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason }))

/** A sold home on tranche lot `index`: reserved with its deposit received, signed, designed, every start gate cleared, adopted. */
async function readySoldHome(kit, org, index, name, depositCents) {
  const lot = org.lots[index]
  const buyer = await fx.reservedBuyer(kit, org, { name, depositCents, receivedOn: "2026-06-12", lot })
  const sale = await fx.agreementFor(kit, org, buyer)
  await seed.chooseDesign(kit, org, { projectId: sale.projectId })
  const gates = await seed.clearStartGates(kit, org, { lotId: lot.id, projectId: sale.projectId })
  await fx.adoptInventory(kit, org, sale.projectId, `${seed.EVIDENCE}/ownership`)
  if (gates.ready.status !== "ready") throw Error(`Package for lot ${lot.lot_number} is ${gates.ready.status}, not ready`)
  return { lot, buyer, contractId: sale.contractId, packageId: gates.packageId, projectId: sale.projectId }
}

/** A buyer reserved on a fresh lot with the deposit received, and the agreement signed. */
async function signedBuyer(kit, org, name, depositCents) {
  const buyer = await fx.reservedBuyer(kit, org, { name, depositCents, receivedOn: "2026-06-10" })
  const sale = await fx.agreementFor(kit, org, buyer)
  return { buyer, contractId: sale.contractId, projectId: sale.projectId }
}

const cancel = (kit, org, contractId, disposition, extra = {}) => kit.as(org.owner, async () => {
  const sales = app("community-sales")
  const plan = await sales.previewAgreementCancellation(contractId)
  return sales.voidPurchaseAgreement({ contractId, reason: extra.reason ?? "Buyer cancelled the purchase", depositDisposition: disposition, expectedPlanHash: plan.hash, ...(extra.forfeitCents ? { forfeitCents: extra.forfeitCents } : {}) })
})

/** What a cancelled sale leaves behind on its home. */
function saleEnd(kit, org, { projectId, contractId, reservationId, prospectId }) {
  const { q } = kit
  const one = (text) => kit.rows(text)[0]
  return {
    agreement: one(`select status from public.contracts where id=${q(contractId)}`).status,
    closings: kit.rows(`select status from public.closings where project_id=${q(projectId)} order by created_at`).map((row) => row.status),
    reservation: one(`select status from public.lot_reservations where id=${q(reservationId)}`).status,
    prospect: one(`select status from public.prospects where id=${q(prospectId)}`).status,
    buyerOnHome: one(`select client_id from public.projects where id=${q(projectId)}`).client_id !== null,
  }
}

/** The refunds and forfeitures recorded for a home's deposit, in cents. */
function depositMoney(kit, org, projectId) {
  const { q } = kit
  const reversals = kit.rows(`select r.amount_cents::bigint n, r.status from public.payment_reversals r join public.payments p on p.id=r.payment_id
    join public.invoices i on i.id=p.invoice_id where r.org_id=${q(org.orgId)} and i.project_id=${q(projectId)} and r.status in ('pending','succeeded') order by r.created_at`)
  const forfeitures = kit.rows(`select total_cents::bigint total, balance_due_cents::bigint due, status from public.invoices where org_id=${q(org.orgId)} and project_id=${q(projectId)} and metadata->>'invoice_kind'='deposit_forfeiture'`)
  return {
    refundsCents: reversals.map((row) => Number(row.n)),
    forfeitures: forfeitures.map((row) => ({ totalCents: Number(row.total), dueCents: Number(row.due), status: row.status })),
  }
}

/** The void on the record: its event and its audit row, each written once however often the settlement ran. */
const voidOnRecord = (kit, contractId) => ({
  events: Number(kit.rows(`select count(*)::int n from public.events where entity_id=${kit.q(contractId)} and event_type='purchase_agreement_voided'`)[0].n),
  audits: Number(kit.rows(`select count(*)::int n from public.audit_log where entity_id=${kit.q(contractId)} and entity_type='contract' and after_data->>'status'='void'`)[0].n),
})

const receipt = (kit, contractId) => {
  const row = kit.rows(`select deposit_disposition, refund_cents::bigint refund, forfeit_cents::bigint forfeit, settlement_status, settlement_error, outcomes from public.purchase_agreement_cancellations where contract_id=${kit.q(contractId)}`)
  return row.map((r) => ({ disposition: r.deposit_disposition, refundCents: Number(r.refund), forfeitCents: Number(r.forfeit), settlement: r.settlement_status, failedStep: r.settlement_error ? r.settlement_error.split(":")[0] : null }))
}

/** Whether the lot is on the sales desk's inventory again, and whether a new buyer can hold it. */
async function backOnTheMarket(kit, org, lotId, name) {
  const page = await kit.as(org.team.sales, () => app("community-sales").listSpecInventoryPage({ communityId: org.communityId, limit: 250 }))
  const row = page.lots.find((item) => item.lotId === lotId)
  const prospect = await seed.registerBuyer(kit, org, { name, email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}.${fx.tag()}@acceptance.example.test` })
  const held = await attempt(() => kit.as(org.team.sales, () => app("community-sales").createLotHoldFromProspect({ prospectId: prospect.id, lotId, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() })))
  return { onInventory: Boolean(row), newBuyerHolds: held.status === "fulfilled" ? "held" : settledLabel(held), prospect, hold: held.value ?? null }
}

/** The home's orders, budget and schedule as release fixed them: rows that keep building must not move. */
function building(kit, projectId) {
  const { q } = kit
  return {
    orders: kit.rows(`select c.id, c.status, c.total_cents::bigint total from public.commitments c where c.project_id=${q(projectId)} and c.commitment_type='purchase_order' order by c.id`),
    budget: kit.rows(`select id, status, total_cents::bigint total from public.budgets where project_id=${q(projectId)} order by version`),
    schedule: kit.rows(`select id, start_date::text s, end_date::text e, status from public.schedule_items where project_id=${q(projectId)} order by id`),
  }
}

// ---------------------------------------------------------------------------

async function cancelBeforeReleaseRefundsAndReopens(kit, expected, check) {
  const org = await orgOf(kit)
  const input = expected.inputs
  const h = await readySoldHome(kit, org, input.lot - 1, "Ruth Abernathy", input.depositCents)
  const plan = await kit.as(org.owner, () => app("community-sales").previewAgreementCancellation(h.contractId))
  const done = await cancel(kit, org, h.contractId, "refund")
  await fx.postToBooks(kit, org)
  const market = await backOnTheMarket(kit, org, h.lot.id, "Next Buyer Before")
  check.equal("a sold home cancelled before it starts: the agreement, closing and reservation end, the package reopens with nothing ordered, the whole deposit is refunded and the lot sells again", expected.expected, {
    plan: { startPackage: plan.start_package?.action ?? null, availableCents: plan.deposit.available_cents },
    settlement: { status: done.settlementStatus, refundCents: done.refundCents, forfeitCents: done.forfeitCents },
    sale: saleEnd(kit, org, { projectId: h.projectId, contractId: h.contractId, reservationId: h.buyer.reservation.id, prospectId: h.buyer.prospect.id }),
    startPackage: kit.rows(`select status from public.start_packages where id=${kit.q(h.packageId)}`)[0].status,
    purchaseOrders: Number(kit.rows(`select count(*)::int n from public.commitments where project_id=${kit.q(h.projectId)} and commitment_type='purchase_order'`)[0].n),
    money: depositMoney(kit, org, h.projectId),
    books: { depositsHeld: home.depositsHeld(kit, org, h.projectId), revenue: -home.balances(kit, org, { projectId: h.projectId, codes: ["4000"] })["4000"] },
    market: { onInventory: market.onInventory, newBuyerHolds: market.newBuyerHolds },
  })
  return { orgId: org.orgId, projectId: h.projectId, contractId: h.contractId }
}

/** The released home whose sale is forfeited, staged once: the forfeiture and the resale both read it. */
function forfeitedHome(kit, expected) {
  if (!HOMES.has(kit)) HOMES.set(kit, (async () => {
    const org = await orgOf(kit)
    const h = await readySoldHome(kit, org, expected.inputs.lot - 1, "Gordon Pryce", expected.inputs.depositCents)
    const release = await seed.releaseHome(kit, org, { packageId: h.packageId, projectId: h.projectId, adoptInventory: false })
    await kit.drainOutbox(org.orgId)
    await project(kit, org)
    const before = building(kit, h.projectId)
    const plan = await kit.as(org.owner, () => app("community-sales").previewAgreementCancellation(h.contractId))
    const done = await cancel(kit, org, h.contractId, "forfeit", { reason: "Buyer walked away after the start" })
    await fx.postToBooks(kit, org)
    return { org, h, release, before, plan, done, after: building(kit, h.projectId) }
  })())
  return HOMES.get(kit)
}

async function cancelAfterReleaseForfeitsAndKeepsBuilding(kit, expected, check) {
  const { org, h, release, before, plan, done, after } = await forfeitedHome(kit, expected)
  const page = await kit.as(org.team.sales, () => app("community-sales").listSpecInventoryPage({ communityId: org.communityId, availability: "spec", limit: 250 }))
  const asSpec = page.lots.find((item) => item.lotId === h.lot.id)
  check.equal("a released home cancelled with the deposit forfeited keeps building as the builder's inventory: orders, budget and schedule are untouched, the forfeiture is income and the deposit liability clears", expected.expected, {
    released: release.released.status,
    plan: { startPackage: plan.start_package?.action ?? null, availableCents: plan.deposit.available_cents },
    settlement: { status: done.settlementStatus, refundCents: done.refundCents, forfeitCents: done.forfeitCents },
    sale: saleEnd(kit, org, { projectId: h.projectId, contractId: h.contractId, reservationId: h.buyer.reservation.id, prospectId: h.buyer.prospect.id }),
    startPackage: kit.rows(`select status from public.start_packages where id=${kit.q(h.packageId)}`)[0].status,
    keepsBuilding: {
      ordersUnchanged: JSON.stringify(before.orders) === JSON.stringify(after.orders), openOrders: after.orders.filter((row) => row.status !== "void").length,
      ordersCents: after.orders.reduce((sum, row) => sum + Number(row.total), 0),
      budgetUnchanged: JSON.stringify(before.budget) === JSON.stringify(after.budget), scheduleUnchanged: JSON.stringify(before.schedule) === JSON.stringify(after.schedule),
    },
    money: depositMoney(kit, org, h.projectId),
    books: { depositsHeld: home.depositsHeld(kit, org, h.projectId), revenue: -home.balances(kit, org, { projectId: h.projectId, codes: ["4000"] })["4000"] },
    specInventory: asSpec ? { isSpec: asSpec.isSpec, askingPriceCents: asSpec.askingPriceCents } : null,
  })
  return { orgId: org.orgId, projectId: h.projectId, contractId: h.contractId }
}

/**
 * The released home's cancellation told starts and purchasing, and flagged the orders that carry the
 * previous buyer's picks. Purchasing keeps the framing picks (the draft order is left as it is) and
 * cancels the electrical pick on the order it already issued: a variance order removing it waits for
 * approval like any other.
 */
async function releasedCancellationFlagsPicksForPurchasing(kit, expected, check) {
  const { org, h } = await forfeitedHome(kit, { inputs: expected.inputs.forfeited })
  const picks = app("sale-cancellation-picks")
  const vendorOf = (name) => org.vendorIds[name]
  const orderOf = (vendor) => kit.rows(`select id, status, metadata->'sale_cancellation_review' review from public.commitments where project_id=${kit.q(h.projectId)} and commitment_type='purchase_order' and company_id=${kit.q(vendorOf(vendor))}`)[0]
  const told = (actor) => Number(kit.rows(`select count(*)::int n from public.notifications where org_id=${kit.q(org.orgId)} and user_id=${kit.q(actor.userId)} and notification_type='released_sale_cancelled' and payload->>'project_id'=${kit.q(h.projectId)}`)[0].n)
  const flagged = kit.rows(`select co.name vendor, jsonb_array_length(c.metadata->'sale_cancellation_review'->'lines') lines from public.commitments c join public.companies co on co.id=c.company_id
    where c.project_id=${kit.q(h.projectId)} and c.metadata->'sale_cancellation_review'->>'status'='open' order by co.name`).map((row) => [row.vendor, Number(row.lines)])
  // The electrical order is issued before purchasing decides; the framing order is still a draft.
  const electrical = orderOf("Bright Electric")
  await kit.as(org.owner, () => app("commitments").updateCommitment({ commitmentId: electrical.id, input: { status: "approved", prequal_override_note: "Acceptance trade: no prequalification on file for this vendor." } }))
  const queue = await kit.as(org.team.purchasing, () => picks.listSaleCancellationReviews({}))
  const salesCannot = await attempt(() => kit.as(org.team.sales, () => picks.resolveSaleCancellationPick({ commitment_id: electrical.id, decision: "keep" })))
  const framing = orderOf("Palmetto Framing")
  const framingLinesBefore = Number(kit.rows(`select count(*)::int n from public.commitment_lines where commitment_id=${kit.q(framing.id)}`)[0].n)
  const kept = await kit.as(org.team.purchasing, () => picks.resolveSaleCancellationPick({ commitment_id: framing.id, decision: "keep", note: "The spec home keeps the quartz and LVP" }))
  const cancelled = await kit.as(org.team.purchasing, () => picks.resolveSaleCancellationPick({ commitment_id: electrical.id, decision: "cancel" }))
  const twice = await attempt(() => kit.as(org.team.purchasing, () => picks.resolveSaleCancellationPick({ commitment_id: electrical.id, decision: "cancel" })))
  const variance = kit.rows(`select co.status, co.total_cents::bigint total, r.code reason from public.commitment_change_orders co left join public.variance_reason_codes r on r.id=co.reason_code_id where co.commitment_id=${kit.q(electrical.id)}`)
  const pendingQueue = await kit.as(org.team.purchasing, () => app("commitment-change-orders").listVarianceOrders({ status: "pending", projectId: h.projectId }))
  const after = (vendor) => orderOf(vendor).review
  check.equal("cancelling a released sale tells starts and purchasing once, flags the orders carrying the previous buyer's picks, and purchasing keeps one and cancels the other by variance order", expected.expected, {
    outcomes: (({ picks_flagged, released_notice_recipients }) => ({ picksFlagged: picks_flagged, told: released_notice_recipients }))(
      kit.rows(`select outcomes from public.purchase_agreement_cancellations where contract_id=${kit.q(h.contractId)}`)[0].outcomes),
    told: { starts: told(org.team.starts), purchasing: told(org.team.purchasing), sales: told(org.team.sales) },
    flagged,
    queue: queue.items.filter((item) => item.projectId === h.projectId).map((item) => [item.vendor, item.issued, item.totalCents]),
    salesCannotDecide: salesCannot.status === "rejected" ? "refused" : "allowed",
    kept: { decision: kept.decision, status: after("Palmetto Framing").status, framingLinesUnchanged: Number(kit.rows(`select count(*)::int n from public.commitment_lines where commitment_id=${kit.q(framing.id)}`)[0].n) === framingLinesBefore },
    cancelled: { decision: cancelled.decision, status: after("Bright Electric").status, raisedVariance: Boolean(cancelled.varianceOrderId) },
    decidedTwice: twice.status === "rejected" && /already decided/.test(twice.reason.message) ? "refused: already decided" : "allowed",
    variance: variance.map((row) => ({ status: row.status, totalCents: Number(row.total), reason: row.reason })),
    inTheVarianceQueue: pendingQueue.items.some((item) => item.id === cancelled.varianceOrderId),
  })
  return { orgId: org.orgId, projectId: h.projectId, varianceOrderId: cancelled.varianceOrderId }
}

async function forfeitedHomeResellsAndCloses(kit, expected, check) {
  const { org, h } = await forfeitedHome(kit, { inputs: expected.inputs.forfeited })
  const input = expected.inputs
  const prospect = await seed.registerBuyer(kit, org, { name: "Imogen Castellanos", email: `imogen.castellanos.${fx.tag()}@acceptance.example.test` })
  const { reservation } = await seed.reserveLot(kit, org, { prospect, lotId: h.lot.id, depositCents: input.depositCents, receivedOn: "2026-06-22" })
  await fx.postToBooks(kit, org)
  const swing = kit.rows(`select swing from public.lots where id=${kit.q(h.lot.id)}`)[0].swing
  const sale = await seed.signAgreement(kit, org, { reservationId: reservation.id, config: seed.configuration(org, { lotId: h.lot.id, plan: org.plans[0], swing: swing === "left" ? "left" : "right" }) })
  await seed.buildHome(kit, org, { projectId: h.projectId, billDate: seed.isoDay(1) })
  await seed.completeHome(kit, org, { projectId: h.projectId, reserveCents: input.reserveCents, date: seed.isoDay(2) })
  const closed = await seed.closeHome(kit, org, { projectId: h.projectId, date: seed.isoDay(3) })
  const evidence = fx.closingEvidence(kit, org, closed.closingId)
  const settlement = evidence.closing.settlement
  check.equal("the forfeited house sells to a new buyer and closes: only the new buyer's deposit settles, revenue is the price plus the earlier forfeiture, and the home's controls tie", expected.expected, {
    sameHome: sale.projectId === h.projectId,
    agreementCents: Number(kit.rows(`select total_cents::bigint n from public.contracts where id=${kit.q(sale.contractId)}`)[0].n),
    closing: evidence.closing.status,
    settlement: { finalPriceCents: settlement.finalPriceCents, depositsApplied: settlement.depositsApplied.map((row) => row.amountCents), balanceDueCents: settlement.balanceDueCents },
    books: {
      depositsHeld: home.depositsHeld(kit, org, h.projectId),
      revenue: -home.balances(kit, org, { projectId: h.projectId, codes: ["4000"] })["4000"],
      inventoryLeft: home.balances(kit, org, { projectId: h.projectId, codes: ["1160", "1170"] }),
    },
    controls: await home.controls(kit, org, seed.isoDay(60)),
  })
  return { orgId: org.orgId, projectId: h.projectId, closingId: closed.closingId }
}

async function reservationReleaseAndSplitDeposit(kit, expected, check) {
  const org = await orgOf(kit)
  const input = expected.inputs
  const sales = app("community-sales")
  const refundee = await fx.reservedBuyer(kit, org, { name: "Walter Okafor", depositCents: input.reservationDepositCents, receivedOn: "2026-06-09" })
  const forfeiter = await fx.reservedBuyer(kit, org, { name: "Lena Marsh", depositCents: input.reservationDepositCents, receivedOn: "2026-06-09" })
  // The consultant can release a hold, but moving the buyer's money takes release authority.
  const consultant = await attempt(() => kit.as(org.team.sales, () => sales.releaseReservation({ reservationId: refundee.reservation.id, reason: "Buyer changed communities", depositDisposition: "refund" })))
  await kit.as(org.owner, () => sales.releaseReservation({ reservationId: refundee.reservation.id, reason: "Buyer changed communities", depositDisposition: "refund" }))
  await kit.as(org.owner, () => sales.releaseReservation({ reservationId: forfeiter.reservation.id, reason: "Buyer let the reservation lapse", depositDisposition: "forfeit" }))
  const split = await signedBuyer(kit, org, "Priya Banerjee", input.agreementDepositCents)
  const splitDone = await cancel(kit, org, split.contractId, "split", { forfeitCents: input.splitForfeitCents, reason: "Buyer lost financing; contract keeps part of the earnest money" })
  await fx.postToBooks(kit, org)
  const reservationStatus = (r) => kit.rows(`select status from public.lot_reservations where id=${kit.q(r.reservation.id)}`)[0].status
  const ledger = (projectId) => ({ depositsHeld: home.depositsHeld(kit, org, projectId), revenue: -home.balances(kit, org, { projectId, codes: ["4000"] })["4000"] })
  check.equal("a reservation released before any agreement refunds or forfeits its whole deposit; a split cancellation keeps the agreed part and refunds the rest; every deposit liability clears", expected.expected, {
    consultantMovesMoney: settledLabel(consultant).replace(/^error: Missing permission: payment\.release.*/, "refused: payment.release"),
    refunded: { reservation: reservationStatus(refundee), money: depositMoney(kit, org, refundee.projectId), books: ledger(refundee.projectId) },
    forfeited: { reservation: reservationStatus(forfeiter), money: depositMoney(kit, org, forfeiter.projectId), books: ledger(forfeiter.projectId) },
    split: { settlement: { status: splitDone.settlementStatus, refundCents: splitDone.refundCents, forfeitCents: splitDone.forfeitCents }, money: depositMoney(kit, org, split.projectId), books: ledger(split.projectId) },
    depositsControl: (await home.controls(kit, org, seed.isoDay(0))).customer_deposits_control,
  })
  return { orgId: org.orgId }
}

async function interruptedCancellationSettlesOnce(kit, expected, check) {
  const org = await orgOf(kit)
  const sales = app("community-sales")
  const s = await signedBuyer(kit, org, "Marcus Feld", expected.inputs.depositCents)
  const fault = races.armFault(kit, { table: "payment_reversals", projectId: s.projectId, times: 1, label: "refund write" })
  let first
  try { first = settledLabel(await attempt(() => cancel(kit, org, s.contractId, "refund"))) } finally { fault.disarm() }
  const afterFailure = { receipt: receipt(kit, s.contractId), agreement: kit.rows(`select status from public.contracts where id=${kit.q(s.contractId)}`)[0].status, money: depositMoney(kit, org, s.projectId) }
  // The seller tries to cancel again: the sale is already cancelled, so only its settlement can be retried.
  const again = settledLabel(await attempt(() => cancel(kit, org, s.contractId, "refund")))
  const record = await kit.as(org.owner, () => sales.getAgreementCancellation(s.contractId))
  const retries = (await Promise.allSettled([
    kit.as(org.owner, () => sales.completeAgreementCancellation({ cancellationId: record.id })),
    kit.as(org.owner, () => sales.completeAgreementCancellation({ cancellationId: record.id })),
  ])).map(settledLabel)
  const later = settledLabel(await attempt(() => kit.as(org.owner, () => sales.completeAgreementCancellation({ cancellationId: record.id }))))
  await fx.postToBooks(kit, org)
  check.equal("a refund that fails after the void commits leaves a failed cancellation the deal can retry; two retries at once refund once and a later retry changes nothing", expected.expected, {
    first, faultFired: fault.fired(), afterFailure, cancelAgain: again, dealShows: record.settlementStatus,
    retriesAtOnce: { completed: retries.filter((label) => label === "done").length, others: retries.filter((label) => label !== "done") },
    laterRetry: later,
    after: { receipt: receipt(kit, s.contractId), money: depositMoney(kit, org, s.projectId), depositsHeld: home.depositsHeld(kit, org, s.projectId), voidOnRecord: voidOnRecord(kit, s.contractId) },
  })
  return { orgId: org.orgId, projectId: s.projectId, contractId: s.contractId }
}

async function lostReplyAndSimultaneousVoids(kit, expected, check) {
  const org = await orgOf(kit)
  const sales = app("community-sales")
  // 1. The void commits and its reply is lost; the seller tries again, then settles from the deal.
  const lostSale = await signedBuyer(kit, org, "Hollis Grant", expected.inputs.depositCents)
  const lost = await races.withLostReply(kit, /\/rpc\/void_purchase_agreement_atomic/, () => cancel(kit, org, lostSale.contractId, "refund"))
  const retry = settledLabel(await attempt(() => cancel(kit, org, lostSale.contractId, "refund")))
  const record = await kit.as(org.owner, () => sales.getAgreementCancellation(lostSale.contractId))
  const settledFromDeal = await kit.as(org.owner, () => sales.completeAgreementCancellation({ cancellationId: record.id }))
  // 2. Two voids of one agreement released together, each in its own database session.
  const twice = await signedBuyer(kit, org, "Odette Ruiz", expected.inputs.depositCents)
  const plan = await kit.as(org.owner, () => sales.previewAgreementCancellation(twice.contractId))
  const call = `select public.void_purchase_agreement_atomic(${kit.q(org.orgId)}, ${kit.q(twice.contractId)}, ${kit.q(org.owner.userId)}, 'Buyer cancelled twice at once', 'refund', null, ${kit.q(plan.hash)}) is not null;`
  const sessionsOut = await sessions.race(kit, [call, call])
  const sessionLabels = sessionsOut.map((r) => (r.ok ? "done" : /Active purchase agreement not found/.test(r.stderr) ? "refused: the agreement is no longer open" : `error: ${r.stderr.slice(0, 160)}`)).sort()
  const twiceRecord = await kit.as(org.owner, () => sales.getAgreementCancellation(twice.contractId))
  await kit.as(org.owner, () => sales.completeAgreementCancellation({ cancellationId: twiceRecord.id }))
  await fx.postToBooks(kit, org)
  const cancellations = (projectId) => Number(kit.rows(`select count(*)::int n from public.purchase_agreement_cancellations where project_id=${kit.q(projectId)}`)[0].n)
  check.equal("a void whose reply was lost is not repeated by the retry and settles from the deal's record; two voids in separate sessions leave one cancellation and one refund", expected.expected, {
    lostReply: {
      first: lost.result.status === "fulfilled" ? "done" : settledLabel(lost.result), repliesDropped: lost.dropped, retry,
      dealShowedBeforeSettling: record.settlementStatus, settledFromDeal: settledFromDeal.settlementStatus,
      cancellations: cancellations(lostSale.projectId), money: depositMoney(kit, org, lostSale.projectId), depositsHeld: home.depositsHeld(kit, org, lostSale.projectId),
      voidOnRecord: voidOnRecord(kit, lostSale.contractId),
    },
    simultaneous: {
      sessions: sessionLabels, cancellations: cancellations(twice.projectId),
      agreement: kit.rows(`select status from public.contracts where id=${kit.q(twice.contractId)}`)[0].status,
      money: depositMoney(kit, org, twice.projectId), depositsHeld: home.depositsHeld(kit, org, twice.projectId),
    },
  })
  return { orgId: org.orgId }
}

module.exports = {
  subcases: {
    "cancel-before-release-refunds-and-reopens": cancelBeforeReleaseRefundsAndReopens,
    "cancel-after-release-forfeits-and-keeps-building": cancelAfterReleaseForfeitsAndKeepsBuilding,
    "released-cancellation-flags-picks-for-purchasing": releasedCancellationFlagsPicksForPurchasing,
    "forfeited-home-resells-and-closes": forfeitedHomeResellsAndCloses,
    "reservation-release-and-split-deposit": reservationReleaseAndSplitDeposit,
    "interrupted-cancellation-settles-once": interruptedCancellationSettlesOnce,
    "lost-reply-and-simultaneous-voids": lostReplyAndSimultaneousVoids,
  },
}
