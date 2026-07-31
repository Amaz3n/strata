// Collinear chain-merging — the defense against exporters that shred wall
// lines into sub-point fragments (field case: a partition wall emitted as
// tens of thousands of <1pt pieces, deleted wholesale by the noise filter,
// causing manual takeoff snapping to miss a wall the raster showed).
require("../scripts/register-ts-node-test")

const test = require("node:test")
const assert = require("node:assert/strict")

const {
  collapseDashChains,
  mergeCollinearChains,
} = require("../lib/drawings/vector-analysis.ts")

const NOISE = 3

function seg(x0, y0, x1, y1, extra = {}) {
  return { x0, y0, x1, y1, width: 1, filled: false, dashed: false, ...extra }
}

function structural(segments) {
  return segments.filter((s) => Math.hypot(s.x1 - s.x0, s.y1 - s.y0) >= NOISE)
}

test("a wall shredded into 100 sub-point fragments merges into one long segment", () => {
  const pieces = []
  for (let i = 0; i < 100; i++) {
    pieces.push(seg(i * 0.5, 10, (i + 1) * 0.5, 10))
  }
  const merged = mergeCollinearChains(pieces)
  const kept = structural(merged)
  assert.strictEqual(kept.length, 1)
  const wall = kept[0]
  const length = Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0)
  assert.ok(Math.abs(length - 50) < 0.01, `expected ~50pt wall, got ${length}`)
})

test("hatching (parallel strokes that never touch end-to-end) does not chain and stays filtered", () => {
  const hatch = []
  for (let i = 0; i < 50; i++) {
    // 2pt diagonal ticks spaced apart — classic hatch fill.
    hatch.push(seg(i * 4, 0, i * 4 + 1.4, 1.4))
  }
  const merged = mergeCollinearChains(hatch)
  assert.strictEqual(structural(merged).length, 0)
})

test("chains stop at corners instead of merging through them", () => {
  const pieces = []
  for (let i = 0; i < 20; i++) pieces.push(seg(i, 0, i + 1, 0)) // horizontal run
  for (let i = 0; i < 20; i++) pieces.push(seg(20, i, 20, i + 1)) // vertical run from the corner
  const merged = mergeCollinearChains(pieces)
  const kept = structural(merged)
  assert.strictEqual(kept.length, 2)
  const orientations = kept.map((s) => (Math.abs(s.x1 - s.x0) > Math.abs(s.y1 - s.y0) ? "h" : "v")).sort()
  assert.deepStrictEqual(orientations, ["h", "v"])
})

test("a drifting near-collinear chain is cut once it leaves the base line", () => {
  // Each piece tilts 2° — pairwise collinear-ish, but the run bows away from
  // the base line; the deviation cap must stop the chain rather than emit one
  // long lying segment.
  const pieces = []
  let x = 0
  let y = 0
  for (let i = 0; i < 40; i++) {
    const angle = (i * 2 * Math.PI) / 180
    const nx = x + Math.cos(angle)
    const ny = y + Math.sin(angle)
    pieces.push(seg(x, y, nx, ny))
    x = nx
    y = ny
  }
  const merged = mergeCollinearChains(pieces)
  // The arc must NOT collapse into a single segment.
  assert.ok(merged.length > 3, `expected the arc to stay segmented, got ${merged.length}`)
})

test("already-long segments pass through untouched", () => {
  const input = [seg(0, 0, 100, 0), seg(0, 50, 0, 150)]
  const merged = mergeCollinearChains(input)
  assert.strictEqual(merged.length, 2)
})

test("a dashed rectangle collapses to four attributed segments", () => {
  const dashed = []
  for (let x = 0; x < 30; x += 5) {
    dashed.push(seg(x, 0, x + 2, 0), seg(x, 20, x + 2, 20))
  }
  for (let y = 0; y < 20; y += 5) {
    dashed.push(seg(0, y, 0, y + 2), seg(30, y, 30, y + 2))
  }
  const collapsed = collapseDashChains(dashed)
  assert.equal(collapsed.length, 4)
  assert.ok(collapsed.every((segment) => segment.dashed))
})

test("one door gap between solid wall runs is not a dash chain", () => {
  const wall = [
    seg(0, 0, 20, 0),
    seg(26, 0, 50, 0),
  ]
  const collapsed = collapseDashChains(wall)
  assert.equal(collapsed.length, 2)
  assert.ok(collapsed.every((segment) => !segment.dashed))
})

test("dot-dash centre lines collapse when their gaps repeat", () => {
  const centre = [
    seg(0, 0, 1, 0),
    seg(4, 0, 8, 0),
    seg(11, 0, 12, 0),
    seg(15, 0, 19, 0),
  ]
  const collapsed = collapseDashChains(centre)
  assert.equal(collapsed.length, 1)
  assert.equal(collapsed[0].dashed, true)
})

test("irregular sketchy linework stays uncollapsed", () => {
  const sketch = [
    seg(0, 0, 2, 0),
    seg(3, 0.2, 5, 0.3),
    seg(10, -0.4, 12, -0.1),
    seg(13, 0.5, 15, 0.9),
  ]
  const collapsed = collapseDashChains(sketch)
  assert.equal(collapsed.length, sketch.length)
  assert.ok(collapsed.every((segment) => !segment.dashed))
})
