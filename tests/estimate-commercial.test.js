"use strict"

/**
 * `lib/financials/estimate-commercial.ts` — the commercial terms of a client
 * document: which purpose it serves, what it must state before it can be
 * issued, how its fee and markup add up, and which terms print on it. The
 * accepted-option math it relies on (`estimate-totals`), the line validation
 * (`validation/estimates`) and the contracted cost scope it hands to the job
 * (`contracted-estimate`) are exercised here at the seams they share with it.
 */

require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const { test } = require("node:test")

const commercial = require("@/lib/financials/estimate-commercial")
const { resolveAcceptedOptions } = require("@/lib/financials/estimate-totals")
const { resolveContractedEstimateItems } = require("@/lib/financials/contracted-estimate")
const { estimateInputSchema } = require("@/lib/validation/estimates")

const { DEFAULT_ESTIMATE_COMMERCIAL } = commercial

test("a legacy document is an agreement and keeps its own terms", () => {
  assert.equal(commercial.normalizeEstimateCommercial({}).purpose, "construction_agreement")
  assert.equal(commercial.estimateDocumentTerms({ terms: "Original terms" }), "Original terms")
})

test("an agreement cannot issue without its basis, payment terms and the fee its billing model needs; a budget can", () => {
  const value = { ...DEFAULT_ESTIMATE_COMMERCIAL, billing_model: "cost_plus_fixed_fee", maturity: "conceptual" }
  assert.equal(commercial.estimateCommercialIssues(value).length, 4)
  assert.deepEqual(commercial.estimateCommercialIssues({ ...value, purpose: "budget" }), [])
})

test("a GMP agreement must fit under its maximum and state an allowance policy when it carries allowances", () => {
  const value = {
    ...DEFAULT_ESTIMATE_COMMERCIAL,
    pricing_basis: "Issued drawings revision 4",
    payment_terms: "Monthly progress",
    billing_model: "cost_plus_gmp",
    gmp_cents: 100000,
  }
  assert.equal(commercial.estimateCommercialIssues(value, { totalCents: 110000, hasAllowances: true }).length, 2)
  assert.deepEqual(
    commercial.estimateCommercialIssues(
      { ...value, allowance_policy: "Materials only; unused amounts credited" },
      { totalCents: 99000, hasAllowances: true },
    ),
    [],
  )
})

test("a fixed builder fee is added once and line markup is never stacked on it", () => {
  const value = { ...DEFAULT_ESTIMATE_COMMERCIAL, billing_model: "cost_plus_fixed_fee", fixed_fee_cents: 20000 }
  const lines = [
    { quantity: 1, unit_cost_cents: 100000, markup_pct: 25 },
    { quantity: 1, unit_cost_cents: 10000, markup_pct: 25, is_optional: true },
  ]
  assert.deepEqual(commercial.calculateCommercialEstimateTotals(lines, 10, 0, value), {
    subtotal: 120000,
    contingency: 0,
    tax: 12000,
    total: 132000,
  })
  const normalized = commercial.normalizeCommercialEstimateLines(lines, value)
  assert.deepEqual(normalized.map((line) => line.markup_pct), [0, 0])
  assert.equal(lines[0].markup_pct, 25, "the caller's lines are not mutated")
})

test("an accepted replacement credit lowers the signed value without double-counting the base", () => {
  const items = [
    {
      id: "replace",
      quantity: 1,
      unit_cost_cents: -10000,
      markup_pct: 10,
      metadata: { is_optional: true, alternate_kind: "replacement", replacement_scope: "Base countertop" },
    },
  ]
  assert.equal(resolveAcceptedOptions(items, 110000, ["replace"], 0).accepted_total_cents, 99000)
  assert.match(commercial.estimateLineNotes(items[0].metadata), /net change/)
})

test("a negative line must be an optional deduct or a replacement that names what it replaces", () => {
  const input = { title: "Test", lines: [{ description: "Credit", unit_cost_cents: -100, quantity: 1 }] }
  assert.equal(estimateInputSchema.safeParse(input).success, false)
  input.lines[0].is_optional = true
  input.lines[0].metadata = { alternate_kind: "replacement" }
  assert.equal(estimateInputSchema.safeParse(input).success, false)
  input.lines[0].metadata.replacement_scope = "Base cabinetry"
  assert.equal(estimateInputSchema.safeParse(input).success, true)
})

test("credits accepted on the budget carry into the agreement's price and the job's cost scope", () => {
  for (const alternate_kind of ["deduct", "replacement"]) {
    const budgetLines = [
      { id: "base", description: "Base cabinetry", quantity: 1, unit_cost_cents: 100000, markup_pct: 10, is_optional: false, metadata: {} },
      {
        id: "credit",
        description: "Cabinet scope credit",
        quantity: 1,
        unit_cost_cents: -10000,
        markup_pct: 10,
        is_optional: true,
        metadata: { is_optional: true, alternate_kind, replacement_scope: "Base cabinetry" },
      },
      { id: "unaccepted", description: "Appliance upgrade", quantity: 1, unit_cost_cents: 50000, markup_pct: 10, is_optional: true, metadata: { is_optional: true } },
    ]

    const agreementLines = commercial.carryAcceptedBudgetScope(budgetLines, ["credit"])
    assert.deepEqual(agreementLines.map((line) => line.id), ["base", "credit"], alternate_kind)
    assert.equal(agreementLines[1].is_optional, false, "an accepted credit is no longer optional")

    const parsed = estimateInputSchema.parse({ title: "Construction agreement", lines: agreementLines })
    assert.equal(commercial.calculateCommercialEstimateTotals(parsed.lines).total, 99000)

    const persisted = parsed.lines.map((line, n) => ({
      ...line,
      id: `agreement-${n}`,
      metadata: { ...line.metadata, is_optional: line.is_optional },
    }))
    const costs = resolveContractedEstimateItems(persisted, {
      source_budget: { estimate_id: "budget", version: 2 },
      accepted_options: { ids: [] },
    })
    assert.deepEqual(costs.map((item) => item.cost_cents), [100000, -10000])
    assert.throws(() => resolveContractedEstimateItems(persisted, { accepted_options: { ids: [] } }), /accepted deduct/)
  }
})

test("a budget prints nonbinding terms, never the org's construction defaults", () => {
  const budget = { precon: { purpose: "budget" }, terms: null }
  const terms = commercial.estimateDocumentTerms(budget, "Binding construction agreement. Deposit due.")
  assert.match(terms, /Nonbinding/)
  assert.doesNotMatch(terms, /Deposit due/)
  assert.match(
    commercial.estimateDocumentTerms({ ...budget, terms: "Owner-authored planning qualification" }, "Contract default"),
    /Owner-authored planning qualification/,
  )
  assert.match(
    commercial.estimateDocumentTerms({ precon: { purpose: "construction_agreement" } }, "Agreement default"),
    /Agreement default/,
  )
})

test("a preconstruction services agreement says it does not authorize construction", () => {
  assert.match(
    commercial.estimateDocumentTerms({ precon: { purpose: "preconstruction_agreement" } }),
    /does not authorize construction/,
  )
})
