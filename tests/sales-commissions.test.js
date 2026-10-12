require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  commissionAmountCents,
  commissionApprovalRefusal,
  commissionBasisCents,
  commissionPlanRefusal,
  commissionUnwindPlan,
  deriveCommissionObligations,
  estimateCommissions,
} = require("../lib/financials/sales-commissions")
const { buildPurchaseAgreementSettlement } = require("../lib/financials/purchase-agreement-pricing")

const CONTRACT = "00000000-0000-4000-8000-0000000000c1"

function settlement({ agreement = 450_000_00, changeOrders = [], adjustments = [] } = {}) {
  return {
    contractId: CONTRACT,
    ...buildPurchaseAgreementSettlement({
      agreementTotalCents: agreement,
      approvedChangeOrders: changeOrders,
      adjustments,
      deposits: [],
    }),
  }
}

const broker = { id: "line-1", lineNo: 1, kind: "coop_broker", payoutChannel: "accounts_payable", basis: "percent_of_authorized_price", rateBps: 250, flatCents: null }
const consultant = { id: "line-2", lineNo: 2, kind: "sales_consultant", payoutChannel: "payroll", basis: "flat", rateBps: null, flatCents: 2_500_00 }

test("the basis is the authorized price: signed change orders count, closing-table adjustments do not", () => {
  const recorded = settlement({
    changeOrders: [{ id: "co-up", totalCents: 12_500_00 }, { id: "co-down", totalCents: -4_000_00 }],
    adjustments: [
      { id: "a", label: "Seller credit", kind: "seller_credit", amountCents: -4_000_00 },
      { id: "b", label: "Closing costs", kind: "closing_cost", amountCents: -3_000_00 },
      { id: "c", label: "Taxes", kind: "proration", amountCents: 812_45 },
    ],
  })
  assert.equal(recorded.finalPriceCents, 452_312_45)
  assert.equal(commissionBasisCents(recorded), 458_500_00)
  assert.throws(() => commissionBasisCents(settlement({ agreement: -1 })), /not a valid commission basis/)
})

test("a percentage rounds half up to the cent on integers; a flat amount ignores the price", () => {
  assert.equal(commissionAmountCents({ basis: "percent_of_authorized_price", rateBps: 275, flatCents: null }, 1_234_567_89), 3_395_062)
  assert.equal(commissionAmountCents({ basis: "percent_of_authorized_price", rateBps: 250, flatCents: null }, 20), 1)
  assert.equal(commissionAmountCents({ basis: "percent_of_authorized_price", rateBps: 250, flatCents: null }, 19), 0)
  assert.equal(commissionAmountCents(consultant, 1), 2_500_00)
  assert.throws(() => commissionAmountCents({ basis: "percent_of_authorized_price", rateBps: 1501, flatCents: null }, 100), /between/)
  assert.throws(() => commissionAmountCents({ basis: "flat", rateBps: null, flatCents: 0 }, 100), /positive/)
})

test("settlement owes one obligation per approved line, keyed by the closing", () => {
  const rows = deriveCommissionObligations({
    closingId: "closing-1",
    plan: { id: "plan-1", revision: 2 },
    lines: [consultant, broker],
    settlement: settlement({ changeOrders: [{ id: "co-up", totalCents: 12_500_00 }] }),
  })
  assert.deepEqual(rows.map((row) => [row.lineNo, row.amountCents]), [[1, 11_562_50], [2, 2_500_00]])
  assert.ok(rows.every((row) => row.basisPriceCents === 462_500_00 && row.evidence.closingId === "closing-1" && row.evidence.planRevision === 2))
  assert.deepEqual(rows[0].evidence.changeOrderIds, ["co-up"])

  const resale = deriveCommissionObligations({ closingId: "closing-2", plan: { id: "plan-1", revision: 2 }, lines: [broker], settlement: settlement() })
  assert.notDeepEqual(resale[0].evidence, rows[0].evidence, "a resale is a new closing and owes on its own evidence")
})

test("the estimate before settlement totals each line on today's price", () => {
  assert.deepEqual(estimateCommissions([broker, consultant], 400_000_00), { lines: [{ lineNo: 1, amountCents: 10_000_00 }, { lineNo: 2, amountCents: 2_500_00 }], totalCents: 12_500_00 })
})

test("a reversed closing clears an unpaid commission and credits a paid one, but never one in a payment run", () => {
  assert.deepEqual(commissionUnwindPlan({ totalCents: 10_000_00, paidCents: 0, inActiveRun: false }), { action: "clear" })
  assert.deepEqual(commissionUnwindPlan({ totalCents: 10_000_00, paidCents: 4_000_00, inActiveRun: false }),
    { action: "credit", creditCents: 10_000_00, applyToBillCents: 6_000_00, openCreditCents: 4_000_00 })
  assert.deepEqual(commissionUnwindPlan({ totalCents: 10_000_00, paidCents: 10_000_00, inActiveRun: false }),
    { action: "credit", creditCents: 10_000_00, applyToBillCents: 0, openCreditCents: 10_000_00 })
  assert.equal(commissionUnwindPlan({ totalCents: 10_000_00, paidCents: 0, inActiveRun: true }).action, "refuse")
})

test("commission terms are approved by a second person who is not a payee", () => {
  const base = { actorUserId: "manager", proposedBy: "consultant", payeeUserIds: ["consultant"], canApprove: true }
  assert.equal(commissionApprovalRefusal(base), null)
  assert.match(commissionApprovalRefusal({ ...base, actorUserId: "consultant", payeeUserIds: [] }), /proposed/)
  assert.match(commissionApprovalRefusal({ ...base, payeeUserIds: ["manager"] }), /payee/)
  assert.match(commissionApprovalRefusal({ ...base, canApprove: false }), /permission/)
  // A waiting "no commissions" replaces approved terms: taking them away is a second person's decision too.
  assert.match(commissionApprovalRefusal({ ...base, payeeUserIds: [], actorUserId: "consultant" }), /proposed/)
  assert.match(commissionApprovalRefusal({ ...base, payeeUserIds: [], canApprove: false }), /permission/)
})

test("signing and closing wait for approved terms or an explicit none", () => {
  assert.match(commissionPlanRefusal(null, "signing"), /declare none/)
  assert.match(commissionPlanRefusal({ status: "proposed" }, "closing"), /waiting for approval/)
  assert.equal(commissionPlanRefusal({ status: "approved" }, "closing"), null)
})
