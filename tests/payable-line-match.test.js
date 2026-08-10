require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  applyCommitmentLineBudgets,
  buildLineMatchRollup,
  lineMatchFingerprint,
  matchInvoiceLinesDeterministic,
  readLineMatchAssessment,
} = require("../lib/financials/payable-line-match")

function commitmentLine(overrides = {}) {
  return {
    id: overrides.id ?? "line-1",
    lineNumber: overrides.lineNumber ?? 1,
    description: overrides.description ?? "Framing labor",
    quantity: overrides.quantity ?? null,
    unit: overrides.unit ?? null,
    unitCostCents: overrides.unitCostCents ?? null,
    scheduledValueCents: overrides.scheduledValueCents ?? 500_000,
    previouslyMatchedCents: overrides.previouslyMatchedCents ?? 0,
  }
}

function invoiceLine(overrides = {}) {
  return {
    description: overrides.description ?? "Framing labor",
    quantity: overrides.quantity ?? null,
    unit: overrides.unit ?? null,
    unitPriceCents: overrides.unitPriceCents ?? null,
    amountCents: overrides.amountCents ?? 100_000,
  }
}

test("a clearly worded line matches its commitment line without an arbiter", () => {
  const decisions = matchInvoiceLinesDeterministic(
    [invoiceLine({ description: "Framing labor", amountCents: 200_000 })],
    [
      commitmentLine({ id: "framing", lineNumber: 1, description: "Framing labor", scheduledValueCents: 400_000 }),
      commitmentLine({ id: "roofing", lineNumber: 2, description: "Roofing shingles", scheduledValueCents: 300_000 }),
    ],
  )

  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].candidates, null, "an unambiguous line must not be sent to the arbiter")
  assert.equal(decisions[0].resolution.commitmentLineId, "framing")
  assert.equal(decisions[0].resolution.source, "deterministic")
})

test("a line with no plausible commitment line is unmatched, never guessed", () => {
  const decisions = matchInvoiceLinesDeterministic(
    [invoiceLine({ description: "Portable toilet rental" })],
    [commitmentLine({ id: "framing", description: "Framing labor" })],
  )

  assert.equal(decisions[0].resolution.matchKind, "unmatched")
  assert.equal(decisions[0].resolution.commitmentLineId, null)
})

test("a commitment with no lines cannot match anything", () => {
  const decisions = matchInvoiceLinesDeterministic([invoiceLine()], [])
  assert.equal(decisions[0].resolution.matchKind, "unmatched")
  assert.match(decisions[0].resolution.note, /no lines/i)
})

test("billing past a commitment line's remaining value is flagged with the arithmetic", () => {
  const line = commitmentLine({ id: "framing", scheduledValueCents: 300_000, previouslyMatchedCents: 250_000 })
  const [matched] = applyCommitmentLineBudgets(
    [
      {
        invoiceLine: invoiceLine({ amountCents: 100_000 }),
        commitmentLineId: "framing",
        commitmentLineNumber: 1,
        commitmentLineLabel: "Framing labor",
        matchKind: "exact",
        source: "deterministic",
        note: null,
        overCommitmentLine: false,
        commitmentLineRemainingCents: null,
      },
    ],
    [line],
  )

  assert.equal(matched.overCommitmentLine, true)
  assert.equal(matched.commitmentLineRemainingCents, 50_000)
  assert.match(matched.note, /50/, "the note must state the remaining value the reader can check")
})

test("several invoice lines landing on one commitment line consume it cumulatively", () => {
  const line = commitmentLine({ id: "framing", scheduledValueCents: 100_000 })
  const base = {
    commitmentLineId: "framing",
    commitmentLineNumber: 1,
    commitmentLineLabel: "Framing labor",
    matchKind: "exact",
    source: "deterministic",
    note: null,
    overCommitmentLine: false,
    commitmentLineRemainingCents: null,
  }
  const results = applyCommitmentLineBudgets(
    [
      { ...base, invoiceLine: invoiceLine({ amountCents: 60_000 }) },
      { ...base, invoiceLine: invoiceLine({ amountCents: 60_000 }) },
    ],
    [line],
  )

  assert.equal(results[0].overCommitmentLine, false, "the first draw still fits")
  assert.equal(results[1].overCommitmentLine, true, "the second draw exceeds what the first left")
  assert.equal(results[1].commitmentLineRemainingCents, 40_000)
})

test("a commitment line carrying no value is not treated as an overrun", () => {
  const [matched] = applyCommitmentLineBudgets(
    [
      {
        invoiceLine: invoiceLine({ amountCents: 100_000 }),
        commitmentLineId: "framing",
        commitmentLineNumber: 1,
        commitmentLineLabel: "Framing labor",
        matchKind: "exact",
        source: "deterministic",
        note: null,
        overCommitmentLine: false,
        commitmentLineRemainingCents: null,
      },
    ],
    [commitmentLine({ id: "framing", scheduledValueCents: 0 })],
  )

  assert.equal(matched.overCommitmentLine, false)
})

test("the rollup counts this bill against the commitment plus approved change orders", () => {
  const rollup = buildLineMatchRollup({
    lines: [
      {
        invoiceLine: invoiceLine({ amountCents: 100_000 }),
        commitmentLineId: null,
        commitmentLineNumber: null,
        commitmentLineLabel: null,
        matchKind: "unmatched",
        source: "deterministic",
        note: null,
        overCommitmentLine: false,
        commitmentLineRemainingCents: null,
      },
    ],
    billTotalCents: 100_000,
    billedToDateCents: 900_000,
    commitmentTotalCents: 900_000,
    approvedChangeOrdersCents: 50_000,
  })

  assert.equal(rollup.revisedCommitmentCents, 950_000)
  assert.equal(rollup.projectedTotalCents, 1_000_000)
  assert.equal(rollup.overCommitmentCents, 50_000)
  assert.equal(rollup.unmatchedCount, 1)
})

test("a commitment with no value never reports an overrun", () => {
  const rollup = buildLineMatchRollup({
    lines: [],
    billTotalCents: 100_000,
    billedToDateCents: 0,
    commitmentTotalCents: 0,
    approvedChangeOrdersCents: 0,
  })

  assert.equal(rollup.overCommitmentCents, 0)
})

test("the fingerprint changes when any input the match depends on changes", () => {
  const base = {
    commitmentId: "c1",
    billTotalCents: 100_000,
    billedToDateCents: 0,
    commitmentTotalCents: 500_000,
    approvedChangeOrdersCents: 0,
    invoiceLines: [invoiceLine()],
    commitmentLines: [commitmentLine()],
  }
  const first = lineMatchFingerprint(base)

  assert.equal(first, lineMatchFingerprint(base), "the same inputs must not re-run the match")
  assert.notEqual(first, lineMatchFingerprint({ ...base, billTotalCents: 100_001 }))
  assert.notEqual(first, lineMatchFingerprint({ ...base, approvedChangeOrdersCents: 1 }))
  assert.notEqual(
    first,
    lineMatchFingerprint({ ...base, commitmentLines: [commitmentLine({ previouslyMatchedCents: 1 })] }),
    "another bill drawing on the line changes what remains, so the match must recompute",
  )
})

test("a malformed stored assessment reads as absent rather than as evidence", () => {
  assert.equal(readLineMatchAssessment(null), null)
  assert.equal(readLineMatchAssessment({}), null)
  assert.equal(readLineMatchAssessment({ line_match: { version: 2, fingerprint: "x", commitmentId: "c" } }), null)
  assert.equal(readLineMatchAssessment({ line_match: { version: 1, fingerprint: "x" } }), null)
})
