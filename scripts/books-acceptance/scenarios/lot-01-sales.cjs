// LOT-01 workflow proof: sales and settlement (EP05-02, EP05-08, EP05-09) plus the
// production-posture legs of the financial-control items (EP10-01, EP10-08) and warranty
// coverage (EP11-02). Every subcase acts as the role that owns the step, through the same
// services the app's server actions call, and asserts the outcome in the database.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")
const fx = require("./lot-01-sales-fixtures.cjs")
const { race } = require("./sessions.cjs")

const lot = () => require("./lot-01.cjs").helpers
const { refusal } = fx
const label = (message, rules) => {
  for (const [pattern, name] of rules) if (pattern.test(message)) return name
  return message
}
const future = (hours) => new Date(Date.now() + hours * 3600000).toISOString()
const NO_QUOTE = "0".repeat(64)
const eventsFor = (kit, org, entityType, entityId) => kit.rows(`select event_type from public.events where org_id=${kit.q(org.orgId)} and entity_type=${kit.q(entityType)} and entity_id=${kit.q(entityId)} order by created_at, id`).map((row) => row.event_type)

// ---------------------------------------------------------------------------
// EP05-02 #0: one traceable lifecycle from prospect to executed agreement.

async function buyerLifecycleIsOneTraceableChain(kit, expected, check) {
  const { equal } = lot()
  const { org } = await lot().stage(kit, "land")
  const sales = app("community-sales"), q = kit.q
  const home = await fx.newLot(kit, org)
  const prospect = await seed.registerBuyer(kit, org, { name: "Lena Okafor", email: `lena.okafor.${fx.tag()}@acceptance.example.test` })
  const prospectRow = kit.rows(`select p.status, p.owner_user_id, p.community_id, (select count(*)::int from public.prospect_contacts c where c.prospect_id=p.id) contacts from public.prospects p where p.id=${q(prospect.id)}`)[0]
  const afterRegistration = { prospectOwnedBySalesConsultant: prospectRow.owner_user_id === org.team.sales.userId, prospectCommunity: prospectRow.community_id === org.communityId, contacts: prospectRow.contacts }

  const hold = await kit.as(org.team.sales, () => sales.createLotHoldFromProspect({ prospectId: prospect.id, lotId: home.id, expiresAt: future(24 * 14) }))
  const promoted = kit.rows(`select promoted_contact_id from public.prospect_contacts where prospect_id=${q(prospect.id)} order by is_primary desc, created_at limit 1`)[0].promoted_contact_id
  const holdRow = kit.rows(`select status, prospect_id, buyer_contact_id, lot_id from public.lot_reservations where id=${q(hold.id)}`)[0]
  const afterHold = {
    status: holdRow.status, linksProspect: holdRow.prospect_id === prospect.id, buyerIsThePromotedProspectContact: holdRow.buyer_contact_id === promoted && Boolean(promoted),
    onTheHeldLot: holdRow.lot_id === home.id, lotHasNoHomeYet: kit.rows(`select project_id from public.lots where id=${q(home.id)}`)[0].project_id === null,
  }

  const reservation = await seed.reserveHold(kit, org.team.sales, { reservationId: hold.id, depositCents: 1200000 })
  const reservedRow = kit.rows(`select status, deposit_required_cents::bigint deposit, deposit_invoice_id, buyer_contact_id, prospect_id from public.lot_reservations where id=${q(hold.id)}`)[0]
  const homeId = kit.rows(`select project_id from public.lots where id=${q(home.id)}`)[0].project_id
  const homeRow = kit.rows(`select property_type, client_id, prospect_id from public.projects where id=${q(homeId)}`)[0]
  const depositInvoice = kit.rows(`select recipient_contact_id, project_id, total_cents::bigint total, metadata->>'invoice_kind' kind, metadata->>'source_reservation_id' source_reservation, metadata->>'customer_id' customer from public.invoices where id=${q(reservedRow.deposit_invoice_id)}`)[0]
  const afterReservation = {
    status: reservedRow.status, depositCents: Number(reservedRow.deposit),
    homeIsAProductionHomeForTheBuyer: homeRow.property_type === "production" && homeRow.client_id === promoted,
    homeKeepsTheProspect: homeRow.prospect_id === prospect.id,
    depositInvoice: { kind: depositInvoice.kind, billsTheBuyer: (depositInvoice.recipient_contact_id ?? depositInvoice.customer) === promoted, onTheHome: depositInvoice.project_id === homeId, tracesToReservation: depositInvoice.source_reservation === hold.id, totalCents: Number(depositInvoice.total) },
  }

  const buyer = { lot: home, prospect, hold, reservation, projectId: homeId, buyerId: promoted }
  const sale = await fx.agreementFor(kit, org, buyer)
  const draft = sale.draft
  const contractRow = kit.rows(`select status, buyer_contact_id, co_buyer_contact_id, project_id, snapshot->'purchase_agreement'->'deposits' deposits from public.contracts where id=${q(sale.contractId)}`)[0]
  const executed = kit.rows(`select r.status, r.contract_id, r.converted_at is not null converted, p.status prospect_status, p.won_at is not null won, c.status contract_status, c.signed_at is not null signed
    from public.lot_reservations r join public.prospects p on p.id=r.prospect_id join public.contracts c on c.id=r.contract_id where r.id=${q(hold.id)}`)[0]
  const closing = kit.rows(`select status, buyer_contact_id, lot_id, project_id from public.closings where project_id=${q(homeId)} and status<>'cancelled'`)
  const lotRow = kit.rows(`select status, project_id from public.lots where id=${q(home.id)}`)[0]
  const afterAgreement = {
    draftWasSavedFirst: draft.status === "draft",
    agreementNamesTheBuyer: contractRow.buyer_contact_id === promoted, agreementOnTheSameHome: contractRow.project_id === homeId,
    agreementCitesTheDepositInvoice: JSON.stringify(contractRow.deposits.map((row) => row.invoice_id)) === JSON.stringify([reservedRow.deposit_invoice_id]),
    reservation: { status: executed.status, ownsTheAgreement: executed.contract_id === sale.contractId, converted: executed.converted },
    prospect: { status: executed.prospect_status, won: executed.won }, contract: { status: executed.contract_status, signed: executed.signed },
    closing: closing.map((row) => ({ status: row.status, buyerIsTheSame: row.buyer_contact_id === promoted, sameHome: row.project_id === homeId, sameLot: row.lot_id === home.id })),
    lot: { status: lotRow.status, sameHome: lotRow.project_id === homeId },
  }
  const trail = {
    reservation: eventsFor(kit, org, "lot_reservation", hold.id), agreement: eventsFor(kit, org, "contract", sale.contractId),
  }
  equal(check, "prospect, buyer, hold, reservation, deposit, agreement and closing are one chain keyed on the same buyer, lot and home, with events at each step", expected.expected, {
    afterRegistration, afterHold, afterReservation, afterAgreement,
    reservationEvents: trail.reservation.filter((type) => ["lot_hold_created", "lot_reserved"].includes(type)),
    agreementEvents: trail.agreement.filter((type) => ["purchase_agreement_created", "purchase_agreement_executed"].includes(type)),
  })
  return { orgId: org.orgId, reservationId: hold.id, contractId: sale.contractId, projectId: homeId }
}

// ---------------------------------------------------------------------------
// EP05-02 #1: a reservation that is not live cannot become an agreement.

async function invalidAndExpiredReservationsCannotProduceAgreements(kit, expected, check) {
  const { equal } = lot()
  const { org } = await lot().stage(kit, "land")
  const sales = app("community-sales"), q = kit.q
  const asSales = (work) => kit.as(org.team.sales, work)
  const create = (actor, buyer, reservationId = buyer.reservation.id, lotId = buyer.lot.id) => refusal(() => kit.as(actor, () => sales.createPurchaseAgreement({
    ...seed.configuration(org, { lotId, plan: org.plans[0], swing: "right" }), ...seed.agreementPacketFor(kit, org, lotId), reservationId, expectedQuoteHash: NO_QUOTE })))
  const reason = label

  // A hold that was never reserved has no home and no deposit: it cannot be signed.
  const holdOnly = await (async () => {
    const home = await fx.newLot(kit, org)
    const prospect = await seed.registerBuyer(kit, org, { name: "Hold Only", email: `hold.only.${fx.tag()}@acceptance.example.test` })
    const hold = await asSales(() => sales.createLotHoldFromProspect({ prospectId: prospect.id, lotId: home.id, expiresAt: future(48) }))
    return { agreement: await create(org.team.sales, { reservation: hold, lot: home }), agreements: Number(kit.rows(`select count(*) n from public.contracts where org_id=${q(org.orgId)} and contract_type='purchase_agreement' and id in (select contract_id from public.lot_reservations where id=${q(hold.id)})`)[0].n) }
  })()

  // A hold past its expiry cannot be reserved, cannot be signed, and is released by the sweep, which frees the lot for another buyer.
  const expired = await (async () => {
    const home = await fx.newLot(kit, org)
    const prospect = await seed.registerBuyer(kit, org, { name: "Slow Buyer", email: `slow.buyer.${fx.tag()}@acceptance.example.test` })
    const hold = await asSales(() => sales.createLotHoldFromProspect({ prospectId: prospect.id, lotId: home.id, expiresAt: future(48) }))
    kit.sql(`update public.lot_reservations set expires_at = now() - interval '2 hours' where id=${q(hold.id)}`)
    const reserve = await refusal(() => seed.reserveHold(kit, org.team.sales, { reservationId: hold.id, depositCents: 500000 }))
    const sign = await create(org.team.sales, { reservation: hold, lot: home })
    await kit.service(() => sales.sweepExpiredLotHolds())
    const row = kit.rows(`select status, released_at is not null released, release_reason from public.lot_reservations where id=${q(hold.id)}`)[0]
    const signAfterSweep = await create(org.team.sales, { reservation: hold, lot: home })
    const next = await seed.registerBuyer(kit, org, { name: "Quick Buyer", email: `quick.buyer.${fx.tag()}@acceptance.example.test` })
    const retaken = await refusal(() => asSales(() => sales.createLotHoldFromProspect({ prospectId: next.id, lotId: home.id, expiresAt: future(48) })))
    return { reserve, sign, signAfterSweep, row, retakenByAnotherBuyer: retaken, events: eventsFor(kit, org, "lot_reservation", hold.id), prospectStatus: kit.rows(`select status from public.prospects where id=${q(prospect.id)}`)[0].status }
  })()

  // A released reservation is over.
  const released = await (async () => {
    const buyer = await fx.reservedBuyer(kit, org, { name: "Walked Away", depositCents: 800000, receivedOn: null })
    await asSales(() => sales.releaseReservation({ reservationId: buyer.reservation.id, reason: "Buyer withdrew before signing" }))
    return { agreement: await create(org.team.sales, buyer), status: kit.rows(`select status from public.lot_reservations where id=${q(buyer.reservation.id)}`)[0].status }
  })()

  // One reservation, one agreement: a second is refused while the first is a draft and after it executes; a mismatched lot is refused.
  const duplicate = await (async () => {
    const buyer = await fx.reservedBuyer(kit, org, { name: "Twice Over", depositCents: 700000, receivedOn: null })
    const other = await fx.newLot(kit, org)
    const wrongLot = await create(org.team.sales, buyer, buyer.reservation.id, other.id)
    const sale = await fx.agreementFor(kit, org, buyer)
    const quote = await asSales(() => sales.priceAgreementDraft(seed.configuration(org, { lotId: buyer.lot.id, plan: org.plans[0], swing: "right" })))
    // A second agreement, not a retry of the first: a retry of the same reviewed request recovers the executed one.
    const again = (actor) => refusal(() => kit.as(actor, () => sales.createPurchaseAgreement({ ...seed.configuration(org, { lotId: buyer.lot.id, plan: org.plans[0], swing: "right" }), ...seed.agreementPacketFor(kit, org, buyer.lot.id), reservationId: buyer.reservation.id, expectedQuoteHash: quote.quoteHash, terms: "Second agreement for the same reservation" })))
    const afterExecution = await again(org.team.sales)
    return { wrongLot, afterExecution, agreements: Number(kit.rows(`select count(*) n from public.contracts where org_id=${q(org.orgId)} and project_id=${q(sale.projectId)} and contract_type='purchase_agreement'`)[0].n) }
  })()

  // A voided agreement cannot be executed; only the sales desk can create one.
  const voided = await (async () => {
    const buyer = await fx.reservedBuyer(kit, org, { name: "Cancelled Sale", depositCents: 600000, receivedOn: null })
    const config = seed.configuration(org, { lotId: buyer.lot.id, plan: org.plans[0], swing: "right" })
    const quote = await asSales(() => sales.priceAgreementDraft(config))
    const packet = seed.agreementPacketFor(kit, org, buyer.lot.id)
    const landManager = await refusal(() => kit.as(org.team.land, () => sales.createPurchaseAgreement({ ...config, ...packet, reservationId: buyer.reservation.id, expectedQuoteHash: quote.quoteHash })))
    const created = await asSales(() => sales.createPurchaseAgreement({ ...config, ...packet, reservationId: buyer.reservation.id, expectedQuoteHash: quote.quoteHash })).catch((error) => { if (!/^Missing (R2 credentials|DOCUMENT_SIGNING_SECRET)/.test(error.message)) throw error })
    const contractId = created?.id ?? kit.rows(`select contract_id from public.lot_reservations where id=${q(buyer.reservation.id)}`)[0].contract_id
    const plan = await kit.as(org.owner, () => sales.previewAgreementCancellation(contractId))
    await kit.as(org.owner, () => sales.voidPurchaseAgreement({ contractId, reason: "Buyer financing was declined", depositDisposition: "refund", expectedPlanHash: plan.hash }))
    const execute = await refusal(() => kit.service(() => sales.executePurchaseAgreementFromEnvelopeExecution({ orgId: org.orgId, contractId, envelopeId: randomUUID() })))
    return { landManager, execute, contract: kit.rows(`select status from public.contracts where id=${q(contractId)}`)[0].status, reservation: kit.rows(`select status from public.lot_reservations where id=${q(buyer.reservation.id)}`)[0].status, closings: kit.rows(`select status from public.closings where project_id=${q(buyer.projectId)}`).map((row) => row.status) }
  })()

  equal(check, "a hold that is not reserved, expired, released, already signed, mismatched, voided or created by the wrong role cannot produce or execute an agreement", expected.expected, {
    holdOnly: { refused: reason(holdOnly.agreement, [[/[Rr]eserved lot with an actual home is required/, "refused: reserved lot with a home required"]]), agreementsCreated: holdOnly.agreements },
    expiredHold: {
      reserve: reason(expired.reserve, [[/hold has expired/, "refused: hold expired"]]),
      sign: reason(expired.sign, [[/[Rr]eserved lot with an actual home is required/, "refused: reserved lot with a home required"]]),
      afterSweep: { status: expired.row.status, released: expired.row.released, reason: expired.row.release_reason, sign: reason(expired.signAfterSweep, [[/[Rr]eserved lot with an actual home is required/, "refused: reserved lot with a home required"]]) },
      lotFreeForAnotherBuyer: expired.retakenByAnotherBuyer === "allowed", expiryRecorded: expired.events.includes("lot_hold_expired"), prospectStillOpen: expired.prospectStatus !== "won",
    },
    released: { status: released.status, agreement: reason(released.agreement, [[/[Rr]eserved lot with an actual home is required/, "refused: reserved lot with a home required"]]) },
    duplicate: {
      wrongLot: reason(duplicate.wrongLot, [[/Reservation and lot do not match/, "refused: reservation and lot do not match"]]),
      afterExecution: reason(duplicate.afterExecution, [[/already has a creation receipt for different reviewed inputs/, "refused: the reservation already has its agreement"]]),
      agreementsOnTheHome: duplicate.agreements,
    },
    voided: {
      landManagerCreate: reason(voided.landManager, [[/Missing permission: sales\.manage/, "refused: sales.manage"]]),
      execute: reason(voided.execute, [[/Purchase agreement was voided/, "refused: agreement was voided"]]),
      contract: voided.contract, reservation: voided.reservation, closings: voided.closings,
    },
  })
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// EP05-08: price, incentives, approved changes, adjustments and deposits foot to integer cents.

async function settlementArithmeticFootsInIntegerCents(kit, expected, check) {
  const { equal } = lot()
  const input = expected.inputs
  const { org } = await lot().stage(kit, "land")
  const sales = app("community-sales"), closings = app("closings"), q = kit.q
  const asSales = (work) => kit.as(org.team.sales, work)
  const incentive = (extra) => asSales(() => sales.upsertIncentive({ communityId: org.communityId, status: "active", requiresApproval: false, ...extra }))
  const fixed = await incentive({ name: "Closing-cost credit", incentiveType: "fixed_amount", amountCents: input.incentives.fixedCents, appliesTo: "price" })
  const percent = await incentive({ name: "Quick-move-in percent", incentiveType: "percent_of_base", percent: input.incentives.percentOfBase, appliesTo: "price" })
  const designCredit = await incentive({ name: "Design studio credit", incentiveType: "fixed_amount", amountCents: input.incentives.designCreditCents, appliesTo: "design_credit" })

  const buyer = await fx.reservedBuyer(kit, org, { name: "Marisol Quintero", depositCents: input.depositCents, premiumCents: input.lotPremiumCents })
  const payment = kit.rows(`select p.id from public.payments p where p.invoice_id=${q(buyer.reservation.depositInvoiceId)}`)[0].id
  await kit.as(org.owner, () => app("payments").recordPaymentReversal({ paymentId: payment, amountCents: input.depositRefundCents, reversalType: "refund", reason: "Buyer reduced the earnest deposit" }))
  await fx.postToBooks(kit, org)
  const sale = await fx.agreementFor(kit, org, buyer, { skus: ["ST-GAR", "KT-QTZ"], incentiveIds: [fixed.id, percent.id, designCredit.id] })
  const agreement = kit.rows(`select total_cents::bigint total from public.contracts where id=${q(sale.contractId)}`)[0]
  const closingId = fx.closingOf(kit, sale.projectId)

  // The closing table's own adjustments.
  const adjustmentBy = (actor, kind, text, amountCents) => refusal(() => kit.as(actor, () => closings.upsertClosingAdjustment({ closingId, label: text, kind, amountCents })))
  const salesDeskAdjusting = await adjustmentBy(org.team.sales, "closing_cost", "Not the closing desk", 100)
  for (const row of input.adjustments) await kit.as(org.owner, () => closings.upsertClosingAdjustment({ closingId, label: row.label, kind: row.kind, amountCents: row.amountCents }))

  const preview = await kit.as(org.owner, () => closings.buildSettlement(closingId))
  const previewSeen = { finalPriceCents: preview.finalPriceCents, agreementTotalCents: preview.components.agreementTotalCents, approvedChangeOrdersCents: preview.components.approvedChangeOrdersCents, adjustmentsCents: preview.components.adjustmentsCents, depositsAppliedCents: preview.depositsAppliedCents, balanceDueCents: preview.balanceDueCents }
  await fx.clearToClose(kit, org, closingId, seed.isoDay(0))
  await fx.settleCall(kit, org.owner, closingId, seed.isoDay(0), "WIRE-ARITH").catch((error) => { if (!/^Closing is recorded; retry completion after resolving the statement: Missing R2/.test(error.message)) throw error })
  const evidence = fx.closingEvidence(kit, org, closingId)
  const settlement = evidence.closing.settlement
  const cents = (value) => Number.isSafeInteger(Number(value))
  const applications = evidence.payments.filter((row) => row.application === "true")
  const balance = evidence.payments.filter((row) => row.application !== "true")
  const amounts = [...evidence.lines.map((row) => Number(row.amount)), ...evidence.payments.map((row) => Number(row.amount)), settlement.finalPriceCents, settlement.balanceDueCents]
  const invoice = kit.rows(`select total_cents::bigint total, balance_due_cents::bigint balance, status from public.invoices where id=${q(evidence.invoiceId)}`)[0]
  const sameLines = (prefix) => evidence.lines.filter((row) => row.description.startsWith(prefix)).map((row) => Number(row.amount))
  equal(check, "price, incentives, adjustments and the net deposit foot to the cent; the closing invoice lines equal the authorized final price", expected.expected, {
    quote: { baseCents: sale.quote.basePriceCents, lotPremiumCents: sale.quote.lotPremiumCents, structuralCents: sale.quote.structuralOptionsCents, designCents: sale.quote.designSelectionsCents, incentivesCents: sale.quote.incentivesCents, totalCents: sale.quote.totalCents,
      incentiveValues: Object.fromEntries(sale.quote.incentives.map((row) => [row.name, row.valueCents])) },
    agreementTotalCents: Number(agreement.total),
    salesDeskCannotAdjust: /Missing permission: closing\.manage/.test(salesDeskAdjusting) ? "refused: closing.manage" : salesDeskAdjusting,
    preview: previewSeen,
    settlement: { finalPriceCents: settlement.finalPriceCents, balanceDueCents: settlement.balanceDueCents, depositsAppliedCents: settlement.depositsAppliedCents, depositsApplied: settlement.depositsApplied.map((row) => row.amountCents) },
    invoice: { totalCents: Number(invoice.total), balanceDueCents: Number(invoice.balance), status: invoice.status, linesTotalCents: evidence.lines.reduce((sum, row) => sum + Number(row.amount), 0), invoices: evidence.invoices.length,
      incentiveLines: sameLines("Incentive").sort((a, b) => a - b), adjustmentLines: [...sameLines("Closing cost"), ...sameLines("Seller credit"), ...sameLines("Proration")] },
    payments: { depositApplications: applications.map((row) => Number(row.amount)), balanceReceipts: balance.map((row) => Number(row.amount)), receivedCents: evidence.payments.reduce((sum, row) => sum + Number(row.amount), 0) },
    everyAmountIsWholeCents: amounts.every(cents),
    homeReceivableCents: lot().houseNet(kit, org, sale.projectId, "1100"),
    homeDepositsHeldCents: -lot().houseNet(kit, org, sale.projectId, "2300"),
    closing: evidence.closing.status,
  })
  return { orgId: org.orgId, closingId, projectId: sale.projectId }
}

// ---------------------------------------------------------------------------
// EP05-08 #1: a closing whose invoice would differ from the authorized price is refused before any money moves.

async function closingRefusesAnInvoiceThatDiffersFromTheAuthorizedPrice(kit, expected, check) {
  const { equal } = lot()
  const input = expected.inputs
  const { org } = await lot().stage(kit, "land")
  const q = kit.q
  const buyer = await fx.reservedBuyer(kit, org, { name: "Tomas Reyes", depositCents: input.depositCents })
  const sale = await fx.agreementFor(kit, org, buyer)
  const closingId = fx.closingOf(kit, sale.projectId)
  await fx.clearToClose(kit, org, closingId, seed.isoDay(0))
  // The agreement total drifts from the priced snapshot its invoice lines are built from. A signed
  // agreement's price is bound by a trigger, so the corruption is simulated with triggers off.
  const drift = (sign) => kit.sql(`begin; set local session_replication_role = replica;
update public.contracts set total_cents = total_cents ${sign} ${input.driftCents} where id=${q(sale.contractId)}; commit;`, "supabase_admin")
  drift("+")
  const refused = await refusal(() => fx.settleCall(kit, org.owner, closingId, seed.isoDay(0), "WIRE-DRIFT"))
  const afterRefusal = fx.closingEvidence(kit, org, closingId)
  const applicationsAfterRefusal = Number(kit.rows(`select count(*) n from public.payments where org_id=${q(org.orgId)} and metadata->>'customer_deposit_application'='true' and metadata->>'deposit_invoice_id'=${q(buyer.reservation.depositInvoiceId)}`)[0].n)
  drift("-")
  await fx.settleCall(kit, org.owner, closingId, seed.isoDay(0), "WIRE-DRIFT").catch((error) => { if (!/^Closing is recorded; retry completion after resolving the statement: Missing R2/.test(error.message)) throw error })
  const settled = fx.closingEvidence(kit, org, closingId)
  equal(check, "settlement refuses while the invoice would not equal the authorized final price, creates nothing, and settles exactly the agreed price once the agreement is true again", expected.expected, {
    // The drifted total no longer matches the agreement's signed original version (EP05-07), which the
    // settlement checks before it builds any invoice line.
    refused: label(refused, [[/The agreement's original version does not match its signed price/, "refused: the agreement total differs from its signed version"]]),
    nothingCreated: { invoices: afterRefusal.invoices.length, payments: afterRefusal.payments.length, status: afterRefusal.closing.status },
    depositStillUnapplied: applicationsAfterRefusal === 0,
    afterCure: { status: settled.closing.status, invoiceTotalCents: Number(settled.invoices[0].total), linesTotalCents: settled.lines.reduce((sum, row) => sum + Number(row.amount), 0), finalPriceCents: settled.closing.settlement.finalPriceCents },
  })
  return { orgId: org.orgId, closingId }
}


// ---------------------------------------------------------------------------
// EP05-08 #0: an approved change order counts once in the final price.

async function approvedChangeOrderCountsOnceInTheFinalPrice(kit, expected, check) {
  const { equal } = lot()
  const input = expected.inputs
  const { org } = await lot().stage(kit, "land")
  const closings = app("closings"), changes = app("change-orders"), q = kit.q
  const buyer = await fx.reservedBuyer(kit, org, { name: "Imani Brooks", depositCents: input.depositCents })
  const sale = await fx.agreementFor(kit, org, buyer)
  const closingId = fx.closingOf(kit, sale.projectId)
  const co = await kit.as(org.owner, () => changes.createChangeOrder({ input: { project_id: sale.projectId, title: "Add covered patio", summary: "Buyer added a covered patio after signing", tax_rate: 0, markup_percent: 0, markup_mode: "percent", requires_signature: true, lines: [{ description: "Covered patio", quantity: 1, unit_cost: input.changeOrderCents / 100, taxable: false }] } }))
  // The buyer signed the amendment at the model home; the approval carries that copy.
  const signedFileId = seed.signedCopyFile(kit, org, sale.projectId, "covered-patio-signed.pdf")
  await kit.as(org.owner, () => changes.approveChangeOrder({ changeOrderId: co.id, approval: { signerName: "Imani Brooks", note: "Signed at the model home", signedFileId } }))
  const preview = await kit.as(org.owner, () => closings.buildSettlement(closingId))
  await fx.clearToClose(kit, org, closingId, seed.isoDay(0))
  const settled = await refusal(() => fx.settleCall(kit, org.owner, closingId, seed.isoDay(0), "WIRE-CHANGE")).then((message) => /^Closing is recorded; retry completion after resolving the statement: Missing R2/.test(message) ? "closed" : message)
  const evidence = fx.closingEvidence(kit, org, closingId)
  equal(check, "an approved change order adds to the agreement total once: the preview, the invoice lines and the receipts all equal agreement + change order", expected.expected, {
    preview: { agreementTotalCents: preview.components.agreementTotalCents, approvedChangeOrdersCents: preview.components.approvedChangeOrdersCents, finalPriceCents: preview.finalPriceCents, balanceDueCents: preview.balanceDueCents },
    settlement: settled,
    invoiceTotalCents: evidence.invoices.length ? Number(evidence.invoices[0].total) : null,
    invoiceLinesTotalCents: evidence.lines.reduce((sum, row) => sum + Number(row.amount), 0),
    receiptsCents: evidence.payments.reduce((sum, row) => sum + Number(row.amount), 0),
  })
  return { orgId: org.orgId, closingId }
}

const STATEMENT_ONLY = /^Closing is recorded; retry completion after resolving the statement: Missing R2/
const settledOrStatementOnly = (message) => message === "allowed" || STATEMENT_ONLY.test(message)

// ---------------------------------------------------------------------------
// EP05-09 #1: every payment and refund lands on the buyer who made it.

async function depositsAndRefundsReconcileToTheirOwnBuyer(kit, expected, check) {
  const { equal, houseNet } = lot()
  const input = expected.inputs
  const { org } = await lot().stage(kit, "land")
  const payments = app("payments"), invoices = app("invoices"), sales = app("community-sales"), q = kit.q
  const heldOn = (projectId) => -houseNet(kit, org, projectId, "2300")
  const paymentOf = (invoiceId) => kit.rows(`select id from public.payments where invoice_id=${q(invoiceId)} and status in ('succeeded','completed') order by created_at limit 1`)[0].id

  // Buyer A: a deposit, partly refunded, then signs. Another customer's deposit also sits on A's home (a buyer who walked away).
  const a = await fx.reservedBuyer(kit, org, { name: "Alma Ferreira", depositCents: input.a.depositCents })
  const aPayment = paymentOf(a.reservation.depositInvoiceId)
  await kit.as(org.owner, () => payments.recordPaymentReversal({ paymentId: aPayment, amountCents: input.a.refundCents, reversalType: "refund", reason: "Buyer reduced the earnest deposit" }))
  const walker = await kit.as(org.owner, () => app("contacts").createContact({ input: { full_name: "Previous Buyer", role_key: "client", email: `previous.buyer.${fx.tag()}@acceptance.example.test` } }))
  const walkerInvoice = await kit.as(org.owner, () => invoices.createInvoice({ input: { project_id: a.projectId, invoice_number: `DEP-W-${fx.tag()}`, customer_id: walker.id, title: "Earnest deposit",
    issue: true, issue_date: seed.isoDay(-5), due_date: seed.isoDay(-5), tax_rate: 0, sent_to_emails: [walker.email ?? `previous.buyer@acceptance.example.test`],
    lines: [{ description: "Earnest deposit", quantity: 1, unit_cost: input.walker.depositCents / 100, taxable: false }], metadata: { invoice_kind: "earnest_deposit" } } }))
  await kit.as(org.owner, () => payments.recordMultiInvoicePayment({ received_at: `${seed.isoDay(-5)}T12:00:00Z`, method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: walkerInvoice.id, amount_cents: input.walker.depositCents }] }))
  const walkerPayment = paymentOf(walkerInvoice.id)
  const saleA = await fx.agreementFor(kit, org, a)

  // Buyer B keeps a deposit on a different home; buyer C has an open upgrade invoice.
  const b = await fx.reservedBuyer(kit, org, { name: "Bao Tran", depositCents: input.b.depositCents })
  const bPayment = paymentOf(b.reservation.depositInvoiceId)
  const c = await fx.reservedBuyer(kit, org, { name: "Carla Mendes", depositCents: input.c.depositCents, receivedOn: null })
  const upgrade = await kit.as(org.owner, () => invoices.createInvoice({ input: { project_id: c.projectId, invoice_number: `UP-C-${fx.tag()}`, customer_id: c.buyerId, title: "Kitchen upgrade",
    issue: true, issue_date: seed.isoDay(0), due_date: seed.isoDay(30), tax_rate: 0, sent_to_emails: ["carla.mendes@acceptance.example.test"],
    lines: [{ description: "Kitchen upgrade", quantity: 1, unit_cost: input.c.upgradeCents / 100, taxable: false }] } }))
  await fx.postToBooks(kit, org)

  const deposits = app("books/customer-deposits")
  const applyTo = (paymentId, invoiceId) => refusal(() => kit.as(org.owner, () => deposits.applyCustomerDeposit({ depositPaymentId: paymentId, targetInvoiceId: invoiceId, amountCents: input.c.upgradeCents })))
  const crossBuyer = { otherBuyersDepositOnTheUpgrade: await applyTo(bPayment, upgrade.id), thePreviousBuyersDepositOnTheUpgrade: await applyTo(walkerPayment, upgrade.id) }
  const salesRefund = await refusal(() => kit.as(org.team.sales, () => payments.recordPaymentReversal({ paymentId: bPayment, amountCents: 1000, reversalType: "refund", reason: "Sales desk cannot refund" })))

  // A settles: only A's own remaining deposit is applied.
  const closingA = fx.closingOf(kit, saleA.projectId)
  await fx.clearToClose(kit, org, closingA, seed.isoDay(0))
  await fx.settleCall(kit, org.owner, closingA, seed.isoDay(0), "WIRE-ALMA").catch((error) => { if (!STATEMENT_ONLY.test(error.message)) throw error })
  const evidenceA = fx.closingEvidence(kit, org, closingA)
  const applications = evidenceA.payments.filter((row) => row.application === "true")
  const invoiceA = kit.rows(`select coalesce(recipient_contact_id::text, metadata->>'customer_id') customer from public.invoices where id=${q(evidenceA.invoiceId)}`)[0]
  const applicationsOf = (paymentId) => Number(kit.rows(`select count(*) n from public.payments where org_id=${q(org.orgId)} and metadata->>'deposit_payment_id'=${q(paymentId)}`)[0].n)

  // B walks away before signing: the refund goes to B's payment only, through the release desk.
  await kit.as(org.owner, () => sales.releaseReservation({ reservationId: b.reservation.id, reason: "Buyer financing was declined", depositDisposition: "refund" }))
  await fx.postToBooks(kit, org)
  const reversals = kit.rows(`select r.amount_cents::bigint cents, r.reversal_type, r.payment_id, coalesce(i.recipient_contact_id::text, i.metadata->>'customer_id') customer
    from public.payment_reversals r join public.payments p on p.id=r.payment_id join public.invoices i on i.id=p.invoice_id
    where r.org_id=${q(org.orgId)} and r.payment_id in (${[aPayment, walkerPayment, bPayment].map(q).join(",")}) and r.status='succeeded' order by r.amount_cents`)
  const byBuyer = Object.fromEntries([[a.buyerId, "alma"], [b.buyerId, "bao"], [walker.id, "previousBuyer"]])
  const controls = await kit.service(() => app("books/verifier").runLedgerTieOuts(org.orgId, seed.isoDay(0)))
  equal(check, "deposits are applied and refunded only to the buyer whose money they are, and the customer-deposit liability and control tie", expected.expected, {
    crossBuyerApplication: { otherBuyersDeposit: /only be applied to that customer/.test(crossBuyer.otherBuyersDepositOnTheUpgrade) ? "refused: not that customer's invoice" : crossBuyer.otherBuyersDepositOnTheUpgrade,
      previousBuyersDeposit: /only be applied to that customer/.test(crossBuyer.thePreviousBuyersDepositOnTheUpgrade) ? "refused: not that customer's invoice" : crossBuyer.thePreviousBuyersDepositOnTheUpgrade },
    salesConsultantRefund: /Missing permission: payment\.release/.test(salesRefund) ? "refused: payment.release" : salesRefund,
    settlementOfAlma: { appliedPaymentIsAlmas: applications.length === 1 && applications[0].deposit_payment_id === aPayment, appliedCents: applications.map((row) => Number(row.amount)),
      balanceReceiptCents: evidenceA.payments.filter((row) => row.application !== "true").map((row) => Number(row.amount)), invoiceBillsAlma: invoiceA.customer === a.buyerId, settlementDepositsCents: evidenceA.closing.settlement.depositsApplied.map((row) => row.amountCents) },
    previousBuyersDeposit: { applications: applicationsOf(walkerPayment), stillHeldOnTheHomeCents: heldOn(saleA.projectId) },
    baoRefund: { reversals: reversals.filter((row) => row.payment_id === bPayment).map((row) => ({ cents: Number(row.cents), type: row.reversal_type, buyer: byBuyer[row.customer] })), heldOnHisHomeCents: heldOn(b.projectId), reservation: kit.rows(`select status from public.lot_reservations where id=${q(b.reservation.id)}`)[0].status },
    almaRefund: reversals.filter((row) => row.payment_id === aPayment).map((row) => ({ cents: Number(row.cents), type: row.reversal_type, buyer: byBuyer[row.customer] })),
    refundsByBuyer: Object.fromEntries(Object.entries(reversals.reduce((all, row) => ({ ...all, [byBuyer[row.customer]]: (all[byBuyer[row.customer]] ?? 0) + Number(row.cents) }), {})).sort(([x], [y]) => x.localeCompare(y))),
    customerDepositsControl: controls.find((row) => row.code === "customer_deposits_control")?.status,
  })
  return { orgId: org.orgId, closingId: closingA }
}

// ---------------------------------------------------------------------------
// EP05-09 #0: a settlement that dies after the money moved resumes without repeating any of it.

async function interruptedSettlementResumesWithoutDuplicates(kit, expected, check) {
  const { equal } = lot()
  const input = expected.inputs
  const { org } = await lot().stage(kit, "land")
  const q = kit.q
  const date = seed.isoDay(0)
  const table = await fx.homeAtTheTable(kit, org, { name: "Dev Patel", depositCents: input.depositCents, date })
  const { closingId, projectId } = table
  const fault = `sales_fault_${fx.tag()}`
  kit.sql(`create function public.${fault}() returns trigger language plpgsql as $$ begin
      if new.org_id = ${q(org.orgId)} and new.source_type in ('invoice','invoice_payment','customer_deposit_application') then raise exception 'Injected failure posting the closing'; end if; return new; end $$;
    create trigger ${fault} before insert on public.journal_entries for each row execute function public.${fault}();`)
  let interrupted
  try { interrupted = await refusal(() => fx.settleCall(kit, org.owner, closingId, date, "WIRE-DEV")) } finally { kit.sql(`drop trigger ${fault} on public.journal_entries; drop function public.${fault}();`) }
  const midway = fx.closingEvidence(kit, org, closingId)
  const midwayState = { closing: midway.closing.status, posting: midway.closing.posting, invoices: midway.invoices.length, applications: midway.payments.filter((row) => row.application === "true").length, receipts: midway.payments.filter((row) => row.application !== "true").length, postedEntries: midway.entries.length }
  const retried = await refusal(() => fx.settleCall(kit, org.owner, closingId, date, "WIRE-DEV"))
  const retriedAgain = await refusal(() => fx.settleCall(kit, org.owner, closingId, date, "WIRE-DEV"))
  const wrongDateAfter = await refusal(() => fx.settleCall(kit, org.owner, closingId, seed.isoDay(1), "WIRE-DEV"))
  await fx.postToBooks(kit, org)
  const after = fx.closingEvidence(kit, org, closingId)
  const count = (sql) => Number(kit.rows(sql)[0].n)
  const settlement = after.closing.settlement
  equal(check, "a settlement interrupted after the money moved resumes on the same invoice, applies the deposit and records the receipt once, and a further retry changes nothing", expected.expected, {
    interrupted: label(interrupted, [[/Closing funds are recorded; retry settlement to finish Books posting: .*Injected failure/, "failed after recording: retry to finish Books posting"]]),
    midway: midwayState,
    retry: settledOrStatementOnly(retried) ? "completed" : retried,
    retryAgain: settledOrStatementOnly(retriedAgain) ? "completed" : retriedAgain,
    closing: { status: after.closing.status, posting: after.closing.posting, invoiceIsTheFirstOne: after.closing.closing_invoice_id === midway.invoiceId },
    invoices: after.invoices.length, applications: after.payments.filter((row) => row.application === "true").map((row) => Number(row.amount)), receipts: after.payments.filter((row) => row.application !== "true").map((row) => Number(row.amount)),
    invoiceEqualsFinalPrice: Number(after.invoices[0].total) === settlement.finalPriceCents, receiptsEqualFinalPrice: after.payments.reduce((sum, row) => sum + Number(row.amount), 0) === settlement.finalPriceCents,
    postedOncePerSource: after.entries.every((row) => row.n === 1) && after.entries.length === 3,
    closedLots: count(`select count(*) n from public.lots where org_id=${q(org.orgId)} and project_id=${q(projectId)} and status='closed'`),
    closedClosings: count(`select count(*) n from public.closings where org_id=${q(org.orgId)} and project_id=${q(projectId)} and status='closed'`),
    settledEvents: count(`select count(*) n from public.events where org_id=${q(org.orgId)} and event_type='closing_settled' and entity_id=${q(closingId)}`),
    warrantyEnrollments: count(`select count(*) n from public.project_warranty_coverage where org_id=${q(org.orgId)} and project_id=${q(projectId)}`),
    dateIsFixedOnceRecorded: /Retry must use the recorded closing date/.test(wrongDateAfter) ? "refused: recorded closing date" : wrongDateAfter,
    homeDepositsHeldCents: -lot().houseNet(kit, org, projectId, "2300"),
  })
  return { orgId: org.orgId, closingId }
}

// ---------------------------------------------------------------------------
// EP05-09 #0 multi_session: two sessions settling one closing together.

async function raceConcurrentSettlement(kit, expected, check) {
  const { equal } = lot()
  const input = expected.inputs
  const { org } = await lot().stage(kit, "land")
  const q = kit.q
  org.closingDeskTwo ??= kit.addMember(org, "org_owner")
  const date = seed.isoDay(0)
  const rounds = [], sessionOutcomes = []
  for (let round = 1; round <= input.rounds; round += 1) {
    const table = await fx.homeAtTheTable(kit, org, { name: `Race Buyer ${round}`, depositCents: input.depositCents + round * 1000, date })
    const { closingId, projectId } = table
    const results = await Promise.allSettled([fx.settleCall(kit, org.owner, closingId, date, `WIRE-R${round}A`), fx.settleCall(kit, org.closingDeskTwo, closingId, date, `WIRE-R${round}B`)])
    const outcomes = results.map((result) => result.status === "fulfilled" ? "completed" : STATEMENT_ONLY.test(result.reason.message) ? "completed" : result.reason.message)
    // Whatever either session left behind, one serial retry finishes it.
    const finish = await refusal(() => fx.settleCall(kit, org.owner, closingId, date, `WIRE-R${round}A`))
    await fx.postToBooks(kit, org)
    const evidence = fx.closingEvidence(kit, org, closingId)
    const count = (sql) => Number(kit.rows(sql)[0].n)
    const settlement = evidence.closing.settlement
    const clean = (message) => message === "completed" || /already being settled|Retry must use the recorded closing date|Failed to create invoice: Invoice number CLOSE-\d+ already exists/.test(message)
    sessionOutcomes.push(outcomes)
    rounds.push({
      sessionsThatFinished: outcomes.filter((outcome) => outcome === "completed").length >= 1,
      everyOtherSessionRefusedCleanly: outcomes.every(clean),
      finishingRetry: settledOrStatementOnly(finish) ? "completed" : finish,
      closing: evidence.closing.status,
      invoices: evidence.invoices.length,
      depositApplications: evidence.payments.filter((row) => row.application === "true").map((row) => Number(row.amount)),
      balanceReceipts: evidence.payments.filter((row) => row.application !== "true").length,
      receiptsEqualFinalPrice: evidence.payments.reduce((sum, row) => sum + Number(row.amount), 0) === settlement.finalPriceCents && Number(evidence.invoices[0].total) === settlement.finalPriceCents,
      postedOncePerSource: evidence.entries.length === 3 && evidence.entries.every((row) => row.n === 1),
      settledEvents: count(`select count(*) n from public.events where org_id=${q(org.orgId)} and event_type='closing_settled' and entity_id=${q(closingId)}`),
      closedClosings: count(`select count(*) n from public.closings where org_id=${q(org.orgId)} and project_id=${q(projectId)} and status='closed'`),
      warrantyEnrollments: count(`select count(*) n from public.project_warranty_coverage where org_id=${q(org.orgId)} and project_id=${q(projectId)}`),
      homeDepositsHeldCents: -lot().houseNet(kit, org, projectId, "2300"),
    })
  }
  equal(check, "two sessions settling one closing together leave one invoice, one deposit application, one receipt and one closing per round; the other session finishes harmlessly or is refused cleanly", expected.expected, rounds)
  return { orgId: org.orgId, sessionOutcomes }
}

// ---------------------------------------------------------------------------
// EP10-01 in production posture: a community-owning legal entity.

const EVIDENCE_SALE = `${seed.EVIDENCE}/land-company-lot-sale`
const SALE_DATE = "2026-06-10"
const AS_OF = seed.isoDay(0)

// Trial balance rows (code -> natural balance) and the proof, for one company or the whole group.
async function trialBalance(kit, org, entityId, asOf = AS_OF) {
  const statements = app("books/statements")
  const report = await kit.service(async () => statements.buildTrialBalance(org.orgId, asOf, await statements.ledgerForCompany(org.orgId, await statements.loadLedgerBalances(org.orgId, asOf), entityId)))
  return { balanced: report.totalDebitCents === report.totalCreditCents, accounts: Object.fromEntries(report.rows.filter((row) => row.balanceCents !== 0).map((row) => [row.code, row.balanceCents])) }
}
const only = (accounts, codes) => Object.fromEntries(codes.filter((code) => accounts[code] !== undefined).map((code) => [code, accounts[code]]))
const sortedRecord = (record) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))

async function productionCommunityEntityReconcilesByEntityAndOrg(kit, expected, check) {
  const { equal } = lot()
  const input = expected.inputs
  const org = await fx.landCompany(kit)
  const q = kit.q, entities = app("books/legal-entities")
  const home = await fx.adoptedHome(kit, org, org.lots[0], "Reconcile Buyer", seed.isoDay(0))
  const wrongRole = await refusal(() => kit.as(org.team.land, () => entities.sellLotToAffiliate({ projectId: home.projectId, date: SALE_DATE, priceCents: input.lotPriceCents, evidenceUrl: EVIDENCE_SALE })))
  const noPrice = await refusal(() => kit.as(org.owner, () => entities.sellLotToAffiliate({ projectId: home.projectId, date: SALE_DATE, priceCents: 0, evidenceUrl: EVIDENCE_SALE })))
  await kit.as(org.owner, () => entities.sellLotToAffiliate({ projectId: home.projectId, date: SALE_DATE, priceCents: input.lotPriceCents, evidenceUrl: EVIDENCE_SALE }))
  // The builder's own receivable and payable on the same home.
  org.bookkeeper ??= kit.addMember(org, "org_office_admin")
  await kit.as(org.owner, () => app("invoices").createInvoice({ input: { project_id: home.projectId, invoice_number: `UP-${fx.tag()}`, customer_id: home.buyer.buyerId, title: "Lot upgrade", issue: true, issue_date: "2026-06-12", due_date: "2026-06-29", tax_rate: 0,
    sent_to_emails: ["reconcile.buyer@acceptance.example.test"], lines: [{ description: "Lot upgrade", quantity: 1, unit_cost: input.receivableCents / 100, taxable: false }] } }))
  const bills = app("vendor-bills")
  const bill = await kit.as(org.bookkeeper, () => bills.createProjectVendorBill({ projectId: home.projectId, input: { company_id: org.vendorIds["Palmetto Framing"], bill_number: `FR-${fx.tag()}`, bill_date: "2026-06-12", due_date: "2026-07-12", total_cents: input.payableCents,
    actual_lines: [{ cost_code_id: org.costCodeIds["06-100"], description: "Framing", amount_cents: input.payableCents, project_id: home.projectId }] } }))
  await kit.as(org.owner, () => bills.approveVendorBillsAtomic([{ id: bill.id }]))
  await fx.postToBooks(kit, org)

  const [land, builder, group] = [await trialBalance(kit, org, org.land), await trialBalance(kit, org, org.builderEntity), await trialBalance(kit, org, null)]
  const aging = async (legalEntityId) => {
    const [ar, ap] = await Promise.all([kit.as(org.owner, () => app("reports/ar-aging").getArAgingReport({ asOf: AS_OF, legalEntityId })), kit.as(org.owner, () => app("reports/ap-aging").getApAgingReport({ asOf: AS_OF, legalEntityId }))])
    return { receivableCents: ar.totals.total_open_cents, payableCents: ap.totals.total_open_cents }
  }
  const reconciliation = await kit.as(org.owner, () => entities.getIntercompanyReconciliation(AS_OF))
  const tieOuts = await kit.service(() => app("books/verifier").runLedgerTieOuts(org.orgId, AS_OF))
  const status = (code) => tieOuts.find((row) => row.code === code)?.status
  const entityBalance = Object.fromEntries(kit.rows(`select coalesce(legal_entity_id::text,'none') entity, sum(debit_cents-credit_cents)::bigint n from public.journal_lines where org_id=${q(org.orgId)} group by 1`).map((row) => [row.entity === org.land ? "land" : row.entity === org.builderEntity ? "builder" : row.entity, Number(row.n)]))
  const sale = kit.rows(`select price_cents::bigint price, cost_cents::bigint cost from public.books_intercompany_sales where org_id=${q(org.orgId)} and lot_id=${q(org.lots[0].id)}`)
  const landCodes = ["1005", "1120", "1180", "4000", "5000"], builderCodes = ["1010", "1100", "1160", "2000", "2180", "2300"], groupCodes = ["1005", "1010", "1100", "1120", "1160", "1180", "2000", "2180", "2300"]
  equal(check, "the land company and the builder each balance on their own, their land, receivable, payable and cash tie to the org, and the lot sale between them is balanced, eliminated and tied", expected.expected, {
    onlyTheBooksDeskSellsALot: /Missing permission: books\.adjust/.test(wrongRole) ? "refused: books.adjust" : wrongRole,
    saleNeedsAPrice: /sale price|priceCents/.test(noPrice) ? "refused: a sale price is required" : noPrice,
    landCompany: { balanced: land.balanced, accounts: only(land.accounts, landCodes) },
    builder: { balanced: builder.balanced, accounts: only(builder.accounts, builderCodes) },
    group: { balanced: group.balanced, accounts: only(group.accounts, groupCodes) },
    entitiesSumToTheOrg: Object.fromEntries(["1005", "1010", "1120", "2000", "1100", "2300"].map((code) => [code, (land.accounts[code] ?? 0) + (builder.accounts[code] ?? 0) === (group.accounts[code] ?? 0)])),
    eachCompanyNetsToZero: Object.fromEntries(Object.entries(entityBalance).filter(([entity]) => ["land", "builder"].includes(entity)).map(([entity, net]) => [entity, net === 0])),
    agingTiesToTheLedger: {
      landReceivable: (await aging(org.land)).receivableCents === (land.accounts["1100"] ?? 0), landPayable: (await aging(org.land)).payableCents === (land.accounts["2000"] ?? 0),
      builderReceivableCents: (await aging(org.builderEntity)).receivableCents, builderReceivableInLedger: builder.accounts["1100"],
      builderPayableCents: (await aging(org.builderEntity)).payableCents, builderPayableInLedger: builder.accounts["2000"],
    },
    intercompany: { pairs: reconciliation.pairs.map((pair) => ({ ties: pair.ties, owedCents: Math.abs(pair.aOwedByB) })), sales: reconciliation.sales.map((row) => ({ profitCents: row.profitCents, realized: row.realized })),
      sale: sale.map((row) => ({ priceCents: Number(row.price), costCents: Number(row.cost) })) },
    controls: sortedRecord(Object.fromEntries(["land_inventory_control", "completed_homes_control", "ar_control", "ap_control", "customer_deposits_control", "intercompany_control"].map((code) => [code, status(code)]))),
  })
  return { orgId: org.orgId, projectId: home.projectId, controlDetail: tieOuts.filter((row) => row.status === "failed") }
}

// ---------------------------------------------------------------------------
// EP10-01 multi_session: two sessions selling the same lot between companies.

async function raceIntercompanyLotSale(kit, expected, check) {
  const { equal } = lot()
  const input = expected.inputs
  const org = await fx.landCompany(kit)
  const q = kit.q, entities = app("books/legal-entities")
  org.closingDeskTwo ??= kit.addMember(org, "org_owner")
  const sell = (actor, projectId, priceCents) => kit.as(actor, () => entities.sellLotToAffiliate({ projectId, date: SALE_DATE, priceCents, evidenceUrl: EVIDENCE_SALE }))
  const rounds = [], saleEvents = []
  for (const [index, round] of input.rounds.entries()) {
    const home = await fx.adoptedHome(kit, org, org.lots[index + 1], `Race Seller ${index + 1}`)
    const results = await Promise.allSettled([sell(org.owner, home.projectId, round.pricesCents[0]), sell(org.closingDeskTwo, home.projectId, round.pricesCents[1])])
    await fx.postToBooks(kit, org)
    const fulfilled = results.filter((result) => result.status === "fulfilled").map((result) => result.value)
    const refused = results.filter((result) => result.status === "rejected").map((result) => result.reason.message)
    const sales = kit.rows(`select id, price_cents::bigint price, cost_cents::bigint cost, journal_entry_id from public.books_intercompany_sales where org_id=${q(org.orgId)} and lot_id=${q(home.lot.id)}`)
    const entries = kit.rows(`select id, status from public.journal_entries where org_id=${q(org.orgId)} and source_type='inventory_start' and source_id=${q(home.lot.id)}`)
    const land = await trialBalance(kit, org, org.land), builder = await trialBalance(kit, org, org.builderEntity)
    const positions = JSON.parse(kit.rows(`select public.books_intercompany_positions(${q(org.orgId)}, ${q(AS_OF)})::text p`)[0].p)
    const side = (entity) => positions.filter((row) => row.entityId === entity).reduce((sum, row) => ({ dueFrom: sum.dueFrom + Number(row.dueFromCents), dueTo: sum.dueTo + Number(row.dueToCents) }), { dueFrom: 0, dueTo: 0 })
    const landSide = side(org.land), builderSide = side(org.builderEntity)
    const events = Number(kit.rows(`select count(*) n from public.events where org_id=${q(org.orgId)} and event_type='books.intercompany_lot_sold' and entity_id=${q(home.projectId)}`)[0].n)
    rounds.push({
      sessionsThatSold: fulfilled.length,
      refusal: refused.map((message) => /already sold to its home on different terms/.test(message) ? "refused: already sold on different terms" : message),
      sameSaleReturned: fulfilled.length < 2 || fulfilled[0].saleId === fulfilled[1].saleId,
      saleRows: sales.length, ledgerEntries: entries.length, entriesPosted: entries.every((row) => row.status === "posted"),
      priceIsOneOfTheOffers: sales.length === 1 && round.pricesCents.includes(Number(sales[0].price)),
      costIsTheLandBasis: sales.length === 1 && Number(sales[0].cost) === org.landCentsPerLot,
      landCompanyBalanced: land.balanced, builderBalanced: builder.balanced,
      companiesAgreeWhatIsOwed: builderSide.dueTo === landSide.dueFrom && builderSide.dueFrom === landSide.dueTo,
    })
    saleEvents.push(events)
  }
  equal(check, "two sessions selling one lot between companies leave one sale and one balanced ledger entry; a conflicting second offer is refused, an identical one returns the same sale", expected.expected, rounds)
  return { orgId: org.orgId, saleEvents }
}

// ---------------------------------------------------------------------------
// EP10-08: period close with production home controls, reopen and correction.

const CLOSE_EVIDENCE = `${seed.EVIDENCE}/period-close`

async function productionHomeControlsBlockCloseAndReopenKeepsEvidence(kit, expected, check) {
  const { equal } = lot()
  const input = expected.inputs
  const home = require("./home-01.cjs").helpers
  const { createAdjustingJournal } = app("books/bookkeeping"), { reverseBooksJournalEntry } = app("books/ledger"), periodClose = app("books/period-close"), q = kit.q
  const org = await home.builder(kit, "LOT-01 production period close", [{ name: "Lot 1 — Aspen plan", priceCents: input.priceCents }, { name: "Lot 2 — Birch plan", priceCents: input.priceCents }])
  const [sold, neighbour] = org.homes
  const june = org.periods["2026-06"].periodId
  for (const [house, start] of [[sold, "2026-06-03"], [neighbour, "2026-06-04"]]) {
    await home.landAndStart(kit, org, house, { date: "2026-06-02", startDate: start, cents: input.landCents })
    await home.bill(kit, org, house.projectId, "2026-06-10", input.constructionCents)
  }
  await home.deposit(kit, org, sold, { date: "2026-06-05", cents: input.depositCents })
  await home.deposit(kit, org, neighbour, { date: "2026-06-06", cents: input.neighbourDepositCents })
  await kit.as(org.owner, () => app("books/warranty-accounting").setWarrantyReserveEstimate({ projectId: sold.projectId, date: "2026-06-20", amountCents: input.warrantyReserveCents, evidenceUrl: `${CLOSE_EVIDENCE}/warranty` }))
  await kit.as(org.owner, () => app("books/inventory").completeProjectInventory({ projectId: sold.projectId, date: "2026-06-20", evidenceUrl: `${CLOSE_EVIDENCE}/completion` }))
  await home.settle(kit, org, sold, "2026-06-25")
  // Checks received but not yet deposited are explained to the close, as the books desk does.
  const { getClearingSupportWorkspace, reviewClearingSupport } = app("books/clearing-support")
  const workspace = await kit.as(org.owner, () => getClearingSupportWorkspace(june))
  await kit.as(org.owner, () => reviewClearingSupport({ periodId: june, ledgerDigest: workspace.ledgerDigest, items: [{ code: "1010", amountCents: kit.postedNet(org.orgId)["1010"], expectedSettlementDate: "2026-07-03", explanation: "June checks deposited on 3 July", evidenceUrl: `${CLOSE_EVIDENCE}/deposit-slip.pdf` }] }))
  const blocking = () => kit.as(org.owner, () => periodClose.runBooksCloseChecklist(june)).then((result) => result.blockingFailures.map((item) => item.code).sort())
  const cents = input.unreconciledCents
  const two = (debit, credit, extra = {}) => [{ accountCode: debit, debitCents: cents, creditCents: 0, ...extra }, { accountCode: credit, debitCents: 0, creditCents: cents }]
  const adjust = (memo, lines) => kit.as(org.reviewer, () => createAdjustingJournal({ entryDate: "2026-06-26", memo, lines })).then((receipt) => receipt.id)
  // Reserve use is only ever posted from an approved warranty visit, so an unsupported use is written to the ledger directly.
  const reserveUse = (reverse) => {
    const account = (code) => kit.rows(`select id from public.gl_accounts where org_id=${q(org.orgId)} and code=${q(code)}`)[0].id
    const line = (no, code, debit, credit) => `jsonb_build_object('line_no',${no},'account_id',${q(account(code))},'project_id',${no === 1 ? q(sold.projectId) : "null"},'debit_cents',${debit},'credit_cents',${credit},'dimensions','{}'::jsonb)`
    return kit.sql(`select public.post_books_journal_entry(${q(org.orgId)}, jsonb_build_object('entry_date','2026-06-26','entry_kind','adjusting','memo','Unsupported warranty reserve use','posting_key',${q(`sales-break:${randomUUID()}`)},
      'projection_version',1,'policy_version',(select active_policy_version from public.books_settings where org_id=${q(org.orgId)}),'source_type','warranty_reserve_consumption','source_id',${q(randomUUID())},'created_by',${q(org.owner.userId)}),
      jsonb_build_array(${line(1, "2260", reverse ? 0 : cents, reverse ? cents : 0)}, ${line(2, "5050", reverse ? cents : 0, reverse ? 0 : cents)}));`).trim()
  }
  const reverseJournal = (entryId) => kit.as(org.reviewer, () => reverseBooksJournalEntry({ entryId, reversalDate: "2026-06-30", reason: "Corrected: posted without the supporting register" }))
  const BREAKERS = {
    land_inventory_control: async () => ({ cure: reverseJournal, entryId: await adjust("Unreconciled land inventory for the close check", two("1120", "3010")) }),
    completed_homes_control: async () => ({ cure: reverseJournal, entryId: await adjust("Unreconciled completed home for the close check", two("1170", "3010", { projectId: neighbour.projectId })) }),
    warranty_reserve_control: async () => ({ cure: () => { reserveUse(true) }, entryId: reserveUse(false) }),
    customer_deposits_control: async () => ({ cure: reverseJournal, entryId: await adjust("Unreconciled customer deposits for the close check", two("3010", "2300", { projectId: neighbour.projectId })) }),
    retainage_receivable_control: async () => ({ cure: reverseJournal, entryId: await adjust("Unreconciled retainage for the close check", two("1110", "3010")) }),
  }
  const clean = await blocking()
  const entriesBefore = () => Number(kit.rows(`select count(*) n from public.journal_entries where org_id=${q(org.orgId)}`)[0].n)
  const broken = {}
  for (const [code, breakIt] of Object.entries(BREAKERS)) {
    const { entryId, cure } = await breakIt()
    const before = entriesBefore()
    const blocked = await blocking()
    const attempt = code === "completed_homes_control" ? await refusal(() => kit.as(org.owner, () => periodClose.closeAccountingPeriod(june))) : null
    const afterAttempt = { status: kit.rows(`select status from public.accounting_periods where id=${q(june)}`)[0].status, entriesChanged: entriesBefore() !== before }
    await cure(entryId)
    broken[code] = { blocks: blocked, cured: await blocking(), ...(attempt === null ? {} : { closeAttempt: /^Close blocked: /.test(attempt) ? "refused: close blocked" : attempt, afterAttempt }) }
  }

  await kit.as(org.owner, () => periodClose.closeAccountingPeriod(june))
  const closed = kit.rows(`select status, close_digest, close_snapshot_ids, closed_by from public.accounting_periods where id=${q(june)}`)[0]
  const snapshot = (id, type) => kit.rows(`select id, content_hash, content from public.financial_statement_snapshots where id=any(${q(`{${id.join(",")}}`)}::uuid[]) and statement_type=${q(type)}`)[0]
  const firstBalanceSheet = snapshot(closed.close_snapshot_ids, "balance_sheet")
  const reasonTooShort = await refusal(() => kit.as(org.owner, () => periodClose.reopenAccountingPeriod({ periodId: june, reason: "late" })))
  const accountantReopen = await refusal(() => kit.as(org.reviewer, () => periodClose.reopenAccountingPeriod({ periodId: june, reason: "Accountant attempting a reopen without the permission" })))
  await kit.as(org.owner, () => periodClose.reopenAccountingPeriod({ periodId: june, reason: input.reopenReason }))
  const reopened = kit.rows(`select status, reopen_reason, reopened_by from public.accounting_periods where id=${q(june)}`)[0]
  await home.bill(kit, org, neighbour.projectId, "2026-06-28", input.correctionCents, "Late grading on the neighbour's lot")
  await kit.as(org.owner, () => periodClose.closeAccountingPeriod(june))
  const reclosed = kit.rows(`select status, close_digest, close_snapshot_ids from public.accounting_periods where id=${q(june)}`)[0]
  const secondBalanceSheet = snapshot(reclosed.close_snapshot_ids, "balance_sheet")
  const oldStillThere = kit.rows(`select content_hash from public.financial_statement_snapshots where id=${q(firstBalanceSheet.id)}`)[0]
  const versions = Number(kit.rows(`select count(*) n from public.financial_statement_snapshots where org_id=${q(org.orgId)} and period_id=${q(june)} and statement_type='balance_sheet' and legal_entity_id is null`)[0].n)
  const events = kit.rows(`select event_type, payload from public.events where org_id=${q(org.orgId)} and entity_id=${q(june)} and event_type in ('books.period_closed','books.period_reopened') order by created_at, id`)
  const inventoryOf = (sheet) => Number(((typeof sheet.content === "string" ? JSON.parse(sheet.content) : sheet.content).rows.find((row) => row.code === "1160") ?? { balanceCents: 0 }).balanceCents)
  equal(check, "an unreconciled land, completed-home, warranty, deposit or retainage control blocks the close without changing the books, each cures cleanly, and a reopen and correction keep both closes on record", expected.expected, {
    cleanBlocking: clean,
    broken,
    closed: { status: closed.status, digest: Boolean(closed.close_digest) },
    reopen: { shortReason: /substantive reopen reason/.test(reasonTooShort) ? "refused: a substantive reason" : reasonTooShort, accountantRefused: /Missing permission: books\.reopen/.test(accountantReopen) ? "refused: books.reopen" : accountantReopen,
      status: reopened.status, reason: reopened.reopen_reason, byTheOwner: reopened.reopened_by === org.owner.userId },
    recloseDiffersFromTheFirst: reclosed.close_digest !== closed.close_digest && JSON.stringify(reclosed.close_snapshot_ids) !== JSON.stringify(closed.close_snapshot_ids),
    firstCloseKept: { stillOnRecord: oldStillThere.content_hash === firstBalanceSheet.content_hash, balanceSheetVersions: versions, homeInventoryAtFirstClose: inventoryOf(firstBalanceSheet), homeInventoryAtReclose: inventoryOf(secondBalanceSheet) },
    events: events.map((row) => row.event_type),
    reopenEventCitesTheFirstClose: events.find((row) => row.event_type === "books.period_reopened")?.payload?.prior_digest === closed.close_digest,
  })
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// EP11-02: coverage is a frozen snapshot of the program at enrollment.

// Calendar months, clamped to the last day of a shorter month: the policy, written independently of the product.
function monthsAfter(dateText, months) {
  const [year, month, day] = dateText.split("-").map(Number)
  const index = year * 12 + (month - 1) + months
  const targetYear = Math.floor(index / 12), targetMonth = index % 12
  const last = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`
}
const dayBefore = (dateText) => new Date(Date.parse(`${dateText}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)

async function warrantyCoverageIsFrozenAtCalendarBoundaries(kit, expected, check) {
  const { equal } = lot()
  const input = expected.inputs
  const { org } = await lot().stage(kit, "land")
  const warranty = app("warranty-operations"), q = kit.q
  const today = seed.isoDay(0)
  const manage = (work) => kit.as(org.team.warranty, work)
  const terms = (coverage) => Object.fromEntries(coverage.terms.map((term) => [term.key, { months: term.duration_months, expiresOn: term.expires_on }]))
  const homeFor = async (name) => (await fx.reservedBuyer(kit, org, { name, depositCents: 100000, receivedOn: null })).projectId
  const request = (projectId, termKey) => kit.as(org.owner, () => warranty.createWarrantyRequest({ input: { project_id: projectId, title: `Warranty claim on ${termKey ?? "no term"}`, coverage_term_key: termKey } }))
  const defaultTerms = { workmanship: 12, systems: 24, structural: 120 }
  const expectedTerms = (effective, durations = defaultTerms) => Object.fromEntries(Object.entries(durations).map(([key, months]) => [key, { months, expiresOn: monthsAfter(effective, months) }]))

  // Leap day: one year on lands on the 28th of the shorter month, and ten years on again.
  const leap = await homeFor("Leap Day Buyer")
  const leapCoverage = await manage(() => warranty.enrollProjectWarrantyCoverage({ projectId: leap, effectiveDate: input.leapDay }))
  // Expiry day is inclusive; the day after is not.
  const lastDayEffective = monthsAfter(today, -12), dayAfterEffective = dayBefore(lastDayEffective)
  const onTheLastDay = await homeFor("Last Day Buyer"), pastTheLastDay = await homeFor("Just Expired Buyer")
  await manage(() => warranty.enrollProjectWarrantyCoverage({ projectId: onTheLastDay, effectiveDate: lastDayEffective }))
  await manage(() => warranty.enrollProjectWarrantyCoverage({ projectId: pastTheLastDay, effectiveDate: dayAfterEffective }))
  const claims = {
    lastDay: (await request(onTheLastDay, "workmanship")).coverage_status,
    dayAfter: (await request(pastTheLastDay, "workmanship")).coverage_status,
    dayAfterSystems: (await request(pastTheLastDay, "systems")).coverage_status,
    dayAfterStructural: (await request(pastTheLastDay, "structural")).coverage_status,
    noTerm: (await request(pastTheLastDay, null)).coverage_status,
    unknownTerm: (await request(pastTheLastDay, "roof")).coverage_status,
  }
  const frozenBefore = { leap: terms(await manage(() => warranty.getProjectWarrantyCoverage(leap))), lastDay: terms(await manage(() => warranty.getProjectWarrantyCoverage(onTheLastDay))), dayAfter: terms(await manage(() => warranty.getProjectWarrantyCoverage(pastTheLastDay))) }
  const expiredFlags = Object.fromEntries((await manage(() => warranty.getProjectWarrantyCoverage(pastTheLastDay))).terms.map((term) => [term.key, term.expired]))

  // The program changes afterwards: shorter workmanship, a new term, structural removed.
  const programs = await kit.as(org.team.warranty, () => warranty.listWarrantyPrograms())
  const standard = programs.find((program) => program.is_default)
  const enrolledBefore = standard.enrolled_count
  await kit.as(org.team.warranty, () => warranty.upsertWarrantyProgram({ id: standard.id, name: standard.name, description: standard.description, is_default: true, is_active: true,
    terms: [{ key: "workmanship", label: "Workmanship & materials", duration_months: input.changedProgram.workmanshipMonths, is_structural: false }, { key: "appliances", label: "Appliances", duration_months: input.changedProgram.appliancesMonths, is_structural: false }] }))
  const frozenAfter = { leap: terms(await manage(() => warranty.getProjectWarrantyCoverage(leap))), lastDay: terms(await manage(() => warranty.getProjectWarrantyCoverage(onTheLastDay))), dayAfter: terms(await manage(() => warranty.getProjectWarrantyCoverage(pastTheLastDay))) }
  const afterChange = {
    lastDayStillCovered: (await request(onTheLastDay, "workmanship")).coverage_status,
    expiredStillExpired: (await request(pastTheLastDay, "workmanship")).coverage_status,
    removedTermStillCovered: (await request(pastTheLastDay, "structural")).coverage_status,
  }
  // A home enrolled after the change carries the new terms (month-end 31 January lands on the last day of February).
  const later = await homeFor("Later Buyer")
  const laterCoverage = await manage(() => warranty.enrollProjectWarrantyCoverage({ projectId: later, effectiveDate: input.monthEnd }))
  const duplicate = await refusal(() => manage(() => warranty.enrollProjectWarrantyCoverage({ projectId: later, effectiveDate: input.monthEnd })))
  const undated = await homeFor("Undated Buyer"), purchasingHome = await homeFor("Purchasing Buyer")
  const impossibleDate = await refusal(() => manage(() => warranty.enrollProjectWarrantyCoverage({ projectId: undated, effectiveDate: "2026-02-30" })))
  const noDate = await refusal(() => manage(() => warranty.enrollProjectWarrantyCoverage({ projectId: undated })))
  const wrongRole = await refusal(() => kit.as(org.team.purchasing, () => warranty.enrollProjectWarrantyCoverage({ projectId: purchasingHome, effectiveDate: today })))

  // A home that closed is covered from its closing date.
  const closedDate = seed.isoDay(0)
  const table = await fx.homeAtTheTable(kit, org, { name: "Closed Buyer", depositCents: 100000, date: closedDate })
  await fx.settleCall(kit, org.owner, table.closingId, closedDate, "WIRE-WARRANTY").catch((error) => { if (!STATEMENT_ONLY.test(error.message)) throw error })
  await fx.postToBooks(kit, org)
  const closedCoverage = await manage(() => warranty.getProjectWarrantyCoverage(table.projectId))
  const closedRow = kit.rows(`select effective_source, effective_date::text date from public.project_warranty_coverage where project_id=${q(table.projectId)}`)[0]
  equal(check, "coverage dates follow the calendar with the last day inclusive, an expired term classifies out of warranty, and a later program change touches no existing coverage", expected.expected, {
    leapDay: { effective: leapCoverage.effective_date, terms: terms(leapCoverage), matches: JSON.stringify(terms(leapCoverage)) === JSON.stringify(expectedTerms(input.leapDay)) },
    expiryInclusive: { lastDay: claims.lastDay, dayAfter: claims.dayAfter, systemsStillRunning: claims.dayAfterSystems, structuralStillRunning: claims.dayAfterStructural, noTerm: claims.noTerm, unknownTerm: claims.unknownTerm },
    expiredFlags,
    snapshotsAtEnrollment: { leapMatchesCalendar: JSON.stringify(frozenBefore.leap) === JSON.stringify(expectedTerms(input.leapDay)), lastDayMatchesCalendar: JSON.stringify(frozenBefore.lastDay) === JSON.stringify(expectedTerms(lastDayEffective)), dayAfterMatchesCalendar: JSON.stringify(frozenBefore.dayAfter) === JSON.stringify(expectedTerms(dayAfterEffective)) },
    programChange: { enrolledHomesBefore: enrolledBefore >= 3, existingCoverageUnchanged: JSON.stringify(frozenAfter) === JSON.stringify(frozenBefore), claimsAfter: afterChange },
    newEnrollmentUsesNewTerms: { terms: terms(laterCoverage), matches: JSON.stringify(terms(laterCoverage)) === JSON.stringify(expectedTerms(input.monthEnd, { workmanship: input.changedProgram.workmanshipMonths, appliances: input.changedProgram.appliancesMonths })) },
    refused: { duplicate: /already has warranty coverage/.test(duplicate) ? "refused: already covered" : duplicate, impossibleDate: /Invalid calendar date/.test(impossibleDate) ? "refused: invalid calendar date" : impossibleDate,
      noDateBeforeClosing: /effective date is required/.test(noDate) ? "refused: effective date required" : noDate, purchasingManager: /Missing permission: warranty\.manage/.test(wrongRole) ? "refused: warranty.manage" : wrongRole },
    closedHome: { source: closedRow.effective_source, startsOnTheClosingDate: closedRow.date === closedDate, matches: JSON.stringify(terms(closedCoverage)) === JSON.stringify(expectedTerms(closedDate, { workmanship: input.changedProgram.workmanshipMonths, appliances: input.changedProgram.appliancesMonths })) },
  })
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// EP05-09 #1 (policy): voiding a signed agreement unwinds the sale and refunds the buyer.

async function voidingASignedAgreementUnwindsTheSale(kit, expected, check) {
  const { equal } = lot()
  const input = expected.inputs
  const { org } = await lot().stage(kit, "land")
  const sales = app("community-sales"), q = kit.q
  const buyer = await fx.reservedBuyer(kit, org, { name: "Rhea Kapoor", depositCents: input.depositCents })
  const sale = await fx.agreementFor(kit, org, buyer)
  // The owner reviews what cancelling will do, then confirms that reviewed plan.
  const plan = await kit.as(org.owner, () => sales.previewAgreementCancellation(sale.contractId))
  const voided = await refusal(() => kit.as(org.owner, () => sales.voidPurchaseAgreement({ contractId: sale.contractId, reason: "Buyer financing was declined", depositDisposition: "refund", expectedPlanHash: plan.hash })))
  await fx.postToBooks(kit, org)
  const reversals = kit.rows(`select r.amount_cents::bigint cents from public.payment_reversals r join public.payments p on p.id=r.payment_id where p.invoice_id=${q(buyer.reservation.depositInvoiceId)} and r.status='succeeded'`)
  equal(check, "voiding a signed agreement with a refund voids it, releases the reservation, re-opens the lead, cancels the closing and refunds the buyer's own deposit", expected.expected, {
    voided: voided === "allowed" ? "voided" : voided,
    contract: kit.rows(`select status from public.contracts where id=${q(sale.contractId)}`)[0].status,
    reservation: kit.rows(`select status from public.lot_reservations where id=${q(buyer.reservation.id)}`)[0].status,
    lead: kit.rows(`select status from public.prospects where id=${q(buyer.prospect.id)}`)[0].status,
    closings: kit.rows(`select status from public.closings where project_id=${q(sale.projectId)}`).map((row) => row.status),
    refundsCents: reversals.map((row) => Number(row.cents)),
    depositsHeldCents: -lot().houseNet(kit, org, sale.projectId, "2300"),
  })
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// EP11-02 (actor): the warranty desk opens a claim on a sold home and sees its coverage.

async function warrantyDeskOpensAClaimOnASoldHome(kit, expected, check) {
  const { equal } = lot()
  const { org } = await lot().stage(kit, "land")
  const warranty = app("warranty-operations")
  const buyer = await fx.reservedBuyer(kit, org, { name: "Claim Buyer", depositCents: 100000, receivedOn: null })
  await kit.as(org.team.warranty, () => warranty.enrollProjectWarrantyCoverage({ projectId: buyer.projectId, effectiveDate: seed.isoDay(-30) }))
  const programTerms = (await kit.as(org.team.warranty, () => warranty.listWarrantyPrograms())).find((program) => program.is_default).terms.length
  const coverage = await kit.as(org.team.warranty, async () => (await warranty.getProjectWarrantyCoverage(buyer.projectId)).terms.length === programTerms).catch((error) => error.message)
  const claim = await kit.as(org.team.warranty, () => warranty.createWarrantyRequest({ input: { project_id: buyer.projectId, title: "Door will not latch", coverage_term_key: "workmanship" } })).then((row) => row.coverage_status, (error) => error.message)
  equal(check, "the warranty manager can read a home's coverage and open a claim on it, which is classified against that coverage", expected.expected, { coverageTerms: coverage, claim })
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// EP04-06 multi_session: one lot, one owner. Holds, conversions, home attaches, expiry,
// releases and cancellation race on the same lot from independent database sessions
// (sessions.cjs: separate psql backends released by a barrier) or as two API requests.

// Each racing statement keeps its locks a moment before committing, so the other session
// runs against it in flight rather than merely after it.
const inFlight = (statement) => `set role service_role;\nbegin;\n${statement};\nselect pg_sleep(0.3);\ncommit;`
const firstLine = (session) => session.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? ""
const ALLOCATION_REFUSALS = [
  [/already has a live reservation|lot_reservations_live_lot_uniq/, "refused: lot already held"],
  [/live hold or reservation for another buyer/, "refused: held for another buyer"],
  [/home belongs to another buyer/, "refused: home belongs to another buyer"],
  // The loser of two conversions may first fail the signing check on the home the winner just built.
  [/Live sellable hold is required|source changed|ancestry changed|Home belongs to another sale|Inspect the existing deposit|Agreement signing home/, "refused: hold no longer live"],
  [/Cancelled reservation review cannot be committed/, "refused: review cancelled"],
  [/Live reservation not found/, "refused: nothing live to release"],
]
const refusedAs = (message) => label(message, ALLOCATION_REFUSALS)

function buyerContact(kit, org, name) {
  const contactId = randomUUID()
  kit.sql(`insert into public.contacts(id, org_id, full_name, email) values(${kit.q(contactId)}, ${kit.q(org.orgId)}, ${kit.q(name)}, ${kit.q(`${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}.${fx.tag()}@acceptance.example.test`)})`)
  return contactId
}
const holdSql = (kit, org, lotId, buyerId) => `insert into public.lot_reservations(org_id, community_id, lot_id, buyer_contact_id, status, expires_at, created_by) values(${kit.q(org.orgId)}, ${kit.q(org.communityId)}, ${kit.q(lotId)}, ${kit.q(buyerId)}, 'hold', now() + interval '14 days', ${kit.q(org.team.sales.userId)})`
const attachSql = (kit, lotId, homeId) => `update public.lots set project_id = ${kit.q(homeId)}, status = 'started' where id = ${kit.q(lotId)}`
// The saved request is private to the RPC, so it is read before the race and
// passed in as the server passes it: the racing session runs as service_role.
const commitSql = (kit, org, actor, reservationId, key, action = "commit") => {
  const request = kit.rows(`select request::text as request from public.reservation_conversion_requests where id = ${kit.q(key)}`)[0]?.request ?? null
  return `select public.reservation_conversion(${kit.q(org.orgId)}, ${kit.q(actor.userId)}, ${kit.q(reservationId)}, ${kit.q(action)}, ${kit.q(key)}, ${request === null ? "null" : `${kit.q(request)}::jsonb`}, null)->>'status'`
}
const releaseSql = (kit, org, reservationId) => `select public.release_lot_reservation(${kit.q(org.orgId)}, ${kit.q(org.team.sales.userId)}, ${kit.q(reservationId)}, 'Buyer went quiet', null)->'after'->>'status'`
const sweepSql = (kit, reservationId) => `update public.lot_reservations set status = 'expired', released_at = now(), release_reason = 'Hold expired' where id = ${kit.q(reservationId)} and status = 'hold' and expires_at < now()`

/** A held lot for a fresh buyer, with the consultant's saved review ready to commit. */
async function heldWithReview(kit, org, name, { depositCents = 500000, reviewers = [org.team.sales] } = {}) {
  const sales = app("community-sales")
  const home = await fx.newLot(kit, org)
  const buyerId = buyerContact(kit, org, name)
  const hold = await kit.as(org.team.sales, () => sales.createLotHold({ lotId: home.id, buyerContactId: buyerId, expiresAt: future(24 * 14) }))
  const keys = []
  for (const actor of reviewers) {
    const requestKey = randomUUID()
    await kit.as(actor, () => sales.registerReservationConversion({ scope: { orgId: org.orgId, actorId: actor.userId, reservationId: hold.id }, requestKey, input: { reservationId: hold.id, depositCents } }))
    keys.push(requestKey)
  }
  return { lot: home, buyerId, hold, keys }
}

/** Who owns the lot now: its live holds and reservations, and its home's buyer. */
function lotOwnership(kit, org, lotId) {
  const q = kit.q
  const row = kit.rows(`select l.project_id, p.client_id,
      (select coalesce(json_agg(distinct r.buyer_contact_id), '[]') from public.lot_reservations r where r.org_id = l.org_id and r.lot_id = l.id
        and r.status in ('hold', 'reserved', 'converted') and (r.status <> 'hold' or r.expires_at is null or r.expires_at > now())) live_buyers,
      (select count(*)::int from public.invoices i where i.org_id = l.org_id and i.metadata->>'invoice_kind' = 'earnest_deposit'
        and i.metadata->>'source_reservation_id' in (select r.id::text from public.lot_reservations r where r.lot_id = l.id)) deposit_invoices,
      (select count(*)::int from public.reservation_conversion_receipts c join public.lot_reservations r on r.id = c.reservation_id where r.lot_id = l.id) homes_built
    from public.lots l left join public.projects p on p.id = l.project_id where l.org_id = ${q(org.orgId)} and l.id = ${q(lotId)}`)[0]
  const owners = new Set([...row.live_buyers, ...(row.client_id ? [row.client_id] : [])])
  return { owners: owners.size, liveReservations: row.live_buyers.length, hasHome: Boolean(row.project_id), homeBuyer: row.client_id, homesBuilt: row.homes_built, depositInvoices: row.deposit_invoices }
}

async function raceTwoHoldsOnOneLot(kit, expected, check) {
  const { equal } = lot()
  const { org } = await lot().stage(kit, "land")
  const sales = app("community-sales")
  const rounds = []
  for (let round = 1; round <= expected.inputs.rounds; round += 1) {
    const service = await fx.newLot(kit, org)
    const buyers = [buyerContact(kit, org, `Hold Alma ${round}`), buyerContact(kit, org, `Hold Bao ${round}`)]
    const requests = await Promise.allSettled(buyers.map((buyerContactId) => kit.as(org.team.sales, () => sales.createLotHold({ lotId: service.id, buyerContactId, expiresAt: future(48) }))))
    const database = await fx.newLot(kit, org)
    const sessions = await race(kit, buyers.map((buyerId) => inFlight(holdSql(kit, org, database.id, buyerId))))
    const occupancy = (lotId) => {
      const { owners, liveReservations, hasHome } = lotOwnership(kit, org, lotId)
      return { owners, liveReservations, hasHome }
    }
    rounds.push({
      viaService: { held: requests.filter((r) => r.status === "fulfilled").length, refused: requests.filter((r) => r.status === "rejected").map((r) => refusedAs(r.reason.message)), ...occupancy(service.id) },
      atDatabase: { held: sessions.filter((s) => s.ok).length, refused: sessions.filter((s) => !s.ok).map((s) => refusedAs(s.stderr)), ...occupancy(database.id) },
    })
  }
  equal(check, "two holds on one lot, as two requests and as two database sessions: one holds, the other is refused, and the lot has one owner", expected.expected, { rounds })
  return { orgId: org.orgId }
}

async function raceTwoConversionsOfOneHold(kit, expected, check) {
  const { equal } = lot()
  const { org } = await lot().stage(kit, "land")
  const rounds = []
  for (let round = 1; round <= expected.inputs.rounds; round += 1) {
    const sale = await heldWithReview(kit, org, `Twice Reserved ${round}`, { reviewers: [org.team.sales, org.owner] })
    const actors = [org.team.sales, org.owner]
    const sessions = await race(kit, actors.map((actor, index) => inFlight(commitSql(kit, org, actor, sale.hold.id, sale.keys[index]))))
    const ownership = lotOwnership(kit, org, sale.lot.id)
    rounds.push({
      committed: sessions.filter((s) => s.ok && firstLine(s) === "committed").length,
      refused: sessions.filter((s) => !s.ok).map((s) => refusedAs(s.stderr)),
      reservation: kit.rows(`select status from public.lot_reservations where id=${kit.q(sale.hold.id)}`)[0].status,
      homeIsTheBuyers: ownership.homeBuyer === sale.buyerId,
      owners: ownership.owners, homesBuilt: ownership.homesBuilt, depositInvoices: ownership.depositInvoices,
    })
  }
  equal(check, "two sessions committing two reviews of one hold: one reservation, one home and one deposit invoice; the other is refused", expected.expected, { rounds })
  return { orgId: org.orgId }
}

async function raceConversionAgainstAnotherBuyersHome(kit, expected, check) {
  const { equal } = lot()
  const { org } = await lot().stage(kit, "land")
  const rounds = []
  for (let round = 1; round <= expected.inputs.rounds; round += 1) {
    const sale = await heldWithReview(kit, org, `Holding Buyer ${round}`)
    const otherBuyer = buyerContact(kit, org, `Other Buyer ${round}`)
    const otherHome = await kit.as(org.owner, () => app("projects").createProject({ input: { name: `Other home ${round}`, property_type: "production", status: "planning", client_id: otherBuyer } }))
    const [conversion, attach] = await race(kit, [inFlight(commitSql(kit, org, org.team.sales, sale.hold.id, sale.keys[0])), inFlight(attachSql(kit, sale.lot.id, otherHome.id))])
    const ownership = lotOwnership(kit, org, sale.lot.id)
    rounds.push({
      conversion: conversion.ok ? firstLine(conversion) : refusedAs(conversion.stderr),
      attach: attach.ok ? "attached" : refusedAs(attach.stderr),
      homeIsTheHoldingBuyers: ownership.homeBuyer === sale.buyerId,
      otherHomeOnNoLot: Number(kit.rows(`select count(*)::int n from public.lots where project_id=${kit.q(otherHome.id)}`)[0].n) === 0,
      owners: ownership.owners, homesBuilt: ownership.homesBuilt, depositInvoices: ownership.depositInvoices,
    })
  }
  equal(check, "a conversion and another buyer's home attach racing on one held lot: the conversion stands with one home and one deposit invoice, and the other home is refused", expected.expected, { rounds })
  return { orgId: org.orgId }
}

async function raceHoldAgainstHomeAttach(kit, expected, check) {
  const { equal } = lot()
  const { org } = await lot().stage(kit, "land")
  const rounds = []
  for (let round = 1; round <= expected.inputs.rounds; round += 1) {
    const home = await fx.newLot(kit, org)
    const holder = buyerContact(kit, org, `Walk-in ${round}`)
    const otherBuyer = buyerContact(kit, org, `Contract Buyer ${round}`)
    const otherHome = await kit.as(org.owner, () => app("projects").createProject({ input: { name: `Contract home ${round}`, property_type: "production", status: "planning", client_id: otherBuyer } }))
    const sessions = await race(kit, [inFlight(holdSql(kit, org, home.id, holder)), inFlight(attachSql(kit, home.id, otherHome.id))])
    const ownership = lotOwnership(kit, org, home.id)
    const [held, attached] = sessions.map((s) => s.ok)
    rounds.push({
      winners: sessions.filter((s) => s.ok).length,
      loserRefusedCleanly: sessions.filter((s) => !s.ok).every((s) => ["refused: held for another buyer", "refused: home belongs to another buyer"].includes(refusedAs(s.stderr))),
      finalStateIsTheWinners: held ? ownership.liveReservations === 1 && !ownership.hasHome : attached && ownership.liveReservations === 0 && ownership.homeBuyer === otherBuyer,
      owners: ownership.owners,
    })
  }
  equal(check, "a hold and another buyer's home attach racing on one lot: exactly one stands, the other is refused, and the lot has one owner", expected.expected, { rounds })
  return { orgId: org.orgId }
}

async function raceExpiryConversionAndRelease(kit, expected, check) {
  const { equal } = lot()
  const { org } = await lot().stage(kit, "land")
  const rounds = []
  for (let round = 1; round <= expected.inputs.rounds; round += 1) {
    const sale = await heldWithReview(kit, org, `Lapsed Buyer ${round}`)
    kit.sql(`update public.lot_reservations set expires_at = now() - interval '1 minute' where id=${kit.q(sale.hold.id)}`)
    const nextBuyer = buyerContact(kit, org, `Next Buyer ${round}`)
    const [sweep, conversion, release, nextHold] = await race(kit, [
      inFlight(sweepSql(kit, sale.hold.id)),
      inFlight(commitSql(kit, org, org.team.sales, sale.hold.id, sale.keys[0])),
      inFlight(releaseSql(kit, org, sale.hold.id)),
      inFlight(holdSql(kit, org, sale.lot.id, nextBuyer)),
    ])
    const lapsed = kit.rows(`select status from public.lot_reservations where id=${kit.q(sale.hold.id)}`)[0].status
    const ownership = lotOwnership(kit, org, sale.lot.id)
    rounds.push({
      sweep: sweep.ok ? "ran" : refusedAs(sweep.stderr),
      conversion: conversion.ok ? firstLine(conversion) : refusedAs(conversion.stderr),
      releaseEndedItOrFoundNothing: release.ok || refusedAs(release.stderr) === "refused: nothing live to release",
      nextHold: nextHold.ok ? "held" : refusedAs(nextHold.stderr),
      lapsedHoldEndedOnce: release.ok ? lapsed === "released" : lapsed === "expired",
      liveReservations: ownership.liveReservations, owners: ownership.owners, hasHome: ownership.hasHome,
      homesBuilt: ownership.homesBuilt, depositInvoices: ownership.depositInvoices,
    })
  }
  equal(check, "a lapsed hold raced by the sweep, its conversion, its release and another buyer's hold: it is never converted, it ends once, and the next buyer owns the lot", expected.expected, { rounds })
  return { orgId: org.orgId }
}

async function raceTwoReleasesRefundOnce(kit, expected, check) {
  const { equal } = lot()
  const { org } = await lot().stage(kit, "land")
  const sales = app("community-sales"), q = kit.q
  org.closingDeskTwo ??= kit.addMember(org, "org_owner")
  const rounds = []
  for (let round = 1; round <= expected.inputs.rounds; round += 1) {
    const depositCents = expected.inputs.depositCents + round * 1000
    const buyer = await fx.reservedBuyer(kit, org, { name: `Withdrawn Buyer ${round}`, depositCents, receivedOn: "2026-06-06" })
    const release = (actor) => kit.as(actor, () => sales.releaseReservation({ reservationId: buyer.reservation.id, reason: "Buyer financing was declined", depositDisposition: "refund" }))
    const results = await Promise.allSettled([release(org.owner), release(org.closingDeskTwo)])
    const refunds = kit.rows(`select r.amount_cents::bigint cents from public.payment_reversals r join public.payments p on p.id = r.payment_id
      where r.org_id=${q(org.orgId)} and p.invoice_id=${q(buyer.reservation.depositInvoiceId)} and r.reversal_type = 'refund' and r.status = 'succeeded'`)
    const ownership = lotOwnership(kit, org, buyer.lot.id)
    rounds.push({
      released: results.filter((r) => r.status === "fulfilled").length,
      refused: results.filter((r) => r.status === "rejected").map((r) => refusedAs(r.reason.message)),
      refundsCents: refunds.map((row) => Number(row.cents)),
      reservation: kit.rows(`select status from public.lot_reservations where id=${q(buyer.reservation.id)}`)[0].status,
      releasedEvents: Number(kit.rows(`select count(*)::int n from public.events where org_id=${q(org.orgId)} and event_type='lot_reservation_released' and entity_id=${q(buyer.reservation.id)}`)[0].n),
      homeBackInInventory: ownership.hasHome && ownership.homeBuyer === null,
      owners: ownership.owners, depositInvoices: ownership.depositInvoices,
    })
  }
  equal(check, "two members releasing one reserved buyer with a refund: one release, one refund of the buyer's deposit, and the home returns to inventory with no owner", expected.expected, { rounds })
  return { orgId: org.orgId }
}

async function raceConversionCancelAgainstCommit(kit, expected, check) {
  const { equal } = lot()
  const { org } = await lot().stage(kit, "land")
  const rounds = []
  for (let round = 1; round <= expected.inputs.rounds; round += 1) {
    const sale = await heldWithReview(kit, org, `Undecided Buyer ${round}`)
    const [commit, cancel] = await race(kit, [
      inFlight(commitSql(kit, org, org.team.sales, sale.hold.id, sale.keys[0])),
      inFlight(commitSql(kit, org, org.team.sales, sale.hold.id, sale.keys[0], "cancel")),
    ])
    const request = kit.rows(`select status from public.reservation_conversion_requests where id=${kit.q(sale.keys[0])}`)[0].status
    const reservation = kit.rows(`select status from public.lot_reservations where id=${kit.q(sale.hold.id)}`)[0].status
    const ownership = lotOwnership(kit, org, sale.lot.id)
    const committed = request === "committed"
    rounds.push({
      oneOutcome: committed
        ? commit.ok && firstLine(commit) === "committed" && cancel.ok && firstLine(cancel) === "committed"
        : request === "cancelled" && cancel.ok && refusedAs(commit.stderr) === "refused: review cancelled",
      reservationMatches: reservation === (committed ? "reserved" : "hold"),
      homesMatch: ownership.homesBuilt === (committed ? 1 : 0) && ownership.hasHome === committed,
      depositInvoicesMatch: ownership.depositInvoices === (committed ? 1 : 0),
      owners: ownership.owners,
    })
  }
  equal(check, "cancelling a saved review while it is committed: either it commits with one home and one deposit invoice, or it is cancelled with neither, never both", expected.expected, { rounds })
  return { orgId: org.orgId }
}

const subcases = {

  "buyer-lifecycle-is-one-traceable-chain": buyerLifecycleIsOneTraceableChain,
  "invalid-and-expired-reservations-cannot-produce-agreements": invalidAndExpiredReservationsCannotProduceAgreements,
  "settlement-arithmetic-foots-in-integer-cents": settlementArithmeticFootsInIntegerCents,
  "approved-change-order-counts-once-in-the-final-price": approvedChangeOrderCountsOnceInTheFinalPrice,
  "closing-refuses-an-invoice-that-differs-from-the-authorized-price": closingRefusesAnInvoiceThatDiffersFromTheAuthorizedPrice,
  "deposits-and-refunds-reconcile-to-their-own-buyer": depositsAndRefundsReconcileToTheirOwnBuyer,
  "interrupted-settlement-resumes-without-duplicates": interruptedSettlementResumesWithoutDuplicates,
  "race-concurrent-settlement": raceConcurrentSettlement,
  "production-community-entity-reconciles-by-entity-and-org": productionCommunityEntityReconcilesByEntityAndOrg,
  "race-intercompany-lot-sale": raceIntercompanyLotSale,
  "production-home-controls-block-close-and-reopen-keeps-evidence": productionHomeControlsBlockCloseAndReopenKeepsEvidence,
  "warranty-coverage-is-frozen-at-calendar-boundaries": warrantyCoverageIsFrozenAtCalendarBoundaries,
  "voiding-a-signed-agreement-unwinds-the-sale": voidingASignedAgreementUnwindsTheSale,
  "warranty-desk-opens-a-claim-on-a-sold-home": warrantyDeskOpensAClaimOnASoldHome,
  "race-two-holds-on-one-lot": raceTwoHoldsOnOneLot,
  "race-two-conversions-of-one-hold": raceTwoConversionsOfOneHold,
  "race-conversion-against-another-buyers-home": raceConversionAgainstAnotherBuyersHome,
  "race-hold-against-home-attach": raceHoldAgainstHomeAttach,
  "race-expiry-conversion-and-release": raceExpiryConversionAndRelease,
  "race-two-releases-refund-once": raceTwoReleasesRefundOnce,
  "race-conversion-cancel-against-commit": raceConversionCancelAgainstCommit,
}
module.exports = { subcases }
