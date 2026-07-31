require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  parseStatedScale,
  findStatedScale,
  feetPerImagePxFromPaperScale,
  crossCheckDimensionChains,
  buildCalibrationProposal,
} = require("../lib/drawings/scale")

// ---------------------------------------------------------------------------
// Stated scale
// ---------------------------------------------------------------------------

test("architectural fractions resolve to feet per paper inch", () => {
  // 1/4" on paper = 1 foot, so one paper inch spans 4 feet.
  assert.equal(parseStatedScale(`1/4" = 1'-0"`).feetPerPaperInch, 4)
  assert.equal(parseStatedScale(`1/8" = 1'-0"`).feetPerPaperInch, 8)
  assert.equal(parseStatedScale(`3/16"=1'-0"`).feetPerPaperInch, 16 / 3)
  assert.equal(parseStatedScale(`1" = 1'-0"`).feetPerPaperInch, 1)
})

test("mixed-number and civil scales parse", () => {
  assert.equal(parseStatedScale(`1 1/2" = 1'-0"`).feetPerPaperInch, 1 / 1.5)
  assert.equal(parseStatedScale(`1" = 20'`).feetPerPaperInch, 20)
  assert.equal(parseStatedScale(`1"=100'`).feetPerPaperInch, 100)
})

test("ratio scales convert through inches", () => {
  // 1:48 — one paper inch is 48 real inches, i.e. 4 feet.
  assert.equal(parseStatedScale("1:48").feetPerPaperInch, 4)
  assert.equal(parseStatedScale("1:96").feetPerPaperInch, 8)
})

test("smart quotes and stray whitespace survive", () => {
  assert.equal(parseStatedScale(`SCALE:  ¼`), null) // the glyph, not a fraction
  assert.equal(parseStatedScale(`SCALE: 1/4” = 1’-0”`).feetPerPaperInch, 4)
})

test("a sheet that disclaims its scale gets none", () => {
  assert.equal(parseStatedScale("SCALE: NTS"), null)
  assert.equal(parseStatedScale("SCALE: NOT TO SCALE"), null)
  // The disclaimer wins even when a number is sitting in the same string.
  assert.equal(parseStatedScale(`SCALE: AS NOTED (1/4" = 1'-0" TYP)`), null)
})

test("nonsense yields null rather than a number", () => {
  assert.equal(parseStatedScale(""), null)
  assert.equal(parseStatedScale("DRAWN BY: JB"), null)
  assert.equal(parseStatedScale(`0" = 1'-0"`), null)
})

test("a fraction in a construction note is NOT a scale", () => {
  // Verbatim from a real customer sheet. The slash-ratio form used to read
  // these as 1:2 and calibrate the sheet 8x wrong.
  assert.equal(parseStatedScale(`1/2" GYP. BD.`), null)
  assert.equal(parseStatedScale(`1/2" SAG RESISTANT GYP. BD. OVER`), null)
  assert.equal(parseStatedScale(`#5 BARS AND SMALLER...............1 1/2"`), null)
  assert.equal(parseStatedScale(`2" DRAIN PIPE`), null)
  assert.equal(parseStatedScale("10.00' NAVD88"), null)
  assert.equal(parseStatedScale(`±0'-0"`), null)
})

test("colon ratios parse only inside a plausible drawing range", () => {
  assert.equal(parseStatedScale("SCALE 1:48").feetPerPaperInch, 4)
  // 1:2 is a mix ratio or a slope, never a drawing scale.
  assert.equal(parseStatedScale("SLOPE 1:2"), null)
  assert.equal(parseStatedScale("1:100000"), null)
})

test("the label and value can arrive in either order, on separate lines", () => {
  // Both orderings are taken verbatim from one real four-page set.
  const labelFirst = ["FLOOR PLAN", "SCALE:", `1/4"=1'-0"`, "NEW PROPOSED"]
  assert.equal(findStatedScale(labelFirst).feetPerPaperInch, 4)

  const valueFirst = ["NEW NON-BEARING PARTITION", `3/4"=1'-0"`, "SCALE:", `±0'-0"`]
  assert.equal(findStatedScale(valueFirst).feetPerPaperInch, 4 / 3)
})

test("the labeled scale wins over parseable noise elsewhere on the sheet", () => {
  const lines = [
    `1/2" GYP. BD.`,
    `1/2" SAG RESISTANT GYP. BD. OVER`,
    "NEW NON-BEARING PARTITION",
    `3/4"=1'-0"`,
    "SCALE:",
    `±0'-0"`,
  ]
  assert.equal(findStatedScale(lines).feetPerPaperInch, 4 / 3)
})

test("prose containing the word SCALE is not a label anchor", () => {
  const lines = [
    "DIMENSIONS, ETC. (DRAWINGS ARE NOT TO BE SCALED).",
    "SHALL NOTIFY THE ARCHITECT AND ENGINEER OF ANY DISCREPANCIES REQUIRING",
    "DO NOT SCALE STRUCTURAL DRAWINGS. REFER TO ARCHITECTURAL FOR DIMENSIONS",
  ]
  assert.equal(findStatedScale(lines), null)
})

test("a labeled NTS suppresses everything on the sheet", () => {
  assert.equal(findStatedScale(["DETAIL", `3/4" = 1'-0"`, "SCALE: NTS"]), null)
  assert.equal(findStatedScale([`1/4" = 1'-0"`, "SCALE: AS NOTED"]), null)
})

test("labeled scales that disagree mean a multi-scale sheet, so nothing is offered", () => {
  const lines = ["SCALE:", `1/4"=1'-0"`, "DETAIL", "SCALE:", `3/4"=1'-0"`]
  assert.equal(findStatedScale(lines), null)
})

test("with no SCALE label anywhere, one unambiguous bare scale is still offered", () => {
  assert.equal(findStatedScale(["FLOOR PLAN", `1/8" = 1'-0"`]).feetPerPaperInch, 8)
  assert.equal(findStatedScale(["FLOOR PLAN", "SHEET A-101"]), null)
  // Two different bare scales are detail callouts, not the sheet's scale.
  assert.equal(findStatedScale([`1/8" = 1'-0"`, "DETAIL", `3/4" = 1'-0"`]), null)
})

test("paper scale converts to feet per rendered pixel through DPI", () => {
  // 4 ft per paper inch, rendered at 200 DPI -> 0.02 ft per pixel.
  assert.equal(feetPerImagePxFromPaperScale(4, 200), 0.02)
  assert.equal(feetPerImagePxFromPaperScale(4, 0), null)
  assert.equal(feetPerImagePxFromPaperScale(0, 200), null)
})

// ---------------------------------------------------------------------------
// Dimension chain
// ---------------------------------------------------------------------------

/**
 * Build a horizontal dimension chain the way a plan prints one: each string is
 * centred on its own segment, so consecutive centres sit half of each apart.
 */
function chain(feetValues, { unitsPerFoot = 4, y = 100, startX = 50 } = {}) {
  const tokens = []
  let edge = startX
  for (const feet of feetValues) {
    const width = feet * unitsPerFoot
    tokens.push({ text: `${feet}'-0"`, x: edge + width / 2, y })
    edge += width
  }
  return tokens
}

test("a clean chain recovers the exact scale", () => {
  // 4 page units per foot -> 0.25 feet per unit.
  const result = crossCheckDimensionChains(chain([12, 16, 10, 14, 20]))
  assert.ok(result, "expected a result")
  assert.ok(Math.abs(result.feetPerUnit - 0.25) < 1e-9)
  assert.equal(result.sampleCount, 4)
  assert.equal(result.axis, "horizontal")
  assert.ok(result.spreadPct < 0.01)
})

test("a vertical chain is recognised too", () => {
  const horizontal = chain([12, 16, 10, 14])
  const vertical = horizontal.map((token) => ({ text: token.text, x: token.y, y: token.x }))
  const result = crossCheckDimensionChains(vertical)
  assert.ok(result)
  assert.equal(result.axis, "vertical")
  assert.ok(Math.abs(result.feetPerUnit - 0.25) < 1e-9)
})

test("one bad string is rejected without losing the chain", () => {
  const tokens = chain([12, 16, 10, 14, 20])
  // An overall dimension parked in the middle of the run.
  tokens.splice(2, 0, { text: `72'-0"`, x: tokens[2].x + 1, y: 100 })
  const result = crossCheckDimensionChains(tokens)
  assert.ok(result, "outlier should not kill the chain")
  assert.ok(Math.abs(result.feetPerUnit - 0.25) < 0.01)
})

test("too few dimensions produce no proposal", () => {
  assert.equal(crossCheckDimensionChains(chain([12, 16])), null)
  assert.equal(crossCheckDimensionChains([]), null)
})

test("dimensions scattered at random agree with nothing", () => {
  const tokens = [
    { text: `12'-0"`, x: 10, y: 100 },
    { text: `16'-0"`, x: 300, y: 100 },
    { text: `10'-0"`, x: 320, y: 100 },
    { text: `14'-0"`, x: 900, y: 100 },
    { text: `20'-0"`, x: 905, y: 100 },
  ]
  assert.equal(crossCheckDimensionChains(tokens), null)
})

test("strings on different rows are not treated as one chain", () => {
  const rowA = chain([12, 16, 10, 14], { y: 100 })
  // Same page, a different elevation, drawn at a different scale.
  const rowB = chain([12, 16, 10, 14], { y: 400, unitsPerFoot: 8 })
  const result = crossCheckDimensionChains([...rowA, ...rowB])
  assert.ok(result)
  // Whichever row wins, it must be one of the two real scales — never a blend.
  assert.ok(
    Math.abs(result.feetPerUnit - 0.25) < 1e-6 || Math.abs(result.feetPerUnit - 0.125) < 1e-6,
    `unexpected blended scale ${result.feetPerUnit}`,
  )
})

test("part numbers and micro-values are ignored", () => {
  const tokens = [
    ...chain([12, 16, 10, 14]),
    { text: `0'-2"`, x: 60, y: 100 },
    { text: "A-101", x: 80, y: 100 },
  ]
  const result = crossCheckDimensionChains(tokens)
  assert.ok(result)
  assert.ok(Math.abs(result.feetPerUnit - 0.25) < 0.01)
})

// ---------------------------------------------------------------------------
// Proposal assembly
// ---------------------------------------------------------------------------

test("the dimension check outranks the title block", () => {
  const proposal = buildCalibrationProposal({
    stated: { feetPerPaperInch: 8, raw: `1/8" = 1'-0"` },
    dimensionCheck: { feetPerUnit: 0.25, sampleCount: 6, spreadPct: 0.4, axis: "horizontal" },
    renderDpi: 200,
    // 200 DPI over 72 pt/inch.
    imagePxPerPageUnit: 200 / 72,
  })
  assert.equal(proposal.method, "dimension_check")
  assert.ok(Math.abs(proposal.feet_per_image_px - 0.25 / (200 / 72)) < 1e-12)
  assert.equal(proposal.sample_count, 6)
  // The title block still rides along as the human-readable label.
  assert.equal(proposal.raw, `1/8" = 1'-0"`)
})

test("the title block is used when nothing corroborates it", () => {
  const proposal = buildCalibrationProposal({
    stated: { feetPerPaperInch: 4, raw: `1/4" = 1'-0"` },
    dimensionCheck: null,
    renderDpi: 200,
    imagePxPerPageUnit: 200 / 72,
  })
  assert.equal(proposal.method, "title_block")
  assert.equal(proposal.feet_per_image_px, 0.02)
})

test("no evidence means no proposal, not a default", () => {
  assert.equal(
    buildCalibrationProposal({
      stated: null,
      dimensionCheck: null,
      renderDpi: 200,
      imagePxPerPageUnit: 200 / 72,
    }),
    null,
  )
})
