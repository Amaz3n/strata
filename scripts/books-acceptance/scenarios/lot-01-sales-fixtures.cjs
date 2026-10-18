// Fixtures for the sales proof (lot-01-sales.cjs): fresh lots, buyers and homes in the
// LOT-01 organisation, built through the same services the sales desk and the closing
// desk use, so each check owns its records and never reads another check's.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app, project } = require("./shared.cjs")

const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const tag = () => randomUUID().slice(0, 6)

/** A lot of the community's own, developed and sellable, made by the land manager. */
async function newLot(kit, org, { premiumCents = 0 } = {}) {
  const number = `Q${tag()}`
  await kit.as(org.team.land, () => app("lots").createLots(org.communityId, { lots: [{
    lotNumber: number, phaseId: org.phaseIds[0], takedownId: null, status: "developed", address: `${number} Quail Way`,
    dimensions: { widthFt: 52, depthFt: 115 }, swing: "right", premiumCents, costBasisCents: 7200000 }] }))
  return kit.rows(`select id, lot_number from public.lots where org_id=${kit.q(org.orgId)} and community_id=${kit.q(org.communityId)} and lot_number=${kit.q(number)}`)[0]
}

/** A buyer who holds a lot and reserves it with an earnest deposit (received when `receivedOn` is given). */
async function reservedBuyer(kit, org, { name, depositCents, receivedOn = seed.isoDay(0), lot = null, premiumCents = 0 }) {
  const home = lot ?? await newLot(kit, org, { premiumCents })
  const slug = `${name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.+|\.+$/g, "")}.${tag()}`
  const prospect = await seed.registerBuyer(kit, org, { name, email: `${slug}@acceptance.example.test` })
  const { hold, reservation } = await seed.reserveLot(kit, org, { prospect, lotId: home.id, depositCents, receivedOn })
  // The receipt reaches the ledger before anything is applied against it, as it would in the field.
  await postToBooks(kit, org)
  const projectId = kit.rows(`select project_id from public.lots where id=${kit.q(home.id)}`)[0].project_id
  const buyerId = kit.rows(`select buyer_contact_id from public.lot_reservations where id=${kit.q(reservation.id)}`)[0].buyer_contact_id
  return { lot: home, prospect, hold, reservation, projectId, buyerId, name }
}

/** Lets the outbox and the projector post what has been recorded so far. */
async function postToBooks(kit, org) {
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
}

/** The agreement for a reserved buyer: quoted, saved, executed; options and incentives per `config`. */
async function agreementFor(kit, org, buyer, { skus = [], incentiveIds = [], plan = org.plans[0] } = {}) {
  const swing = kit.rows(`select swing from public.lots where id=${kit.q(buyer.lot.id)}`)[0].swing
  const config = seed.configuration(org, { lotId: buyer.lot.id, plan, swing: swing === "left" ? "left" : "right", skus, incentiveIds })
  return seed.signAgreement(kit, org, { reservationId: buyer.reservation.id, config })
}

/** A sold home waiting at the closing table: reserved with a received deposit, signed, cleared to close. */
async function homeAtTheTable(kit, org, { name, depositCents, date, premiumCents = 0 }) {
  const buyer = await reservedBuyer(kit, org, { name, depositCents, premiumCents })
  const sale = await agreementFor(kit, org, buyer)
  const closingId = closingOf(kit, sale.projectId)
  await clearToClose(kit, org, closingId, date)
  return { buyer, sale, closingId, projectId: sale.projectId }
}

const closingOf = (kit, projectId) => kit.rows(`select id from public.closings where project_id=${kit.q(projectId)} and status<>'cancelled'`)[0].id
const closingRow = (kit, closingId) => kit.rows(`select status, actual_date::text actual_date, closing_invoice_id, metadata->>'books_posting_status' posting, settlement from public.closings where id=${kit.q(closingId)}`)[0]

/** The closing desk's steps up to the table: scheduled, every gate waived with a reason, cleared to close. */
async function clearToClose(kit, org, closingId, date) {
  const closings = app("closings")
  await kit.as(org.owner, () => closings.scheduleClosing({ closingId, scheduledDate: date }))
  await require("../production-seed.cjs").prepareClosingGates(kit, org, closingId)
  await kit.as(org.owner, () => closings.markClearedToClose(closingId))
}

const settleCall = (kit, actor, closingId, date, reference = "WIRE-SALES") =>
  kit.as(actor, () => app("closings").settleClosing({ closingId, actualDate: date, paymentMethod: "wire", paymentReference: reference }))

/** Everything recorded for one closing: the invoice, its lines, payments, deposit applications, receipts and postings. */
function closingEvidence(kit, org, closingId) {
  const q = kit.q
  const closing = closingRow(kit, closingId)
  const invoices = kit.rows(`select id, total_cents::bigint total, status from public.invoices where org_id=${q(org.orgId)} and metadata->>'invoice_kind'='closing' and metadata->>'source_closing_id'=${q(closingId)}`)
  const invoiceId = invoices[0]?.id ?? null
  const payments = invoiceId ? kit.rows(`select id, amount_cents::bigint amount, coalesce(metadata->>'customer_deposit_application','false') application, metadata->>'deposit_payment_id' deposit_payment_id, provider_payment_id, status
    from public.payments where org_id=${q(org.orgId)} and invoice_id=${q(invoiceId)} order by created_at, id`) : []
  const lines = invoiceId ? kit.rows(`select description, round(quantity*unit_price_cents)::bigint amount from public.invoice_lines where invoice_id=${q(invoiceId)} order by sort_order, id`) : []
  const entries = invoiceId ? kit.rows(`select source_type, source_id, count(*)::int n from public.journal_entries where org_id=${q(org.orgId)} and status='posted'
    and source_id in (${[invoiceId, ...payments.map((p) => p.id)].map(q).join(",")}) group by 1,2`) : []
  return { closing, invoices, invoiceId, payments, lines, entries }
}

const glId = (kit, org, code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0]?.id ?? null

/**
 * A home adopted for owned-inventory accounting. The placeholder contract the sale
 * creates beside the agreement must carry a revenue policy first (LOT-01 D4/D16), so
 * the policy is proposed and reviewed by hand exactly as seed.releaseHome does.
 */
async function adoptInventory(kit, org, projectId, evidenceUrl) {
  const policies = app("books/revenue-policies"), inventory = app("books/inventory")
  const adopt = () => kit.as(org.owner, () => inventory.enableProjectInventory({ projectId, effectiveOn: "2026-06-01", evidenceUrl }))
  await adopt().catch(async (error) => {
    if (!/earn revenue differently|recognizes revenue at sale/.test(error.message)) throw error
    const contracts = kit.rows(`select id, contract_type from public.contracts where project_id=${kit.q(projectId)} and status='active'`)
    for (const contract of contracts) {
      const proposal = await kit.as(org.owner, () => policies.proposeRevenuePolicy({ projectId, contractId: contracts.length === 1 ? null : contract.id, method: "closing", billingMethod: contract.contract_type === "purchase_agreement" ? "purchase_agreement" : "fixed_price", effectiveFrom: "2026-06-01", rationale: "A home earns its revenue at closing; the placeholder contract carries none." }))
      await kit.as(org.reviewer, () => policies.reviewRevenuePolicy({ policyId: proposal.policyId, approve: true }))
    }
    await adopt()
  })
}

const LAND_COMPANIES = new WeakMap()
/**
 * A production builder whose community land is owned by its own legal entity: the land
 * company holds the land-inventory account and a checking account, buys the first
 * tranche with its own cash, and the lots are developed and sellable. Built once per run.
 */
function landCompany(kit) {
  if (!LAND_COMPANIES.has(kit)) LAND_COMPANIES.set(kit, buildLandCompany(kit))
  return LAND_COMPANIES.get(kit)
}
async function buildLandCompany(kit) {
  const org = await seed.productionBuilder(kit, { name: "LOT-01 community land company" })
  await seed.seedCommunity(kit, org)
  await seed.seedProduct(kit, org)
  const entities = app("books/legal-entities"), inventory = app("books/inventory"), communities = app("communities"), lots = app("lots")
  org.land = (await kit.as(org.owner, () => entities.createLegalEntity({ name: "Cypress Landing Land Co", legalName: "Cypress Landing Land Company LLC" }))).id
  org.builderEntity = kit.rows(`select id from public.books_legal_entities where org_id=${kit.q(org.orgId)} and is_primary`)[0].id
  await kit.as(org.owner, () => app("books/chart-management").createGlAccount({ code: "1005", name: "Land company checking", accountType: "asset", subtype: "cash", normalBalance: "debit" }))
  for (const code of ["1005", "1120"]) await kit.as(org.owner, () => entities.setLegalEntityOwner({ kind: "account", id: glId(kit, org, code), entityId: org.land }))
  const tranche = org.lots.slice(0, 10)
  org.landCentsPerLot = 7200000
  org.trancheLotIds = tranche.map((row) => row.id)
  await kit.as(org.owner, () => inventory.acquireLandInventory({ date: "2026-06-02", allocations: tranche.map((row) => ({ lotId: row.id, amountCents: org.landCentsPerLot })), cashAccountId: glId(kit, org, "1005"), cashCents: org.landCentsPerLot * tranche.length, debtInstrumentId: null, debtCents: 0, reference: "Cypress Landing tranche 1", evidenceUrl: `${seed.EVIDENCE}/land-company-tranche-1` }))
  await kit.as(org.team.land, () => communities.closeLotTakedown(org.takedownId, { actualDate: "2026-06-02" }))
  await kit.as(org.team.land, () => lots.bulkUpdateLots(org.communityId, { lotIds: org.trancheLotIds, patch: { status: "developed" } }))
  await project(kit, org)
  return org
}

/** A buyer on one of the land company's lots, signed, with the home adopted for owned inventory. */
async function adoptedHome(kit, org, lotRow, name, receivedOn = null) {
  const buyer = await reservedBuyer(kit, org, { name, depositCents: 500000, receivedOn, lot: lotRow })
  const sale = await agreementFor(kit, org, buyer)
  await adoptInventory(kit, org, sale.projectId, `${seed.EVIDENCE}/land-company-ownership`)
  return { buyer, sale, projectId: sale.projectId, lot: lotRow }
}

module.exports = { adoptInventory, landCompany, adoptedHome, glId, homeAtTheTable, postToBooks, refusal, tag, newLot, reservedBuyer, agreementFor, closingOf, closingRow, clearToClose, settleCall, closingEvidence }
