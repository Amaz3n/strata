require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const {
  detectSheetMetadata, mergeDetectedSheetMetadata, normalizeSheetNumberCandidate,
  shouldVerifySheetMetadata, buildSheetMetadataVisionPrompt,
} = require("../lib/drawings/sheet-metadata")

const run = (text, x = .88, y = .93, h = .02) => ({ text, x, y, h, w: .08 })
const detect = (textRuns = [], pageText = textRuns.map(r => r.text).join("\n")) =>
  detectSheetMetadata({ textRuns, pageText, setTitle: "House", pageNumber: 2 })

test("A2 wins over A5.1 references regardless of text extraction order", () => {
  const runs = [run("SEE SHEET A5.1", .3, .3), run("A5.1", .4, .5, .008), run("A2")]
  for (const input of [runs, [...runs].reverse()]) {
    assert.equal(detect(input).sheetNumber, "A2")
    assert.equal(detect(input).confidence, "medium")
  }
})

test("SEE SHEET and SEE DRAWING are never identity labels", () => {
  for (const ref of ["SEE SHEET A5.1", "SEE DRAWING A5.1", "REFER TO SHEET A5.1", "DETAIL 1/A5.1"]) {
    assert.equal(detect([], `A2\nFLOOR PLAN\n${ref}`).method, "fallback")
    assert.equal(detect([run(ref)]).method, "fallback")
  }
})

test("inline title-block identity fields and title are spatially associated", () => {
  const result = detect([
    run("SHEET NUMBER: A2", .87, .93), run("TITLE: SECOND FLOOR PLAN", .86, .9),
    run("TITLE: WALL DETAILS", .15, .3), run("SHEET A5.1", .5, .5),
  ])
  assert.equal(result.sheetNumber, "A2")
  assert.equal(result.sheetTitle, "SECOND FLOOR PLAN")
  assert.equal(result.method, "label")
  assert.ok(result.sourceBounds)
})

test("separate field labels and values use geometry, not array adjacency", () => {
  const result = detect([
    run("SHEET NO.", .88, .90, .008), run("A5.1", .3, .5, .008),
    run("A2", .88, .92), run("SHEET TITLE:", .88, .86, .008),
    run("FIRST FLOOR PLAN", .88, .88, .012),
  ])
  assert.equal(result.sheetNumber, "A2")
  assert.equal(result.sheetTitle, "FIRST FLOOR PLAN")
})

test("ambiguous sheet index and conflicting fields abstain", () => {
  assert.equal(detect([run("A2"), run("A5.1", .88, .88)]).method, "fallback")
  assert.equal(detect([], "SHEET NUMBER: A2\nSHEET NUMBER: A5.1").method, "fallback")
})

test("small standalone detail bubbles and body numbers are not title blocks", () => {
  assert.equal(detect([run("A5.1", .88, .93, .006)]).method, "fallback")
  assert.equal(detect([run("A5.1", .5, .5, .03)]).method, "fallback")
})

test("top-left, bottom-left and top-right title blocks are supported", () => {
  for (const [x, y] of [[.05, .05], [.05, .9], [.88, .05]]) {
    assert.equal(detect([run("SHEET: A2", x, y)]).sheetNumber, "A2")
  }
})

test("missing text, malformed positions and scans keep a neutral placeholder", () => {
  for (const runs of [[], [run("A2", NaN)], [run("A2", .88, .93, -1)]]) {
    assert.equal(detect(runs).sheetNumber, "House - Page 2")
  }
})

test("legacy text can read an exact field but cannot skip verification", () => {
  const result = detect([], "SHEET NO.: A2\nTITLE: FLOOR PLAN")
  assert.equal(result.sheetNumber, "A2")
  assert.equal(result.sheetTitle, "FLOOR PLAN")
  assert.equal(shouldVerifySheetMetadata(true), true)
  assert.equal(shouldVerifySheetMetadata(false), false)
})

test("sheet-number validation rejects prose and detail fractions", () => {
  for (const value of ["SEE A2", "1/A2", "A2 / A5.1", "A2 floor plan", "A/2"]) {
    assert.equal(normalizeSheetNumberCandidate(value), null)
  }
  for (const value of ["A2", "A2.1", "A-101", "FP1.1", "S2.0A"]) {
    assert.equal(normalizeSheetNumberCandidate(value), value)
  }
})

const merge = (detected, vision) => mergeDetectedSheetMetadata(detected, vision)
test("clear vision corrects even a legacy high-confidence wrong label", () => {
  const result = merge({ ...detect([], "SHEET: A5.1"), confidence: "high" }, {
    sheetNumber: "A2", sheetTitle: "FLOOR PLAN", confidence: "high", discipline: "S", needsReview: false,
    evidence: { text: "A2", location: "bottom right", is_title_block: true },
  })
  assert.equal(result.sheetNumber, "A2")
  assert.equal(result.discipline, "A")
  assert.equal(result.sheetTitle, "FLOOR PLAN")
  assert.equal(result.method, "vision")
})

test("low-confidence vision cannot replace a number or title", () => {
  const initial = detect([], "SHEET: A2\nTITLE: FLOOR PLAN")
  assert.deepEqual(merge(initial, { sheetNumber: "A5.1", sheetTitle: "DETAILS", confidence: "low" }), { ...initial, confidence: "low" })
})

test("conflicting medium-confidence vision flags uncertainty without mixing identities", () => {
  const initial = detect([], "SHEET: A2\nTITLE: FLOOR PLAN")
  const result = merge(initial, { sheetNumber: "A5.1", sheetTitle: "DETAILS", confidence: "medium" })
  assert.equal(result.sheetNumber, "A2")
  assert.equal(result.sheetTitle, "FLOOR PLAN")
  assert.equal(result.confidence, "low")
})

test("null identity does not inherit a model's high confidence", () => {
  const result = merge(detect(), { sheetNumber: null, sheetTitle: null, confidence: "high" })
  assert.equal(result.confidence, "low")
  assert.equal(result.method, "fallback")
})

test("vision prompt reads independently and explicitly excludes references", () => {
  const prompt = buildSheetMetadataVisionPrompt()
  assert.match(prompt, /TITLE BLOCK/)
  assert.match(prompt, /Ignore detail\/section bubbles/)
  assert.match(prompt, /Return null/)
  assert.doesNotMatch(prompt, /Current text-based guess|preserve the existing guess/)
})

test("abbreviated labels and legitimate index titles are retained", () => {
  for (const field of ["SHT. NO.", "DWG. NO.", "SHEET NUMBER"]) {
    const result = detect([], `${field}: A2\nTITLE: DRAWING INDEX`)
    assert.equal(result.sheetNumber, "A2")
    assert.equal(result.sheetTitle, "DRAWING INDEX")
  }
})

test("long set names retain unique page suffixes when detection abstains", () => {
  const input = { pageText: "", setTitle: "A".repeat(100) }
  const first = detectSheetMetadata({ ...input, pageNumber: 1 })
  const second = detectSheetMetadata({ ...input, pageNumber: 2 })
  assert.notEqual(first.sheetNumber, second.sheetNumber)
  assert.ok(first.sheetNumber.length <= 50)
})
