require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  parseVectorsBin,
  buildVectorIndex,
  snapPoint,
} = require("../lib/drawings/vector-snap")

// A 1000x800 rendered sheet, matching the takeoff-measure fixtures. Segments
// below are written in IMAGE PIXELS for readability and normalized on encode.
const IMAGE = { width: 1000, height: 800 }

/** Encode image-px segments into a spec-compliant vectors.bin ArrayBuffer. */
function encodeVectorsBin(
  segmentsPx,
  { magic = "ARCV", version = 1, countOverride = null, attrs = [] } = {},
) {
  const count = countOverride ?? segmentsPx.length
  const buffer = new ArrayBuffer(
    12 + segmentsPx.length * 16 + (version === 2 ? segmentsPx.length * 2 : 0),
  )
  const view = new DataView(buffer)
  for (let i = 0; i < 4; i++) view.setUint8(i, magic.charCodeAt(i))
  view.setUint16(4, version, true)
  view.setUint16(6, 0, true)
  view.setUint32(8, count, true)
  segmentsPx.forEach(([x0, y0, x1, y1], i) => {
    view.setFloat32(12 + i * 16, x0 / IMAGE.width, true)
    view.setFloat32(12 + i * 16 + 4, y0 / IMAGE.height, true)
    view.setFloat32(12 + i * 16 + 8, x1 / IMAGE.width, true)
    view.setFloat32(12 + i * 16 + 12, y1 / IMAGE.height, true)
  })
  if (version === 2) {
    const attrOffset = 12 + segmentsPx.length * 16
    segmentsPx.forEach((_, i) => {
      const attr = attrs[i] ?? {}
      view.setUint8(attrOffset + i * 2, (attr.dashed ? 1 : 0) | (attr.filled ? 2 : 0))
      view.setUint8(attrOffset + i * 2 + 1, Math.round((attr.width ?? 1) * 10))
    })
  }
  return buffer
}

function indexOf(segmentsPx, options) {
  const parsed = parseVectorsBin(encodeVectorsBin(segmentsPx, options))
  assert.ok(parsed, "fixture must parse")
  const index = buildVectorIndex(parsed, IMAGE)
  assert.ok(index, "fixture must index")
  return index
}

// ---------------------------------------------------------------------------
// parseVectorsBin
// ---------------------------------------------------------------------------

test("vectors.bin round-trips segments through the binary contract", () => {
  const segments = [
    [100, 100, 900, 100],
    [900, 100, 900, 700],
    [12.5, 640, 480, 320],
  ]
  const parsed = parseVectorsBin(encodeVectorsBin(segments))
  assert.ok(parsed)
  assert.equal(parsed.segments.length, 12)
  segments.forEach(([x0, y0, x1, y1], i) => {
    assert.ok(Math.abs(parsed.segments[i * 4] * IMAGE.width - x0) < 0.01)
    assert.ok(Math.abs(parsed.segments[i * 4 + 1] * IMAGE.height - y0) < 0.01)
    assert.ok(Math.abs(parsed.segments[i * 4 + 2] * IMAGE.width - x1) < 0.01)
    assert.ok(Math.abs(parsed.segments[i * 4 + 3] * IMAGE.height - y1) < 0.01)
  })
  assert.equal(parsed.flags, null)
  assert.equal(parsed.widths, null)
})

test("vectors.bin parsing rejects bad magic, version, and length mismatches", () => {
  const segments = [[0, 0, 100, 100]]
  assert.equal(parseVectorsBin(encodeVectorsBin(segments, { magic: "NOPE" })), null)
  assert.equal(parseVectorsBin(encodeVectorsBin(segments, { version: 3 })), null)
  // Header claims more segments than the body carries.
  assert.equal(parseVectorsBin(encodeVectorsBin(segments, { countOverride: 5 })), null)
  // Truncated below the header.
  assert.equal(parseVectorsBin(new ArrayBuffer(6)), null)
  // Empty payload is valid: a sheet with vectors extracted but none surviving.
  const empty = parseVectorsBin(encodeVectorsBin([]))
  assert.ok(empty)
  assert.equal(empty.segments.length, 0)
})

test("vectors.bin v2 exposes aligned flags and widths while v1 remains compatible", () => {
  const parsed = parseVectorsBin(
    encodeVectorsBin(
      [[0, 0, 100, 100], [100, 0, 100, 100]],
      {
        version: 2,
        attrs: [{ dashed: true, width: 0.5 }, { filled: true, width: 2.4 }],
      },
    ),
  )
  assert.ok(parsed)
  assert.deepEqual(Array.from(parsed.flags), [1, 2])
  assert.deepEqual(Array.from(parsed.widths), [5, 24])
})

// ---------------------------------------------------------------------------
// snapPoint
// ---------------------------------------------------------------------------

test("snap prefers an endpoint over a closer mid-segment projection", () => {
  const index = indexOf([[100, 500, 500, 500]])
  // 8px from the endpoint, 4px from the segment body — the corner still wins.
  const snapped = snapPoint(index, { x: 108, y: 504 }, 12)
  assert.ok(snapped)
  assert.equal(snapped.kind, "endpoint")
  assert.ok(Math.abs(snapped.point.x - 100) < 0.01)
  assert.ok(Math.abs(snapped.point.y - 500) < 0.01)
})

test("snap falls back to the segment projection away from endpoints", () => {
  const index = indexOf([[100, 500, 500, 500]])
  const snapped = snapPoint(index, { x: 300, y: 506 }, 12)
  assert.ok(snapped)
  assert.equal(snapped.kind, "segment")
  assert.ok(Math.abs(snapped.point.x - 300) < 0.01)
  assert.ok(Math.abs(snapped.point.y - 500) < 0.01)
})

test("snap finds a crossing intersection when no endpoint is near", () => {
  // Two long segments crossing at (400, 400), endpoints far away.
  const index = indexOf([
    [100, 400, 700, 400],
    [400, 100, 400, 700],
  ])
  const snapped = snapPoint(index, { x: 405, y: 396 }, 12)
  assert.ok(snapped)
  assert.equal(snapped.kind, "intersection")
  assert.ok(Math.abs(snapped.point.x - 400) < 0.01)
  assert.ok(Math.abs(snapped.point.y - 400) < 0.01)
})

test("snap returns null beyond the tolerance", () => {
  const index = indexOf([[100, 500, 500, 500]])
  assert.equal(snapPoint(index, { x: 300, y: 540 }, 12), null)
  assert.equal(snapPoint(index, { x: 980, y: 40 }, 12), null)
})

// ---------------------------------------------------------------------------
