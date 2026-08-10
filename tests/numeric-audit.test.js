require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  extractNumericClaims,
  auditNumericClaims,
  describeUnsupportedFigures,
} = require("../lib/ai/numeric-audit")

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

test("money, percentages and large counts are all extracted", () => {
  const claims = extractNumericClaims("Open AR is $482,190 across 11 invoices, up 12% on 15000 last month.")
  assert.deepEqual(
    claims.map((claim) => [claim.text, claim.value, claim.kind]),
    [
      ["$482,190", 482190, "money"],
      ["12%", 12, "percent"],
      ["15000", 15000, "count"],
    ],
  )
})

test("small bare numbers are ignored — they are counts, not arithmetic", () => {
  const claims = extractNumericClaims("There are 3 open RFIs and 11 invoices.")
  assert.deepEqual(claims, [])
})

test("small money amounts are still checked", () => {
  const claims = extractNumericClaims("A credit of $42.75 was applied.")
  assert.equal(claims.length, 1)
  assert.equal(claims[0].value, 42.75)
  assert.equal(claims[0].kind, "money")
})

test("abbreviated magnitudes expand", () => {
  const claims = extractNumericClaims("Backlog is $2.4M, with $850k billed.")
  assert.deepEqual(
    claims.map((claim) => claim.value),
    [2_400_000, 850_000],
  )
})

test("identifiers are not numbers", () => {
  const claims = extractNumericClaims("See sheet A-101 and PO-4471 for the detail.")
  assert.deepEqual(claims, [])
})

test("decimals inside money survive the separator stripping", () => {
  const claims = extractNumericClaims("The total is $1,234,567.89.")
  assert.equal(claims[0].value, 1234567.89)
})

test("extraction is repeatable — the shared regex does not carry state", () => {
  const text = "Open AR is $482,190."
  assert.deepEqual(extractNumericClaims(text), extractNumericClaims(text))
})

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const FIGURES = [
  { value: 482190, label: "Open AR" },
  { value: 11, label: "Invoice count" },
]

test("a figure a tool returned is supported", () => {
  const audit = auditNumericClaims("Open AR is $482,190.", FIGURES)
  assert.equal(audit.unsupported.length, 0)
  assert.equal(audit.supported.length, 1)
})

test("rounding by the model is still support, not invention", () => {
  const audit = auditNumericClaims("Open AR is about $482,000.", FIGURES)
  assert.equal(audit.unsupported.length, 0)
})

test("an average the model worked out itself is flagged", () => {
  // 482190 / 11 = 43835 — arithmetic no tool performed.
  const audit = auditNumericClaims("Open AR is $482,190, roughly $43,835 per invoice.", FIGURES)
  assert.equal(audit.unsupported.length, 1)
  assert.equal(audit.unsupported[0].text, "$43,835")
})

test("a percentage nothing computed is flagged", () => {
  const audit = auditNumericClaims("Open AR is $482,190, up 12% on last month.", FIGURES)
  assert.deepEqual(
    audit.unsupported.map((claim) => claim.text),
    ["12%"],
  )
})

test("a percentage a tool did return is supported either as 12 or 0.12", () => {
  const asWhole = auditNumericClaims("Margin is 12%.", [{ value: 12, label: "Margin" }])
  assert.equal(asWhole.unsupported.length, 0)

  const asRatio = auditNumericClaims("Margin is 12%.", [{ value: 0.12, label: "Margin" }])
  assert.equal(asRatio.unsupported.length, 0)
})

test("with no figures declared nothing is flagged", () => {
  // An answer built from retrieved documents legitimately quotes their numbers.
  const audit = auditNumericClaims("The contract lists $1,250,000 for sitework.", [])
  assert.equal(audit.unsupported.length, 0)
  assert.equal(audit.supported.length, 1)
})

test("a zero figure only supports a zero claim", () => {
  const audit = auditNumericClaims("Overdue AR is $0 and open AR is $5,000.", [
    { value: 0, label: "Overdue AR" },
  ])
  assert.deepEqual(
    audit.unsupported.map((claim) => claim.text),
    ["$5,000"],
  )
})

test("an answer with no numbers audits clean", () => {
  const audit = auditNumericClaims("No invoices are overdue on this project.", FIGURES)
  assert.deepEqual(audit.claims, [])
  assert.equal(describeUnsupportedFigures(audit), null)
})

// ---------------------------------------------------------------------------
// Caveat wording
// ---------------------------------------------------------------------------

test("one unsupported figure reads in the singular", () => {
  const audit = auditNumericClaims("Open AR is $482,190, or $43,835 each.", FIGURES)
  const message = describeUnsupportedFigures(audit)
  assert.match(message, /\$43,835 was not returned by a query/)
  assert.match(message, /check it against/)
})

test("several unsupported figures read in the plural and are capped", () => {
  const audit = auditNumericClaims(
    "Totals: $11,000, $12,000, $13,000, $14,000, $15,000, $16,000.",
    FIGURES,
  )
  const message = describeUnsupportedFigures(audit)
  assert.match(message, /and 2 other figures were not returned/)
  assert.match(message, /check them against/)
})

test("a clean audit produces no caveat", () => {
  const audit = auditNumericClaims("Open AR is $482,190.", FIGURES)
  assert.equal(describeUnsupportedFigures(audit), null)
})
