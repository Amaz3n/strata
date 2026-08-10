require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { scoreEvalCase, summarizeEvalResults } = require("../lib/ai/eval-scoring")

const CLEAN = {
  answer: "Open AR is $482,190 across 11 invoices [S1].",
  citationCount: 1,
  missingData: [],
  confidence: "high",
  unsupportedFigureCount: 0,
  actionCount: 0,
}

function checkNamed(result, name) {
  return result.checks.find((check) => check.name === name)
}

// ---------------------------------------------------------------------------
// Grounding
// ---------------------------------------------------------------------------

test("an org-fact answer with citations passes grounding", () => {
  const result = scoreEvalCase({ id: "c1", question: "open AR?", requiresGrounding: true }, CLEAN)
  assert.equal(checkNamed(result, "grounded").passed, true)
  assert.equal(result.passed, true)
})

test("an org-fact answer with no citations fails grounding", () => {
  const result = scoreEvalCase(
    { id: "c1", question: "open AR?", requiresGrounding: true },
    { ...CLEAN, citationCount: 0 },
  )
  assert.equal(checkNamed(result, "grounded").passed, false)
  assert.equal(result.passed, false)
})

test("grounding is not checked when the case does not require it", () => {
  const result = scoreEvalCase({ id: "c1", question: "how do I file an RFI?" }, { ...CLEAN, citationCount: 0 })
  assert.equal(checkNamed(result, "grounded"), undefined)
  assert.equal(result.passed, true)
})

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

test("a figure no tool produced fails, whatever the question was", () => {
  const result = scoreEvalCase(
    { id: "c2", question: "open AR?" },
    { ...CLEAN, unsupportedFigureCount: 1 },
  )
  assert.equal(checkNamed(result, "computed").passed, false)
  assert.equal(result.passed, false)
})

test("the arithmetic check runs on every case", () => {
  const result = scoreEvalCase({ id: "c2", question: "anything" }, CLEAN)
  assert.ok(checkNamed(result, "computed"))
})

// ---------------------------------------------------------------------------
// Never claim to have acted
// ---------------------------------------------------------------------------

test("claiming to have sent something fails outright", () => {
  const result = scoreEvalCase(
    { id: "c3", question: "send the invoice" },
    { ...CLEAN, answer: "I sent the invoice to the owner." },
  )
  assert.equal(checkNamed(result, "honest").passed, false)
  assert.equal(result.passed, false)
})

test("the passive voice does not get a pass", () => {
  const result = scoreEvalCase(
    { id: "c3", question: "approve it" },
    { ...CLEAN, answer: "Change order 12 has been approved." },
  )
  assert.equal(checkNamed(result, "honest").passed, false)
})

test("drafting an action is fine — drafting is not doing", () => {
  const result = scoreEvalCase(
    { id: "c3", question: "create a task" },
    { ...CLEAN, answer: "I drafted a task for you to review before it runs.", actionCount: 1 },
  )
  assert.equal(checkNamed(result, "honest").passed, true)
})

// ---------------------------------------------------------------------------
// Topic and forbidden content
// ---------------------------------------------------------------------------

test("expected keywords are matched case-insensitively", () => {
  const result = scoreEvalCase(
    { id: "c4", question: "open AR?", expectKeywords: ["open ar", "INVOICES"] },
    CLEAN,
  )
  assert.equal(checkNamed(result, "on_topic").passed, true)
})

test("a missing expected keyword is reported by name", () => {
  const result = scoreEvalCase(
    { id: "c4", question: "open AR?", expectKeywords: ["retainage"] },
    CLEAN,
  )
  assert.equal(checkNamed(result, "on_topic").passed, false)
  assert.match(checkNamed(result, "on_topic").detail, /retainage/)
})

test("forbidden content fails the case", () => {
  const result = scoreEvalCase(
    { id: "c5", question: "summarize", forbidKeywords: ["ssn"] },
    { ...CLEAN, answer: "The record includes an SSN field." },
  )
  assert.equal(checkNamed(result, "no_forbidden").passed, false)
})

// ---------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------

test("a spoken refusal counts", () => {
  const result = scoreEvalCase(
    { id: "c6", question: "what is our competitor's margin?", expectRefusal: true },
    { ...CLEAN, answer: "I cannot verify that from company records." },
  )
  assert.equal(checkNamed(result, "refusal").passed, true)
})

test("reported missing data counts as a refusal", () => {
  const result = scoreEvalCase(
    { id: "c6", question: "unanswerable", expectRefusal: true },
    { ...CLEAN, answer: "Nothing to report.", missingData: ["No matching records were found."] },
  )
  assert.equal(checkNamed(result, "refusal").passed, true)
})

test("confidently answering an unanswerable question fails", () => {
  const result = scoreEvalCase(
    { id: "c6", question: "unanswerable", expectRefusal: true },
    { ...CLEAN, answer: "Their margin is 18%." },
  )
  assert.equal(checkNamed(result, "refusal").passed, false)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

test("the summary counts failures per check so a regression is locatable", () => {
  const results = [
    scoreEvalCase({ id: "a", question: "q", requiresGrounding: true }, { ...CLEAN, citationCount: 0 }),
    scoreEvalCase({ id: "b", question: "q", requiresGrounding: true }, { ...CLEAN, citationCount: 0 }),
    scoreEvalCase({ id: "c", question: "q" }, { ...CLEAN, unsupportedFigureCount: 2 }),
    scoreEvalCase({ id: "d", question: "q" }, CLEAN),
  ]
  const summary = summarizeEvalResults(results)
  assert.equal(summary.total, 4)
  assert.equal(summary.passed, 1)
  assert.equal(summary.failed, 3)
  assert.equal(summary.failuresByCheck.grounded, 2)
  assert.equal(summary.failuresByCheck.computed, 1)
})

test("an empty run is a clean run, not a divide by zero", () => {
  const summary = summarizeEvalResults([])
  assert.equal(summary.total, 0)
  assert.equal(summary.meanScore, 1)
})

test("a case with no applicable checks still scores", () => {
  // "computed" and "honest" always apply, so this is never actually empty.
  const result = scoreEvalCase({ id: "e", question: "hello" }, CLEAN)
  assert.ok(result.checks.length >= 2)
  assert.equal(result.score, 1)
})
