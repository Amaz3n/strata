// SALE-01 subcases for EP05-06 commission controls. Composed by sale-01.cjs; every case builds its
// own HOME-01 org, so nothing here depends on another case's state.
//   terms (proposer)  : org.reviewer, granted sales.commission_manage as a member override, and the
//                       consultant payee paid through payroll
//   terms (approver)  : org.owner
// Expected values (expected/SALE-01.json, under each subcase's `expected`) are the observed objects
// below; the amounts follow from the inputs: 2.5% of the authorized price (price + signed change
// order), never of the seller credit.
const { randomUUID } = require("node:crypto")
const { app } = require("./shared.cjs")

const home = () => require("./home-01.cjs").helpers
const lot = () => require("./lot-01.cjs").helpers
const packet = () => require("./sale-01-packet.cjs").helpers
const equal = (check, label, expected, observed) => lot().equal(check, label, expected, observed)
const refuse = (kit, actor, work) => lot().refusal(() => kit.as(actor, work))

const PRICE_CENTS = 45000000
const CHANGE_ORDER_CENTS = 1250000
const SELLER_CREDIT_CENTS = -400000
const CONSULTANT_FLAT_CENTS = 250000

/** A home under an executed agreement, with a brokerage on file and the proposer able to set terms. */
async function sale(kit, name) {
  const q = kit.q
  const org = await home().builder(kit, name, [{ name: "Lot 1 — Aspen plan", priceCents: PRICE_CENTS }])
  const [house] = org.homes
  const brokerageId = randomUUID()
  kit.sql(`insert into public.companies(id,org_id,name) values(${q(brokerageId)},${q(org.orgId)},'Gulf Realty');
insert into public.membership_permission_overrides(membership_id,permission_key,effect)
  select id,'sales.commission_manage','grant' from public.memberships where org_id=${q(org.orgId)} and user_id=${q(org.reviewer.userId)}
  on conflict do nothing;`)
  return { org, house, brokerageId }
}

function terms(brokerageId, consultantId) {
  return {
    coopBroker: "broker",
    lines: [
      { kind: "coop_broker", payeeCompanyId: brokerageId, agentName: "Dana Agent", basis: "percent_of_authorized_price", rateBps: 250, flatCents: null },
      { kind: "sales_consultant", payeeUserId: consultantId, payoutChannel: "payroll", payeeCompanyId: null, basis: "flat", rateBps: null, flatCents: CONSULTANT_FLAT_CENTS },
    ],
  }
}

/** Proposed by the consultant, approved by the owner; returns the plan id. */
async function approvedTerms(kit, org, house, brokerageId) {
  const commissions = app("sales-commissions")
  const proposed = await kit.as(org.reviewer, () => commissions.proposeCommissionPlan({ contractId: house.contractId, plan: terms(brokerageId, org.reviewer.userId) }))
  await kit.as(org.owner, () => commissions.approveCommissionPlan({ planId: proposed.plan.id }))
  return proposed.plan.id
}

/**
 * A change order the buyer signs (the agreement's version 2, so it is in the
 * authorized price) and a seller credit, so the basis and the final price differ.
 */
async function amendAndCredit(kit, org, house) {
  const lanai = await packet().changeOrder(kit, org, house.projectId, "Extended lanai", CHANGE_ORDER_CENTS)
  await packet().buyerSigns(kit, org, house.projectId, lanai.id, `${house.name} buyer`)
  return { kind: "seller_credit", label: "Seller credit", amountCents: SELLER_CREDIT_CENTS }
}

/** Amended, credited and settled through the closing desk; scheduling and the gates are HOME-01's `settle`. */
async function settleWithCredit(kit, org, house, date) {
  const closings = app("closings"), q = kit.q
  const credit = await amendAndCredit(kit, org, house)
  const closingId = randomUUID()
  kit.sql(`insert into public.closings(id,org_id,project_id,lot_id,community_id,status,buyer_contact_id,created_by) values(${q(closingId)},${q(org.orgId)},${q(house.projectId)},${q(house.lotId)},${q(org.communityId)},'projected',${q(house.buyerId)},${q(org.owner.userId)})`)
  await kit.as(org.owner, () => closings.upsertClosingAdjustment({ closingId, ...credit }))
  await home().settle(kit, org, house, date, closingId)
  return closingId
}

// The bill number carries the closing's tag, so it is checked by its shape, not its value.
const obligations = (kit, closingId) => kit.rows(`select o.line_no, o.payout_channel, o.amount_cents::bigint amount, o.basis_price_cents::bigint basis, o.status,
  b.status bill_status, b.bill_number from public.sales_commission_obligations o left join public.vendor_bills b on b.id=o.vendor_bill_id
  where o.closing_id=${kit.q(closingId)} and o.adjusts_obligation_id is null order by o.line_no`)
  .map((row) => ({ line: row.line_no, channel: row.payout_channel, amountCents: Number(row.amount), basisCents: Number(row.basis), status: row.status,
    billStatus: row.bill_status, commissionBill: /^COMM-/.test(row.bill_number ?? "") }))

// EP05-06 criterion 0: commissions derive from terms approved by a second person who is not a payee.
async function termsApprovedWithTheAgreement(kit, expected, check) {
  const { org, house, brokerageId } = await sale(kit, "SALE-01 commission terms")
  const commissions = app("sales-commissions")
  const proposed = await kit.as(org.reviewer, () => commissions.proposeCommissionPlan({ contractId: house.contractId, plan: terms(brokerageId, org.reviewer.userId) }))
  const selfApproval = await refuse(kit, org.reviewer, () => commissions.approveCommissionPlan({ planId: proposed.plan.id }))
  const holdBefore = (await kit.as(org.owner, () => commissions.getAgreementCommissionPlan(house.contractId))).signingRefusal
  const approved = await kit.as(org.owner, () => commissions.approveCommissionPlan({ planId: proposed.plan.id }))
  const holdAfter = (await kit.as(org.owner, () => commissions.getAgreementCommissionPlan(house.contractId))).signingRefusal
  const directEdit = kit.rows(`select count(*)::int n from public.sales_commission_plan_lines where plan_id=${kit.q(proposed.plan.id)}`)[0].n
  equal(check, "commission terms are approved by a second person and then hold nothing", expected.expected, {
    proposedStatus: proposed.plan.status,
    estimateTotalCents: proposed.estimateTotalCents,
    selfApproval,
    heldBeforeApproval: holdBefore !== null,
    approvedStatus: approved.plan.status,
    holdAfterApproval: holdAfter,
    lines: directEdit,
  })
  return { orgId: org.orgId }
}

// EP05-06 criterion 1: settlement creates the payables exactly once, on the authorized price.
async function settlementCreatesPayablesOnce(kit, expected, check) {
  const { org, house, brokerageId } = await sale(kit, "SALE-01 commission settlement")
  await approvedTerms(kit, org, house, brokerageId)
  const closingId = await settleWithCredit(kit, org, house, "2026-06-25")
  const closings = app("closings")
  await kit.as(org.owner, () => closings.recoverClosingCompletion(house.projectId, closingId)).catch(() => {})
  await Promise.all([1, 2].map(() => kit.as(org.owner, () => closings.recoverClosingCompletion(house.projectId, closingId)).catch(() => {})))
  await kit.drainOutbox(org.orgId)
  const net = kit.postedNet(org.orgId)
  const jobCost = kit.rows(`select count(*)::int n from public.job_cost_entries j join public.bill_lines l on l.id::text=j.source_id::text
    join public.vendor_bills b on b.id=l.bill_id where b.metadata ? 'sales_commission_obligation_id' and j.org_id=${kit.q(org.orgId)}`)[0].n
  equal(check, "settlement owes each line once, on the agreement plus the signed change order", expected.expected, {
    obligations: obligations(kit, closingId),
    agreementVersions: kit.rows(`select array_agg(kind order by version_number) kinds from public.purchase_agreement_versions where contract_id=${kit.q(house.contractId)}`)[0].kinds,
    bills: kit.rows(`select count(*)::int n from public.vendor_bills where metadata->>'closing_id'=${kit.q(closingId)}`)[0].n,
    accrued2240: -(net["2240"] ?? 0),
    commissionJobCostEntries: jobCost,
  })
  return { orgId: org.orgId, closingId }
}

// EP05-06 criterion 1: a reversal before payment clears; after payment it claws back, never paying twice.
async function reversalReconcilesWithoutDuplicatePayment(kit, expected, check) {
  const { org, house, brokerageId } = await sale(kit, "SALE-01 commission reversal")
  await approvedTerms(kit, org, house, brokerageId)
  const closingId = await settleWithCredit(kit, org, house, "2026-06-25")
  const vendorBills = app("vendor-bills"), closings = app("closings"), q = kit.q
  const brokerBill = kit.rows(`select id, total_cents::bigint total from public.vendor_bills where metadata->>'closing_id'=${q(closingId)}`)[0]
  await kit.as(org.owner, () => vendorBills.approveVendorBillsAtomic([{ id: brokerBill.id }])).catch(() => {})
  const paid = Number(brokerBill.total) - 100000
  await kit.as(org.owner, () => vendorBills.updateVendorBillStatus({ billId: brokerBill.id, input: { status: "partial", payment_amount_cents: paid, payment_method: "check", payment_reference: "CHK-2001", check_number: "2001" } }))
  await kit.as(org.owner, () => closings.reverseClosing({ closingId, reason: "Buyer financing fell through at the last minute", date: "2026-07-02" }))
  await kit.as(org.owner, () => closings.reverseClosing({ closingId, reason: "Buyer financing fell through at the last minute", date: "2026-07-02" })).catch(() => {})
  await kit.drainOutbox(org.orgId)
  const credit = kit.rows(`select total_cents::bigint total from public.vendor_bills where metadata->>'sales_commission_obligation_id' is not null and total_cents<0 and org_id=${q(org.orgId)}`)
  const bill = kit.rows(`select status, paid_cents::bigint paid from public.vendor_bills where id=${q(brokerBill.id)}`)[0]
  equal(check, "a reversed closing closes the unpaid commission and leaves what was paid open to recover", expected.expected, {
    obligations: obligations(kit, closingId).map((row) => ({ line: row.line, status: row.status })),
    credits: credit.map((row) => Number(row.total)),
    brokerBill: { status: bill.status, paidCents: Number(bill.paid) },
    cashPaidCents: paid,
    payrollClawbacks: kit.rows(`select amount_cents::bigint amount from public.sales_commission_obligations where closing_id=${q(closingId)} and adjusts_obligation_id is not null`).map((row) => Number(row.amount)),
  })
  return { orgId: org.orgId, closingId }
}

const subcases = {
  "commission-terms-approved-with-the-agreement": termsApprovedWithTheAgreement,
  "settlement-creates-commission-payables-once": settlementCreatesPayablesOnce,
  "closing-reversal-reconciles-commissions-without-duplicate-payment": reversalReconcilesWithoutDuplicatePayment,
}
module.exports = { subcases }
