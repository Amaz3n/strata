require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  localInkAround,
  verifySymbolProposals,
  MIN_SEGMENTS_FOR_VERIFICATION,
} = require("../lib/drawings/symbol-verify")

const IMAGE = { width: 2000, height: 1000 }
const RADIUS = 20

/** A cluster of short strokes centred on a normalized point — one "symbol". */
function symbolAt(x, y, strokes = 8) {
  const segments = []
  for (let i = 0; i < strokes; i++) {
    const offset = ((i % 4) - 1.5) * 6 // ±9px around the centre
    const x0 = x + offset / IMAGE.width
    const y0 = y + offset / IMAGE.height
    segments.push(x0, y0, x0 + 8 / IMAGE.width, y0 + 8 / IMAGE.height)
  }
  return segments
}

/** Filler linework far from anything, to clear the usable-vectors floor. */
function sheetNoise(count) {
  const segments = []
  for (let i = 0; i < count; i++) {
    const x = 0.9 + (i % 10) * 0.001
    const y = 0.9 + Math.floor(i / 10) * 0.0005
    segments.push(x, y, x + 0.001, y)
  }
  return segments
}

// ---------------------------------------------------------------------------
// Local ink
// ---------------------------------------------------------------------------

test("ink is counted inside the window and ignored outside it", () => {
  const segments = [...symbolAt(0.5, 0.5), ...symbolAt(0.2, 0.2)]
  const here = localInkAround(segments, IMAGE, { x: 0.5, y: 0.5 }, RADIUS)
  const blank = localInkAround(segments, IMAGE, { x: 0.8, y: 0.8 }, RADIUS)
  assert.ok(here.segments > 0)
  assert.ok(here.lengthPx > 0)
  assert.equal(blank.segments, 0)
  assert.equal(blank.lengthPx, 0)
})

test("a long wall passing through contributes nothing — a wall is not a symbol", () => {
  // Both endpoints far outside the window, crossing straight through it.
  const wall = [0.0, 0.5, 1.0, 0.5]
  const ink = localInkAround(wall, IMAGE, { x: 0.5, y: 0.5 }, RADIUS)
  assert.equal(ink.segments, 0)
})

test("a segment with one endpoint inside counts", () => {
  const stroke = [0.5, 0.5, 0.9, 0.9]
  const ink = localInkAround(stroke, IMAGE, { x: 0.5, y: 0.5 }, RADIUS)
  assert.equal(ink.segments, 1)
})

test("a trailing partial segment does not read past the end of the buffer", () => {
  const ink = localInkAround([0.5, 0.5, 0.51], IMAGE, { x: 0.5, y: 0.5 }, RADIUS)
  assert.equal(ink.segments, 0)
})

test("a Float32Array reads the same as a plain array", () => {
  const segments = symbolAt(0.5, 0.5)
  const typed = localInkAround(Float32Array.from(segments), IMAGE, { x: 0.5, y: 0.5 }, RADIUS)
  const plain = localInkAround(segments, IMAGE, { x: 0.5, y: 0.5 }, RADIUS)
  assert.equal(typed.segments, plain.segments)
})

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

test("a proposal on real linework is kept, one on blank paper is dropped", () => {
  const segments = [
    ...symbolAt(0.5, 0.5),
    ...symbolAt(0.6, 0.5),
    ...sheetNoise(MIN_SEGMENTS_FOR_VERIFICATION * 4),
  ]
  const result = verifySymbolProposals({
    proposals: [
      { x: 0.6, y: 0.5 }, // real
      { x: 0.3, y: 0.3 }, // hallucinated onto empty space
    ],
    segments,
    imageSize: IMAGE,
    exemplar: { x: 0.5, y: 0.5 },
    radiusPx: RADIUS,
  })

  assert.equal(result.skipped, false)
  assert.deepEqual(result.supported, [{ x: 0.6, y: 0.5 }])
  assert.deepEqual(result.rejected, [{ x: 0.3, y: 0.3 }])
})

test("a scan with no usable vectors skips verification instead of rejecting everything", () => {
  const proposals = [
    { x: 0.2, y: 0.2 },
    { x: 0.4, y: 0.4 },
  ]
  const result = verifySymbolProposals({
    proposals,
    segments: symbolAt(0.5, 0.5), // far below the usable-vectors floor
    imageSize: IMAGE,
    exemplar: { x: 0.5, y: 0.5 },
    radiusPx: RADIUS,
  })

  assert.equal(result.skipped, true)
  assert.equal(result.supported.length, 2)
  assert.equal(result.rejected.length, 0)
})

test("an exemplar with no ink under it declines to judge the rest of the sheet", () => {
  const segments = [...symbolAt(0.5, 0.5), ...sheetNoise(MIN_SEGMENTS_FOR_VERIFICATION * 4)]
  const result = verifySymbolProposals({
    proposals: [{ x: 0.3, y: 0.3 }],
    segments,
    imageSize: IMAGE,
    // Clicked somewhere with nothing under it — the premise is untrustworthy.
    exemplar: { x: 0.1, y: 0.7 },
    radiusPx: RADIUS,
  })

  assert.equal(result.skipped, true)
  assert.equal(result.supported.length, 1)
})

test("the exemplar sets the bar, so a sparse symbol is not held to a dense one's density", () => {
  const sparse = [...symbolAt(0.5, 0.5, 3), ...symbolAt(0.6, 0.5, 3)]
  const segments = [...sparse, ...sheetNoise(MIN_SEGMENTS_FOR_VERIFICATION * 4)]
  const result = verifySymbolProposals({
    proposals: [{ x: 0.6, y: 0.5 }],
    segments,
    imageSize: IMAGE,
    exemplar: { x: 0.5, y: 0.5 },
    radiusPx: RADIUS,
  })

  assert.equal(result.skipped, false)
  assert.equal(result.supported.length, 1)
})

test("a match carrying somewhat less ink than the exemplar still passes", () => {
  // The exemplar box catches a lead line the real symbol does not have.
  const segments = [
    ...symbolAt(0.5, 0.5, 12),
    ...symbolAt(0.6, 0.5, 6),
    ...sheetNoise(MIN_SEGMENTS_FOR_VERIFICATION * 4),
  ]
  const result = verifySymbolProposals({
    proposals: [{ x: 0.6, y: 0.5 }],
    segments,
    imageSize: IMAGE,
    exemplar: { x: 0.5, y: 0.5 },
    radiusPx: RADIUS,
  })

  assert.equal(result.supported.length, 1)
})

test("input order is preserved among the survivors", () => {
  const segments = [
    ...symbolAt(0.2, 0.5),
    ...symbolAt(0.4, 0.5),
    ...symbolAt(0.6, 0.5),
    ...sheetNoise(MIN_SEGMENTS_FOR_VERIFICATION * 4),
  ]
  const result = verifySymbolProposals({
    proposals: [
      { x: 0.6, y: 0.5 },
      { x: 0.9, y: 0.1 },
      { x: 0.2, y: 0.5 },
      { x: 0.4, y: 0.5 },
    ],
    segments,
    imageSize: IMAGE,
    exemplar: { x: 0.4, y: 0.5 },
    radiusPx: RADIUS,
  })

  assert.deepEqual(result.supported, [
    { x: 0.6, y: 0.5 },
    { x: 0.2, y: 0.5 },
    { x: 0.4, y: 0.5 },
  ])
  assert.equal(result.rejected.length, 1)
})

test("no proposals is not an error", () => {
  const result = verifySymbolProposals({
    proposals: [],
    segments: [...symbolAt(0.5, 0.5), ...sheetNoise(MIN_SEGMENTS_FOR_VERIFICATION * 4)],
    imageSize: IMAGE,
    exemplar: { x: 0.5, y: 0.5 },
    radiusPx: RADIUS,
  })
  assert.equal(result.supported.length, 0)
  assert.equal(result.rejected.length, 0)
  assert.equal(result.skipped, false)
})
