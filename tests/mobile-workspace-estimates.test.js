require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { parseBudgetDraft } = require("../lib/mobile/workspace-estimates")
const { DEFAULT_ESTIMATE_COMMERCIAL } = require("../lib/financials/estimate-commercial")

const COST_CODE = "00000000-0000-4000-8000-000000000001"
const BID = "00000000-0000-4000-8000-000000000002"

const line = {
  description: "Work",
  quantity: "2",
  unit: "hour",
  unit_price: "125.25",
  markup_pct: "10",
  is_optional: "false",
  is_allowance: "false",
  notes: "Test",
}
const values = {
  title: "Budget test",
  lines: JSON.stringify([line]),
  tax_rate: "7",
  contingency_percent: "5",
  pricing_basis: "Concept drawings",
}
const rows = (...lines) => JSON.stringify(lines)
const draft = (overrides = {}) => ({ precon: { ...DEFAULT_ESTIMATE_COMMERCIAL, purpose: "budget" }, lines: [], ...overrides })

test("a new native estimate is a conceptual budget priced in cents, without client-supplied provenance", () => {
  const input = parseBudgetDraft({
    ...values,
    precon: { purpose: "construction_agreement" },
    lines: rows({ ...line, cost_code_id: "injected", metadata: JSON.stringify({ takeoff: "injected" }) }),
  })

  assert.equal(input.precon.purpose, "budget")
  assert.equal(input.precon.maturity, "conceptual")
  assert.equal(input.lines[0].unit_cost_cents, 12525)
  assert.equal(input.lines[0].cost_code_id, undefined)
  assert.equal(input.lines[0].metadata, undefined)
})

test("revising a budget keeps the server's cost coding, bid and takeoff provenance and presentation", () => {
  const previous = draft({
    precon: { ...DEFAULT_ESTIMATE_COMMERCIAL, purpose: "budget", billing_model: "cost_plus_percent" },
    terms: "Existing terms",
    intro: "Existing cover",
    pricing_display: "subtotals",
    photos: [{ path: "org/photo.jpg", caption: "Photo" }],
    lines: [
      {
        id: "line-a",
        cost_code_id: COST_CODE,
        item_type: "line",
        metadata: { takeoff: { condition_id: "condition-a" }, source_bid_submission_id: BID },
      },
    ],
  })

  const input = parseBudgetDraft({ ...values, lines: rows({ ...line, id: "line-a", cost_code_id: "injected" }) }, previous)

  assert.equal(input.lines[0].cost_code_id, COST_CODE)
  assert.equal(input.lines[0].source_bid_submission_id, BID)
  assert.deepEqual(input.lines[0].metadata.takeoff, { condition_id: "condition-a" })
  assert.equal(input.precon.billing_model, "cost_plus_percent")
  assert.equal(input.terms, "Existing terms")
  assert.equal(input.pricing_display, "subtotals")
  assert.equal(input.photos[0].path, "org/photo.jpg")
})

test("foreign or repeated line ids, negative or non-numeric money, bad emails and impossible dates are refused", () => {
  const previous = draft({ lines: [{ id: "line-a", item_type: "line" }] })
  const invalidLines = [
    [{ ...line, id: "foreign" }],
    [{ ...line, id: "line-a" }, { ...line, id: "line-a" }],
    [{ ...line, quantity: "-1" }],
    [{ ...line, unit_price: "NaN" }],
    [{ ...line, unit_price: "-5" }],
  ]
  for (const lines of invalidLines) {
    assert.throws(() => parseBudgetDraft({ ...values, lines: rows(...lines) }, previous), undefined, JSON.stringify(lines))
  }
  assert.throws(() => parseBudgetDraft({ ...values, recipient_email: "invalid" }))
  assert.throws(() => parseBudgetDraft({ ...values, valid_until: "2026-02-30" }))
})

test("a preconstruction agreement validates its commercial terms and cannot pose as a construction agreement", () => {
  const input = parseBudgetDraft({
    ...values,
    purpose: "preconstruction_agreement",
    billing_model: "cost_plus_fixed_fee",
    fixed_fee: "2500.50",
    payment_terms: "Due on completion",
    retainage_percent: "5",
  })

  assert.equal(input.precon.purpose, "preconstruction_agreement")
  assert.equal(input.precon.fixed_fee_cents, 250050)
  assert.equal(input.precon.payment_terms, "Due on completion")
  assert.throws(() => parseBudgetDraft({ ...values, purpose: "construction_agreement" }))
  assert.throws(() => parseBudgetDraft({ ...values, retainage_percent: "101" }))
})

test("editing a construction draft keeps its document type; a changed recipient becomes ad hoc", () => {
  const previous = draft({
    precon: {
      ...DEFAULT_ESTIMATE_COMMERCIAL,
      purpose: "construction_agreement",
      governing_documents: [{ id: COST_CODE, version_id: null, name: "Plans" }],
    },
    recipient_contact_id: BID,
    recipient_name: "Old",
    recipient_email: "old@example.com",
  })

  const input = parseBudgetDraft({ ...values, purpose: "budget", recipient_name: "New", recipient_email: "new@example.com" }, previous)

  assert.equal(input.precon.purpose, "construction_agreement")
  assert.equal(input.precon.governing_documents[0].name, "Plans")
  assert.equal(input.recipient_contact_id, null)
  assert.equal(input.recipient_email, "new@example.com")
})
