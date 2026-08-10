require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  assessGrounding,
  extractCitedSourceIndexes,
  stripCitationMarkers,
} = require("../lib/services/ai-assistant/grounding")

test("cited indexes are read in first-appearance order, deduped", () => {
  assert.deepEqual(extractCitedSourceIndexes("Per [S2] and [S1], also [S2].", 4), [2, 1])
})

test("multiple ids inside one bracket are all read", () => {
  assert.deepEqual(extractCitedSourceIndexes("Both [S1, S3] agree.", 4), [1, 3])
  assert.deepEqual(extractCitedSourceIndexes("Both [S1,S3] agree.", 4), [1, 3])
})

test("out-of-range ids are dropped", () => {
  // A model citing [S9] against four sources is describing something it was
  // never shown; surfacing that as provenance is the bug this prevents.
  assert.deepEqual(extractCitedSourceIndexes("See [S9] and [S2].", 4), [2])
  assert.deepEqual(extractCitedSourceIndexes("See [S0].", 4), [])
})

test("an answer with no markers cites nothing", () => {
  assert.deepEqual(extractCitedSourceIndexes("The budget looks fine.", 5), [])
})

test("markers are stripped cleanly for display", () => {
  assert.equal(stripCitationMarkers("Ridgeline is over budget [S1]."), "Ridgeline is over budget.")
  assert.equal(stripCitationMarkers("Two subs [S1, S2] are unpaid."), "Two subs are unpaid.")
  assert.equal(stripCitationMarkers("No markers here."), "No markers here.")
})

test("a numeric claim with no citation and no tool evidence is flagged", () => {
  const result = assessGrounding({
    answer: "You are $42,500 over budget.",
    sourceCount: 3,
    hasToolEvidence: false,
  })
  assert.equal(result.hasUngroundedNumericClaim, true)
  assert.deepEqual(result.citedIndexes, [])
})

test("the same claim is grounded once it cites a source", () => {
  const result = assessGrounding({
    answer: "You are $42,500 over budget [S2].",
    sourceCount: 3,
    hasToolEvidence: false,
  })
  assert.equal(result.hasUngroundedNumericClaim, false)
  assert.deepEqual(result.citedIndexes, [2])
  assert.equal(result.displayAnswer, "You are $42,500 over budget.")
})

test("tool output counts as evidence on its own", () => {
  // A figure from finance_metric is grounded even with no [S#] marker, because
  // the tool result IS the source.
  assert.equal(
    assessGrounding({
      answer: "Committed cost is $1,204,000.",
      sourceCount: 0,
      hasToolEvidence: true,
    }).hasUngroundedNumericClaim,
    false,
  )
})

test("prose without figures is not flagged as ungrounded", () => {
  assert.equal(
    assessGrounding({
      answer: "I could not find a matching commitment.",
      sourceCount: 2,
      hasToolEvidence: false,
    }).hasUngroundedNumericClaim,
    false,
  )
})

test("a bare small integer is not treated as a financial claim", () => {
  // "3 open RFIs" should not demand a citation the way "$42,500" does.
  assert.equal(
    assessGrounding({ answer: "There are 3 open RFIs.", sourceCount: 2, hasToolEvidence: false })
      .hasUngroundedNumericClaim,
    false,
  )
})
