require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  findSymbolMatches,
  partitionByNearbyText,
} = require("../lib/drawings/symbol-match")

/**
 * Count by example turns one click into a quantity, so the interesting cases
 * are the ones where it must NOT: a symbol that only half-matches, a page of
 * hatching, a sheet with no linework, and — the one that would actually cost
 * money — two symbols whose geometry is identical and whose labels are not.
 */

const IMAGE = { width: 1000, height: 1000 }

/** Segments arrive normalized 0..1, flat as [x0, y0, x1, y1, ...]. */
function segments(list) {
  return new Float32Array(list.flat())
}

/**
 * A plus sign: four strokes from a centre. Distinctive enough to match, small
 * enough to be a symbol rather than a region.
 */
function plusAt(cx, cy, size = 0.01) {
  return [
    [cx - size, cy, cx + size, cy],
    [cx, cy - size, cx, cy + size],
    [cx - size, cy - size, cx - size, cy + size],
    [cx + size, cy - size, cx + size, cy + size],
  ]
}

test("one clicked symbol finds its identical copies", () => {
  const sheet = segments([
    ...plusAt(0.2, 0.2),
    ...plusAt(0.5, 0.2),
    ...plusAt(0.8, 0.2),
    ...plusAt(0.5, 0.6),
  ])

  const result = findSymbolMatches(sheet, IMAGE, { x: 0.2, y: 0.2 })
  assert.ok(result.exemplarSegmentCount >= 2, "the click should pick up an exemplar")
  // Four occurrences: the three others PLUS the clicked one, which is itself a
  // thing being counted. The caller must not add the click back on top.
  assert.equal(result.matches.length, 4)
  assert.equal(result.truncated, false)

  const xs = result.matches.map((match) => Math.round(match.point.x * 100) / 100).sort()
  assert.deepEqual(xs, [0.2, 0.5, 0.5, 0.8])
})

test("every match reports where and how well it matched", () => {
  const sheet = segments([...plusAt(0.2, 0.2), ...plusAt(0.6, 0.6)])
  const result = findSymbolMatches(sheet, IMAGE, { x: 0.2, y: 0.2 })
  assert.equal(result.matches.length, 2)
  for (const match of result.matches) {
    assert.ok(match.score > 0.7 && match.score <= 1)
    assert.ok([0, 90, 180, 270].includes(match.rotation))
  }
  const other = result.matches.find((match) => match.point.x > 0.4)
  assert.ok(other, "the second plus should be found")
  assert.ok(Math.abs(other.point.x - 0.6) < 0.01)
  assert.ok(Math.abs(other.point.y - 0.6) < 0.01)
})

test("a partial copy does not count as the symbol", () => {
  // The second shape has one of the four strokes; nowhere near the threshold.
  const sheet = segments([...plusAt(0.2, 0.2), [0.6, 0.6, 0.61, 0.6]])
  const result = findSymbolMatches(sheet, IMAGE, { x: 0.2, y: 0.2 })
  // Only the exemplar's own placement — the fragment is not an occurrence.
  assert.equal(result.matches.length, 1)
  assert.ok(Math.abs(result.matches[0].point.x - 0.2) < 0.01)
})

test("a sheet with no vectors returns nothing rather than throwing", () => {
  const empty = findSymbolMatches(new Float32Array(0), IMAGE, { x: 0.5, y: 0.5 })
  assert.deepEqual(empty.matches, [])
  assert.equal(empty.exemplarSegmentCount, 0)
  assert.equal(empty.exemplarBox, null)

  // A degenerate image size is the same kind of "cannot help" answer.
  const noImage = findSymbolMatches(segments(plusAt(0.2, 0.2)), { width: 0, height: 0 }, { x: 0.2, y: 0.2 })
  assert.deepEqual(noImage.matches, [])
})

test("clicking empty paper finds nothing and says the exemplar was empty", () => {
  const sheet = segments(plusAt(0.2, 0.2))
  const result = findSymbolMatches(sheet, IMAGE, { x: 0.9, y: 0.9 })
  assert.equal(result.exemplarSegmentCount, 0)
  assert.deepEqual(result.matches, [])
})

test("the match cap is enforced and disclosed, never silently applied", () => {
  const many = []
  for (let i = 0; i < 40; i++) {
    many.push(...plusAt(0.05 + (i % 8) * 0.11, 0.05 + Math.floor(i / 8) * 0.11))
  }
  const result = findSymbolMatches(segments(many), IMAGE, { x: 0.05, y: 0.05 }, { maxMatches: 5 })
  assert.equal(result.matches.length, 5)
  assert.equal(result.truncated, true, "a capped search must report that it was capped")
})

test("a region restriction excludes matches outside it", () => {
  const sheet = segments([
    ...plusAt(0.2, 0.2),
    ...plusAt(0.3, 0.3),
    ...plusAt(0.9, 0.9),
  ])
  const result = findSymbolMatches(sheet, IMAGE, { x: 0.2, y: 0.2 }, {
    region: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 },
  })
  // The exemplar and its neighbour, but not the one across the sheet.
  assert.equal(result.matches.length, 2)
  assert.ok(result.matches.every((match) => match.point.x < 0.5))
})

test("matches are ordered best-first", () => {
  const sheet = segments([...plusAt(0.2, 0.2), ...plusAt(0.5, 0.5), ...plusAt(0.8, 0.8)])
  const result = findSymbolMatches(sheet, IMAGE, { x: 0.2, y: 0.2 })
  const scores = result.matches.map((match) => match.score)
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i - 1] >= scores[i], "scores must be descending")
  }
})

test("the exemplar box is reported so the viewer can show what was matched", () => {
  const result = findSymbolMatches(segments(plusAt(0.2, 0.2)), IMAGE, { x: 0.2, y: 0.2 })
  const box = result.exemplarBox
  assert.ok(box)
  assert.ok(box.x0 < 0.2 && box.x1 > 0.2)
  assert.ok(box.y0 < 0.2 && box.y1 > 0.2)
})

// ---------------------------------------------------------------------------
// Text disambiguation — the expensive mistake
// ---------------------------------------------------------------------------

test("a match tagged differently is separated out, not silently counted", () => {
  const matches = [
    { point: { x: 0.5, y: 0.5 }, score: 1, rotation: 0 },
    { point: { x: 0.8, y: 0.8 }, score: 1, rotation: 0 },
  ]
  const labels = [
    // The exemplar carries no tag; one match carries "GFI".
    { x: 0.81, y: 0.8, text: "GFI" },
  ]
  const { confirmed, differentLabel } = partitionByNearbyText(
    matches,
    { x: 0.2, y: 0.2 },
    labels,
    IMAGE,
  )
  assert.equal(confirmed.length, 1)
  assert.equal(differentLabel.length, 1)
  assert.equal(differentLabel[0].point.x, 0.8)
})

test("a match sharing the exemplar's tag is confirmed", () => {
  const matches = [{ point: { x: 0.8, y: 0.8 }, score: 1, rotation: 0 }]
  const labels = [
    { x: 0.21, y: 0.2, text: "GFI" },
    { x: 0.81, y: 0.8, text: "GFI" },
  ]
  const { confirmed, differentLabel } = partitionByNearbyText(
    matches,
    { x: 0.2, y: 0.2 },
    labels,
    IMAGE,
  )
  assert.equal(confirmed.length, 1)
  assert.equal(differentLabel.length, 0)
})

test("with no extracted text every match is confirmed rather than doubted", () => {
  const matches = [{ point: { x: 0.8, y: 0.8 }, score: 1, rotation: 0 }]
  const { confirmed, differentLabel } = partitionByNearbyText(
    matches,
    { x: 0.2, y: 0.2 },
    [],
    IMAGE,
  )
  assert.equal(confirmed.length, 1)
  assert.equal(differentLabel.length, 0)
})

test("page furniture is not treated as a symbol tag", () => {
  const matches = [{ point: { x: 0.8, y: 0.8 }, score: 1, rotation: 0 }]
  const labels = [
    // Too long to be a tag — a general note, not a symbol label.
    { x: 0.81, y: 0.8, text: "ALL RECEPTACLES TO BE 18 INCHES AFF TYPICAL" },
    // Far enough away to belong to something else entirely.
    { x: 0.2, y: 0.9, text: "S3" },
  ]
  const { confirmed, differentLabel } = partitionByNearbyText(
    matches,
    { x: 0.2, y: 0.2 },
    labels,
    IMAGE,
  )
  assert.equal(confirmed.length, 1)
  assert.equal(differentLabel.length, 0)
})
